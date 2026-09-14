'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { tempDir, removeTree } = require('./lib/test-temp')
const { spawn, execFileSync } = require('node:child_process')
const bridge = require('../src/main/terminal/editor-bridge')

async function main() {
  const root = tempDir('voiceink-editor-failure-')
  const failures = []
  const children = []
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  function launch(target) {
    const child = spawn(`${bridge.shimCommand()} "${target}"`, { shell: true, windowsHide: true, stdio: 'ignore' })
    children.push(child)
    return child
  }
  async function waitFor(check) {
    for (let i = 0; i < 40; i++) { if (check()) return true; await sleep(100) }
    return false
  }
  try {
    bridge.configure(root)
    bridge.shimCommand()
    const missing = launch(path.join(root, 'missing.txt'))
    const ended = await waitFor(() => missing.exitCode !== null)
    try {
      assert.ok(ended, '來源不存在時必須退出，不能讓 CLI 永遠等待')
      assert.notEqual(missing.exitCode, 0, '讀檔失敗不能回報成功')
    } catch (error) { failures.push(error) }

    const targetDir = path.join(root, 'target')
    fs.mkdirSync(targetDir)
    const target = path.join(targetDir, 'prompt.txt')
    fs.writeFileSync(target, 'original')
    let request
    bridge.start((_, payload) => { request = payload })
    const writing = launch(target)
    assert.ok(await waitFor(() => request), '應收到編輯請求')
    bridge.save(request.id, 'saved edit')
    fs.renameSync(targetDir, path.join(root, 'moved'))
    bridge.cancel(request.id)
    assert.ok(await waitFor(() => writing.exitCode !== null), '寫回失敗應退出')
    try {
      assert.notEqual(writing.exitCode, 0, '寫回失敗不能回報成功')
      assert.equal(fs.readFileSync(path.join(root, 'editor-bridge/requests', `${request.id}.out`), 'utf8'), 'saved edit', '寫回失敗要保留編輯內容')
    } catch (error) { failures.push(error) }
    assert.equal(fs.readFileSync(path.join(root, 'moved/prompt.txt'), 'utf8'), 'original')
  } finally {
    bridge.stop()
    for (const child of children) {
      if (child.exitCode !== null) continue
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* 已退出 */ }
    }
    removeTree(root)
  }
  assert.equal(failures.length, 0, failures.map(error => error.message).join('\n'))
  console.log('PASS 編輯器讀取失敗不死等、寫回失敗回報錯誤並保留內容')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
