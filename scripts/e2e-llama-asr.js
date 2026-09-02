/**
 * e2e：本地 GPU ASR（llama-server sidecar）
 * 用法：npx electron scripts/e2e-llama-asr.js
 *
 * 真的把 llama-server 拉起來、真的送一段 Edge TTS 合成的音訊回來比對、真的確認關得掉。
 * 沒裝執行環境或模型時只跑純函式那幾條，不當成失敗。
 */
const path = require('path')
const { spawn, execSync } = require('child_process')
const { app } = require('electron')

// 打包外執行時 app 名是 Electron → userData 會找不到 voiceink 的模型
app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))

const llamaAsr = require('../src/main/llama-asr')
const asrSelect = require('../src/main/asr-select')
const models = require('../src/main/models')
const edgeTts = require('../src/main/edge-tts')

const SENTENCE = '今天天氣很好，我們一起去公園散步吧。'

let passed = 0
let failed = 0

function ok(name, cond, extra = '') {
  if (cond) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`)
  }
}

function makeStore(data) {
  return {
    data: { ...data },
    get(key, def) { return key in this.data ? this.data[key] : def },
    set(key, value) { this.data[key] = value }
  }
}

/** mp3 bytes → 16k mono Float32Array */
function decodeTo16k(mp3) {
  const ffmpeg = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked')
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-f', 'f32le', '-ac', '1', '-ar', '16000', 'pipe:1'
    ])
    const chunks = []
    proc.stdout.on('data', (c) => chunks.push(c))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exit ${code}`))
      const buf = Buffer.concat(chunks)
      const out = new Float32Array(buf.length / 4)
      for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4)
      resolve(out)
    })
    proc.stdin.on('error', () => {})
    proc.stdin.end(mp3)
  })
}

/** 系統上還有幾個 llama-server 在跑 */
function llamaServerCount() {
  try {
    const out = execSync(
      'powershell.exe -NoProfile -Command "(Get-Process llama-server -ErrorAction SilentlyContinue | Measure-Object).Count"',
      { windowsHide: true, encoding: 'utf8' }
    )
    return Number(String(out).trim()) || 0
  } catch {
    return 0
  }
}

