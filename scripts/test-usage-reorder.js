const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const modulePath = path.join(
  __dirname,
  '..',
  'src',
  'renderer',
  'scripts',
  'usage-reorder.js'
)
const source = fs.readFileSync(modulePath, 'utf8').replace(/^export /gm, '')
const sandbox = {}
vm.createContext(sandbox)
vm.runInContext(
  `${source}\n;globalThis.__exports = { moveProvider, mergeVisibleOrder, pickCollision, slotShift };`,
  sandbox
)
const { moveProvider, mergeVisibleOrder, pickCollision, slotShift } = sandbox.__exports

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL  ${name}\n        ${error.message}`)
  }
}

console.log('\n[A] immutable reorder')
check('第一張移到最後', () => {
  assert.equal(
    JSON.stringify(moveProvider(['a', 'b', 'c'], 'a', 2)),
    JSON.stringify(['b', 'c', 'a'])
  )
})
check('中間張移到最前', () => {
  assert.equal(
    JSON.stringify(moveProvider(['a', 'b', 'c'], 'b', 0)),
    JSON.stringify(['b', 'a', 'c'])
  )
})
check('未知 provider 不改內容且回傳新陣列', () => {
  const order = ['a', 'b', 'c']
  const next = moveProvider(order, 'x', 1)
  assert.equal(JSON.stringify(next), JSON.stringify(order))
  assert.notStrictEqual(next, order)
})
check('target index 會 clamp', () => {
  assert.equal(
    JSON.stringify(moveProvider(['a', 'b', 'c'], 'c', -9)),
    JSON.stringify(['c', 'a', 'b'])
  )
})
check('隱藏 provider 保持原槽位，只替換可見順序', () => {
  assert.equal(
    JSON.stringify(mergeVisibleOrder(
      ['a', 'hidden', 'b', 'c'],
      ['b', 'a', 'c']
    )),
    JSON.stringify(['b', 'hidden', 'a', 'c'])
  )
})

console.log('\n[C] collision (pointerWithin then closestCenter)')
check('游標在卡片內就選那張', () => {
  const items = [
    { id: 'a', left: 0, top: 0, width: 100, height: 100 },
    { id: 'b', left: 120, top: 0, width: 100, height: 100 }
  ]
  assert.equal(pickCollision({ x: 150, y: 40 }, items), 'b')
})
check('空隙裡選最近中心，不必進到卡片裡', () => {
  const items = [
    { id: 'a', left: 0, top: 0, width: 100, height: 80 },
    { id: 'b', left: 0, top: 200, width: 100, height: 80 }
  ]
  assert.equal(pickCollision({ x: 50, y: 170 }, items), 'b')
})
check('空清單回 null', () => {
  assert.equal(pickCollision({ x: 0, y: 0 }, []), null)
})
check('slotShift 只算位移、不改原座標', () => {
  const home = { left: 10, top: 20 }
  const slot = { left: 110, top: 60 }
  assert.equal(JSON.stringify(slotShift(home, slot)), JSON.stringify({ dx: 100, dy: 40 }))
  assert.equal(home.left, 10)
})
check('缺槽位時位移為 0', () => {
  assert.equal(JSON.stringify(slotShift(null, { left: 1, top: 1 })), JSON.stringify({ dx: 0, dy: 0 }))
})

console.log(`\n${failed ? 'FAILED' : 'ALL PASS'}  ${passed} passed, ${failed} failed\n`)
if (failed) process.exitCode = 1
