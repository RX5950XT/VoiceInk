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
  `${source}\n;globalThis.__exports = { moveProvider, mergeVisibleOrder, capturePositions, animateFlip };`,
  sandbox
)
const { moveProvider, mergeVisibleOrder, capturePositions, animateFlip } = sandbox.__exports

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

function fakeElement(provider, rect, calls) {
  return {
    dataset: { provider },
    getBoundingClientRect: () => ({ ...rect }),
    animate(frames, options) {
      const animation = { provider, frames, options }
      calls.push(animation)
      return animation
    }
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

console.log('\n[B] FLIP layout animation')
check('記錄 provider 對應位置', () => {
  const elements = [
    fakeElement('a', { left: 10, top: 20 }, []),
    fakeElement('b', { left: 30, top: 40 }, [])
  ]
  const positions = capturePositions(elements)
  assert.equal(positions.get('a').left, 10)
  assert.equal(positions.get('b').top, 40)
})
check('只以 transform 執行 110ms FLIP', () => {
  const calls = []
  const elements = [
    fakeElement('a', { left: 100, top: 0 }, calls),
    fakeElement('b', { left: 0, top: 0 }, calls)
  ]
  const before = new Map([
    ['a', { left: 0, top: 0 }],
    ['b', { left: 100, top: 0 }]
  ])
  const animations = animateFlip(elements, before, false)
  assert.equal(animations.length, 2)
  assert.equal(
    JSON.stringify(calls[0].frames[0]),
    JSON.stringify({ transform: 'translate3d(-100px, 0px, 0)' })
  )
  assert.equal(
    JSON.stringify(calls[0].frames[1]),
    JSON.stringify({ transform: 'translate3d(0, 0, 0)' })
  )
  assert.equal(calls[0].options.duration, 110)
  assert.equal(calls[0].options.easing, 'cubic-bezier(0.22, 1, 0.36, 1)')
})
check('相同位置不建立動畫', () => {
  const calls = []
  const elements = [fakeElement('a', { left: 0, top: 0 }, calls)]
  assert.equal(animateFlip(elements, new Map([['a', { left: 0, top: 0 }]]), false).length, 0)
  assert.equal(calls.length, 0)
})
check('reduced motion 不建立位移動畫', () => {
  const calls = []
  const elements = [fakeElement('a', { left: 100, top: 0 }, calls)]
  assert.equal(animateFlip(elements, new Map([['a', { left: 0, top: 0 }]]), true).length, 0)
  assert.equal(calls.length, 0)
})

console.log(`\n${failed ? 'FAILED' : 'ALL PASS'}  ${passed} passed, ${failed} failed\n`)
if (failed) process.exitCode = 1
