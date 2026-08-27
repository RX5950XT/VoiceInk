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
  `${source}\n;globalThis.__exports = { moveProvider, mergeVisibleOrder, capturePositions, animateFlip, pickCollision, slotShift };`,
  sandbox
)
const { moveProvider, mergeVisibleOrder, capturePositions, animateFlip, pickCollision, slotShift } = sandbox.__exports

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

function fakeElement(provider, rect, calls, animations = []) {
  return {
    dataset: { provider },
    getBoundingClientRect: () => ({ ...rect }),
    getAnimations: () => animations,
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

console.log('\n[D] FLIP interrupt')
check('新 FLIP 量 last 前先取消進行中的動畫', () => {
  const calls = []
  let cancelled = false
  const running = [{ cancel() { cancelled = true } }]
  const element = {
    dataset: { provider: 'a' },
    getBoundingClientRect() {
      return cancelled ? { left: 200, top: 0 } : { left: 150, top: 0 }
    },
    getAnimations: () => running,
    animate(frames, options) {
      calls.push({ frames, options })
      return { frames, options }
    }
  }
  animateFlip([element], new Map([['a', { left: 0, top: 0 }]]), false)
  assert.equal(cancelled, true)
  assert.equal(calls[0].frames[0].transform, 'translate3d(-200px, 0px, 0)')
  assert.equal(calls[0].options.fill, 'none')
})

console.log(`\n${failed ? 'FAILED' : 'ALL PASS'}  ${passed} passed, ${failed} failed\n`)
if (failed) process.exitCode = 1
