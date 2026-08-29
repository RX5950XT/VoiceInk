/**
 * VoiceInk - 本地 GPU ASR（llama-server sidecar）
 *
 * 為什麼是 sidecar 而不是 in-process：
 * - npm 的 `sherpa-onnx-win-x64` 是 CPU-only 編譯，provider 傳 cuda 只會靜默退回 CPU
 * - 已裝的 `node-llama-cpp@3.20` 沒有 multimodal／audio API（dist 裡連 image 都沒有）
 * 所以 GPU ASR 只能靠 llama.cpp 官方的 `llama-server.exe`（Vulkan 版 34MB，自帶 CPU backend，
 * 不需要 CUDA／cuDNN），它本身就是 OpenAI 相容端點，我們只負責拉起來／關掉／送音訊。
 *
 * 對外介面刻意跟 `local-asr.js` 一模一樣（setStore/warm/unload/isLoaded/transcribe），
 * 這樣 `engine.js`／`file-transcribe.js` 只要換一個模組參考就好，不必到處寫 if。
 */

const { spawn } = require('child_process')
const net = require('net')
const { randomBytes } = require('crypto')
const models = require('./models')
const { float32ToWav, normalizeSamples } = require('./cloud-asr')
const { s2twp, shouldS2twpSource } = require('./opencc')

const ASR_MODEL_KEY = 'qwen3asrgpu'
const RUNTIME_KEY = 'llamaruntime'
const HOST = '127.0.0.1'
/** 第一次要把 2.4GB 權重讀進 VRAM，慢的機器要等一下 */
const READY_TIMEOUT_MS = 180000
const HEALTH_POLL_MS = 400
/** 單次請求逾時：28 秒音訊在 GPU 上是次秒級，這只是防卡死 */
const REQUEST_TIMEOUT_MS = 120000
/** 16k mono float32 → 兩分鐘 */
const MAX_SAMPLES = 16000 * 120
/** 保留最後幾行 stderr 給失敗時的診斷用（不外流給 renderer） */
const STDERR_KEEP_LINES = 20

/** @type {{ child: import('child_process').ChildProcess, port: number, apiKey: string } | null} */
let server = null
/** @type {Promise<void> | null} */
let startPromise = null
/** unload 遞增：in-flight 的 start 完成後 gen 不符就自己收掉 */
let startGen = 0
/** @type {string[]} */
let stderrTail = []
/**
 * `--list-devices` 的結果快取（每次啟動 App 問一次就夠）
 * @type {undefined | string | null}
 */
let cachedDevice

/** 介面與 `local-asr.js` 對齊用；sidecar 的設定全在 registry，不讀 store */
function setStore() {}

/**
 * 剝掉 Qwen3-ASR 經 llama-server 回來的 `language English<asr_text>` 前綴。
 * 上游還沒修（llama.cpp issue #26749），vLLM 那邊是在自己的實作裡剝掉的。
 * @param {string} text
 * @returns {string}
 */
function stripAsrTags(text) {
  if (typeof text !== 'string') return ''
  const marker = text.indexOf('<asr_text>')
  const body = marker >= 0 ? text.slice(marker + '<asr_text>'.length) : text
  return body.replace(/<\/asr_text>\s*$/, '').trim()
}

/**
 * 找一個沒人用的 port（讓 OS 挑，再馬上還回去）
 * @returns {Promise<number>}
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, HOST, () => {
      const { port } = /** @type {import('net').AddressInfo} */ (srv.address())
      srv.close(() => resolve(port))
    })
  })
}

/**
 * 問 llama.cpp 有哪些後端裝置，挑第一個非 CPU 的。
 *
 * **不能只靠 `--gpu-layers 99`**：b10666 實測若不指定 `--device`，就算機器上有
 * Vulkan 裝置也整包跑 CPU——prompt eval 7.4 tok/s（指定後 720 tok/s，快 97 倍）。
 * 兩次都不會印任何錯誤，只有看 tok/s 才發現。
 * @param {string} exe
 * @returns {Promise<string | null>}
 */
