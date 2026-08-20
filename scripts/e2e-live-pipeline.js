/**
 * e2e：即時字幕 VAD → 真實本地 ASR
 * 用法：npx electron scripts/e2e-live-pipeline.js
 *
 * Edge TTS 分別合成兩句，中間插入靜音，再以 renderer 實際的 2048-sample frame
 * 餵進 vad.js；預期依停頓切成兩句，並由 Qwen3-ASR 辨識出各自關鍵字。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { spawn } = require('child_process')
const { app } = require('electron')

app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))

const localAsr = require('../src/main/local-asr')
const edgeTts = require('../src/main/edge-tts')
const SAMPLE_RATE = 16000
const FRAME_SIZE = 2048
const PHRASES = ['今天天氣很好。', '我們一起去公園散步吧。']

function loadVad() {
  const source = fs
    .readFileSync(path.join(__dirname, '../src/renderer/scripts/vad.js'), 'utf8')
    .replace(/^export /gm, '')
  const sandbox = { Float32Array }
  vm.createContext(sandbox)
  vm.runInContext(`${source}\n;globalThis.__createVad = createVad;`, sandbox)
  return sandbox.__createVad
}

/** @param {Buffer} mp3 */
function decodeTo16k(mp3) {
  const ffmpeg = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked')
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-f', 'f32le', '-ac', '1', '-ar', String(SAMPLE_RATE), 'pipe:1'
    ])
    const chunks = []
    let stderr = ''
    proc.stdout.on('data', chunk => chunks.push(chunk))
    proc.stderr.on('data', chunk => { stderr += chunk })
    proc.on('error', reject)
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg exit ${code}: ${stderr.trim()}`))
      const buffer = Buffer.concat(chunks)
      const samples = new Float32Array(buffer.length / 4)
      for (let i = 0; i < samples.length; i++) samples[i] = buffer.readFloatLE(i * 4)
      resolve(samples)
    })
    proc.stdin.on('error', () => {})
    proc.stdin.end(mp3)
  })
}

/** @param {Float32Array[]} arrays */
function concat(arrays) {
  const out = new Float32Array(arrays.reduce((total, item) => total + item.length, 0))
  let offset = 0
  for (const item of arrays) {
    out.set(item, offset)
    offset += item.length
  }
  return out
}

/** 與 live-caption.js 相同的低音量補償。 @param {Float32Array} samples */
function applyGain(samples) {
  let peak = 0
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]))
  if (peak >= 0.3 || peak === 0) return
  const gain = Math.min(0.9 / peak, 8)
  for (let i = 0; i < samples.length; i++) samples[i] *= gain
}

async function main() {
  await app.whenReady()
  let failed = false
  try {
    const voice = edgeTts.DEFAULT_TTS_VOICES['zh-TW']
    const clips = []
    for (const phrase of PHRASES) {
      const result = await edgeTts.synthesize({ text: phrase, voice })
      const samples = await decodeTo16k(Buffer.from(result.data))
      clips.push(samples)
      console.log(`  TTS  ${phrase} ${(samples.length / SAMPLE_RATE).toFixed(2)}s`)
    }

    const silence = (ms) => new Float32Array(Math.round((ms / 1000) * SAMPLE_RATE))
    const input = concat([silence(500), clips[0], silence(700), clips[1], silence(700)])
    const createVad = loadVad()
    const vad = createVad({ sampleRate: SAMPLE_RATE })
    const utterances = []
    for (let offset = 0; offset < input.length; offset += FRAME_SIZE) {
      const frame = new Float32Array(FRAME_SIZE)
      frame.set(input.subarray(offset, Math.min(input.length, offset + FRAME_SIZE)))
      const result = vad.push(frame)
      if (result.utterance) utterances.push(result.utterance)
    }

    console.log(`  VAD  切出 ${utterances.length} 句：${utterances.map(u => `${(u.length / SAMPLE_RATE).toFixed(2)}s`).join(', ')}`)
    assert.strictEqual(utterances.length, 2, `預期 2 句，實際 ${utterances.length} 句`)

    localAsr.setStore({ get: (key, fallback) => key === 'asrThreads' ? 0 : fallback })
    const warm = await localAsr.warm()
    assert.ok(warm.ok, warm.warnings.join('; '))

    const texts = []
    for (const samples of utterances) {
      applyGain(samples)
      const text = await localAsr.transcribe({
        samples,
        sampleRate: SAMPLE_RATE,
        lang: 'zh-TW'
      })
      texts.push(text)
      console.log(`  ASR  ${text}`)
    }
    assert.ok(texts[0].includes('天氣'), `第一句缺少「天氣」：${texts[0]}`)
    assert.ok(texts[1].includes('公園') && texts[1].includes('散步'), `第二句辨識錯誤：${texts[1]}`)
    console.log('\nALL PASS  VAD 2/2，ASR 關鍵字 3/3\n')
  } catch (error) {
    failed = true
    console.error('\nFAILED', error.stack || error, '\n')
  } finally {
    await localAsr.unload().catch(() => {})
    app.exit(failed ? 1 : 0)
  }
}

main()
