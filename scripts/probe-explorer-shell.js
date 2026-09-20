'use strict'

/**
 * 殼層 sidecar 的實測（唯讀，不叫用任何命令）。
 *
 * 問四件事：
 *   [A] 選檔案時 `IContextMenu` 到底吐出哪些項目（7-Zip／WinRAR／傳送到／內容在不在）
 *   [B] 空白處的背景選單有沒有東西
 *   [C] Google Drive 路徑的 overlay 槽位，以及那個槽位畫出來長什麼樣
 *   [D] 對一張真 PNG 取縮圖：有 base64、尺寸接近要求、且跟類型圖示不是同一張
 *
 * 用法：npx electron scripts/probe-explorer-shell.js [要測的資料夾]
 * 預設拿專案根目錄。想驗綠勾請給 Google Drive 底下的路徑。
 */

const path = require('path')
const fs = require('fs')
const zlib = require('zlib')
const { startShell } = require('../src/main/explorer/shell-host')
const { tempDir } = require('./lib/test-temp')

const ROOT = path.join(__dirname, '..')
const THUMB_SIZE = 96
let passed = 0
let failed = 0

function ok(name, cond, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  PASS ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]
    for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const payload = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(payload))
  return Buffer.concat([len, payload, crc])
}

/** 純色 PNG（RGB），給 IShellItemImageFactory 當「真的有畫面的檔」。 */
function solidPng(width, height, r, g, b) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 3
      raw[i] = r
      raw[i + 1] = g
      raw[i + 2] = b
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function pick(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const file = entries.find((e) => e.isFile())
  const folder = entries.find((e) => e.isDirectory())
  return {
    file: file ? path.join(dir, file.name) : '',
    folder: folder ? path.join(dir, folder.name) : ''
  }
}

function flatten(items, depth = 0, out = []) {
  for (const item of items || []) {
    if (item.sep) {
      out.push(`${'  '.repeat(depth)}────`)
      continue
    }
    const marks = [item.icon ? '圖' : '  ', item.disabled ? '停用' : '', item.verb ? `verb=${item.verb}` : '']
    out.push(`${'  '.repeat(depth)}${item.label}  ${marks.filter(Boolean).join(' ')}`)
    if (item.children) flatten(item.children, depth + 1, out)
  }
  return out
}

async function main() {
  const dir = process.argv[2] || ROOT
  const shell = await startShell()
  if (!shell.ok) {
    console.error('sidecar 起不來：', shell.error, '（先跑 npm run build:shell）')
    return 1
  }
  const target = pick(dir)
  console.log('資料夾：', dir)

  for (const [label, p] of [['檔案', target.file], ['資料夾', target.folder]]) {
    if (!p) continue
    console.log(`\n=== [A] ${label} 的殼層選單：${path.basename(p)} ===`)
    const menu = await shell.send({ op: 'menu', paths: [p] })
    if (!menu.ok) console.log('  失敗：', menu.error)
    else {
      console.log(flatten(menu.data.items).join('\n'))
      await shell.send({ op: 'release', token: menu.data.token })
    }
  }

  console.log('\n=== [B] 背景選單 ===')
  const bg = await shell.send({ op: 'menu', paths: [], dir })
  if (!bg.ok) console.log('  失敗：', bg.error)
  else {
    console.log(flatten(bg.data.items).join('\n'))
    await shell.send({ op: 'release', token: bg.data.token })
  }

  console.log('\n=== [C] overlay（槽位 + 殼層疊好的圖示）===')
  const probePaths = [dir, target.file, target.folder].filter(Boolean)
  const slots = await shell.send({ op: 'overlay', paths: probePaths })
  if (!slots.ok) console.log('  失敗：', slots.error)
  else {
    for (let i = 0; i < probePaths.length; i++) {
      const p = probePaths[i]
      const slot = slots.data.slots[i]
      const icon = await shell.send({ op: 'icon', path: p })
      const img = icon.ok ? icon.data.icon : null
      if (!img) {
        console.log(`  槽 ${slot}  無圖  ${p}`)
        continue
      }
      const bytes = Buffer.from(img.bgra, 'base64')
      let opaque = 0
      let green = 0
      let sample = ''
      for (let b = 0; b < bytes.length; b += 4) {
        const a = bytes[b + 3]
        if (a <= 16) continue
        opaque++
        const r = bytes[b + 2]
        const g = bytes[b + 1]
        const bl = bytes[b]
        if (!sample) sample = `${r},${g},${bl}`
        if (g > r + 20 && g > bl + 20 && g > 80) green++
      }
      console.log(`  槽 ${slot}  ${img.w}×${img.h} 不透明 ${opaque} 綠 ${green} 首色 rgb(${sample})  ${p}`)
    }
  }

  console.log('\n=== [D] 縮圖（IShellItemImageFactory，不是類型圖示）===')
  {
    const dirPath = tempDir('shell-thumb')
    const pngPath = path.join(dirPath, 'solid-magenta.png')
    fs.writeFileSync(pngPath, solidPng(256, 256, 255, 0, 128))
    const thumb = await shell.send({ op: 'thumb', path: pngPath, size: THUMB_SIZE })
    const icon = await shell.send({ op: 'icon', path: pngPath })
    const thumbImg = thumb.ok ? thumb.data && thumb.data.thumb : null
    const iconImg = icon.ok ? icon.data && icon.data.icon : null
    ok('縮圖回得到 base64', Boolean(thumbImg && typeof thumbImg.bgra === 'string' && thumbImg.bgra.length > 32),
      thumb.ok ? `w=${thumbImg && thumbImg.w}` : String(thumb.error || 'no data'))
    const close = thumbImg
      && Math.abs(thumbImg.w - THUMB_SIZE) <= 32
      && Math.abs(thumbImg.h - THUMB_SIZE) <= 32
    ok(`縮圖尺寸接近 ${THUMB_SIZE}`, Boolean(close),
      thumbImg ? `${thumbImg.w}×${thumbImg.h}` : '無圖')
    ok('縮圖不是類型圖示', Boolean(thumbImg && iconImg && thumbImg.bgra !== iconImg.bgra),
      !thumbImg ? '沒有縮圖' : !iconImg ? '沒有類型圖示' : '兩張 base64 相同')
  }

  shell.stop()
  console.log(`\n${passed} passed, ${failed} failed`)
  return failed === 0 ? 0 : 1
}

function finish(code) {
  if (process.versions.electron) {
    require('electron').app.exit(code)
  } else {
    process.exit(code)
  }
}

function boot() {
  main().then(finish).catch((error) => {
    console.error(error)
    finish(1)
  })
}

if (process.versions.electron) {
  const { app } = require('electron')
  app.setPath('userData', tempDir('shell-probe-ud'))
  app.whenReady().then(boot)
} else {
  boot()
}
