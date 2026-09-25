#!/usr/bin/env node
/**
 * VoiceInk — 檔案頁補齊 Windows 檔案總管的差距（打包版 CDP）
 *
 * - 原生右鍵選單（殼層 sidecar）有東西、Alt+Enter 叫得出 Windows 的「內容」視窗
 *   （sidecar 主執行緒沒跑訊息迴圈時，InvokeCommand 回報成功但視窗永遠不出來）
 * - ZIP：點兩下走進去、唯讀（指令列／右鍵／Delete）、詳情看得到內容、複製貼上＝解壓縮、全部解壓縮
 * - 右鍵選單等殼層項目時資料夾被背景重讀，選單不可以被安靜丟掉
 *
 * 先 npm run electron:pack。收尾只 taskkill 自己的 pid。
 */
'use strict'

const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')
const ROOT = path.join(__dirname, '..')
const { tempDir, removeTree } = require('./lib/test-temp')
const EXE = process.env.VOICEINK_EXE || path.join(ROOT, 'dist', 'win-unpacked', 'VoiceInk.exe'), PORT = 9293
const UD = tempDir('voiceink-zipcdp-'); const SEED = path.join(UD, 'seed'); fs.mkdirSync(path.join(SEED, 'src', 'docs'), { recursive: true })
fs.writeFileSync(path.join(SEED, 'src', 'readme.txt'), 'hello from zip')
fs.writeFileSync(path.join(SEED, 'src', 'docs', 'a.md'), '# 標題\n內容')
execFileSync('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${path.join(SEED, 'src')}\\*' -DestinationPath '${path.join(SEED, 'pack.zip')}'`])
removeTree(path.join(SEED, 'src'))
fs.writeFileSync(path.join(SEED, 'plain.txt'), 'x')
/** 列出 VoiceInkShell.exe 的頂層視窗（「內容」視窗開在 sidecar 裡） */
const WINS_PS1 = path.join(UD, 'wins.ps1')
fs.writeFileSync(WINS_PS1, "Add-Type @\"\nusing System;\nusing System.Text;\nusing System.Collections.Generic;\nusing System.Runtime.InteropServices;\npublic static class W {\n  public delegate bool P(IntPtr h, IntPtr l);\n  [DllImport(\"user32.dll\")] public static extern bool EnumWindows(P cb, IntPtr l);\n  [DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);\n  [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);\n  [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr h);\n  public static List<string> List(uint[] pids) {\n    var outp = new List<string>();\n    EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid);\n      if (Array.IndexOf(pids, pid) >= 0) { var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256);\n        if (sb.Length > 0) outp.Add(pid + \":\" + (IsWindowVisible(h) ? \"V:\" : \"H:\") + sb); }\n      return true; }, IntPtr.Zero);\n    return outp;\n  }\n}\n\"@\n$pids = @(Get-Process VoiceInkShell -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })\nif ($pids.Count -eq 0) { \"no sidecar\"; exit }\n[W]::List($pids) -join \"`n\"\n")
fs.writeFileSync(path.join(UD, 'config.json'), JSON.stringify({ sysmonSensors: false }))
fs.writeFileSync(path.join(UD, 'explorer.json'), JSON.stringify({ uffsAuto: false, lastPath: SEED, view: 'list' }))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const getJson = (u) => new Promise((res, rej) => { http.get(u, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej) })
function cdp(url) {
  const ws = new WebSocket(url); let id = 0; const p = new Map()
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } })
  const send = (method, params = {}) => new Promise(r => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  return new Promise(r => ws.addEventListener('open', () => r({
    send,
    eval: async (expression) => { const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (m.result.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400)); return m.result.result.value },
    close: () => ws.close()
  })))
}
let pass = 0, fail = 0
const ok = (n, c, d) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${!c && d ? ' — ' + d : ''}`) }
const waitFor = async (c, expr, ms = 8000) => { const t = Date.now() + ms; while (Date.now() < t) { try { if (await c.eval(expr)) return true } catch {} await sleep(200) } return false }
const winTitle = () => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WINS_PS1], { encoding: 'utf8' })
  .split(String.fromCharCode(10)).filter((l) => l.includes(':V:')).join(' | ')
const toastHas = (text) => `[...document.querySelectorAll('[class*=toast]')].some(t => t.textContent.includes(${JSON.stringify(text)}))`

;(async () => {
  const child = spawn(EXE, ['--inspect=127.0.0.1:9294', `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], {
    stdio: 'ignore',
    // 開檔／詳情解出來的暫存副本留在自己的暫存資料夾，測完一起刪
    env: { ...process.env, VOICEINK_ZIP_TEMP: path.join(UD, 'zip-temp') }
  })
  try {
    let t; for (let i = 0; i < 100 && !t; i++) { await sleep(300); try { t = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find(x => x.type === 'page' && /index\.html/.test(x.url)) } catch {} }
    const c = await cdp(t.webSocketDebuggerUrl)
    let n; for (let i = 0; i < 60 && !n; i++) { await sleep(300); try { n = (await getJson('http://127.0.0.1:9294/json/list'))[0] } catch {} }
    const m = await cdp(n.webSocketDebuggerUrl)
    await sleep(1500)
    await c.eval(`document.querySelector('[data-page="explorer"]').click()`)
    await waitFor(c, `!!document.querySelector('#exList [data-id="pack.zip"]')`)

    const menu = await c.eval(`electronAPI.explorer.shellMenu({paths:[${JSON.stringify(path.join(SEED, 'plain.txt'))}],dir:${JSON.stringify(SEED)}}).then(r=>{const labels=[];const walk=(a)=>a.forEach(i=>{if(i.label)labels.push(i.label+(i.verb?'['+i.verb+']':''));if(i.children)walk(i.children)});walk(r.data.items);electronAPI.explorer.shellRelease(r.data.token);return labels})`)
    console.log('shell menu:', menu.join(' | '))
    ok('原生右鍵選單有東西（含內容）', menu.length > 5 && menu.some(l => /\[properties\]/.test(l)))

    await c.eval(`document.querySelector('#exList [data-id="plain.txt"]').click()`); await sleep(300)
    await c.eval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',altKey:true,bubbles:true,cancelable:true}))`)
    let title = ''
    for (let i = 0; i < 25 && !title; i++) { await sleep(400); title = winTitle() }
    ok('Alt+Enter 叫出 Windows 原生內容視窗', /plain\.txt/.test(title), title)

    await c.eval(`document.querySelector('#exList [data-id="pack.zip"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
    ok('點兩下 .zip 走進去', await waitFor(c, `!!document.querySelector('#exList [data-id="readme.txt"]') && !!document.querySelector('#exList [data-id="docs"]')`))
    const bar = await c.eval(`[...document.querySelectorAll('#exCmdBar button')].map(b=>b.textContent)`)
    ok('壓縮檔裡的指令列＝開啟／複製／解壓縮', JSON.stringify(bar) === JSON.stringify(['開啟', '複製', '複製路徑', '解壓縮到…', '全部解壓縮']), JSON.stringify(bar))
    ok('新增資料夾／檔案藏起來', await c.eval(`document.getElementById('exNewFolderBtn').hidden && document.getElementById('exNewFileBtn').hidden`))
    await c.eval(`document.querySelector('#exList [data-id="readme.txt"]').click()`)
    ok('詳情看得到壓縮檔裡的文字', await waitFor(c, `(document.getElementById('exDetail')?.textContent||'').includes('hello from zip')`),
      await c.eval(`(document.getElementById('exDetail')?.textContent||'').slice(0,200)`))
    await c.eval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}))`); await sleep(500)
    ok('Delete 在壓縮檔裡被擋（唯讀提示，不跳確認）', await c.eval(`!document.querySelector('dialog[open]') && ${toastHas('唯讀')}`))
    await c.eval(`document.querySelectorAll('dialog[open]').forEach(d=>d.close())`)

    await c.eval(`document.querySelector('#exList [data-id="readme.txt"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:300,clientY:300}))`); await sleep(600)
    const ctx = await c.eval(`[...document.querySelectorAll('.ws-menu button, .ws-menu [role=menuitem]')].map(b=>b.textContent.trim())`)
    ok('壓縮檔裡右鍵只有唯讀動作', ctx.includes('解壓縮到…') && ctx.includes('全部解壓縮') && !ctx.includes('刪除') && !ctx.includes('重新命名'), JSON.stringify(ctx))
    await c.eval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await sleep(300)

    await c.eval(`[...document.querySelectorAll('#exCmdBar button')].find(b=>b.textContent==='複製').click()`); await sleep(500)
    await c.eval(`document.getElementById('exUpBtn').click()`)
    await waitFor(c, `!!document.querySelector('#exList [data-id="plain.txt"]')`)
    await c.eval(`[...document.querySelectorAll('#exCmdBar button')].find(b=>b.textContent==='貼上').click()`)
    ok('複製後貼到外面＝解壓縮', await waitFor(c, `!!document.querySelector('#exList [data-id="readme.txt"]')`) && fs.readFileSync(path.join(SEED, 'readme.txt'), 'utf8') === 'hello from zip')

    await c.eval(`document.querySelector('#exList [data-id="pack.zip"]').click()`); await sleep(300)
    await c.eval(`[...document.querySelectorAll('#exCmdBar button')].find(b=>b.textContent==='全部解壓縮').click()`)
    ok('選 .zip 按全部解壓縮＝旁邊多一個同名資料夾', await waitFor(c, `!!document.querySelector('#exList [data-id="pack"]')`) && fs.existsSync(path.join(SEED, 'pack', 'docs', 'a.md')))

    await c.eval(`document.querySelector('#exList [data-id="plain.txt"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:300,clientY:300}))`); await sleep(600)
    await waitFor(c, `document.querySelectorAll('.ws-menu').length > 0`, 8000)
    const ctx2 = await c.eval(`[...document.querySelectorAll('.ws-menu button, .ws-menu [role=menuitem]')].map(b=>b.textContent.trim())`)
    ok('一般右鍵有「內容」且殼層那份不重複', ctx2.filter(l => l.startsWith('內容')).length === 1, JSON.stringify(ctx2))
    await c.eval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await sleep(300)

    await c.eval(`document.querySelector('#exList [data-id="pack.zip"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
    await waitFor(c, `!!document.querySelector('#exList [data-id="docs"]')`)
    await c.eval(`document.querySelector('#exList [data-id="readme.txt"]').click()`); await sleep(800)
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 650, deviceScaleFactor: 1, mobile: false }); await sleep(700)
    const b64 = await m.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w=>/index\\.html/.test(w.webContents.getURL())).webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}).then(i=>i.toPNG().toString('base64'))`)
    fs.mkdirSync(path.join(ROOT, 'dist', 'explorer-tabs-qa'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, 'dist', 'explorer-tabs-qa', 'zip-view.png'), Buffer.from(b64, 'base64'))
    c.close(); m.close()
  } finally {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    await sleep(1500); removeTree(UD)
  }
  console.log(`${pass} passed, ${fail} failed`)
})().catch(e => { console.error(e); process.exit(1) })
