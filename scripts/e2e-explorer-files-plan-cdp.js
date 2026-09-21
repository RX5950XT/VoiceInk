#!/usr/bin/env node
/**
 * VoiceInk — 參考 Files 的五批檔案總管改進，打包版真畫面驗收（CDP）。
 *
 * 舊有的檔案總管回歸請跑 `e2e-explorer-cdp.js`；這支只驗這五批新東西：
 *   1 操作中心（進度、逐筆結果、取消）
 *   2 分頁瀏覽狀態（選取、捲動在分頁之間與重開之後都還在）
 *   3 大型資料夾（分批載入、只畫可見列、排序涵蓋全部、搜尋篩選）
 *   4 預覽（Markdown／PDF／影音、換檔不殘留、關閉釋放、詳情欄收合）
 *   5 雙欄與批次改名（左右欄各自狀態、跨欄搬檔、改名前後預覽）
 *
 * 只動自種的暫存資料夾，測完刪掉；收尾只 taskkill 自己的 pid。
 */

'use strict'

const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')
const { tempDir, removeTree } = require('./lib/test-temp')

// 與既有 e2e-explorer-cdp.js 平行執行時不能共用埠或 profile。
const PORT = 9291
const INSPECT_PORT = 9292
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = tempDir('voiceink-e2e-files-')

/** 大資料夾要夠大才看得出分批與虛擬清單；2,600 已超過舊的 2,000 上限。 */
const BIG_COUNT = 2600
const LAST_ITEM = `item-${String(BIG_COUNT - 1).padStart(5, '0')}.txt`

const SEED_DIR = path.join(USER_DATA_DIR, 'seed-folder')
const TARGET_DIR = path.join(USER_DATA_DIR, 'target-folder')
const PREVIEW_DIR = path.join(USER_DATA_DIR, 'preview-folder')
const SMALL_DIR = path.join(USER_DATA_DIR, 'small-folder')
const DUAL_DIR = path.join(USER_DATA_DIR, 'dual-folder')

for (const dir of [SEED_DIR, TARGET_DIR, PREVIEW_DIR, SMALL_DIR, DUAL_DIR]) fs.mkdirSync(dir, { recursive: true })

for (let i = 0; i < BIG_COUNT; i += 1) {
  fs.writeFileSync(path.join(SEED_DIR, `item-${String(i).padStart(5, '0')}.txt`), String(i))
}

// 第 1 批：貼上要看得到逐筆結果，所以來源給三個小檔；大檔另外放，才來得及按取消。
for (const name of ['copy-a.txt', 'copy-b.txt', 'copy-c.txt']) {
  fs.writeFileSync(path.join(SMALL_DIR, name), name.repeat(64))
}
const BIG_FILE = path.join(SMALL_DIR, 'big.bin')
fs.writeFileSync(BIG_FILE, Buffer.alloc(96 * 1024 * 1024, 7))

// 第 5 批：雙欄與批次改名各自用乾淨的資料夾，不跟大資料夾混在一起。
for (const name of ['dual-1.txt', 'dual-2.txt', 'dual-3.txt']) {
  fs.writeFileSync(path.join(DUAL_DIR, name), name)
}

// 第 4 批：Markdown／PDF／圖片／影片各一份。影片只驗預覽掛得起來，不驗播放。
fs.writeFileSync(path.join(PREVIEW_DIR, 'README.md'), '# 預覽標題\n\n**粗體內文**\n')
function minimalPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R 7 0 R] /Count 3 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length 44 >>\nstream\nBT /F1 12 Tf 20 100 Td (preview) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 220 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
  ]
  let text = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'
  const offsets = [0]
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(text, 'binary'))
    text += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const start = Buffer.byteLength(text, 'binary')
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) text += `${String(offset).padStart(10, '0')} 00000 n \n`
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return Buffer.from(text, 'binary')
}
fs.writeFileSync(path.join(PREVIEW_DIR, 'sample.pdf'), minimalPdf())
fs.writeFileSync(path.join(PREVIEW_DIR, 'shot.png'), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4o6GBFTEMLQkAe3tLAfuiUfAAAAAASUVORK5CYII=',
  'base64'
))
fs.writeFileSync(path.join(PREVIEW_DIR, 'sample.mp4'), Buffer.alloc(64))

fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))
fs.writeFileSync(path.join(USER_DATA_DIR, 'explorer.json'), JSON.stringify({
  uffsAuto: false,
  lastPath: SEED_DIR,
  view: 'list'
}))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = ''
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    request.setTimeout(2_000, () => request.destroy(new Error('CDP HTTP 逾時')))
    request.on('error', reject)
  })
}

function stopTestApp(child) {
  if (child?.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch { /* 程序已結束 */ }
  }
}

class Cdp {
  constructor(url) {
    this.url = url
    this.id = 0
    this.pending = new Map()
    this.errors = []
  }

  async connect(page = true) {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve)
      this.ws.addEventListener('error', () => reject(new Error('CDP WebSocket 連不上')))
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails.text)
      if (!message.id || !this.pending.has(message.id)) return
      const pending = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    await this.send('Runtime.enable')
    if (page) await this.send('Page.enable')
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 逾時：${method}`))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result?.value
  }

  close() {
    for (const item of this.pending.values()) clearTimeout(item.timer)
    try { this.ws.close() } catch { /* 已關 */ }
  }
}

async function waitFor(fn, ms, label) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(150)
  }
  throw new Error(`逾時：${label}`)
}

let passed = 0
function assert(cond, name, detail) {
  if (!cond) throw new Error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  passed += 1
  console.log(`  PASS ${name}`)
}

const json = (value) => JSON.stringify(value)
/** 丟進 querySelector 的屬性值要再包一層引號，中文與空白才不會把選擇器拆斷。 */
const attr = (value) => JSON.stringify(JSON.stringify(value))

/** 開一個連上打包版的 CDP session；重開 App 驗證狀態還原時會再叫一次。 */
async function launch() {
  const child = spawn(EXE, [
    '--hidden',
    `--inspect=127.0.0.1:${INSPECT_PORT}`,
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`
  ], { stdio: 'ignore' })
  await waitFor(async () => {
    try { return await getJson(`http://127.0.0.1:${PORT}/json/version`) } catch { return null }
  }, 60_000, 'CDP 起來')
  const target = await waitFor(async () => {
    const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
    return list.find((t) => t.type === 'page' && /index\.html/.test(t.url))
  }, 30_000, '主視窗')
  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.connect()
  await waitFor(
    () => cdp.eval(`document.readyState === 'complete' && typeof window.electronAPI?.explorer?.listDir === 'function'`),
    30_000,
    'preload'
  )
  await cdp.eval(`document.querySelector('[data-page="explorer"]').click()`)
  await waitFor(() => cdp.eval(`document.getElementById('page-explorer')?.classList.contains('active')`), 15_000, '檔案頁')
  // 大資料夾是分批載入的：等第一批真的畫出來再動作，不然後到的那一批會把剛切走的路徑蓋回來。
  await waitFor(() => cdp.eval(`document.querySelectorAll('#exList .ex-row').length > 0`), 30_000, '第一批列出來')
  return { child, cdp }
}

