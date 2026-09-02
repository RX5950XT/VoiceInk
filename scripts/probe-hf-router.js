'use strict'

/**
 * llama-server 的 **router 模式**到底長什麼樣（實測，不猜）。
 *
 * 「HF模型」分頁整個架構都押在這上面：不指定 `-m` 啟動＋`--models-dir` 就是一個
 * 會自己發現模型、依請求路由、可載入／卸載的多模型伺服器——如果它真的照文件那樣運作，
 * 我們就完全不必自己寫多模型程序管理器。所以這支要先跑，而且要印出真實回應。
 *
 * 要回答的問題：
 *   [A] 沒有 `-m` 起得來嗎？`/health` 回什麼？
 *   [B] `--models-dir` 掃到的模型 **id 怎麼來的**（檔名？資料夾名？）
 *   [C] `GET /models` 的真實 JSON 形狀（status／architecture／source）
 *   [D] `--api-key` 在 router 上有沒有效（含子程序）
 *   [E] `--models-preset` 的 INI 吃不吃得到，`[*]` 與 `[<名字>]` 誰贏
 *   [F] `POST /models/load` ／ `/models/unload` 的請求與回應形狀
 *   [G] `GET /models/sse` 推什麼
 *   [H] `POST /v1/chat/completions` 帶 `model` 能不能路由並自動載入
 *   [I] 多模態子資料夾（model.gguf + mmproj-*.gguf）會不會被當成一顆
 *   [J] 收程序：kill router 之後子程序有沒有一起走
 *
 * 用法：`node scripts/probe-hf-router.js`
 *   `--keep` 跑完不刪暫存資料夾（要自己看 presets.ini 時用）
 */

const { spawn, execFileSync } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')
const net = require('net')

const HOST = '127.0.0.1'
const KEEP = process.argv.includes('--keep')

const MODELS_ROOT = path.join(process.env.APPDATA || os.homedir(), 'voiceink', 'models')
const RUNTIME_DIR = path.join(MODELS_ROOT, 'llamaruntime')
const SERVER_EXE = path.join(RUNTIME_DIR, 'llama-server.exe')