function detectDevice(exe) {
  if (cachedDevice !== undefined) return Promise.resolve(cachedDevice)
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(exe, ['--list-devices'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    child.stdout.on('data', (d) => { out += String(d) })
    child.on('error', () => resolve((cachedDevice = null)))
    child.on('close', () => {
      // 行格式：`  Vulkan0: NVIDIA GeForce RTX 5060 Ti (16265 MiB, 15350 MiB free)`
      const match = out.match(/^\s*((?:Vulkan|CUDA|ROCm|SYCL|Metal)\d+):/m)
      resolve((cachedDevice = match ? match[1] : null))
    })
    setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, 10000)
  })
}

/**
 * @param {number} port
 * @returns {Promise<boolean>}
 */
async function healthOk(port) {
  try {
    const res = await fetch(`http://${HOST}:${port}/health`, {
      signal: AbortSignal.timeout(2000)
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * 模型與執行環境都要在
 * @returns {{ exe: string, gguf: string, mmproj: string }}
 */
function resolvePaths() {
  if (!models.isDownloaded(RUNTIME_KEY)) {
    throw new Error('尚未安裝 llama.cpp 執行環境，請到設定 → 本地模型下載')
  }
  if (!models.isDownloaded(ASR_MODEL_KEY)) {
    throw new Error('本地 GPU 語音模型尚未下載，請到設定 → 本地模型下載')
  }
  const exe = models.filePath(RUNTIME_KEY, 'binary')
  const gguf = models.filePath(ASR_MODEL_KEY, 'gguf')
  const mmproj = models.filePath(ASR_MODEL_KEY, 'mmproj')
  if (!exe || !gguf || !mmproj) throw new Error('llama-server 路徑設定不完整')
  return { exe, gguf, mmproj }
}

/**
 * 啟動 sidecar 並等它 ready
 * @returns {Promise<{ ok: boolean, warnings: string[] }>}
 */
async function warm() {
  if (server) return { ok: true, warnings: [] }
  if (startPromise) {
    try {
      await startPromise
    } catch { /* 由下方的 isLoaded 判定 */ }
    return { ok: !!server, warnings: [] }
  }

  const myGen = startGen
  startPromise = (async () => {
    const { exe, gguf, mmproj } = resolvePaths()
    const device = await detectDevice(exe)
    const port = await freePort()
    // sidecar 綁 127.0.0.1，但仍強制金鑰：同機的其他程序也不該能用它
    const apiKey = randomBytes(24).toString('hex')

    const args = [
      '-m', gguf,
      '--mmproj', mmproj,
      '--host', HOST,
      '--port', String(port),
      '--api-key', apiKey,
      '-c', '8192',
      '--gpu-layers', '99'
    ]
    if (device) args.push('--device', device)

    stderrTail = []
    const child = spawn(exe, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    child.stderr.on('data', (d) => {
      stderrTail.push(...String(d).split('\n'))
      if (stderrTail.length > STDERR_KEEP_LINES) {
        stderrTail = stderrTail.slice(-STDERR_KEEP_LINES)
      }
    })

    let exited = false
    child.on('exit', () => { exited = true })
    child.on('error', () => { exited = true })

    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (exited) throw new Error('llama-server 啟動失敗（程序已結束）')
      if (await healthOk(port)) {
        if (myGen !== startGen) {
          try { child.kill() } catch { /* ignore */ }
          throw new Error('llama-server 啟動已取消')
        }
        server = { child, port, apiKey }
        return
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS))
    }
    try { child.kill() } catch { /* ignore */ }
    throw new Error('llama-server 啟動逾時')
  })()

  try {
    await startPromise
    return { ok: true, warnings: [] }
  } catch (e) {
    return { ok: false, warnings: [/** @type {Error} */ (e).message || String(e)] }
  } finally {
    startPromise = null
  }
}

/**
 * @returns {boolean}
 */
function isLoaded() {
  return !!server
}

/**
 * 關掉 sidecar；in-flight 的 warm 也一併作廢
 * @returns {Promise<{ ok: boolean, warnings: string[] }>}
 */
async function unload() {
  startGen++
  const current = server
  server = null
  if (!current) return { ok: true, warnings: [] }
  await new Promise((resolve) => {
    const done = () => resolve()
    current.child.once('exit', done)
    try { current.child.kill() } catch { done() }
    // 砍不掉就別卡住呼叫端（下次 warm 會另開一個 port）
    setTimeout(done, 5000)
  })
  return { ok: true, warnings: [] }
}

/**
 * Float32 16k → WAV → multipart POST /v1/audio/transcriptions
 *
 * llama-server 只吃 multipart（不是 cloud-asr 那種 `input_audio` JSON），所以這裡自己送。
 * @param {{ samples: unknown, sampleRate?: number, lang?: string }} req
 * @returns {Promise<string>}
 */
async function transcribe(req) {
  const rate = Number(req?.sampleRate) || 16000
  if (rate !== 16000) throw new Error(`不支援的 sampleRate: ${rate}`)
  const samples = normalizeSamples(req?.samples)
  if (samples.length === 0) return ''
  if (samples.length > MAX_SAMPLES) {
    throw new Error(`音訊過長（${samples.length} samples，上限 ${MAX_SAMPLES}）`)
  }

  if (!server) {
    const { warnings } = await warm()
    if (!server) throw new Error(warnings[0] || 'llama-server 尚未啟動')
  }
  const { port, apiKey } = /** @type {{ port: number, apiKey: string }} */ (server)

  const form = new FormData()
  form.append('file', new Blob([float32ToWav(samples, rate)], { type: 'audio/wav' }), 'audio.wav')
  form.append('response_format', 'json')
  const lang = toAsrLang(req?.lang)
  if (lang) form.append('language', lang)

  let res
  try {
    res = await fetch(`http://${HOST}:${port}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (e) {
    if (/** @type {{ name?: string }} */ (e)?.name === 'TimeoutError') {
      throw new Error('本地 GPU 轉錄逾時')
    }
    throw new Error('本地 GPU 轉錄連線失敗，請重新開始轉錄')
  }

  const raw = await res.text()
  if (!res.ok) {
    // 只記狀態碼：body 由 sidecar 決定，不進 UI 也不進 log
    console.error(`[llama-asr] HTTP ${res.status}`)
    throw new Error(`本地 GPU 轉錄失敗（HTTP ${res.status}）`)
  }
  let json
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error('本地 GPU 轉錄回應不是有效 JSON')
  }
  let text = stripAsrTags(typeof json?.text === 'string' ? json.text : '')
  // Qwen3-ASR 中文一律吐簡體；CPU 那條（local-asr）本來就會轉，兩支要一致
  if (text && shouldS2twpSource(text, /** @type {string} */ (req?.lang))) text = s2twp(text)
  return text
}

/**
 * Qwen3-ASR 吃 ISO 語言碼；auto 就不指定讓它自己判
 * @param {unknown} lang
 * @returns {string | undefined}
 */
function toAsrLang(lang) {
  if (typeof lang !== 'string' || !lang || lang === 'auto') return undefined
  if (lang === 'zh-TW' || lang === 'zh-CN') return 'zh'
  if (/^[a-z]{2}$/i.test(lang)) return lang.toLowerCase()
  return undefined
}

/**
 * 最近的 stderr（診斷用，不送進 renderer）
 * @returns {string[]}
 */
function recentStderr() {
  return [...stderrTail]
}

module.exports = {
  setStore,
  warm,
  unload,
  isLoaded,
  transcribe,
  ASR_MODEL_KEY,
  // 測試／除錯用
  stripAsrTags,
  toAsrLang,
  detectDevice,
  recentStderr
}
