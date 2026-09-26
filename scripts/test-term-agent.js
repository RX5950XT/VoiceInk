'use strict'
/**
 * 終端機畫面判斷：Claude 的進行中／等人／回到輸入框，以及跟宿主狀態怎麼合併。
 * 用法：node scripts/test-term-agent.js
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const FIXTURES = path.join(__dirname, 'fixtures', 'term-agent')

function linesOf(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8').split(/\r?\n/)
}

async function main() {
  const agent = await import(pathToFileURL(path.join(__dirname, '../src/renderer/scripts/term-agent.js')).href)
  const status = await import(pathToFileURL(path.join(__dirname, '../src/renderer/scripts/ws-terminal-status.js')).href)
  const icons = await import(pathToFileURL(path.join(__dirname, '../src/renderer/scripts/ws-tool-icons.js')).href)
  const { detectScreen, mergeState, viewportLines } = agent
  let failed = 0
  const check = (name, fn) => {
    try {
      fn()
      console.log(`PASS ${name}`)
    } catch (error) {
      failed += 1
      console.error(`FAIL ${name}: ${error.message}`)
    }
  }

  check('剛啟動的空輸入框是 idle', () => {
    assert.equal(detectScreen(linesOf('startup.txt')), 'idle')
  })
  check('回合進行中是 working', () => {
    assert.equal(detectScreen(linesOf('working.txt')), 'working')
  })
  check('做完回到輸入框是 idle', () => {
    assert.equal(detectScreen(linesOf('idle.txt')), 'idle')
  })
  check('確認畫面是 waiting', () => {
    assert.equal(detectScreen(linesOf('waiting.txt')), 'waiting')
  })

  check('總結行 ✳ Baked for 加上 ❯ 是 idle', () => {
    assert.equal(detectScreen([
      '水循環講完了',
      '✳ Baked for 14m',
      '❯ '
    ]), 'idle')
  })
  check('只有轉圈符號、沒有現在分詞，不是 working', () => {
    assert.equal(detectScreen(['✳ Baked for 14m']), null)
  })
  check('一般 shell 畫面是 null', () => {
    assert.equal(detectScreen([
      'PS C:\\Users\\me>',
      'dir',
      'hello',
      'PS C:\\Users\\me>'
    ]), null)
  })
  check('esc to interrupt 在視窗上面不誤判', () => {
    const above = ['前面的對話提到 esc to interrupt 這幾個字']
    const filler = Array.from({ length: 8 }, (_, i) => `填充 ${i}`)
    assert.equal(detectScreen([...above, ...filler, '❯ ']), 'idle')
  })
  check('大小寫不分', () => {
    assert.equal(detectScreen(['ESC TO INTERRUPT']), 'working')
    assert.equal(detectScreen([
      'Do You Want To Proceed?',
      'Esc To Cancel'
    ]), 'waiting')
  })
  check('只有 esc to cancel、沒有確認句，不是 waiting', () => {
    assert.equal(detectScreen(['請看說明：esc to cancel']), null)
  })

  check('程序結束以宿主為準', () => {
    assert.equal(mergeState({ host: 'exited', hook: 'working', screen: 'waiting' }), 'exited')
    assert.equal(mergeState({ host: 'stopped', hook: 'idle', screen: 'working' }), 'stopped')
  })
  check('hook 優先，working 顯示成 running', () => {
    assert.equal(mergeState({ host: 'running', hook: 'working', screen: 'idle' }), 'running')
    assert.equal(mergeState({ host: 'running', hook: 'waiting', screen: 'working' }), 'waiting')
    assert.equal(mergeState({ host: 'idle', hook: 'idle', screen: 'working' }), 'idle')
  })
  check('沒有 hook 才看畫面', () => {
    assert.equal(mergeState({ host: 'idle', hook: null, screen: 'working' }), 'running')
    assert.equal(mergeState({ host: 'running', hook: null, screen: 'waiting' }), 'waiting')
    assert.equal(mergeState({ host: 'running', hook: null, screen: 'idle' }), 'idle')
  })
  check('兩邊都沒有就用宿主', () => {
    assert.equal(mergeState({ host: 'running', hook: null, screen: null }), 'running')
    assert.equal(mergeState({ host: 'idle', hook: null, screen: null }), 'idle')
  })

  check('viewport 從 baseY 取、折行接回去', () => {
    const buffer = {
      baseY: 2,
      getLine(y) {
        const rows = {
          2: { isWrapped: false, translateToString: () => 'esc to' },
          3: { isWrapped: true, translateToString: () => ' interrupt' }
        }
        return rows[y]
      }
    }
    assert.deepEqual(viewportLines(buffer, 2), ['esc to interrupt'])
  })

  check('等人的文字與圖示', () => {
    assert.equal(status.terminalStatusLabel({ state: 'waiting' }), '等你回答')
    assert.equal(status.terminalStatusLabel({ state: 'running' }), '運行中')
    assert.equal(icons.stateIconName({ state: 'waiting' }), 'state-waiting')
  })

  console.log(`\n${failed ? failed + ' failed' : 'all passed'}`)
  process.exitCode = failed ? 1 : 0
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
