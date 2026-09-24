#!/usr/bin/env node
/**
 * VoiceInk — 終端機連結（網址／路徑）回歸測試（node 直跑，不需 electron）
 *
 * 三塊：畫面字串的掃描（`term-link-scan.js`）、主行程的路徑解析（`terminal/links.js`）、
 * 還有「三份清單」——service 匯出、`terminal:*` IPC、preload 白名單少一行，
 * renderer 只會拿到通用錯誤（CLAUDE.md 的地雷）。
 */

'use strict'

const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')
const os = require('os')
const fs = require('fs')
const { pathToFileURL } = require('url')

const ROOT = path.join(__dirname, '..')
const links = require(path.join(ROOT, 'src/main/terminal/links.js'))

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 折行用的假 buffer：每列一個 { text, isWrapped } */
function fakeBuffer(rows, cols) {
  return {
    getLine(i) {
      const row = rows[i]
      if (!row) return undefined
      return {
        isWrapped: !!row.isWrapped,
        length: cols,
        translateToString: (trim) => (trim ? row.text.replace(/\s+$/, '') : row.text.padEnd(cols, ' '))
      }
    }
  }
}

async function main() {
  const scan = await import(
    require('url').pathToFileURL(path.join(ROOT, 'src/renderer/scripts/term-link-scan.js')).href
  )

  // ===== 掃描：網址 =====
  console.log('\n[掃描：網址]')
  {
    const hits = scan.scanLine('Local:   http://localhost:5173/ ready')
    const url = hits.find((hit) => hit.url)
    ok('認得 http 網址', url?.url === 'http://localhost:5173/', JSON.stringify(hits))
    ok('位移對得回原字串', 'Local:   http://localhost:5173/ ready'.slice(url.start, url.end) === url.url)
    // 網址整段也符合「含斜線」的路徑樣式，重疊的候選必須丟掉，
    // 不然同一段字會產出兩個連結，點下去變成去查檔案系統。
    ok('網址不會同時被當成路徑', hits.filter((hit) => !hit.url).length === 0, JSON.stringify(hits))
  }
  {
    const hits = scan.scanLine('see (https://example.com/a/b), then')
    ok('剝掉尾巴的標點', hits[0]?.url === 'https://example.com/a/b', JSON.stringify(hits))
    ok('剝掉開頭的括號', hits[0]?.start === 'see ('.length)
  }
  {
    const line = '請看https://example.com/a/b即可'
    const hits = scan.scanLine(line)
    ok('網址不含前後中文', hits[0]?.url === 'https://example.com/a/b', JSON.stringify(hits))
    ok('網址位移不含前後中文', line.slice(hits[0].start, hits[0].end) === 'https://example.com/a/b')
  }
  {
    const hits = scan.scanLine('open file:///C:/Users/foo/a.txt now')
    ok('file:// 當成路徑不是網址', hits[0]?.url === '' && hits[0]?.text === 'C:/Users/foo/a.txt', JSON.stringify(hits))
  }
  {
    const hits = scan.scanLine('docs www.example.com/a/b ok')
    ok('www. 補成 https', hits[0]?.url === 'https://www.example.com/a/b', JSON.stringify(hits))
  }
  {
    const hits = scan.scanLine('Local: localhost:5173/app ready')
    ok('localhost:埠當成網址', hits[0]?.url === 'http://localhost:5173/app', JSON.stringify(hits))
  }

  // ===== 掃描：路徑 =====
  console.log('\n[掃描：路徑]')
  {
    const line = 'modified:   src/main/terminal/links.js'
    const hits = scan.scanLine(line)
    ok('git status 那行認得相對路徑', hits.length === 1 && hits[0].text === 'src/main/terminal/links.js', JSON.stringify(hits))
  }
  {
    const hits = scan.scanLine('  at src/renderer/app.js:120:8')
    ok('行號欄號不算路徑的一部分', hits[0]?.text === 'src/renderer/app.js', JSON.stringify(hits))
    ok('底線仍蓋住行號那段', hits[0]?.end === '  at src/renderer/app.js:120:8'.length)
    ok('行號留給開檔', hits[0]?.line === 120, JSON.stringify(hits[0]))
  }
  {
    const hits = scan.scanLine('D:\\Workspace\\VoiceInk\\package.json')
    ok('認得 Windows 絕對路徑', hits[0]?.text === 'D:\\Workspace\\VoiceInk\\package.json', JSON.stringify(hits))
  }
  {
    ok('沒有斜線就不是候選', scan.scanLine('npm run electron:pack').length === 0)
    ok('單純一條斜線不是候選', scan.scanLine('a / b').length === 0)
    ok('空行沒有候選', scan.scanLine('').length === 0)
  }
  {
    const line = '請看src/main/terminal/links.js即可'
    const hits = scan.scanLine(line)
    ok('路徑不含前後中文', hits[0]?.text === 'src/main/terminal/links.js', JSON.stringify(hits))
    ok('路徑位移不含前後中文', line.slice(hits[0].start, hits[0].end) === 'src/main/terminal/links.js')
  }
  {
    const hits = scan.scanLine('Read(src/main/terminal/links.js)')
    ok('函式呼叫括號裡只取路徑', hits[0]?.text === 'src/main/terminal/links.js', JSON.stringify(hits))
  }
  {
    const hits = scan.scanLine('cwd=src/main/terminal/links.js')
    ok('等號左邊不是路徑', hits[0]?.text === 'src/main/terminal/links.js', JSON.stringify(hits))
  }
  {
    const hits = scan.scanLine('error:C:\\Users\\foo\\bar.txt')
    ok('冒號後面的 Windows 路徑單獨取出', hits[0]?.text === 'C:\\Users\\foo\\bar.txt', JSON.stringify(hits))
  }
  {
    const hits = scan.scanLine('路徑：D:\\文件\\說明.txt')
    ok('全形冒號後面的中文路徑仍認得', hits[0]?.text === 'D:\\文件\\說明.txt', JSON.stringify(hits))
  }
  {
    const hits = scan.scanLine('see src/文件/foo.js here')
    ok('相對路徑中間的中文檔名留著', hits[0]?.text === 'src/文件/foo.js', JSON.stringify(hits))
  }

  // ===== 掃描：折行 =====
  console.log('\n[掃描：折行]')
  {
    const cols = 10
    const rows = [
      { text: 'prompt> ' },
      { text: 'see http:/' },
      { text: '/a.io/x', isWrapped: true }
    ]
    const info = scan.logicalLine(fakeBuffer(rows, cols), 3)
    ok('折行往回接到起點', info?.startY === 2, JSON.stringify(info))
    // 非最後一折要補滿到 cols，位移才換得回欄位；補不滿就會整段錯位。
    ok('前面每一折補滿 cols 格', info?.text.length === cols + '/a.io/x'.length, JSON.stringify(info))
    const hit = scan.scanLine(info.text).find((entry) => entry.url)
    ok('跨折行的網址接得起來', hit?.url === 'http://a.io/x', JSON.stringify(hit))
    ok('起點換回第 2 列第 5 欄', JSON.stringify(info.at(hit.start)) === JSON.stringify({ x: 5, y: 2 }))
    ok('終點落在第 3 列', info.at(hit.end - 1).y === 3)
  }
  {
    // CLI 自己印了換行（沒設 isWrapped），路徑在斜線處被切成兩段
    const rows = [
      { text: 'see src/main/terminal/' },
      { text: 'links.js here' }
    ]
    const info = scan.logicalLine(fakeBuffer(rows, 40), 1)
    const hit = scan.scanLine(info.text).find((entry) => entry.text.includes('links.js'))
    ok('硬換行的路徑接得起來', hit?.text === 'src/main/terminal/links.js', JSON.stringify({ text: info?.text, hit }))
  }
  {
    const rows = [
      { text: 'go http://localhost:5173/a/' },
      { text: 'very/long/path end' }
    ]
    const info = scan.logicalLine(fakeBuffer(rows, 40), 1)
    const hit = scan.scanLine(info.text).find((entry) => entry.url)
    ok('硬換行的網址接得起來', hit?.url === 'http://localhost:5173/a/very/long/path', JSON.stringify(hit))
  }
  {
    // 剛好填滿一列再從下一列繼續，CLI 送了換行所以 isWrapped 是 false
    const cols = 24
    const rows = [
      { text: 'http://example.com/abcde' },
      { text: 'f/file.js' }
    ]
    ok('第一列剛好填滿 cols', rows[0].text.length === cols)
    const info = scan.logicalLine(fakeBuffer(rows, cols), 1)
    const hit = scan.scanLine(info.text).find((entry) => entry.url)
    ok('滿列硬換行的網址接得起來', hit?.url === 'http://example.com/abcdef/file.js', JSON.stringify({ text: info?.text, hit }))
  }
  {
    // 「看」佔兩欄，「 src/a.js」從第 3 欄開始。若用字元位移 % cols，底線會畫到「看」上面。
    const rows = [{ text: '看 src/a.js' }]
    const line = {
      isWrapped: false,
      length: 12,
      getCell(x) {
        const cells = [
          { chars: '看', width: 2 }, { chars: '', width: 0 },
          { chars: ' ', width: 1 },
          { chars: 's', width: 1 }, { chars: 'r', width: 1 }, { chars: 'c', width: 1 },
          { chars: '/', width: 1 }, { chars: 'a', width: 1 }, { chars: '.', width: 1 },
          { chars: 'j', width: 1 }, { chars: 's', width: 1 }
        ]
        return cells[x]
      },
      translateToString: (trim) => (trim ? '看 src/a.js' : '看 src/a.js'.padEnd(12, ' '))
    }
    const buf = { getLine: (i) => (i === 0 ? line : undefined) }
    const info = scan.logicalLine(buf, 1)
    const hit = scan.scanLine(info.text).find((entry) => entry.text === 'src/a.js')
    ok('寬字元列掃得到路徑', hit?.text === 'src/a.js', JSON.stringify(hit))
    ok('寬字元後的路徑從第 4 欄起', JSON.stringify(info.at(hit.start)) === JSON.stringify({ x: 4, y: 1 }),
      JSON.stringify(info.at(hit.start)))
    ok('寬字元本身不是路徑的起點', info.at(0).x === 1 && info.at(hit.start).x !== 1)
  }

  // ===== 主行程：路徑解析 =====
  console.log('\n[主行程：路徑解析]')
  const base = tempDir('vi-links-')
  try {
    const dir = path.join(base, 'sub dir')
    fs.mkdirSync(dir)
    const file = path.join(dir, 'note.txt')
    fs.writeFileSync(file, 'x')

    ok('相對路徑以階段 cwd 為基準', (await links.resolveCandidate(base, 'sub dir/note.txt'))?.full === file)
    ok('資料夾回 dir', (await links.resolveCandidate(base, 'sub dir'))?.kind === 'dir')
    ok('檔案回 file', (await links.resolveCandidate(base, 'sub dir/note.txt'))?.kind === 'file')
    ok('絕對路徑不需要 cwd', (await links.resolveCandidate('', file))?.full === file)
    // 沒有基準就別拿 process.cwd() 頂替：那是 App 自己的目錄，跟畫面上看到的無關
    ok('相對路徑沒有 cwd 就回 null', (await links.resolveCandidate('', 'sub dir/note.txt')) === null)
    ok('不存在的路徑回 null', (await links.resolveCandidate(base, 'nope/none.txt')) === null)
    ok('含控制字元回 null', (await links.resolveCandidate(base, `sub dir${String.fromCharCode(0)}/note.txt`)) === null)
    ok('超長字串回 null', (await links.resolveCandidate(base, 'a'.repeat(600))) === null)
    ok('非字串回 null', (await links.resolveCandidate(base, { full: file })) === null)

    const projects = [
      { id: 'w_parent', path: base },
      { id: 'w_child', path: dir }
    ]
    const located = links.locateInProjects(file, projects, 'w_parent')
    ok('目前專案能對上就用目前的', located?.projectId === 'w_parent' && located?.relPath === 'sub dir/note.txt'.replace(/\//g, path.sep).split(path.sep).join('/'), JSON.stringify(located))
    const nested = links.locateInProjects(file, projects, '')
    ok('沒有目前專案時用最深的那層', nested?.projectId === 'w_child' && nested?.relPath === 'note.txt', JSON.stringify(nested))
    ok('專案外的絕對路徑對不到', links.locateInProjects(path.join(os.homedir(), 'nope.txt'), projects, '') === null)
    ok('資料夾本身對得到專案根', links.locateInProjects(base, projects, '')?.relPath === '')
  } finally {
    removeTree(base)
  }

  // ===== 三份清單 =====
  console.log('\n[三份清單]')
  {
    const service = fs.readFileSync(path.join(ROOT, 'src/main/terminal/service.js'), 'utf8')
    const ipc = fs.readFileSync(path.join(ROOT, 'src/main/terminal/ipc.js'), 'utf8')
    const preload = fs.readFileSync(path.join(ROOT, 'src/preload/preload.js'), 'utf8')
    // main.js 那份 `registerTerminalIpc({ service: { ... } })` 才是**第四份**清單，
    // 也是最容易漏的一份：v1.16.0 的 resolveLinks／revealLink 就漏在這裡——
    // service 有、ipc 有、preload 有，只有 main.js 沒接，整個連結功能安靜地不作用。
    // 所以不要列固定名單，直接從 ipc.js 反推「有哪些 service.X 真的被用到」。
    const mainJs = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8')
    const block = mainJs.slice(mainJs.indexOf('registerTerminalIpc('))
    const serviceBlock = block.slice(0, block.indexOf('isMainSender'))
    const used = [...new Set([...ipc.matchAll(/service\.(\w+)\(/g)].map((m) => m[1]))]
    ok('ipc.js 至少用到 9 支 service 方法', used.length >= 9, used.join(' '))
    for (const name of used) {
      ok(`service 匯出 ${name}`, new RegExp(`\\b${name}[,:]`).test(service))
      ok(`main.js 的白名單接得到 ${name}`, new RegExp(`\\b${name}:`).test(serviceBlock))
    }
    const channels = [...new Set([...ipc.matchAll(/ipcMain\.handle\('(terminal:\w+)'/g)].map((m) => m[1]))]
    for (const channel of channels) {
      ok(`preload 白名單有 ${channel}`, preload.includes(`'${channel}'`))
    }
  }

  // ===== 貼上不可以被安靜截掉 =====
  console.log('\n[送進 PTY 的切段]')
  {
    const { splitForPty, MAX_WRITE_CHARS } = await import(
      pathToFileURL(path.join(ROOT, 'src/renderer/scripts/term-write-chunks.js')).href
    )
    const pty = require(path.join(ROOT, 'src/main/terminal/pty.js'))
    ok('切段上限跟 main 的 MAX_WRITE_CHARS 同一個數字', MAX_WRITE_CHARS === pty.MAX_WRITE_CHARS,
      `${MAX_WRITE_CHARS} vs ${pty.MAX_WRITE_CHARS}`)
    const long = 'a'.repeat(MAX_WRITE_CHARS * 2 + 7)
    const parts = splitForPty(long)
    ok('超長字串切成多段', parts.length === 3, `${parts.length} 段`)
    ok('每一段都在上限內', parts.every((one) => one.length <= MAX_WRITE_CHARS))
    ok('接回去跟原字串一模一樣（不再被截半）', parts.join('') === long)
    ok('沒超過上限就不切', splitForPty('hello').length === 1)
    ok('空字串不產生任何一段', splitForPty('').length === 0)
    // 代理對剛好卡在邊界：切一半送出去，兩邊都是無效的半個字元
    const pair = 'x'.repeat(MAX_WRITE_CHARS - 1) + '\u{1F600}' + 'y'
    const cut = splitForPty(pair)
    const noSplitPair = cut.every((one) => {
      const last = one.charCodeAt(one.length - 1)
      return !(last >= 0xd800 && last <= 0xdbff)
    })
    ok('代理對不會被從中間剖開', noSplitPair && cut.join('') === pair)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
