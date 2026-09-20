#!/usr/bin/env node
/**
 * 檔案總管殼層 sidecar：選單去重、宿主協定、三份清單、原生旗標。
 * 不叫用任何殼層命令（那是 probe-explorer-shell.js）。
 */

'use strict'

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { EventEmitter } = require('events')
const { startShell, resolveExePath } = require('../src/main/explorer/shell-host')

const ROOT = path.join(__dirname, '..')
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

function loadFilter() {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/explorer-dnd.js'), 'utf8')
    .replace(/^import.*\r?\n/gm, '')
    .replace(/^export /gm, '')
  const context = { console }
  vm.createContext(context)
  vm.runInContext(src, context)
  return context.filterShellItems
}

console.log('\n[A] 殼層選單去重')
{
  const filter = loadFilter()
  const items = [
    { label: '開啟', verb: 'open', cmd: 1 },
    { sep: true },
    { sep: true },
    { label: '7-Zip', cmd: 10, children: [{ label: '加到壓縮檔', cmd: 11 }] },
    { label: 'WinRAR', cmd: 20, children: [{ label: '加到檔案', cmd: 21 }] },
    { label: '複製', verb: 'copy', cmd: 2 },
    { label: '傳送到', cmd: 30, children: [{ label: '文件', cmd: 31 }] },
    { label: '內容', verb: 'properties', cmd: 40 },
    { sep: true }
  ]
  const out = filter(items)
  ok('丟掉開啟／複製', !out.some((i) => i.verb === 'open' || i.verb === 'copy'))
  ok('留下 7-Zip', out.some((i) => i.label === '7-Zip' && i.children && i.children.length === 1))
  ok('留下 WinRAR', out.some((i) => i.label === 'WinRAR'))
  ok('留下傳送到子選單', out.some((i) => i.label === '傳送到' && i.children && i.children[0].label === '文件'))
  ok('留下內容', out.some((i) => i.verb === 'properties'))
  ok('開頭結尾沒有分隔線', !out[0].sep && !out[out.length - 1].sep)
  const seps = out.filter((i) => i.sep).length
  ok('連續分隔線收成一條', seps <= 2)
}

console.log('\n[B] sidecar 找不到執行檔時安靜降級')
{
  const resolved = resolveExePath({ resourcesPath: path.join(ROOT, 'this-does-not-exist') })
  const fallback = path.join(ROOT, 'resources', 'shell', 'VoiceInkShell.exe')
  ok('開發路徑指到 resources/shell', resolved === fallback || resolved === '', resolved)
}

console.log('\n[C] 宿主行協定（假 spawn，不碰真 COM）')
{
  const responses = new Map()
  function fakeSpawn() {
    const proc = new EventEmitter()
    const stdout = new EventEmitter()
    stdout.setEncoding = () => {}
    proc.stdout = stdout
    proc.stdin = {
      write: (line) => {
        const msg = JSON.parse(String(line).trim())
        const payload = responses.get(msg.op) || { ok: true, data: { token: 1, items: [] } }
        queueMicrotask(() => stdout.emit('data', `${JSON.stringify({ id: msg.id, ...payload })}\n`))
      },
      end: () => {}
    }
    proc.kill = () => proc.emit('exit', 0)
    queueMicrotask(() => stdout.emit('data', 'READY\n'))
    return proc
  }
  responses.set('menu', {
    ok: true,
    data: { token: 7, items: [{ label: '7-Zip', cmd: 1, children: [{ label: '解壓縮', cmd: 2 }] }] }
  })
  responses.set('thumb', {
    ok: true,
    data: { thumb: { w: 96, h: 96, bgra: 'AAAA' } }
  })
  responses.set('attrs', {
    ok: true,
    data: { items: [{ name: 'secret.txt', hidden: true, system: false }, { name: 'plain.txt', hidden: false, system: false }] }
  })
  const exe = path.join(ROOT, 'resources', 'shell', 'VoiceInkShell.exe')
  startShell({ spawnFn: fakeSpawn, exePath: exe || 'VoiceInkShell.exe' }).then(async (shell) => {
    ok('假 sidecar 起得來', shell.ok === true, shell.error)
    const menu = await shell.send({ op: 'menu', paths: ['C:\\a.txt'] })
    ok('選單帶 token', menu.ok && menu.data.token === 7)
    ok('7-Zip 子選單在', menu.data.items[0].children[0].label === '解壓縮')
    const thumb = await shell.send({ op: 'thumb', path: 'C:\\a.png', size: 96 })
    ok('縮圖協定帶尺寸', thumb.ok && thumb.data.thumb.w === 96)
    const attrs = await shell.send({ op: 'attrs', dir: 'C:\\tmp' })
    ok('屬性協定帶 hidden', attrs.ok && attrs.data.items[0].hidden === true && attrs.data.items[1].hidden === false)
    shell.stop()
    finishRest()
  }).catch((error) => {
    ok('假 sidecar 起得來', false, error.message)
    finishRest()
  })
}