/** 拿現有 registry 裡最小的一顆 GGUF 來當白老鼠（不下載任何東西） */
const CANDIDATE_GGUF = [
  ['linguaforge08q4', path.join(MODELS_ROOT, 'linguaforge08q4', 'gguf-v5e', 'linguaforge-v5e-0.8b-Q4_K_M.gguf')],
  ['qwen35translate', path.join(MODELS_ROOT, 'qwen35translate', 'Qwen3.5-0.8B-Q4_K_M.gguf')],
  ['qwen354b', path.join(MODELS_ROOT, 'qwen354b', 'Qwen3.5-4B-Q4_K_M.gguf')]
]
/** 多模態那一顆（ASR 的，但檔案佈局跟 VLM 一樣：gguf ＋ mmproj） */
const MM_GGUF = path.join(MODELS_ROOT, 'qwen3asrgpu', 'Qwen3-ASR-1.7B-Q8_0.gguf')
const MM_PROJ = path.join(MODELS_ROOT, 'qwen3asrgpu', 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function note(tag, message) {
  console.log(`  ${tag} ${message}`)
}
function fail(tag, message) {
  failures += 1
  console.log(`  ${tag} FAIL ${message}`)
}
/** 大 JSON 只印前幾百字，但關鍵欄位另外挑出來 */
function dump(label, value, limit = 1200) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  console.log(`    ${label}: ${text.length > limit ? text.slice(0, limit) + ' …(截斷)' : text}`)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, HOST, () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/**
 * @param {string} url
 * @param {{ method?: string, body?: unknown, apiKey?: string, timeoutMs?: number }} [opt]
 */
async function call(url, opt = {}) {
  const headers = {}
  if (opt.apiKey) headers.Authorization = `Bearer ${opt.apiKey}`
  if (opt.body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(url, {
    method: opt.method || 'GET',
    headers,
    body: opt.body === undefined ? undefined : JSON.stringify(opt.body),
    signal: AbortSignal.timeout(opt.timeoutMs || 30000)
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 不是 JSON 就留 text */ }
  return { status: res.status, json, text }
}

/**
 * 起一個 router
 * @param {{ dir: string, presetPath?: string, apiKey?: string, extra?: string[] }} opt
 */
async function startRouter(opt) {
  const port = await freePort()
  const args = [
    '--host', HOST,
    '--port', String(port),
    '--models-dir', opt.dir,
    '--no-webui'
  ]
  if (opt.presetPath) args.push('--models-preset', opt.presetPath)
  if (opt.apiKey) args.push('--api-key', opt.apiKey)
  if (opt.extra) args.push(...opt.extra)

  const stderrTail = []
  const child = spawn(SERVER_EXE, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const keep = (d) => {
    stderrTail.push(...String(d).split('\n').filter(Boolean))
    while (stderrTail.length > 40) stderrTail.shift()
  }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)

  let exited = false
  child.on('exit', () => { exited = true })

  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if (exited) throw new Error(`router 立刻結束了：\n${stderrTail.slice(-15).join('\n')}`)
    try {
      const res = await fetch(`http://${HOST}:${port}/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok || res.status === 503) return { child, port, stderrTail, healthStatus: res.status }
    } catch { /* 還沒起來 */ }
    await sleep(400)
  }
  try { child.kill() } catch { /* ignore */ }
  throw new Error(`router 啟動逾時：\n${stderrTail.slice(-15).join('\n')}`)
}

/** 只殺自己 spawn 的那棵樹 */
function killTree(child) {
  if (!child?.pid) return
  try { execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch { /* 已結束 */ }
}

/** 目前有幾個 llama-server 在跑（用來驗 [J] 子程序有沒有一起走） */
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

async function main() {
  if (!fs.existsSync(SERVER_EXE)) {
    console.log('SKIP：找不到 llama-server.exe，請先到設定 → 本地模型安裝「llama.cpp 執行環境」')
    process.exit(0)
  }
  const version = execFileSync(SERVER_EXE, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString().trim().split('\n')[0]
  console.log(`llama-server: ${version}\n`)

  const picked = CANDIDATE_GGUF.find(([, p]) => fs.existsSync(p))
  if (!picked) {
    console.log('SKIP：本機沒有任何可用的 GGUF（需要 linguaforge08q4／qwen35translate／qwen354b 其中一顆）')
    process.exit(0)
  }
  const [pickedKey, pickedGguf] = picked
  console.log(`白老鼠模型：${pickedKey} → ${path.basename(pickedGguf)}\n`)

  // ---- 佈置暫存 models-dir：一顆單檔（junction 省複製）、一顆多模態子資料夾 ----
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-router-'))
  const modelsDir = path.join(root, 'hf-models')
  fs.mkdirSync(modelsDir, { recursive: true })

  // 單檔：直接硬連結（同碟）或複製
  const flatName = 'probe-flat-model.gguf'
  const flatPath = path.join(modelsDir, flatName)
  try { fs.linkSync(pickedGguf, flatPath) } catch { fs.copyFileSync(pickedGguf, flatPath) }

  // 子資料夾：資料夾名 ≠ 檔名，才驗得出 id 是從哪來的
  const dirName = 'Probe-Folder-Model'
  const subDir = path.join(modelsDir, dirName)
  fs.mkdirSync(subDir, { recursive: true })
  const innerName = 'weights-inside.gguf'
  try { fs.linkSync(pickedGguf, path.join(subDir, innerName)) } catch { fs.copyFileSync(pickedGguf, path.join(subDir, innerName)) }

  // 多模態：gguf ＋ mmproj 同一個子資料夾
  let mmDirName = null
  if (fs.existsSync(MM_GGUF) && fs.existsSync(MM_PROJ)) {
    mmDirName = 'Probe-Multimodal'
    const mmDir = path.join(modelsDir, mmDirName)
    fs.mkdirSync(mmDir, { recursive: true })
    for (const [src, dst] of [[MM_GGUF, 'model.gguf'], [MM_PROJ, 'mmproj-Q8_0.gguf']]) {
      const target = path.join(mmDir, dst)
      try { fs.linkSync(src, target) } catch { fs.copyFileSync(src, target) }
    }
  }

  const apiKey = 'probe-secret-' + Math.random().toString(16).slice(2)
  const presetPath = path.join(root, 'presets.ini')
  // [E]：`[*]` 給一個好認的 ctx，模型自己的區段蓋掉它 → 看 /models 的 status.args
  fs.writeFileSync(presetPath, [
    'version = 1',
    '',
    '[*]',
    'c = 1024',
    'flash-attn = on',
    '',
    // 單檔那筆刻意用**長選項名**：`plan.toPresetArgs` 產的是 `ctx-size`／`gpu-layers`，
    // 只驗過短名 `c` 的話等於沒驗到我們真正會寫出去的那份 INI
    `[${flatName.replace(/\.gguf$/, '')}]`,
    'ctx-size = 3072',
    'gpu-layers = 0',
    '',
    `[${dirName}]`,
    'c = 2048',
    ''
  ].join('\n'), 'utf8')

  const before = countLlamaServers()
  let router = null
  try {
    console.log('[A] 不給 -m，只給 --models-dir 起 router')
    router = await startRouter({ dir: modelsDir, presetPath, apiKey })
    note('[A]', `起來了，port=${router.port}，/health → HTTP ${router.healthStatus}`)

    // ---- [D] 金鑰 ----
    console.log('\n[D] --api-key 有沒有效')
    const noKey = await call(`http://${HOST}:${router.port}/models`)
    const withKey = await call(`http://${HOST}:${router.port}/models`, { apiKey })
    note('[D]', `不帶金鑰 → HTTP ${noKey.status}；帶金鑰 → HTTP ${withKey.status}`)
    if (noKey.status === 200) fail('[D]', 'router 沒有擋沒帶金鑰的請求（我們要靠它擋同機其他程序）')
    if (withKey.status !== 200) fail('[D]', `帶了正確金鑰還是 HTTP ${withKey.status}`)

    // ---- [B][C] 模型 id 從哪來、JSON 形狀 ----
    console.log('\n[B][C] GET /models 的真實回應')
    const list = withKey.json
    dump('原始 JSON', list, 2500)
    const rows = Array.isArray(list?.data) ? list.data : (Array.isArray(list?.models) ? list.models : [])
    note('[C]', `共 ${rows.length} 筆`)
    for (const row of rows) {
      note('[B]', `id=${JSON.stringify(row?.id)} source=${row?.source} status=${row?.status?.value} ` +
        `modalities=${JSON.stringify(row?.architecture?.input_modalities)} args=${JSON.stringify(row?.status?.args)}`)
    }
    const ids = rows.map((r) => String(r?.id || ''))
    if (!ids.length) fail('[B]', '一顆都沒掃到（--models-dir 沒生效？）')

    // ---- [E] preset 吃不吃得到 ----
    console.log('\n[E] --models-preset 的值有沒有進到 status.args')
    const flatRow = rows.find((r) => String(r?.id || '').includes('probe-flat-model'))
    const dirRow = rows.find((r) => String(r?.id || '').includes('Probe-Folder-Model') || String(r?.id || '').includes('weights-inside'))
    for (const [label, row, want] of [['單檔（長選項名）', flatRow, '3072'], ['子資料夾（短選項名）', dirRow, '2048']]) {
      if (!row) { fail('[E]', `${label} 那筆沒出現在清單裡`); continue }
      const args = (row?.status?.args || []).join(' ')
      const hit = args.includes(want)
      note('[E]', `${label} id=${row.id} args=${JSON.stringify(row?.status?.args)} → ${hit ? `吃到 ctx=${want}` : `沒看到 ctx=${want}`}`)
      if (!hit) note('[E]', '  （args 可能只在載入後才填，下面載入完會再看一次）')
    }

    // ---- [I] 多模態 ----
    if (mmDirName) {
      console.log('\n[I] 多模態子資料夾')
      const mmRow = rows.find((r) => String(r?.id || '').includes('Probe-Multimodal'))
      if (!mmRow) fail('[I]', '多模態那個子資料夾沒被當成一顆模型')
      else note('[I]', `id=${mmRow.id} modalities=${JSON.stringify(mmRow?.architecture?.input_modalities)}`)
    } else {
      note('[I]', 'SKIP（本機沒裝 qwen3asrgpu，沒有 mmproj 可用）')
    }

    // ---- [G] SSE ----
    console.log('\n[G] GET /models/sse')
    try {
      const controller = new AbortController()
      const sse = await fetch(`http://${HOST}:${router.port}/models/sse`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal
      })
      note('[G]', `HTTP ${sse.status} content-type=${sse.headers.get('content-type')}`)
      if (sse.ok && sse.body) {
        const reader = sse.body.getReader()
        const first = await Promise.race([reader.read(), sleep(4000).then(() => null)])
        if (first?.value) dump('第一段', new TextDecoder().decode(first.value), 600)
        else note('[G]', '4 秒內沒有推任何東西（可能只在狀態變動時推）')
      }
      controller.abort()
    } catch (e) {
      note('[G]', `讀不到：${e.message}`)
    }

    // ---- [F] load / unload ----
    const target = ids.find((id) => id.includes('probe-flat-model')) || ids[0]
    console.log(`\n[F] POST /models/load（目標：${target}）`)
    const loadRes = await call(`http://${HOST}:${router.port}/models/load`, {
      method: 'POST', apiKey, body: { model: target }, timeoutMs: 180000
    })
    note('[F]', `HTTP ${loadRes.status}`)
    dump('load 回應', loadRes.json ?? loadRes.text, 800)

    // 等它真的 loaded
    let loadedRow = null
    for (let i = 0; i < 60; i += 1) {
      const again = await call(`http://${HOST}:${router.port}/models`, { apiKey })
      loadedRow = (again.json?.data || []).find((r) => String(r?.id) === target)
      if (loadedRow?.status?.value === 'loaded') break
      if (loadedRow?.status?.failed) break
      await sleep(1000)
    }
    note('[F]', `載入後 status=${loadedRow?.status?.value} failed=${loadedRow?.status?.failed}`)
    dump('載入後這一筆', loadedRow, 1500)
    if (loadedRow?.status?.value !== 'loaded') fail('[F]', '載不起來')
    else note('[E]', `載入後 args=${JSON.stringify(loadedRow?.status?.args)}`)

    const during = countLlamaServers()
    note('[J]', `載入中的 llama-server 程序數：${during}（起 router 前 ${before}）`)

    // ---- [H] 路由 + 自動載入 ----
    console.log('\n[H] POST /v1/chat/completions 帶 model 路由')
    const chat = await call(`http://${HOST}:${router.port}/v1/chat/completions`, {
      method: 'POST',
      apiKey,
      timeoutMs: 180000,
      body: {
        model: target,
        messages: [{ role: 'user', content: 'Say OK.' }],
        max_tokens: 16,
        stream: false
      }
    })
    note('[H]', `HTTP ${chat.status}`)
    const said = chat.json?.choices?.[0]?.message?.content
    if (chat.status === 200 && typeof said === 'string') note('[H]', `模型回：${JSON.stringify(said.slice(0, 120))}`)
    else { fail('[H]', '沒有回出內容'); dump('回應', chat.json ?? chat.text, 800) }

    // /v1/models 形狀（renderer 端只會看到這個）
    const v1 = await call(`http://${HOST}:${router.port}/v1/models`, { apiKey })
    console.log('\n[C] GET /v1/models（OpenAI 相容形狀）')
    dump('回應', v1.json ?? v1.text, 900)

    // 未載入的那一顆直接聊 → 驗自動載入
    const other = ids.find((id) => id !== target)
    if (other) {
      console.log(`\n[H] 沒先 load，直接對「${other}」發請求（驗 autoload）`)
      const auto = await call(`http://${HOST}:${router.port}/v1/chat/completions`, {
        method: 'POST', apiKey, timeoutMs: 180000,
        body: { model: other, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 8, stream: false }
      })
      note('[H]', `HTTP ${auto.status} → ${auto.status === 200 ? '會自動載入' : '不會自動載入'}`)
      if (auto.status !== 200) dump('回應', auto.json ?? auto.text, 500)
    }

    // ---- [F] unload ----
    console.log('\n[F] POST /models/unload')
    const unloadRes = await call(`http://${HOST}:${router.port}/models/unload`, {
      method: 'POST', apiKey, body: { model: target }, timeoutMs: 60000
    })
    note('[F]', `HTTP ${unloadRes.status}`)
    dump('unload 回應', unloadRes.json ?? unloadRes.text, 500)

    // ---- reload（手動拖檔進資料夾）----
    console.log('\n[B] 手動丟一個檔進去後 GET /models?reload=1 認不認得')
    const addedName = 'probe-dropped-in.gguf'
    try { fs.linkSync(pickedGguf, path.join(modelsDir, addedName)) } catch { fs.copyFileSync(pickedGguf, path.join(modelsDir, addedName)) }
    const reload = await call(`http://${HOST}:${router.port}/models?reload=1`, { apiKey })
    const reloadIds = (reload.json?.data || []).map((r) => String(r?.id))
    const found = reloadIds.some((id) => id.includes('probe-dropped-in'))
    note('[B]', `reload 後 ${reloadIds.length} 筆，新檔${found ? '有' : '沒'}出現：${JSON.stringify(reloadIds)}`)
    if (!found) fail('[B]', '?reload=1 沒有重新掃描（手動拖檔進資料夾的功能要另想辦法）')
  } catch (error) {
    failures += 1
    console.error('\nFAIL', error.message)
  } finally {
    // ---- [J] 收程序 ----
    if (router) {
      killTree(router.child)
      await sleep(2500)
      const after = countLlamaServers()
      console.log(`\n[J] kill router 之後的 llama-server 程序數：${after}（起 router 前 ${before}）`)
      if (after > before) fail('[J]', '有子程序沒被收掉——runtime.js 要自己追子 pid')
      if (router.stderrTail.length) {
        console.log('\n最後幾行 stderr（診斷用）：')
        console.log(router.stderrTail.slice(-12).map((l) => '  ' + l).join('\n'))
      }
    }
    if (KEEP) console.log(`\n暫存保留在：${root}`)
    else fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    console.log(`\n${failures === 0 ? 'PASS' : `FAIL（${failures} 項）`}`)
    process.exit(failures === 0 ? 0 : 1)
  }
}

main()
