/**
 * e2e：本地 ASR 推論執行緒設定（真的重建 recognizer、真的跑一次轉錄）
 * 用法：npx electron scripts/e2e-asr-threads.js
 *
 * 順帶記錄：sherpa 官方 Windows 套件是 CPU-only 編譯，沒有 GPU 可選，
 * 所以這個設定是本地 ASR 唯一實際有效的效能旋鈕。
 */
const path = require('path')
const { spawn } = require('child_process')
const { app } = require('electron')

// 打包外執行時 app 名是 Electron → userData 會找不到 voiceink 的模型
app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))

const localAsr = require('../src/main/local-asr')
const edgeTts = require('../src/main/edge-tts')

/** 用 Edge TTS 現合成一句已知文字，再送回 ASR：真正的往返驗證 */
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

/** 假設定 store */
function makeStore(asrThreads) {
  return {
    data: { asrThreads },
    get(key, def) {
      return key in this.data ? this.data[key] : def
    },
    set(key, value) {
      this.data[key] = value
    }
  }
}

/**
 * mp3 bytes → 16k mono Float32Array（用專案已有的 ffmpeg-static）
 * @param {Buffer} mp3
 * @returns {Promise<Float32Array>}
 */
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

async function main() {
  await app.whenReady()
  try {
    const store = makeStore(0)
    localAsr.setStore(store)

    ok('未設定時走自動（≥2）', localAsr.resolveThreads() >= 2, String(localAsr.resolveThreads()))
    store.set('asrThreads', 4)
    ok('設 4 時回 4', localAsr.resolveThreads() === 4, String(localAsr.resolveThreads()))
    store.set('asrThreads', 999)
    ok('超出範圍回自動', localAsr.resolveThreads() !== 999)
    store.set('asrThreads', 1)
    ok('小於 2 回自動', localAsr.resolveThreads() >= 2)

    let samples = null
    try {
      const voice = edgeTts.DEFAULT_TTS_VOICES['zh-TW']
      const res = await edgeTts.synthesize({ text: SENTENCE, voice })
      samples = await decodeTo16k(Buffer.from(res.data))
      console.log(`        TTS 合成 ${(samples.length / 16000).toFixed(2)}s`)
    } catch (e) {
      console.log('  SKIP  TTS 合成失敗（需連網），略過實際轉錄：', e.message || e)
    }
    if (samples) {
      const texts = []
      for (const threads of [2, 8]) {
        store.set('asrThreads', threads)
        const warm = await localAsr.warm()
        ok(`threads=${threads} 預熱成功`, warm.ok, JSON.stringify(warm.warnings))
        const t0 = Date.now()
        const text = await localAsr.transcribe({ samples, sampleRate: 16000, lang: 'zh-TW' })
        console.log(`        threads=${threads} → ${Date.now() - t0}ms：${text}`)
        texts.push(text)
        ok(`threads=${threads} 轉出正確內容`, text.includes('公園') && text.includes('散步'), text)
      }
      ok('不同執行緒數結果一致', texts[0] === texts[1], JSON.stringify(texts))
      await localAsr.unload()
      ok('卸載成功', localAsr.isLoaded() === false)
    }
  } catch (e) {
    failed++
    console.error('\n未預期例外：', e)
  }
  console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'}  ${passed} passed, ${failed} failed\n`)
  app.exit(failed === 0 ? 0 : 1)
}

main()
