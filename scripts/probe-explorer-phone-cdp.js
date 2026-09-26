#!/usr/bin/env node
/**
 * VoiceInk — 檔案頁瀏覽手機（MTP）：**要真的插著一支手機**（解鎖、USB 選「檔案傳輸」），沒插就 SKIP。
 *
 * 打包版 CDP：本機首頁的手機卡 → 點進去 → 儲存空間 → Download；
 * Ctrl+V 把電腦的檔案複製進手機 → F2 被擋 → Ctrl+C 複製出來貼回電腦 → 詳情 → Delete 永久刪掉。
 * 手機上只會暫時多一個 `voiceink-probe-*.txt`，最後刪掉並確認不見。
 *
 * 先 npm run electron:pack（改了 native/explorer-shell 要先 npm run build:shell）。收尾只 taskkill 自己的 pid。
 */
'use strict'

const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')
const ROOT = path.join(__dirname, '..')
const { tempDir, removeTree } = require('./lib/test-temp')
const drives = require('../src/main/explorer/drives')

const EXE = process.env.VOICEINK_EXE || path.join(ROOT, 'dist', 'win-unpacked', 'VoiceInk.exe')
const PORT = 9295
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const getJson = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (c) => { b += c }); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej)
})
function cdp(url) {
  const ws = new WebSocket(url); let id = 0; const p = new Map()
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id) } })
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  return new Promise((r) => ws.addEventListener('open', () => r({
    eval: async (expression) => {
      const m = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (m.result.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400))
      return m.result.result.value
    },
    close: () => ws.close()
  })))
}
let pass = 0; let fail = 0
const ok = (n, c, d) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${n}${!c && d ? ' — ' + d : ''}`) }
const waitFor = async (c, expr, ms = 20000) => {
  const t = Date.now() + ms
  while (Date.now() < t) { try { if (await c.eval(expr)) return true } catch {} await sleep(250) }
  return false
}
const row = (name) => `document.querySelector('#exList [data-id=${JSON.stringify(JSON.stringify(name)).slice(1, -1)}]')`
const hasRow = (name) => `!!${row(name)}`
const key = (k, extra = '') => `document.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},${extra}bubbles:true,cancelable:true}))`
const toastHas = (text) => `[...document.querySelectorAll('[class*=toast]')].some(t => t.textContent.includes(${JSON.stringify(text)}))`

;(async () => {
  const phones = await drives.listDevices()
  if (!phones.length) {
    console.log('SKIP 沒有插著的手機（要解鎖、USB 選「檔案傳輸」）')
    return
  }
  const UD = tempDir('voiceink-phonecdp-')
  const SEED = path.join(UD, 'seed')
  fs.mkdirSync(SEED, { recursive: true })
  const name = `voiceink-probe-${Date.now()}.txt`
  const body = `手機 probe ${Date.now()}`
  fs.writeFileSync(path.join(SEED, name), body)
  fs.writeFileSync(path.join(UD, 'config.json'), JSON.stringify({ sysmonSensors: false }))
  fs.writeFileSync(path.join(UD, 'explorer.json'), JSON.stringify({ uffsAuto: false, lastPath: 'thispc', view: 'list' }))
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], {
    stdio: 'ignore',
    env: { ...process.env, VOICEINK_ZIP_TEMP: path.join(UD, 'zip-temp') }
  })
  let dl = ''
  let c = null
  try {
    let t
    for (let i = 0; i < 100 && !t; i++) {
      await sleep(300)
      try { t = (await getJson(`http://127.0.0.1:${PORT}/json/list`)).find((x) => x.type === 'page' && /index\.html/.test(x.url)) } catch {}
    }
    c = await cdp(t.webSocketDebuggerUrl)
    await sleep(1500)
    await c.eval(`document.querySelector('[data-page="explorer"]').click()`)
    const card = `document.querySelector('#exHome .ex-home-card[data-path^="mtp:"]')`
    ok('本機首頁有手機卡', await waitFor(c, `!!${card}`), await c.eval(`document.getElementById('exHome')?.textContent.slice(0,200)`))
    const phonePath = await c.eval(`${card}.dataset.path`)
    await c.eval(`${card}.click()`)
    ok('點手機卡在 App 裡打開', await waitFor(c, `document.querySelectorAll('#exList .ex-row').length > 0`))
    const crumbs = await c.eval(`[...document.querySelectorAll('#exCrumbs .ex-crumb')].map(b=>b.textContent)`)
    ok('路徑列＝本機 ▸ 手機', crumbs[0] === '本機' && crumbs[1] === phonePath.slice(4), JSON.stringify(crumbs))
    ok('手機裡沒有新增資料夾／檔案鈕', await c.eval(`document.getElementById('exNewFolderBtn').hidden && document.getElementById('exNewFileBtn').hidden`))
    const storage = await c.eval(`document.querySelector('#exList .ex-row').dataset.path`)
    dl = `${storage}\\Download`
    await c.eval(`document.querySelector('#exList .ex-row').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
    ok('點兩下進儲存空間，看得到 Download', await waitFor(c, hasRow('Download')))
    await c.eval(`${row('Download')}.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
    await waitFor(c, `(document.getElementById('exCrumbs')?.textContent||'').includes('Download')`)
    const bar = await c.eval(`[...document.querySelectorAll('#exCmdBar button')].map(b=>b.textContent)`)
    ok('手機裡的指令列＝開啟／複製／貼上／永久刪除', JSON.stringify(bar) === JSON.stringify(['開啟', '複製', '貼上', '永久刪除']), JSON.stringify(bar))

    // 電腦 → 手機：剪貼簿放本機檔案，在手機的 Download 按 Ctrl+V
    const clip = await c.eval(`electronAPI.explorer.setClipboard([${JSON.stringify(path.join(SEED, name))}], 'copy')`)
    ok('剪貼簿放得進本機檔案', clip && clip.ok, JSON.stringify(clip))
    await c.eval(key('v', 'ctrlKey:true,'))
    ok('Ctrl+V 複製進手機，清單出現那個檔案', await waitFor(c, hasRow(name), 60000))

    await c.eval(`${row(name)}.click()`)
    ok('詳情看得到大小', await waitFor(c, `(document.getElementById('exDetail')?.textContent||'').includes('位元組') || /\\d+\\s*B/.test(document.getElementById('exDetail')?.textContent||'')`),
      await c.eval(`(document.getElementById('exDetail')?.textContent||'').slice(0,200)`))
    await c.eval(key('F2')); await sleep(500)
    ok('F2 在手機裡被擋（有講原因）', await c.eval(`!document.querySelector('#exList input') && ${toastHas('手機裡不能改名')}`))

    // 手機 → 電腦：Ctrl+C 後回到本機暫存資料夾 Ctrl+V
    fs.unlinkSync(path.join(SEED, name))
    await c.eval(`${row(name)}.click()`)
    await c.eval(key('c', 'ctrlKey:true,')); await sleep(500)
    // 在路徑列打本機暫存資料夾按 Enter（跟使用者一樣）
    await c.eval(`(()=>{const i=document.getElementById('exPathInput');i.hidden=false;i.value=${JSON.stringify(SEED)};i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`)
    ok('到了本機暫存資料夾', await waitFor(c, `(document.getElementById('exCrumbs')?.textContent||'').includes('seed')`, 8000))
    await c.eval(key('v', 'ctrlKey:true,'))
    ok('Ctrl+V 從手機複製回電腦，內容一樣', await waitFor(c, hasRow(name), 60000) && fs.readFileSync(path.join(SEED, name), 'utf8') === body)

    // 回手機刪掉（永久刪除要先確認）
    await c.eval(`document.getElementById('exBackBtn').click()`)
    // 本機那份同名，所以要看路徑列真的換回手機，不能只看「有那一列」
    ok('上一頁回到手機的 Download', await waitFor(c, `(document.getElementById('exCrumbs')?.textContent||'').includes('Download') && ${hasRow(name)}`, 30000))
    await c.eval(`${row(name)}.click()`)
    await c.eval(key('Delete')); await sleep(600)
    const ask = await c.eval(`document.querySelector('dialog[open]')?.textContent || ''`)
    ok('Delete 先問「永久刪除」', ask.includes('永久刪除'), ask)
    await c.eval(`[...document.querySelectorAll('dialog[open] button')].find(b=>b.textContent.trim()==='永久刪除').click()`)
    ok('刪掉後清單裡不見了', await waitFor(c, `!${hasRow(name)}`, 30000))
    const after = await c.eval(`electronAPI.explorer.listDir(${JSON.stringify(dl)}, { showHidden: true })`)
    ok('手機上真的沒有那個檔案', after.ok && !after.data.entries.some((e) => e.name === name))
    dl = ''
  } finally {
    // 中途失敗也要把測試檔從手機清掉
    if (dl && c) {
      try { await c.eval(`electronAPI.explorer.removeEntry(${JSON.stringify(`${dl}\\${name}`)}, { permanent: true })`) } catch {}
    }
    if (c) c.close()
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    await sleep(1500)
    removeTree(UD)
  }
  console.log(`${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
})().catch((e) => { console.error(e); process.exit(1) })
