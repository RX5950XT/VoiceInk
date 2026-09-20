'use strict'

/**
 * 殼層 sidecar 的實測（唯讀，不叫用任何命令）。
 *
 * 問三件事：
 *   [A] 選檔案時 `IContextMenu` 到底吐出哪些項目（7-Zip／WinRAR／傳送到／內容在不在）
 *   [B] 空白處的背景選單有沒有東西
 *   [C] Google Drive 路徑的 overlay 槽位，以及那個槽位畫出來長什麼樣
 *
 * 用法：node scripts/probe-explorer-shell.js [要測的資料夾]
 * 預設拿專案根目錄。想驗綠勾請給 Google Drive 底下的路徑。
 */

const path = require('path')
const fs = require('fs')
const { startShell } = require('../src/main/explorer/shell-host')

const ROOT = path.join(__dirname, '..')

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
    process.exit(1)
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

  shell.stop()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
