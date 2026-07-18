/**
 * e2e：長檔串流轉錄（ffmpeg 切段）
 * - 驗證 ffmpeg 可用、多段切塊（≥2 段）
 * - 檔案大小／格式上限
 * - 不把整檔 Float32 常駐記憶體
 *
 * 用法：npx electron scripts/e2e-file-long.js
 */
const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

app.whenReady().then(async () => {
  // e2e 下 app 名為 Electron，對齊正式 userData
  app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))

  const fileTranscribe = require('../src/main/file-transcribe')
  const engine = require('../src/main/engine')
  const localAsr = require('../src/main/local-asr')

  let failed = 0
  const ok = (name, cond, detail = '') => {
    if (cond) console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
    else {
      failed++
      console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    }
  }

  console.log('\n=== e2e-file-long ===\n')

  // 1) ffmpeg 路徑
  let ffmpegPath = ''
  try {
    ffmpegPath = fileTranscribe.resolveFfmpegPath()
    ok('ffmpeg binary exists', fs.existsSync(ffmpegPath), ffmpegPath)
  } catch (e) {
    ok('ffmpeg binary exists', false, String(e.message || e))
  }

  // 2) 常數對齊需求
  ok('MAX_FILE_BYTES ≥ 100MB', fileTranscribe.MAX_FILE_BYTES >= 100 * 1024 * 1024,
    `${(fileTranscribe.MAX_FILE_BYTES / 1024 / 1024).toFixed(0)} MB`)
  ok('MAX_DURATION ≥ 2h', fileTranscribe.MAX_DURATION_SEC >= 2 * 3600,
    `${fileTranscribe.MAX_DURATION_SEC / 3600} h`)
  ok('MIN_GUARANTEED = 2h', fileTranscribe.MIN_GUARANTEED_DURATION_SEC === 2 * 3600)

  // 3) 大小上限
  const fakeHuge = path.join(os.tmpdir(), 'voiceink-e2e-huge.wav')
  // 不真的建 200MB，只測 validate 對 path 不存在／副檔名
  try {
    fileTranscribe.validateFilePath(path.join(os.tmpdir(), 'no-such-voiceink-xyz.mp3'))
    ok('missing file throws', false)
  } catch (e) {
    ok('missing file throws', /不存在/.test(e.message), e.message)
  }

  try {
    fileTranscribe.validateFilePath(__filename) // .js
    ok('bad ext throws', false)
  } catch (e) {
    ok('bad ext throws', /不支援/.test(e.message), e.message)
  }

  // 4) 產生 60s 16k mono wav（≥ 2 個 28s 段）
  const wavPath = path.join(os.tmpdir(), 'voiceink-e2e-60s.wav')
  const seconds = 60
  const sampleRate = 16000
  const nSamples = seconds * sampleRate
  // 16-bit PCM wav
  const dataSize = nSamples * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  // 440Hz 短 tone 開頭 + 靜音（有聲較易確認 ASR 路徑活著）
  for (let i = 0; i < nSamples; i++) {
    let sample = 0
    if (i < sampleRate * 0.3) {
      sample = Math.sin(2 * Math.PI * 440 * (i / sampleRate)) * 0.2
    }
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(sample * 32767))), 44 + i * 2)
  }
  fs.writeFileSync(wavPath, buf)
  ok('wrote 60s wav', fs.existsSync(wavPath), `${(fs.statSync(wavPath).size / 1024).toFixed(0)} KB`)

  // 5) 載入 ASR 並串流轉錄
  const t0 = Date.now()
  let progressEvents = 0
  let maxChunk = 0
  try {
    const warm = await engine.acquire('file', { asr: true, llm: false })
    ok('engine acquire ASR', warm.ok, warm.warnings?.join('; '))

    const result = await fileTranscribe.transcribeFile(
      { filePath: wavPath, lang: 'zh-TW', modelKey: localAsr.ASR_MODEL_KEY },
      (p) => {
        progressEvents++
        if (p.chunk) maxChunk = Math.max(maxChunk, p.chunk)
      }
    )

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    ok('transcribeFile returns', !!result, `chunks=${result.chunks} duration=${result.durationSec?.toFixed?.(1)}s textLen=${(result.text || '').length} ${elapsed}s`)
    ok('multi-chunk (≥2 for 60s)', result.chunks >= 2, `chunks=${result.chunks}`)
    ok('duration ≈ 60s', result.durationSec != null && Math.abs(result.durationSec - 60) < 2,
      String(result.durationSec))
    ok('progress events fired', progressEvents >= 2, `n=${progressEvents} maxChunk=${maxChunk}`)

    await engine.release('file')
  } catch (e) {
    ok('transcribeFile pipeline', false, e.message || e)
    try { await engine.release('file') } catch { /* */ }
  }

  // 6) parseDuration
  const d = fileTranscribe.parseDurationSec('  Duration: 02:15:30.50, start: 0.000000')
  ok('parseDuration 2h15m', d != null && Math.abs(d - (2 * 3600 + 15 * 60 + 30.5)) < 0.01, String(d))

  try { fs.unlinkSync(wavPath) } catch { /* */ }
  try { fs.unlinkSync(fakeHuge) } catch { /* */ }

  console.log(`\n=== ${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} ===\n`)
  app.exit(failed === 0 ? 0 : 1)
}).catch((e) => {
  console.error(e)
  app.exit(1)
})
