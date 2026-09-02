#!/usr/bin/env node
/**
 * VoiceInk — 「HF模型」後端的端到端驗證（`npx electron scripts/e2e-hfmodels.js`）
 *
 * 真的起一台 llama.cpp router、真的載一顆本機的 GGUF、真的發一次 `/v1/chat/completions`。
 * mock 綠燈證明不了 router 長什麼樣，這一支才是「這條路真的通」的證據。
 *
 * **不碰使用者的模型庫**：`hfmodels.init()` 指到暫存資料夾，裡面的 GGUF 用硬連結
 * （連不了才複製）接回真的檔案，跑完整個暫存資料夾刪掉。
 * app 的 userData 仍指向真的 `voiceink`——`llamaruntime` 在那底下，換掉就找不到 llama-server。
 */

'use strict'

const { app } = require('electron')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
// `npx electron <script>` 時 app 名是 Electron，不設就找不到已下載的模型
app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))

const hfmodels = require(path.join(ROOT, 'src/main/hfmodels/index.js'))
const library = require(path.join(ROOT, 'src/main/hfmodels/library.js'))
const runtime = require(path.join(ROOT, 'src/main/hfmodels/runtime.js'))

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function countLlamaServers() {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "(Get-Process llama-server -ErrorAction SilentlyContinue | Measure-Object).Count"
    ], { windowsHide: true }).toString().trim()
    return Number(out) || 0
  } catch {
    return -1
  }
}

/** 拿現有 registry 裡最小的一顆當白老鼠（不下載任何東西） */
function findGguf() {
  const root = path.join(app.getPath('appData'), 'voiceink', 'models')
  const candidates = [
    path.join(root, 'linguaforge08q4', 'gguf-v5e', 'linguaforge-v5e-0.8b-Q4_K_M.gguf'),
    path.join(root, 'qwen35translate', 'Qwen3.5-0.8B-Q4_K_M.gguf'),
    path.join(root, 'qwen354b', 'Qwen3.5-4B-Q4_K_M.gguf')
  ]
  return candidates.find((p) => fs.existsSync(p)) || ''
}

