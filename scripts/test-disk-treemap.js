'use strict'
/**
 * 磁碟空間 treemap 純函式。
 * 用法：node scripts/test-disk-treemap.js
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

function intersects(a, b) {
  const x = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const y = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return x > 0 && y > 0 ? x * y : 0
}

function assertLayout(items, rect, label) {
  const live = items.filter((item) => item.w > 0 && item.h > 0)
  const total = items.reduce((s, item) => s + Math.max(0, item.value), 0)
  const rectArea = rect.w * rect.h
  let sum = 0
  for (const item of live) {
    sum += item.w * item.h
    assert.ok(item.x >= rect.x - 0.05, `${label} x 在矩形內`)
    assert.ok(item.y >= rect.y - 0.05, `${label} y 在矩形內`)
    assert.ok(item.x + item.w <= rect.x + rect.w + 0.05, `${label} 右緣在矩形內`)
    assert.ok(item.y + item.h <= rect.y + rect.h + 0.05, `${label} 下緣在矩形內`)
    if (total > 0) {
      const ratio = (item.w * item.h) / rectArea
      const expect = item.value / total
      assert.ok(Math.abs(ratio - expect) < 0.02, `${label} 面積比 ${item.value}: ${ratio.toFixed(4)} vs ${expect.toFixed(4)}`)
    }
  }
  assert.ok(Math.abs(sum - rectArea) / rectArea < 0.02, `${label} 面積和 ${sum} vs ${rectArea}`)
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      assert.ok(intersects(live[i], live[j]) < 0.05, `${label} 重疊`)
    }
  }
}

function contrast(hex, other) {
  const lum = (h) => {
    const n = parseInt(h.slice(1), 16)
    const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    const ch = (shift) => lin(((n >> shift) & 255) / 255)
    return 0.2126 * ch(16) + 0.7152 * ch(8) + 0.0722 * ch(0)
  }
  const a = lum(hex)
  const b = lum(other)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

async function main() {
  const url = pathToFileURL(path.join(__dirname, '../src/renderer/scripts/disk-treemap.js')).href
  const api = await import(url)
  const { squarify, categorize, isReclaimable, formatBytes, layoutTree, removePath, fullPath } = api
  let failed = 0
  const check = (name, fn) => {
    try { fn(); console.log(`PASS ${name}`) }
    catch (error) { failed += 1; console.error(`FAIL ${name}: ${error.message}`) }
  }

  check('單一塊填滿', () => {
    const rect = { x: 2, y: 3, w: 100, h: 40 }
    const [one] = squarify([{ id: 'a', value: 5 }], rect)
    assert.equal(one.id, 'a')
    assertLayout([{ ...one, value: 5 }], rect, 'single')
  })

  check('面積守恆、不重疊、都在矩形內', () => {
    const rect = { x: 0, y: 0, w: 600, h: 400 }
    const values = [6, 6, 4, 3, 2, 2, 1]
    const laid = squarify(values.map((value, i) => ({ id: i, value })), rect)
    assert.equal(laid.length, values.length)
    assertLayout(laid.map((item, i) => ({ ...item, value: values[i] })), rect, 'classic')
    const aspects = laid.map((item) => Math.max(item.w / item.h, item.h / item.w))
    assert.ok(Math.max(...aspects) < 6, `長寬比過差 ${Math.max(...aspects)}`)
  })

  check('零值不佔面積', () => {
    const rect = { x: 0, y: 0, w: 200, h: 100 }
    const laid = squarify([{ value: 0 }, { value: 3 }, { value: 1 }], rect)
    assert.equal(laid[0].w, 0)
    assert.equal(laid[0].h, 0)
    assertLayout(laid.map((item) => ({ ...item, value: item.value })), rect, 'zeros')
  })

  check('空矩形', () => {
    const laid = squarify([{ value: 4 }], { x: 1, y: 1, w: 0, h: 10 })
    assert.equal(laid[0].w, 0)
    assert.equal(laid[0].h, 0)
  })

  check('categorize', () => {
    assert.equal(categorize({ n: 'app.js', k: 'f' }), 'code')
    assert.equal(categorize({ n: 'Clip.MP4', k: 'f' }), 'video')
    assert.equal(categorize({ n: 'a.png', k: 'f' }), 'image')
    assert.equal(categorize({ n: 'a.mp3', k: 'f' }), 'audio')
    assert.equal(categorize({ n: 'a.pdf', k: 'f' }), 'doc')
    assert.equal(categorize({ n: 'a.zip', k: 'f' }), 'archive')
    assert.equal(categorize({ n: 'a.exe', k: 'f' }), 'bin')
    assert.equal(categorize({ n: 'a.xyz', k: 'f' }), 'other')
    assert.equal(categorize({ n: 'node_modules', k: 'd' }), 'cache')
    assert.equal(categorize({ n: 'src', k: 'd' }), 'dir')
    assert.equal(categorize({ n: '（其他 3 項）', k: 'o' }), 'other')
  })

  check('isReclaimable', () => {
    assert.equal(isReclaimable('node_modules'), true)
    assert.equal(isReclaimable('Node_Modules'), true)
    assert.equal(isReclaimable('Temp'), true)
    assert.equal(isReclaimable('.cache'), true)
    assert.equal(isReclaimable('Cache'), true)
    assert.equal(isReclaimable('__pycache__'), true)
    assert.equal(isReclaimable('.gradle'), true)
    assert.equal(isReclaimable('.npm'), true)
    assert.equal(isReclaimable('target'), true)
    assert.equal(isReclaimable('src'), false)
    assert.equal(isReclaimable('my-node_modules'), false)
  })

  check('formatBytes', () => {
    assert.equal(formatBytes(0), '0 B')
    assert.equal(formatBytes(500), '500 B')
    assert.equal(formatBytes(1536), '1.5 KB')
    assert.equal(formatBytes(1048576), '1.0 MB')
  })

  check('子塊落在父塊裡', () => {
    const tree = {
      n: 'D:\\work', s: 100, f: 3, k: 'd',
      c: [
        { n: 'a', s: 60, f: 2, k: 'd', c: [
          { n: 'a1.txt', s: 40, f: 1, k: 'f' },
          { n: 'a2.txt', s: 20, f: 1, k: 'f' }
        ] },
        { n: 'b.bin', s: 40, f: 1, k: 'f' }
      ]
    }
    const cells = layoutTree(tree, { x: 0, y: 0, w: 400, h: 300 }, (node) => node.s)
    const a = cells.find((cell) => cell.node.n === 'a')
    const a1 = cells.find((cell) => cell.node.n === 'a1.txt')
    assert.ok(a && a1)
    assert.ok(a1.x >= a.x - 0.05 && a1.y >= a.y - 0.05)
    assert.ok(a1.x + a1.w <= a.x + a.w + 0.05)
    assert.ok(a1.y + a1.h <= a.y + a.h + 0.05)
    assert.equal(fullPath(a1.chain), 'D:\\work\\a\\a1.txt')
  })

  check('removePath 扣掉祖先', () => {
    const tree = {
      n: 'D:\\work', s: 100, f: 3, k: 'd',
      c: [
        { n: 'a', s: 60, f: 2, k: 'd', c: [{ n: 'a1.txt', s: 60, f: 1, k: 'f' }] },
        { n: 'b.bin', s: 40, f: 1, k: 'f' }
      ]
    }
    const gone = removePath(tree, 'D:\\work\\a\\a1.txt')
    assert.equal(gone.n, 'a1.txt')
    assert.equal(tree.c[0].c.length, 0)
    assert.equal(tree.c[0].s, 0)
    assert.equal(tree.s, 40)
    assert.equal(tree.f, 2)
    assert.equal(tree.c[1].s, 40)
    assert.equal(removePath(tree, 'D:\\work'), null)
  })

  check('類別色對比', () => {
    const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles/themes.css'), 'utf8')
    const dark = css.slice(0, css.indexOf('[data-theme="light"]'))
    const light = css.slice(css.indexOf('[data-theme="light"]'))
    for (const [name, block] of [['dark', dark], ['light', light]]) {
      const vars = {}
      for (const match of block.matchAll(/--disk-([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) vars[match[1]] = match[2]
      assert.ok(vars.ink && vars.paper, `${name} 缺字色`)
      for (const key of ['code', 'cache', 'video', 'image', 'audio', 'doc', 'archive', 'bin', 'other', 'dir']) {
        const best = Math.max(contrast(vars[key], vars.ink), contrast(vars[key], vars.paper))
        assert.ok(best >= 4.5, `${name} ${key} 對比 ${best.toFixed(2)}`)
      }
    }
  })

  process.exitCode = failed ? 1 : 0
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