function finishRest() {
  console.log('\n[D] 原生程式用對旗標')
  {
    const overlays = fs.readFileSync(path.join(ROOT, 'native/explorer-shell/Overlays.cs'), 'utf8')
    const menu = fs.readFileSync(path.join(ROOT, 'native/explorer-shell/ShellMenu.cs'), 'utf8')
    const interop = fs.readFileSync(path.join(ROOT, 'native/explorer-shell/Interop.cs'), 'utf8')
    const thumbs = fs.readFileSync(path.join(ROOT, 'native/explorer-shell/Thumbnails.cs'), 'utf8')
    const program = fs.readFileSync(path.join(ROOT, 'native/explorer-shell/Program.cs'), 'utf8')
    const attrsCs = fs.readFileSync(path.join(ROOT, 'native/explorer-shell/Attributes.cs'), 'utf8')
    const icons = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/explorer-icons.js'), 'utf8')
    ok('圖示走 SHGFI_ADDOVERLAYS', overlays.includes('SHGFI_ADDOVERLAYS'))
    ok('不自己挖 overlay 圖庫', overlays.includes('不要想自己把那張小圖單獨挖出來'))
    ok('傳送到走 SYNCCASCADEMENU', interop.includes('CMF_SYNCCASCADEMENU') && menu.includes('CMF_SYNCCASCADEMENU'))
    ok('空子選單會退回 IContextMenu2', menu.includes('HandleMenuMsg') && menu.includes('IContextMenu2'))
    ok('pidl 陣列明寫 LPArray', interop.includes('UnmanagedType.LPArray'))
    ok('縮圖走 IShellItemImageFactory', thumbs.includes('IShellItemImageFactory') && thumbs.includes('GetImage'))
    ok('縮圖旗標 RESIZETOFIT + BIGGERSIZEOK', thumbs.includes('SIIGBF_RESIZETOFIT') && thumbs.includes('SIIGBF_BIGGERSIZEOK'))
    ok('fallback 仍給可顯示的圖', thumbs.includes('SIIGBF_RESIZETOFIT | Native.SIIGBF_BIGGERSIZEOK'))
    ok('先用 THUMBNAILONLY | INCACHEONLY 探快取裡有沒有真縮圖',
      thumbs.includes('SIIGBF_THUMBNAILONLY') && thumbs.includes('SIIGBF_INCACHEONLY'))
    ok('sidecar 不 Sleep 等縮圖', !/Thread\.Sleep/.test(thumbs) && !/Task\.Delay/.test(thumbs))
    ok('pending 寫進 thumb JSON', /WriteBoolean\("pending"/.test(program))
    ok('HBITMAP 用完 DeleteObject', thumbs.includes('DeleteObject(hbmp)'))
    ok('sidecar 有 thumb op', program.includes('case "thumb"'))
    ok('sidecar 有 attrs op', program.includes('case "attrs"'))
    ok('屬性一次問整層', attrsCs.includes('EnumerateFileSystemInfos'))
    ok('屬性上限 2000', attrsCs.includes('MaxEntries = 2000'))
    ok('讀不到的項目跳過', attrsCs.includes('沒權限或瞬間消失'))
    ok('圖示與縮圖快取 key 分開', icons.includes("? 't' : 'i'"))
    ok('只在方格檢視要縮圖', icons.includes('is-grid') && icons.includes('pdf') && icons.includes('docx'))
    ok('pending 縮圖會重試且不進快取', /pending === true/.test(icons) && /MAX_RETRY/.test(icons))
  }

  console.log('\n[E] ipc／main／preload 有殼層三支')
  {
    const ipc = fs.readFileSync(path.join(ROOT, 'src/main/explorer/ipc.js'), 'utf8')
    const main = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8')
    const preload = fs.readFileSync(path.join(ROOT, 'src/preload/preload.js'), 'utf8')
    for (const name of ['shellMenu', 'shellInvoke', 'shellRelease']) {
      ok(`ipc 有 ${name}`, ipc.includes(`explorer:${name}`))
      ok(`main 白名單有 ${name}`, main.includes(`${name}: (...args)`))
      ok(`preload 有 ${name}`, preload.includes(`'explorer:${name}'`))
    }
    ok('before-quit 收 sidecar', /explorerMod\.shutdown/.test(main))
    ok('fileIcon 可帶縮圖選項', ipc.includes('fileIcon(target, opts)') && preload.includes('fileIcon: (target, opts)'))
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}
