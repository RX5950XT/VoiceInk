'use strict'

// 真 HTTP listener、隔離隨機埠；不啟動前景觀測或碰使用者資料。
const assert = require('node:assert/strict')
const http = require('node:http')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { createWebServer } = require('../src/main/screentime/webserver')
const { createObserver } = require('../src/main/screentime/observer')

async function main() {
  const servers = []
  const original = http.createServer
  http.createServer = (...args) => {
    const server = original(...args)
    servers.push(server)
    return server
  }
  let failed = 0
  const check = async (name, fn) => {
    try { await fn(); console.log(`PASS ${name}`) }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`) }
  }
  try {
    await check('資料庫暫時寫不進去時，保留原應用時長並在下次補寫', async () => {
      let tick
      let locked = true
      const written = []
      const file = path.join(__dirname, '../src/main/screentime/index.js')
      const realRequire = createRequire(file)
      const context = { module: { exports: {} }, console, setTimeout, clearTimeout, require: (id) => {
        if (id === './observer') return { createObserver: options => {
          tick = options.onTick
          return { start() {}, stop() {} }
        } }
        if (id === './webserver') return { createWebServer: () => ({ start: async () => ({ ok: true }), stop: async () => {} }) }
        if (id === './db') return { ensureImported: () => ({}), openDb: () => ({}),
          readAppConfig: () => ({}), destDir: () => '', closeDb() {} }
        if (id === './write') return { updateAppDuration(_db, name, duration) {
          if (locked) throw new Error('database locked')
          written.push({ name, duration })
        } }
        return realRequire(id)
      } }
      vm.runInNewContext(fs.readFileSync(file, 'utf8'), context)
      const service = context.module.exports.createScreentimeService({ userDataPath: 'unused' })
      service.start()
      for (let i = 0; i < 60; i++) tick({ name: 'editor', path: 'D:/editor.exe', idleMs: 0 })
      tick({ name: 'browser', path: 'D:/browser.exe', idleMs: 0 })
      locked = false
      await service.stop()
      assert.deepEqual(written, [{ name: 'editor', duration: 60 }, { name: 'browser', duration: 1 }])
    })
    await check('服務停止後，晚到的啟動失敗不再排重試', async () => {
      let finishStart
      let retries = 0
      const file = path.join(__dirname, '../src/main/screentime/index.js')
      const realRequire = createRequire(file)
      const context = { module: { exports: {} }, setTimeout: () => { retries++; return 1 },
        clearTimeout() {}, require: (id) => {
          if (id === './observer') return { createObserver: () => ({ start() {}, stop() {} }) }
          if (id === './webserver') return { createWebServer: () => ({
            start: () => new Promise((resolve) => { finishStart = resolve }), stop: async () => {}
          }) }
          if (id === './db') return { ensureImported: () => ({}), openDb: () => ({}),
            readAppConfig: () => ({}), destDir: () => '', closeDb() {} }
          return realRequire(id)
        } }
      vm.runInNewContext(fs.readFileSync(file, 'utf8'), context)
      const service = context.module.exports.createScreentimeService({ userDataPath: 'unused' })
      service.start()
      await service.stop()
      finishStart({ ok: false })
      await Promise.resolve()
      assert.equal(retries, 0)
    })
    await check('觀測器啟動失敗不崩潰，舊程序退出不影響新程序', () => {
      const children = []
      const observer = createObserver({ spawnFn: () => {
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {}
        })
        children.push(child)
        return child
      } })
      try {
        observer.start()
        assert.doesNotThrow(() => children[0].emit('error', new Error('ENOENT')))
        assert.equal(observer.running, false)
        observer.start()
        children[0].emit('exit', 1)
        assert.equal(observer.running, true)
        assert.doesNotThrow(() => children[1].stdin.emit('error', new Error('EPIPE')))
        assert.equal(observer.running, false)
      } finally { observer.stop() }
    })
    await check('port 0 由系統分配埠，連續啟動共用同一次等待', async () => {
      const web = createWebServer({ port: 0 })
      try {
        const first = web.start()
        const second = web.start()
        const results = await Promise.all([first, second])
        assert.equal(first, second)
        assert.equal(results[0].ok, true)
        assert.notEqual(results[0].port, 8908)
        assert.ok(results[0].port > 0)
      } finally { await web.stop() }
    })
    await check('啟動尚未完成便停止，不留下 listener', async () => {
      const probe = original()
      await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
      const port = probe.address().port
      await new Promise((resolve) => probe.close(resolve))
      const web = createWebServer({ port })
      const starting = web.start()
      await web.stop()
      await starting
      assert.equal(web.listening, false)
    })
    await check('啟動、停止、再啟動按呼叫順序完成', async () => {
      const web = createWebServer({ port: 0 })
      try {
        const first = web.start()
        const stopping = web.stop()
        const next = web.start()
        await Promise.all([first, stopping, next])
        assert.equal(web.listening, true)
      } finally { await web.stop() }
    })
    await check('整個服務快速重啟後，網站 listener 仍會恢復', async () => {
      let web
      const file = path.join(__dirname, '../src/main/screentime/index.js')
      const realRequire = createRequire(file)
      const context = { module: { exports: {} }, console, setTimeout, clearTimeout, require: id => {
        if (id === './observer') return { createObserver: () => ({ start() {}, stop() {} }) }
        if (id === './webserver') return { createWebServer: options => (web = createWebServer(options)) }
        if (id === './db') return { ensureImported: () => ({}), openDb: () => ({}),
          readAppConfig: () => ({}), destDir: () => '', closeDb() {} }
        return realRequire(id)
      } }
      vm.runInNewContext(fs.readFileSync(file, 'utf8'), context)
      const service = context.module.exports.createScreentimeService({ userDataPath: 'unused', port: 0 })
      try {
        service.start()
        await web.start()
        const stopping = service.stop()
        service.start()
        await stopping
        await new Promise(resolve => setTimeout(resolve, 30))
        assert.equal(web.listening, true)
      } finally { await service.stop() }
    })
  } finally {
    http.createServer = original
    for (const server of servers) {
      if (server.listening) await new Promise((resolve) => server.close(resolve))
    }
  }
  process.exitCode = failed ? 1 : 0
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