const MODEL_ID = 'e2e-probe-model'

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-hfmodels-e2e-'))
  const before = countLlamaServers()
  try {
    hfmodels.init({ userDataPath: tmp })

    console.log('\n[A] 執行環境')
    const ready = hfmodels.runtimeReady()
    ok('llama.cpp 執行環境在', ready.ready === true, ready.reason)
    if (!ready.ready) return

    const device = await hfmodels.currentDevice()
    ok('問得出後端裝置', device === null || !!device.id,
      device ? `${device.id} ${device.name} ${device.freeMiB}/${device.totalMiB} MiB` : '沒有 GPU（會用 CPU）')

    console.log('\n[B] 模型庫（暫存，不碰使用者的）')
    const src = findGguf()
    if (!src) {
      console.log('  SKIP 本機沒有可用的 GGUF，後面全部跳過')
      return
    }
    const dir = library.dirFor(MODEL_ID)
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, path.basename(src))
    try { fs.linkSync(src, target) } catch { fs.copyFileSync(src, target) }
    ok('模型庫在暫存資料夾底下', library.root().startsWith(tmp), library.root())

    const locals = await hfmodels.listLocal()
    const mine = locals.find((m) => m.id === MODEL_ID)
    ok('掃得到剛放進去的模型', !!mine, JSON.stringify(locals.map((m) => m.id)))
    ok('讀得到檔頭（架構／層數）', !!mine?.arch && mine.plan !== null,
      mine ? `arch=${mine.arch} ctx=${mine.contextTrain}` : '')
    ok('算得出執行參數', (mine?.plan?.ctxSize || 0) > 0 && (mine?.plan?.gpuLayers || 0) >= 0,
      mine ? `ctx=${mine.plan.ctxSize} ngl=${mine.plan.gpuLayers} device=${mine.plan.device || 'CPU'}` : '')

    console.log('\n[C] presets.ini')
    const planned = await hfmodels.writePresets()
    const iniPath = path.join(tmp, 'hf-presets.ini')
    const ini = fs.readFileSync(iniPath, 'utf8')
    ok('寫得出 presets.ini', ini.includes(`[${MODEL_ID}]`), ini.split('\n').slice(0, 8).join(' | '))
    ok('參數有進去', /ctx-size = \d+/.test(ini) && /gpu-layers = \d+/.test(ini))
    ok('每顆模型都有一份決策', planned.some((p) => p.id === MODEL_ID))

    console.log('\n[D] 起 router')
    const started = await hfmodels.startRuntime()
    ok('router 起得來', started.running === true && started.port > 0, `port=${started.port}`)
    if (!started.running) {
      console.log('  診斷：', runtime.diagnostics().slice(-6).join(' | '))
      return
    }

    const rows = await hfmodels.refreshModels()
    const row = rows.find((r) => String(r.id) === MODEL_ID)
    ok('router 掃得到那顆模型', !!row, JSON.stringify(rows.map((r) => r.id)))
    ok('preset 有吃到（status.args 帶著我們寫的參數）',
      (row?.status?.args || []).join(' ').includes('--ctx-size'),
      JSON.stringify(row?.status?.args || []))

    console.log('\n[E] 載入並真的發一次請求')
    const loaded = await hfmodels.loadModel(MODEL_ID)
    ok('load 成功', loaded === true)

    const endpoint = hfmodels.endpoint()
    ok('endpoint 有 baseUrl 與金鑰（**只給 main 用**）', !!endpoint?.baseUrl && !!endpoint?.apiKey)
    ok('runtimeStatus 不含金鑰',
      JSON.stringify(hfmodels.runtimeStatus()) === JSON.stringify({ running: true, port: started.port }),
      JSON.stringify(hfmodels.runtimeStatus()))

    const noAuth = await fetch(`${endpoint.baseUrl}/v1/models`).catch(() => null)
    ok('不帶金鑰會被擋（同機其他程序也不該能用）', noAuth ? noAuth.status === 401 : false,
      noAuth ? `HTTP ${noAuth.status}` : '連不上')

    const chat = await fetch(`${endpoint.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_ID,
        messages: [{ role: 'user', content: 'Say OK.' }],
        max_tokens: 8,
        stream: false
      })
    })
    const chatJson = chat.ok ? await chat.json() : null
    ok('打得到 /v1/chat/completions', chat.status === 200, `HTTP ${chat.status}`)
    // **不要只斷言「content 是字串」**：空字串也是字串，模型根本沒跑也會過。
    // 看 `completion_tokens` 才知道它真的解碼了（這顆是翻譯模型，回空內容是正常的）
    ok('模型真的產出 token 了', Number(chatJson?.usage?.completion_tokens) > 0,
      `completion_tokens=${chatJson?.usage?.completion_tokens} content=`
      + JSON.stringify(chatJson?.choices?.[0]?.message?.content || '').slice(0, 60))

    const afterLoad = await hfmodels.listLocal()
    ok('列表看得出「載著」', afterLoad.find((m) => m.id === MODEL_ID)?.loaded === true)

    ok('unload 成功', await hfmodels.unloadModel(MODEL_ID) === true)

    console.log('\n[F] 收尾')
    hfmodels.stopRuntime()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    ok('router 關掉後狀態歸零', hfmodels.runtimeStatus().running === false)
    const after = countLlamaServers()
    ok('沒有留下 llama-server 孤兒程序', after <= before, `前 ${before} → 後 ${after}`)

    ok('刪得掉模型', await hfmodels.removeLocal(MODEL_ID) === true)
    ok('刪完模型庫就空了', (await hfmodels.listLocal()).length === 0)
  } finally {
    try { hfmodels.shutdown() } catch { /* 已經收掉了 */ }
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

app.whenReady()
  .then(main)
  .catch((error) => {
    failed++
    console.log(`  FAIL 拋錯 — ${error && error.stack}`)
  })
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`)
    app.exit(failed === 0 ? 0 : 1)
  })
