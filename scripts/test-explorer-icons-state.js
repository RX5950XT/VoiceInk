'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.resolve(__dirname, '..')
const SOURCE = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/explorer-icons.js'), 'utf8')
  .replace(/^export /gm, '')
const PNG = 'data:image/png;base64,AAA'

function flush() {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve())
}

function loadIcons(fileIcon) {
  const timers = []
  const observers = []
  let nextTimer = 1
  const context = {
    console,
    Map,
    Set,
    WeakSet,
    Math,
    setTimeout(fn, ms) {
      const item = { id: nextTimer++, fn, ms }
      timers.push(item)
      return item.id
    },
    clearTimeout(id) {
      const index = timers.findIndex((item) => item.id === id)
      if (index >= 0) timers.splice(index, 1)
    },
    IntersectionObserver: class {
      constructor(callback) {
        this.callback = callback
        this.disconnected = false
        observers.push(this)
      }

      observe(el) {
        this.callback([{ isIntersecting: true, target: el }])
      }

      unobserve() {}

      disconnect() {
        this.disconnected = true
      }
    },
    document: {
      createElement() {
        return { src: '', alt: '', draggable: false }
      }
    },
    window: { electronAPI: { explorer: { fileIcon } } }
  }
  vm.createContext(context)
  vm.runInContext(SOURCE, context)
  return { context, timers, observers }
}

function element(filePath) {
  return {
    dataset: { path: filePath },
    isConnected: true,
    textContent: '',
    replaceChildren(node) { this.child = node }
  }
}

function host(grid, elements) {
  return {
    classList: { contains: (name) => grid && name === 'is-grid' },
    querySelectorAll: () => elements,
    isConnected: true
  }
}

async function testCooldownCancelsPendingWork() {
  let resolve
  const el = element('C:\\pending.pdf')
  const env = loadIcons(() => new Promise((done) => { resolve = done }))
  env.context.paintFileIcons(host(true, [el]), () => Promise.resolve({ ok: false }))
  assert.equal(env.timers.length, 0)
  assert.equal(typeof env.context.clearFileIconWork, 'function')

  env.context.clearFileIconWork()
  assert.equal(env.timers.length, 0)
  assert.equal(env.observers[0].disconnected, true)
  resolve({ ok: true, data: { url: PNG, pending: true } })
  await flush()
  assert.equal(env.timers.length, 0)
  assert.equal(el.child, undefined)
}

async function testStaleFinallyUsesCurrentQueueContext() {
  const oldRequests = []
  const first = [1, 2, 3, 4].map((n) => element(`C:\\old-${n}.pdf`))
  const next = element('C:\\new.pdf')
  let readOld = 0
  let readNew = 0
  const env = loadIcons((filePath) => new Promise((resolve) => {
    oldRequests.push({ filePath, resolve })
  }))

  env.context.paintFileIcons(host(true, first), () => {
    readOld += 1
    return Promise.resolve({ ok: true, data: { url: 'old-read' } })
  })
  assert.equal(oldRequests.length, 4)

  env.context.paintFileIcons(host(false, [next]), () => {
    readNew += 1
    return Promise.resolve({ ok: true, data: { url: 'new-read' } })
  })
  assert.equal(readNew, 0)

  oldRequests[0].resolve({ ok: true, data: { url: PNG } })
  await flush()
  assert.equal(oldRequests.length, 4)
  assert.equal(readOld, 0)
  assert.equal(readNew, 1)
}

Promise.resolve()
  .then(testCooldownCancelsPendingWork)
  .then(testStaleFinallyUsesCurrentQueueContext)
  .then(() => console.log('2 passed, 0 failed'))
  .catch((error) => {
    console.error(error.stack || error)
    process.exitCode = 1
  })