async function main() {
  await app.whenReady()
  const before = llamaServerCount()
  try {
    // ── 純函式：不需要模型也能驗 ───────────────────────────────────────
    ok(
      '剝掉 llama-server 的 language/<asr_text> 前綴',
      llamaAsr.stripAsrTags('language Chinese<asr_text>咳咳咳。') === '咳咳咳。'
    )
    ok(
      '沒有標記時原樣回傳',
      llamaAsr.stripAsrTags('hello world') === 'hello world'
    )
    ok('非字串回空字串', llamaAsr.stripAsrTags(null) === '')
    ok(
      '語言碼：zh-TW→zh、auto→不指定',
      llamaAsr.toAsrLang('zh-TW') === 'zh' && llamaAsr.toAsrLang('auto') === undefined
    )

    // ── 模組選擇：只有 store 決定，renderer 說了不算 ─────────────────
    // 三個子分頁各存各的（fileAsr／liveAsr／dictationAsr），所以要指名 scope
    const cpuStore = makeStore({ liveAsr: 'local:qwen3asr' })
    const gpuStore = makeStore({ liveAsr: 'local:qwen3asrgpu', fileAsr: 'local:qwen3asr' })
    asrSelect.setStore(cpuStore)
    ok('預設走 sherpa（CPU）', asrSelect.currentKey('live') === 'qwen3asr')
    asrSelect.setStore(gpuStore)
    ok('選 GPU 模型時走 llama-server', asrSelect.pick('live') === llamaAsr)
    ok('同一份 store 裡別頁的選擇不受影響', asrSelect.pick('file') !== llamaAsr)
    asrSelect.setStore(makeStore({ liveAsr: 'local:../../evil' }))
    ok('未知 key 退回 CPU 那顆', asrSelect.currentKey('live') === 'qwen3asr')

    // ── registry：archive 型別的已安裝判定看 check 不看下載檔名 ───────
    const runtime = models.MODELS.llamaruntime
    ok('llamaruntime 是 archive 型別', runtime.archive === true)
    ok(
      'llamaruntime 用 check 判定已安裝（不是 zip 檔名）',
      Array.isArray(runtime.check) && runtime.check.includes('llama-server.exe') &&
      !runtime.check.some((f) => f.endsWith('.zip'))
    )
    ok(
      'GPU ASR 模型宣告了 requires',
      models.MODELS.qwen3asrgpu.requires === 'llamaruntime'
    )
    ok('LinguaForge Q8 已從 registry 移除', !models.MODELS.linguaforge08)
    ok('Q8 舊 key 不再通過白名單', models.isLlmKey('linguaforge08') === false)

    // ── 真的跑一次 ───────────────────────────────────────────────────
    const ready = models.isDownloaded('llamaruntime') && models.isDownloaded('qwen3asrgpu')
    if (!ready) {
      console.log('  SKIP  執行環境或模型未安裝，略過實跑（設定 → 本地模型可下載）')
    } else {
      asrSelect.setStore(gpuStore)
      const device = await llamaAsr.detectDevice(models.filePath('llamaruntime', 'binary'))
      console.log(`        偵測到的推論裝置：${device || '（沒有非 CPU 裝置）'}`)
      ok('至少偵測得到一個裝置字串或明確的 null', device === null || typeof device === 'string')

      const t0 = Date.now()
      const warm = await llamaAsr.warm()
      ok('sidecar 啟動成功', warm.ok, JSON.stringify(warm.warnings) + '\n' + llamaAsr.recentStderr().join('\n'))
      console.log(`        啟動耗時 ${Date.now() - t0}ms`)
      ok('啟動後 isLoaded 為 true', llamaAsr.isLoaded() === true)
      ok('系統上多了一個 llama-server', llamaServerCount() > before)

      if (warm.ok) {
        let samples = null
        try {
          const voice = edgeTts.DEFAULT_TTS_VOICES['zh-TW']
          const res = await edgeTts.synthesize({ text: SENTENCE, voice })
          samples = await decodeTo16k(Buffer.from(res.data))
          console.log(`        TTS 合成 ${(samples.length / 16000).toFixed(2)}s`)
        } catch (e) {
          console.log('  SKIP  TTS 合成失敗（需連網）：', e.message || e)
        }
        if (samples) {
          const t1 = Date.now()
          const text = await asrSelect.transcribe('live', { samples, sampleRate: 16000, lang: 'zh-TW' })
          const first = Date.now() - t1
          const t2 = Date.now()
          await asrSelect.transcribe('live', { samples, sampleRate: 16000, lang: 'zh-TW' })
          const audioSec = samples.length / 16000
          console.log(
            `        ${audioSec.toFixed(2)}s 音訊：首次 ${first}ms、第二次 ${Date.now() - t2}ms → ${text}`
          )
          ok('轉出正確內容', text.includes('公園') && text.includes('散步'), text)
          ok(
            '中文輸出轉成繁體（CPU 那條本來就會轉，兩支要一致）',
            !/[气们园]/.test(text),
            text
          )
          ok('輸出已剝掉 asr_text 標記', !text.includes('<asr_text>') && !/^language /.test(text), text)
        }
      }

      await llamaAsr.unload()
      ok('卸載後 isLoaded 為 false', llamaAsr.isLoaded() === false)
      await new Promise((r) => setTimeout(r, 1500))
      ok('程序真的收掉了', llamaServerCount() <= before, `before=${before} now=${llamaServerCount()}`)
    }
  } catch (e) {
    failed++
    console.error('\n未預期例外：', e)
  } finally {
    await llamaAsr.unload().catch(() => {})
  }
  console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'}  ${passed} passed, ${failed} failed\n`)
  app.exit(failed === 0 ? 0 : 1)
}

main()
