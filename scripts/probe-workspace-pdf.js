'use strict'

/**
 * 實測：Electron 43 在 `sandbox: true` 的視窗裡，PDF 到底畫不畫得出來、要開什麼。
 *
 * 為什麼要先跑這一支：內建瀏覽器那條已經決定**不開 `webviewTag`**（視窗層級的安全開關），
 * PDF 預覽如果也需要一個窗級開關，那筆帳要先算清楚。而且 iframe 指到 PDF 失敗時
 * 畫面是**一片空白、不報錯**，跟「還在載入」長得一模一樣——用眼睛看不出差別。
 *
 * 判準：iframe 裡真的長出 Chromium 的 PDF 檢視器（`embed[type="application/pdf"]`）。
 *
 *   node_modules/electron/dist/electron.exe scripts/probe-workspace-pdf.js
 */

const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

/** 最小可用的單頁 PDF（自己拼，不抓外部檔案） */
function tinyPdf() {
  const objects = [
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R'
      + '/Resources<</Font<</F1 5 0 R>>>>>>endobj\n',
    '4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 20 40 Td (VoiceInk PDF) Tj ET\nendstream endobj\n',
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n'
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (const obj of objects) {
    offsets.push(body.length)
    body += obj
  }
  const xref = body.length
  let out = `${body}xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objects.length; i += 1) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const TMP = os.tmpdir()

/**
 * @param {{ plugins: boolean, mode: 'blob' | 'file', base64: string, pdfPath: string, tag: string }} req
 * @returns {Promise<{ viewer: boolean, height: number, note: string }>}
 */
async function attempt(req) {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      plugins: req.plugins
    }
  })
  // 走真的 file:// 頁（data: URL 在 plugins 開著時會 ERR_FAILED），跟正式 renderer 一致
  const html = '<!doctype html><meta http-equiv="Content-Security-Policy" '
    + 'content="default-src \'self\'; script-src \'self\' \'unsafe-inline\'; frame-src blob: file:">'
    + '<body style="margin:0"><iframe id="f" style="width:100%;height:600px;border:0"></iframe></body>'
  const page = path.join(TMP, `vi-probe-pdf-${req.tag}.html`)
  fs.writeFileSync(page, html, 'utf8')

  let note = ''
  let viewer = false
  let height = 0
  try {
    await win.loadFile(page)
    const fileUrl = `file:///${req.pdfPath.replace(/\\/g, '/')}`
    const script = `(async () => {
      const bin = atob(${JSON.stringify(req.base64)})
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
      const f = document.getElementById('f')
      f.src = ${JSON.stringify(req.mode)} === 'blob' ? blobUrl : ${JSON.stringify(fileUrl)}
      await new Promise((r) => setTimeout(r, 3000))
      try {
        const doc = f.contentDocument
        if (!doc) return { viewer: false, height: 0, note: 'contentDocument 拿不到' }
        const embed = doc.querySelector('embed[type="application/pdf"]')
        return {
          viewer: Boolean(embed),
          height: embed ? embed.getBoundingClientRect().height : 0,
          note: (doc.body ? doc.body.innerHTML : '').slice(0, 100)
        }
      } catch (e) {
        return { viewer: false, height: 0, note: 'cross-origin（多半代表真的換了檢視器）: ' + e.message }
      }
    })()`
    const r = await win.webContents.executeJavaScript(script)
    viewer = r.viewer
    height = r.height
    note = r.note
  } catch (error) {
    note = `載入失敗：${error.message}`
  }
  win.destroy()
  try { fs.unlinkSync(page) } catch { /* 清不掉就算了 */ }
  return { viewer, height, note }
}

app.whenReady().then(async () => {
  const pdf = tinyPdf()
  const pdfPath = path.join(TMP, 'vi-probe.pdf')
  fs.writeFileSync(pdfPath, pdf)
  console.log(`測試 PDF：${pdfPath}（${pdf.length} bytes）`)
  const base64 = pdf.toString('base64')

  const matrix = [
    { plugins: true, mode: 'blob', tag: 'on-blob' },
    { plugins: true, mode: 'file', tag: 'on-file' },
    { plugins: false, mode: 'blob', tag: 'off-blob' },
    { plugins: false, mode: 'file', tag: 'off-file' }
  ]
  for (const row of matrix) {
    // eslint-disable-next-line no-await-in-loop
    const r = await attempt({ ...row, base64, pdfPath })
    console.log(`\nplugins=${row.plugins} src=${row.mode}`)
    console.log(`  內建 PDF 檢視器：${r.viewer ? '有' : '沒有'}   高度：${Math.round(r.height)}`)
    console.log(`  備註：${r.note || '(空)'}`)
  }
  try { fs.unlinkSync(pdfPath) } catch { /* 清不掉就算了 */ }
  app.exit(0)
})