function api(cdp) {
  const tabPath = () => cdp.eval(`document.querySelector('.ex-tab.is-active')?.dataset.path || ''`)
  const goto = async (dir) => {
    const deadline = Date.now() + 40_000
    while (Date.now() < deadline) {
      await cdp.eval(`(() => {
        document.getElementById('exPathBar').dispatchEvent(new MouseEvent('click', { bubbles: true }))
        const input = document.getElementById('exPathInput')
        input.value = ${json(dir)}
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })()`)
      const landed = await waitFor(
        async () => (String(await tabPath()).toLowerCase() === dir.toLowerCase() ? true : null),
        6_000,
        `切到 ${dir}`
      ).catch(() => null)
      if (landed) {
        await waitFor(() => cdp.eval(`document.querySelectorAll('#exList .ex-row').length > 0 || document.getElementById('exEmpty')?.hidden === false`), 25_000, `${dir} 畫出來`)
        // 還在飛的那一批回來之後不能把路徑換掉。
        await sleep(600)
        if (String(await tabPath()).toLowerCase() === dir.toLowerCase()) return
      }
    }
    throw new Error(`切不過去 ${dir}——目前停在 ${await tabPath()}`)
  }
  const clickRow = (id, opts = {}) => cdp.eval(`(() => {
    const row = document.querySelector('#exList [data-id=' + ${attr(id)} + ']')
    if (!row) return false
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: ${Boolean(opts.ctrl)} }))
    return true
  })()`)
  const cmd = (label) => cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('#exCmdBar button')].find((b) => b.textContent.trim() === ${json(label)})
    if (!btn || btn.disabled) return false
    btn.click()
    return true
  })()`)
  const selectedIds = () => cdp.eval(`[...document.querySelectorAll('#exList .ex-row.is-selected')].map((r) => r.dataset.id)`)
  return { goto, clickRow, cmd, selectedIds }
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.log(`SKIP 找不到 ${EXE}（先 npm run electron:pack）`)
    return
  }
  let session = null
  try {
    session = await launch()
    let { cdp } = session
    let ui = api(cdp)

    console.log('\n[1] 操作中心：進度、逐筆結果、取消')
    await ui.goto(SMALL_DIR)
    assert(await ui.clickRow('copy-a.txt'), '選得到來源檔')
    await ui.clickRow('copy-b.txt', { ctrl: true })
    await ui.clickRow('copy-c.txt', { ctrl: true })
    assert((await ui.selectedIds()).length === 3, '多選三個檔案')
    assert(await ui.cmd('複製'), '命令列有「複製」')
    await ui.goto(TARGET_DIR)
    assert(await ui.cmd('貼上'), '命令列有「貼上」')

    const card = await waitFor(() => cdp.eval(`(() => {
      const host = document.querySelector('.ex-ops-host')
      const one = host && host.querySelector('.ex-ops-card')
      if (!one) return null
      return {
        title: one.querySelector('strong')?.textContent || '',
        status: one.querySelector('.ex-ops-status')?.textContent || '',
        meter: !!one.querySelector('progress.ex-ops-meter'),
        items: [...one.querySelectorAll('.ex-ops-item-name')].map((n) => n.textContent)
      }
    })()`), 25_000, '操作中心出現卡片')
    assert(card.meter, '卡片有進度條', json(card))
    assert(card.items.length === 3, '逐筆列出三個檔案', json(card.items))
    await waitFor(() => cdp.eval(`(() => {
      const one = document.querySelector('.ex-ops-card .ex-ops-status')
      return one && /完成/.test(one.textContent) ? true : null
    })()`), 30_000, '複製跑到完成')
    for (const name of ['copy-a.txt', 'copy-b.txt', 'copy-c.txt']) {
      assert(fs.existsSync(path.join(TARGET_DIR, name)), `真的複製出 ${name}`)
    }

    // 取消：複製 96MB 的大檔再按取消。同一顆磁碟的「搬移」是 rename，一瞬間就結束，
    // 按不到取消——真正的取消語意由 `test-explorer-operations.js` 與
    // `probe-explorer-operations-cross-volume.js` 驗；這裡只確認打包版按得下去、
    // 收在終局狀態，而且不管是取消還是完成，檔案都不會半路壞掉。
    await ui.goto(SMALL_DIR)
    assert(await ui.clickRow('big.bin'), '選得到大檔')
    assert(await ui.cmd('複製'), '命令列有「複製」（大檔）')
    await ui.goto(TARGET_DIR)
    assert(await ui.cmd('貼上'), '大檔開始複製')
    const cancelled = await waitFor(() => cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('.ex-ops-card .ex-ops-actions button')]
        .find((b) => /取消/.test(b.textContent))
      if (!btn || btn.disabled) return null
      btn.click()
      return true
    })()`), 20_000, '按得到取消')
    assert(cancelled, '取消鈕按得下去')
    const ended = await waitFor(() => cdp.eval(`(() => {
      const one = document.querySelector('.ex-ops-card .ex-ops-status')
      if (!one) return null
      const label = one.textContent.trim()
      return /完成|取消|失敗/.test(label) ? label : null
    })()`), 60_000, '大檔的操作收尾')
    assert(/完成|取消|失敗/.test(ended), `大檔操作收在終局狀態（${ended}）`)
    assert(fs.existsSync(BIG_FILE), '來源大檔一直都在')
    const copiedTo = path.join(TARGET_DIR, 'big.bin')
    if (/取消/.test(ended)) {
      assert(!fs.existsSync(copiedTo), '取消之後目的地沒有半截檔')
    } else {
      assert(fs.statSync(copiedTo).size === fs.statSync(BIG_FILE).size, '來不及取消就整份複製完，大小一致')
      fs.rmSync(copiedTo)
    }
    console.log('\n[2] 分頁瀏覽狀態：選取、捲動切回來還在')
    await ui.goto(SEED_DIR)
    // 剛切過來的那幾次重畫會把捲動位置歸零，所以設到真的停在那裡為止。
    const scrolled = await waitFor(() => cdp.eval(`(() => {
      const list = document.getElementById('exList')
      if (list.scrollTop < 4000) { list.scrollTop = 4000; return null }
      return list.scrollTop
    })()`), 20_000, '清單捲得下去')
    assert(scrolled >= 4000, '清單真的捲下去了', json(scrolled))
    // 點畫面中段那一列：點第一列會被捲回頂端，測不出「切回來還在原處」。
    // 等虛擬清單真的把視窗換到捲動後的位置，再挑列；不然挑到的是換窗前那一批。
    await waitFor(() => cdp.eval(`(() => {
      const first = document.querySelector('#exList .ex-row')?.dataset.id || ''
      return first && first !== 'item-00000.txt' ? first : null
    })()`), 20_000, '可見範圍跟著捲動換過去')
    const marked = await waitFor(() => cdp.eval(`(() => {
      const list = document.getElementById('exList')
      const rows = [...list.querySelectorAll('.ex-row')]
      if (rows.length < 4) return null
      const row = rows[Math.floor(rows.length / 2)]
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      return { id: row.dataset.id }
    })()`), 15_000, '捲到中段選一列')
    await sleep(400)
    const anchored = await cdp.eval(`(() => ({
      id: document.querySelector('#exList .ex-row.is-selected')?.dataset.id || '',
      top: document.getElementById('exList').scrollTop
    }))()`)
    assert(anchored.id === marked.id, '選到的就是中段那一列', json([marked, anchored]))
    assert(anchored.top > 1000, '選完之後還停在中段', json(anchored))
    await cdp.eval(`document.getElementById('exTabAddBtn').click()`)
    await waitFor(() => cdp.eval(`document.querySelectorAll('.ex-tab').length >= 2`), 15_000, '第二個分頁')
    await cdp.eval(`(() => {
      const tabs = [...document.querySelectorAll('.ex-tab')]
      tabs[0].querySelector('.ex-tab-open').click()
    })()`)
    const back = await waitFor(() => cdp.eval(`(() => {
      const list = document.getElementById('exList')
      const sel = document.querySelector('#exList .ex-row.is-selected')
      if (!sel) return null
      return { id: sel.dataset.id, top: list.scrollTop }
    })()`), 20_000, '切回原分頁')
    assert(back.id === anchored.id, '切回來選取還在', json([anchored.id, back.id]))
    assert(Math.abs(back.top - anchored.top) < 200, '切回來捲動位置還在', json([anchored.top, back.top]))

    console.log('\n[3] 大型資料夾：全部看得到、只畫可見列')
    const virt = await cdp.eval(`(() => {
      const list = document.getElementById('exList')
      return {
        rows: list.querySelectorAll('.ex-row').length,
        spacers: list.querySelectorAll('.ex-virtual-spacer').length
      }
    })()`)
    assert(virt.spacers > 0, '清單用了虛擬捲動的撐高元素', json(virt))
    assert(virt.rows > 0 && virt.rows < 400, `只畫可見列（${virt.rows} 列，不是 ${BIG_COUNT}）`, json(virt))
    const last = await waitFor(() => cdp.eval(`(() => {
      const l = document.getElementById('exList')
      l.scrollTop = l.scrollHeight
      return document.querySelector('#exList [data-id=' + ${attr(LAST_ITEM)} + ']') ? true : null
    })()`), 40_000, `捲到最後一筆 ${LAST_ITEM}`)
    assert(last, `第 ${BIG_COUNT} 筆 ${LAST_ITEM} 到得了`)
    const total = await cdp.eval(`document.getElementById('exStatusText')?.textContent || ''`)
    assert(/2600/.test(total.replace(/[\s,，]/g, '')), '狀態列講得出完整筆數', total)

    // 換排序方向之後，第一列必須換人——證明排序涵蓋全部，不是只排載進來的那幾頁。
    await cdp.eval(`(() => { document.getElementById('exList').scrollTop = 0 })()`)
    await sleep(500)
    const firstAsc = await cdp.eval(`document.querySelector('#exList .ex-row')?.dataset.id || ''`)
    await cdp.eval(`(() => {
      const head = document.getElementById('exListHead')
      const name = [...head.querySelectorAll('.ex-sort')].find((b) => /名稱/.test(b.textContent))
      name?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })()`)
    const firstDesc = await waitFor(() => cdp.eval(`(() => {
      const l = document.getElementById('exList')
      l.scrollTop = 0
      const id = l.querySelector('.ex-row')?.dataset.id || ''
      return id && id !== ${json(firstAsc)} ? id : null
    })()`), 25_000, '換排序方向')
    assert(firstDesc === LAST_ITEM, '倒序第一列就是完整清單的最後一筆', json([firstAsc, firstDesc]))

    const filters = await cdp.eval(`(() => ({
      present: !!document.getElementById('exSearchFilters'),
      type: !!document.getElementById('exSearchType'),
      size: !!document.getElementById('exSearchMinSize') && !!document.getElementById('exSearchMaxSize'),
      date: !!document.getElementById('exSearchFrom') && !!document.getElementById('exSearchTo'),
      where: !!document.getElementById('exSearchLocation')
    }))()`)
    assert(filters.present && filters.type && filters.size && filters.date && filters.where,
      '搜尋有類型／大小／日期／位置篩選', json(filters))

    console.log('\n[4] 預覽：Markdown／PDF／影音，換檔不殘留')
    await ui.goto(PREVIEW_DIR)
    assert(await ui.clickRow('README.md'), '選得到 Markdown')
    await cdp.eval(`document.querySelector('#exList .ex-row.is-selected')
      .dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))`)
    const md = await waitFor(() => cdp.eval(`(() => {
      const article = document.querySelector('.ex-preview-root .ex-preview-markdown')
      return article && /預覽標題/.test(article.textContent) ? article.textContent.slice(0, 40) : null
    })()`), 20_000, 'Markdown 預覽')
    assert(md, 'Markdown 預覽畫得出內容', json(md))

    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))`)
    const afterStep = await waitFor(() => cdp.eval(`(() => {
      const root = document.querySelector('.ex-preview-root')
      if (!root) return null
      const caption = root.querySelector('.ex-preview-caption')?.textContent || ''
      if (/README/.test(caption)) return null
      return {
        caption,
        markdownLeft: !!root.querySelector('.ex-preview-markdown'),
        pdf: !!root.querySelector('.ex-preview-pdf-canvas'),
        image: !!root.querySelector('.ex-preview-image'),
        video: !!root.querySelector('.ex-preview-video')
      }
    })()`), 30_000, '換到下一個檔')
    assert(!afterStep.markdownLeft, '換檔之後沒有殘留上一份 Markdown', json(afterStep))
    assert(afterStep.pdf || afterStep.image || afterStep.video, '下一個檔也有預覽內容', json(afterStep))

    {
      // 換檔會繞圈，一直按到自種的三頁 PDF 為止，不假設排序上剛好是下一份。
      await waitFor(() => cdp.eval(`(() => {
        const root = document.querySelector('.ex-preview-root')
        if (!root) return null
        if (root.querySelector('.ex-preview-pdf-canvas')) return true
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
        return null
      })()`), 30_000, '換到自種的三頁 PDF')
      await waitFor(() => cdp.eval(`document.querySelector('.ex-preview-pdf-canvas')?.width === 270`), 15_000, 'PDF 第一頁完成')
      await cdp.eval(`(() => {
        const next = document.querySelector('.ex-preview-pdf-bar button:last-child')
        next.click(); next.click()
      })()`)
      const lastPage = await waitFor(() => cdp.eval(`(() => {
        const label = document.querySelector('.ex-preview-pdf-bar span')?.textContent
        const width = document.querySelector('.ex-preview-pdf-canvas')?.width
        return label === '第 3 / 3 頁' && width === 324 ? { label, width } : null
      })()`), 15_000, 'PDF 連按翻到第三頁')
      assert(lastPage.width === 324, '連按翻頁後畫布與頁碼都對應最新頁', json(lastPage))
    }

    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    const closed = await waitFor(() => cdp.eval(`(() => {
      if (document.querySelector('.ex-preview-root')) return null
      return { media: document.querySelectorAll('.ex-preview-video, .ex-preview-audio').length + 1 }
    })()`), 15_000, '關閉預覽')
    assert(closed.media === 1, '關掉之後影音元素也收乾淨', json(closed))

    const detail = await cdp.eval(`(() => {
      const btn = document.getElementById('exDetailToggleBtn')
      const pane = document.getElementById('exDetail')
      const before = pane.getBoundingClientRect().width
      btn.click()
      return { before, after: pane.getBoundingClientRect().width, pressed: btn.getAttribute('aria-pressed') }
    })()`)
    assert(detail.after < detail.before, '詳情欄收得起來', json(detail))
    await cdp.eval(`document.getElementById('exDetailToggleBtn').click()`)

    console.log('\n[5] 雙欄與批次改名')
    await ui.goto(DUAL_DIR)
    await cdp.eval(`document.getElementById('exDualBtn').click()`)
    const paneShown = () => cdp.eval(`(() => {
      const pane = document.getElementById('exSecondPane')
      const list = document.getElementById('exSecondList')
      if (!pane || !list) return null
      return {
        hidden: pane.hidden,
        pressed: document.getElementById('exDualBtn').getAttribute('aria-pressed'),
        rows: list.querySelectorAll('.ex-row').length,
        pathLabel: document.getElementById('exSecondPath')?.textContent || '',
        emptyHidden: document.getElementById('exSecondEmpty')?.hidden,
        actions: [...document.querySelectorAll('.ex-second-actions button')].map((b) => b.textContent.trim())
      }
    })()`)
    // 右欄是非同步載入的，等它真的把檔案畫出來再判斷。
    const dual = await waitFor(
      async () => {
        const state = await paneShown()
        return state && !state.hidden && state.rows > 0 ? state : null
      },
      20_000,
      '雙欄打開'
    ).catch(async () => { throw new Error(`右欄沒列出檔案 — ${json(await paneShown())}`) })
    assert(dual.pressed === 'true', '雙欄鈕有 aria-pressed', json(dual))
    assert(dual.actions.length === 4, '跨欄的四顆操作鈕都在', json(dual.actions))
    assert(dual.rows > 0, '右欄也列得出檔案', json(dual))

    const leftBefore = await cdp.eval(`document.querySelector('.ex-tab.is-active')?.dataset.path || ''`)
    assert(leftBefore === DUAL_DIR, '左欄停在自己的資料夾', json(leftBefore))

    // 右欄自己走到別的資料夾：左欄不能跟著動，跨欄搬檔才有意義。
    await cdp.eval(`document.getElementById('exSecondUp').click()`)
    await waitFor(() => cdp.eval(`(() => {
      const row = [...document.querySelectorAll('#exSecondList .ex-row')]
        .find((r) => r.dataset.name === 'target-folder')
      if (!row) return null
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
      return true
    })()`), 20_000, '右欄走進 target-folder')
    const rightAt = await waitFor(async () => {
      const label = await cdp.eval(`document.getElementById('exSecondPath')?.textContent || ''`)
      return String(label).toLowerCase() === TARGET_DIR.toLowerCase() ? label : null
    }, 20_000, '右欄停在 target-folder')
    assert(rightAt, '右欄自己切到另一個資料夾', json(rightAt))
    assert(await cdp.eval(`document.querySelector('.ex-tab.is-active')?.dataset.path === ${json(DUAL_DIR)}`),
      '右欄換路徑時左欄沒被拖著走')

    assert(await ui.clickRow('dual-1.txt'), '左欄選得到檔案')
    await ui.clickRow('dual-2.txt', { ctrl: true })
    const moved = await cdp.eval(`(() => {
      const btn = document.getElementById('exMoveToSecond')
      if (!btn || btn.disabled) return false
      btn.click()
      return true
    })()`)
    assert(moved, '「搬到右欄」按得下去')
    await waitFor(
      () => (!fs.existsSync(path.join(DUAL_DIR, 'dual-1.txt')) ? true : null),
      30_000,
      '左欄的檔真的搬走'
    )
    assert(!fs.existsSync(path.join(DUAL_DIR, 'dual-1.txt')), '搬到右欄之後左欄不再有 dual-1.txt')
    assert(fs.existsSync(path.join(TARGET_DIR, 'dual-1.txt')) && fs.existsSync(path.join(TARGET_DIR, 'dual-2.txt')),
      '兩個檔真的落在右欄的資料夾')
    assert(await cdp.eval(`document.querySelector('.ex-tab.is-active')?.dataset.path === ${json(DUAL_DIR)}`),
      '跨欄搬檔之後左欄還停在原地')

    await cdp.eval(`document.getElementById('exDualBtn').click()`)

    // 批次改名：選兩個檔，對話框要先列出新舊名稱才准送出。
    await ui.goto(TARGET_DIR)
    assert(await ui.clickRow('copy-a.txt'), '批次改名選得到第一個')
    await ui.clickRow('copy-b.txt', { ctrl: true })
    assert(await ui.cmd('批次改名'), '命令列有「批次改名」')
    const dialog = await waitFor(() => cdp.eval(`(() => {
      const box = document.querySelector('dialog.ex-batch-dialog')
      if (!box) return null
      return {
        rows: [...box.querySelectorAll('.ex-batch-row')].map((r) => r.textContent),
        applyDisabled: box.querySelector('.btn-primary')?.disabled
      }
    })()`), 20_000, '批次改名對話框')
    assert(dialog.rows.length === 2, '列出兩筆新舊名稱', json(dialog.rows))
    assert(dialog.applyDisabled === true, '還沒改任何欄位時不准套用', json(dialog.applyDisabled))
    const renamed = await cdp.eval(`(() => {
      const box = document.querySelector('dialog.ex-batch-dialog')
      const prefix = [...box.querySelectorAll('input')][0]
      prefix.value = 'vi-'
      prefix.dispatchEvent(new Event('input', { bubbles: true }))
      const apply = box.querySelector('.btn-primary')
      if (apply.disabled) return false
      apply.click()
      return true
    })()`)
    assert(renamed, '填了前綴之後可以套用')
    await waitFor(() => (fs.existsSync(path.join(TARGET_DIR, 'vi-copy-a.txt')) ? true : null), 20_000, '改名落地')
    assert(fs.existsSync(path.join(TARGET_DIR, 'vi-copy-a.txt')) && fs.existsSync(path.join(TARGET_DIR, 'vi-copy-b.txt')),
      '兩個檔都真的改了名')

    console.log('\n[6] 重開 App：分頁狀態還原得回來')
    const beforeRestart = await cdp.eval(`(() => ({
      tabs: [...document.querySelectorAll('.ex-tab')].map((t) => t.dataset.path),
      active: document.querySelector('.ex-tab.is-active')?.dataset.path || ''
    }))()`)
    const renderErrors = cdp.errors.filter((text) => !/DevTools|Autofill/.test(text))
    assert(renderErrors.length === 0, 'renderer 沒有未處理的例外', json(renderErrors.slice(0, 3)))

    cdp.close()
    stopTestApp(session.child)
    session = null
    await sleep(2_500)
    session = await launch()
    cdp = session.cdp
    ui = api(cdp)
    const afterRestart = await waitFor(() => cdp.eval(`(() => {
      const tabs = [...document.querySelectorAll('.ex-tab')].map((t) => t.dataset.path)
      return tabs.length ? { tabs, active: document.querySelector('.ex-tab.is-active')?.dataset.path || '' } : null
    })()`), 25_000, '重開之後的分頁')
    assert(afterRestart.tabs.length === beforeRestart.tabs.length,
      `重開之後分頁數一樣（${beforeRestart.tabs.length}）`, json([beforeRestart.tabs, afterRestart.tabs]))
    assert(afterRestart.active === beforeRestart.active, '重開之後停在同一個資料夾',
      json([beforeRestart.active, afterRestart.active]))

    console.log(`\nALL PASS — ${passed} 項`)
  } finally {
    try { session?.cdp?.close() } catch { /* 已關 */ }
    stopTestApp(session?.child)
    await sleep(800)
    removeTree(USER_DATA_DIR)
  }
}

main().catch((error) => {
  console.error(error.message || error)
  process.exitCode = 1
})
