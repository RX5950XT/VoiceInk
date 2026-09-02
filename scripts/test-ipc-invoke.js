'use strict'

/**
 * 八組模組 ipc.js 共用的 `makeInvoke` 外殼。
 *
 * 這一層唯一的工作是「擋非主視窗」與「收斂錯誤訊息」，兩件都是信任邊界，
 * 抽成共用之後更要有東西守著——尤其是「不准把 `error.message` 原樣送出去」。
 *
 * 執行：node scripts/test-ipc-invoke.js
 */

const assert = require('node:assert')
const { makeInvoke } = require('../src/main/ipc-invoke')

let passed = 0
function ok(name, cond, extra) {
  assert.ok(cond, `${name}${extra ? ` — ${extra}` : ''}`)
  passed += 1
}

const MAIN = { sender: 'main' }
const OTHER = { sender: 'other' }
const isMainSender = (event) => event === MAIN

async function main() {
  const invoke = makeInvoke({
    isMainSender,
    forbidden: '僅主視窗可操作測試',
    code: 'TEST_ERROR',
    message: '測試操作失敗'
  })

  // [A] 非主視窗一律擋掉，而且不執行 action
  let ran = false
  const denied = await invoke(OTHER, () => { ran = true; return 1 })
  ok('非主視窗被擋下', denied.ok === false && denied.error.code === 'FORBIDDEN')
  ok('被擋下時 action 不執行', ran === false)
  ok('擋下訊息用呼叫端給的字串', denied.error.message === '僅主視窗可操作測試')

  // [B] 正常路徑包成 { ok, data }
  const okRes = await invoke(MAIN, async () => ({ n: 42 }))
  ok('成功回 { ok, data }', okRes.ok === true && okRes.data.n === 42)

  // [C] 外部錯誤訊息不得外洩：只有 userMessage 是白名單
  const leaky = Object.assign(new Error("ENOENT: open 'D:\\\\Users\\\\me\\\\secret.json'"), { code: 'ENOENT' })
  const hidden = await invoke(MAIN, () => { throw leaky })
  ok('保留錯誤代碼', hidden.error.code === 'ENOENT')
  ok('不透傳 error.message', !/secret\.json/.test(hidden.error.message), hidden.error.message)
  ok('退回通用訊息', hidden.error.message === '測試操作失敗')

  const whitelisted = Object.assign(new Error('內部細節'), { code: 'BAD_INPUT', userMessage: '請先填模型' })
  const shown = await invoke(MAIN, () => { throw whitelisted })
  ok('userMessage 原樣送出', shown.error.message === '請先填模型')

  // [D] 沒有 code 的錯誤退回預設代碼
  const plain = await invoke(MAIN, () => { throw new Error('x') })
  ok('無 code 時用預設代碼', plain.error.code === 'TEST_ERROR')

  // [E] publicError 完全接管收斂（usage／hfmodels 各有一套）
  const custom = makeInvoke({
    isMainSender,
    forbidden: 'nope',
    publicError: (error) => ({ code: error?.code || 'X', message: error?.message || 'y' })
  })
  const viaCustom = await custom(MAIN, () => { throw Object.assign(new Error('自己寫的訊息'), { code: 'MINE' }) })
  ok('publicError 接管', viaCustom.error.code === 'MINE' && viaCustom.error.message === '自己寫的訊息')
  const customDenied = await custom(OTHER, () => 1)
  ok('publicError 不影響 FORBIDDEN', customDenied.error.code === 'FORBIDDEN' && customDenied.error.message === 'nope')

  console.log(`ALL PASS — ${passed} passed, 0 failed`)
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
