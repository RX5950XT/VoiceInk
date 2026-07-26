/**
 * VoiceInk - 長檔案串流轉錄（Main Process）
 *
 * 本地：ffmpeg → 16k mono f32le 串流，每 28 秒切一段送 sherpa-onnx。
 * 雲端：ffmpeg segment → mp3 片段送 OpenRouter 相容 /audio/transcriptions。
 * 不把整檔解碼進 RAM，可穩定支援 ≥2 小時、≥100MB（上限見常數）。
 */

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')
const { randomBytes } = require('crypto')
const localAsr = require('./local-asr')
const cloudAsr = require('./cloud-asr')

/** 原始檔案上限（≥100MB 需求；留 200MB 餘裕） */
const MAX_FILE_BYTES = 200 * 1024 * 1024
/** 時長上限：保證 2 小時；硬上限 4 小時避免無盡等待 */
const MAX_DURATION_SEC = 4 * 60 * 60
const MIN_GUARANTEED_DURATION_SEC = 2 * 60 * 60
const CHUNK_SECONDS = 28
/** 雲端 STT 片段秒數（避開上游 ~60s timeout） */
const CLOUD_CHUNK_SECONDS = 50
const SAMPLE_RATE = 16000
const CHUNK_SAMPLES = CHUNK_SECONDS * SAMPLE_RATE
const BYTES_PER_SAMPLE = 4
const CHUNK_BYTES = CHUNK_SAMPLES * BYTES_PER_SAMPLE

const SUPPORTED_EXT = new Set(['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'wma', 'aiff', 'aif'])

/** @type {{ kill: () => void, gen: number } | null} */
let activeJob = null
let jobGen = 0

/**
 * 解析 asar 內 ffmpeg-static 路徑
 * @returns {string}
 */
function resolveFfmpegPath() {
  let bin = require('ffmpeg-static')
  if (typeof bin !== 'string' || !bin) {
    throw new Error('ffmpeg-static 未正確安裝')
  }
  bin = bin.replace(/app\.asar(?!\.unpacked)/g, 'app.asar.unpacked')
  if (!fs.existsSync(bin)) {
    throw new Error(`找不到 ffmpeg 執行檔: ${bin}`)
  }
  return bin
}

/**
 * 從 ffmpeg stderr 解析 Duration
 * @param {string} text
 * @returns {number|null} 秒
 */
function parseDurationSec(text) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text)
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3])
}

/**
 * 取消進行中的檔案轉錄
 * @returns {boolean} 是否有任務被取消
 */
function cancel() {
  if (!activeJob) return false
  try {
    activeJob.kill()
  } catch {
    /* ignore */
  }
  activeJob = null
  return true
}

/**
 * 驗證使用者選取的檔案路徑
 * @param {string} filePath
 * @returns {{ size: number, ext: string }}
 */
function validateFilePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('檔案路徑無效')
  }
  const resolved = path.resolve(filePath)
  if (resolved !== filePath && path.normalize(resolved) !== path.normalize(filePath)) {
    // 仍允許相對路徑被 resolve 後使用，但必須存在
  }
  if (!path.isAbsolute(resolved)) {
    throw new Error('僅接受絕對路徑')
  }
  if (!fs.existsSync(resolved)) {
    throw new Error('檔案不存在')
  }
  const st = fs.statSync(resolved)
  if (!st.isFile()) {
    throw new Error('路徑不是一般檔案')
  }
  if (st.size <= 0) {
    throw new Error('檔案是空的')
  }
  if (st.size > MAX_FILE_BYTES) {
    const mb = (st.size / (1024 * 1024)).toFixed(1)
    const lim = (MAX_FILE_BYTES / (1024 * 1024)).toFixed(0)
    throw new Error(`檔案過大（${mb} MB），上限 ${lim} MB`)
  }
  const ext = path.extname(resolved).slice(1).toLowerCase()
  if (!SUPPORTED_EXT.has(ext)) {
    throw new Error(`不支援的格式: ${ext || '（無副檔名）'}`)
  }
  return { size: st.size, ext }
}

/**
 * 串流解碼並逐段 ASR
 * @param {{ filePath: string, lang: string, modelKey?: string }} req
 * @param {(p: { percent: number, text: string, chunk?: number, totalChunks?: number, durationSec?: number }) => void} [onProgress]
 * @returns {Promise<{ text: string, durationSec: number|null, chunks: number }>}
 */
async function transcribeFile(req, onProgress) {
  const filePath = req?.filePath
  const lang = req?.lang || 'zh-TW'
  const modelKey = req?.modelKey || localAsr.ASR_MODEL_KEY

  const { size } = validateFilePath(filePath)
  const resolved = path.resolve(filePath)

  // 取消前一個（理論上 renderer 重入鎖已擋）
  cancel()
  const gen = ++jobGen
  let killed = false
  let child = null

  const kill = () => {
    killed = true
    if (child && !child.killed) {
      try {
        child.kill('SIGKILL')
      } catch {
        try { child.kill() } catch { /* ignore */ }
      }
    }
  }
  activeJob = { kill, gen }

  const report = (percent, text, extra = {}) => {
    if (killed || gen !== jobGen) return
    try {
      onProgress?.({
        percent: Math.max(0, Math.min(99, Math.round(percent))),
        text,
        ...extra
      })
    } catch {
      /* ignore progress errors */
    }
  }

  report(3, '準備解碼音訊…')

  const ffmpegBin = resolveFfmpegPath()
  const args = [
    '-hide_banner',
    '-nostdin',
    '-i', resolved,
    '-vn',
    '-sn',
    '-dn',
    '-ac', '1',
    '-ar', String(SAMPLE_RATE),
    '-f', 'f32le',
    '-acodec', 'pcm_f32le',
    'pipe:1'
  ]

  return new Promise((resolve, reject) => {
    let settled = false
    let durationSec = null
    let stderrBuf = ''
    let pending = Buffer.alloc(0)
    let samplesDone = 0
    let chunkIndex = 0
    const parts = []
    /** @type {Promise<void>} */
    let chain = Promise.resolve()

    const fail = (err) => {
      if (settled) return
      settled = true
      kill()
      if (activeJob && activeJob.gen === gen) activeJob = null
      reject(err instanceof Error ? err : new Error(String(err)))
    }

    const succeed = (result) => {
      if (settled) return
      settled = true
      if (activeJob && activeJob.gen === gen) activeJob = null
      resolve(result)
    }

    try {
      child = spawn(ffmpegBin, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (e) {
      fail(e)
      return
    }

    child.on('error', (e) => {
      fail(new Error(`無法啟動 ffmpeg: ${e.message || e}`))
    })

    child.stderr.on('data', (buf) => {
      const s = buf.toString('utf8')
      stderrBuf = (stderrBuf + s).slice(-8000)
      if (durationSec == null) {
        const d = parseDurationSec(stderrBuf)
        if (d != null && Number.isFinite(d) && d > 0) {
          durationSec = d
          if (durationSec > MAX_DURATION_SEC) {
            fail(
              new Error(
                `音訊過長（${formatDuration(durationSec)}），上限 ${formatDuration(MAX_DURATION_SEC)}`
              )
            )
            return
          }
          report(6, `音訊長度 ${formatDuration(durationSec)}，開始轉錄…`, { durationSec })
        }
      }
    })

    /**
     * 對一段 PCM 做 ASR（可在 chain 內直接 await，勿再 enqueue processChunk）
     * @param {Float32Array} samples
     */
    const runAsrOnSamples = async (samples) => {
      if (killed || gen !== jobGen || settled) return
      if (!samples || samples.length === 0) return

      chunkIndex += 1
      const totalChunks =
        durationSec != null
          ? Math.max(1, Math.ceil(durationSec / CHUNK_SECONDS))
          : null

      let text = ''
      try {
        text = await localAsr.transcribe({
          samples,
          sampleRate: SAMPLE_RATE,
          lang,
          modelKey
        })
      } catch (e) {
        fail(e)
        return
      }

      if (killed || gen !== jobGen || settled) return
      if (text) parts.push(text)

      samplesDone += samples.length
      let percent
      if (durationSec != null && durationSec > 0) {
        const ratio = Math.min(1, samplesDone / (durationSec * SAMPLE_RATE))
        percent = 8 + ratio * 78
      } else {
        percent = Math.min(85, 8 + chunkIndex * 3)
      }
      const label =
        totalChunks != null
          ? `正在轉錄中… (${chunkIndex}/${totalChunks})`
          : `正在轉錄中… (第 ${chunkIndex} 段)`
      report(percent, label, {
        chunk: chunkIndex,
        totalChunks: totalChunks ?? undefined,
        durationSec: durationSec ?? undefined
      })

      // ASR 慢於解碼時 stdout 可能 pause，每段結束後恢復
      if (child && child.stdout && !child.stdout.destroyed && child.stdout.isPaused()) {
        child.stdout.resume()
      }
    }

    /**
     * 將 PCM 塊排進串列佇列（只從 stdout data 呼叫，勿在 chain 內 await 自己）
     * @param {Float32Array} samples
     */
    const enqueueChunk = (samples) => {
      chain = chain.then(() => runAsrOnSamples(samples))
    }

    child.stdout.on('data', (buf) => {
      if (killed || settled) return
      pending = Buffer.concat([pending, buf])

      // 待處理 PCM 堆積過多時暫停解碼，避免 RAM 暴衝（ASR 完成後 resume）
      if (pending.length > CHUNK_BYTES * 3) {
        try { child.stdout.pause() } catch { /* ignore */ }
      }

      while (pending.length >= CHUNK_BYTES) {
        const slice = pending.subarray(0, CHUNK_BYTES)
        pending = Buffer.from(pending.subarray(CHUNK_BYTES))
        enqueueChunk(bufferToFloat32(slice))
      }
    })

    child.on('close', (code, signal) => {
      // 先把尾段 enqueue，再 finalize——不可在 chain 內 await enqueue（會死鎖）
      if (!killed && !settled && pending.length >= BYTES_PER_SAMPLE) {
        const n = Math.floor(pending.length / BYTES_PER_SAMPLE)
        const usable = n * BYTES_PER_SAMPLE
        const slice = pending.subarray(0, usable)
        pending = Buffer.alloc(0)
        enqueueChunk(bufferToFloat32(slice))
      }

      chain = chain
        .then(() => {
          if (settled) return
          if (killed || gen !== jobGen) {
            fail(new Error('轉錄已取消'))
            return
          }
          // code 0 或 null（pipe 正常結束）；非 0 且無任何音訊則失敗
          if (code && code !== 0 && samplesDone === 0 && chunkIndex === 0) {
            const hint = stderrBuf.trim().split('\n').slice(-3).join(' ')
            fail(new Error(`音訊解碼失敗${hint ? `：${hint}` : `（ffmpeg exit ${code}）`}`))
            return
          }
          if (signal && samplesDone === 0 && !killed) {
            fail(new Error(`音訊解碼中斷（${signal}）`))
            return
          }

          const text = parts.join('\n')
          report(88, '轉錄完成', {
            chunk: chunkIndex,
            durationSec: durationSec ?? samplesDone / SAMPLE_RATE
          })
          succeed({
            text,
            durationSec: durationSec ?? (samplesDone > 0 ? samplesDone / SAMPLE_RATE : null),
            chunks: chunkIndex,
            fileBytes: size
          })
        })
        .catch((e) => fail(e))
    })
  })
}

/**
 * 將 PCM f32le Buffer 安全轉成 Float32Array（處理非 4-byte 對齊 offset）
 * @param {Buffer} buf
 * @returns {Float32Array}
 */
function bufferToFloat32(buf) {
  const n = Math.floor(buf.byteLength / BYTES_PER_SAMPLE)
  if (n <= 0) return new Float32Array(0)
  if (buf.byteOffset % 4 === 0) {
    return new Float32Array(buf.buffer, buf.byteOffset, n).slice()
  }
  const aligned = Buffer.from(buf.subarray(0, n * BYTES_PER_SAMPLE))
  return new Float32Array(aligned.buffer, aligned.byteOffset, n)
}

/**
 * @param {number} sec
 * @returns {string}
 */
function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '?'
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h} 小時 ${m} 分`
  if (m > 0) return `${m} 分 ${r} 秒`
  return `${r} 秒`
}

/**
 * 執行 ffmpeg 並等待結束
 * @param {string} bin
 * @param {string[]} args
 * @param {{ onStderr?: (s: string) => void, killRef?: { child: import('child_process').ChildProcess|null } }} [opts]
 * @returns {Promise<{ code: number|null, signal: string|null, stderr: string }>}
 */
function runFfmpeg(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let stderr = ''
    let child
    try {
      child = spawn(bin, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      })
    } catch (e) {
      reject(e)
      return
    }
    if (opts.killRef) opts.killRef.child = child
    child.stderr.on('data', (buf) => {
      const s = buf.toString('utf8')
      stderr = (stderr + s).slice(-12000)
      opts.onStderr?.(s)
    })
    child.on('error', (e) => reject(new Error(`無法啟動 ffmpeg: ${e.message || e}`)))
    child.on('close', (code, signal) => {
      if (opts.killRef) opts.killRef.child = null
      resolve({ code, signal, stderr })
    })
  })
}

/**
 * 雲端：ffmpeg 切成 mp3 段 → 逐段 transcriptions
 * @param {{ filePath: string, lang: string, store: object }} req
 * @param {(p: object) => void} [onProgress]
 * @returns {Promise<{ text: string, durationSec: number|null, chunks: number }>}
 */
async function transcribeFileCloud(req, onProgress) {
  const filePath = req?.filePath
  const lang = req?.lang || 'zh-TW'
  const store = req?.store
  if (!store) throw new Error('雲端轉錄需要設定儲存')

  const { size } = validateFilePath(filePath)
  const resolved = path.resolve(filePath)

  cancel()
  const gen = ++jobGen
  let killed = false
  /** @type {{ child: import('child_process').ChildProcess|null }} */
  const killRef = { child: null }

  const kill = () => {
    killed = true
    if (killRef.child && !killRef.child.killed) {
      try {
        killRef.child.kill('SIGKILL')
      } catch {
        try { killRef.child.kill() } catch { /* ignore */ }
      }
    }
  }
  activeJob = { kill, gen }

  const report = (percent, text, extra = {}) => {
    if (killed || gen !== jobGen) return
    try {
      onProgress?.({
        percent: Math.max(0, Math.min(99, Math.round(percent))),
        text,
        ...extra
      })
    } catch {
      /* ignore */
    }
  }

  const tmpRoot = path.join(
    os.tmpdir(),
    `voiceink-cloud-asr-${process.pid}-${randomBytes(6).toString('hex')}`
  )
  await fsp.mkdir(tmpRoot, { recursive: true })
  const pattern = path.join(tmpRoot, 'seg_%03d.mp3')

  try {
    report(3, '準備切割音訊（雲端）…')
    const ffmpegBin = resolveFfmpegPath()

    // 先 probe 時長
    let durationSec = null
    const probe = await runFfmpeg(
      ffmpegBin,
      ['-hide_banner', '-i', resolved, '-f', 'null', '-'],
      {
        killRef,
        onStderr: (s) => {
          if (durationSec == null) {
            const d = parseDurationSec(s)
            if (d != null && Number.isFinite(d) && d > 0) durationSec = d
          }
        }
      }
    )
    if (killed || gen !== jobGen) throw new Error('轉錄已取消')
    // probe 常以 non-zero 結束（無輸出），仍可能已解析 Duration
    if (durationSec == null) {
      const d = parseDurationSec(probe.stderr)
      if (d != null && Number.isFinite(d) && d > 0) durationSec = d
    }
    if (durationSec != null && durationSec > MAX_DURATION_SEC) {
      throw new Error(
        `音訊過長（${formatDuration(durationSec)}），上限 ${formatDuration(MAX_DURATION_SEC)}`
      )
    }

    report(8, durationSec != null
      ? `音訊長度 ${formatDuration(durationSec)}，切割中…`
      : '切割音訊中…', { durationSec: durationSec ?? undefined })

    const segArgs = [
      '-hide_banner',
      '-nostdin',
      '-i', resolved,
      '-vn',
      '-sn',
      '-dn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'libmp3lame',
      '-b:a', '64k',
      '-f', 'segment',
      '-segment_time', String(CLOUD_CHUNK_SECONDS),
      '-reset_timestamps', '1',
      pattern
    ]
    const seg = await runFfmpeg(ffmpegBin, segArgs, { killRef })
    if (killed || gen !== jobGen) throw new Error('轉錄已取消')
    if (seg.code && seg.code !== 0) {
      const hint = seg.stderr.trim().split('\n').slice(-3).join(' ')
      throw new Error(`音訊切割失敗${hint ? `：${hint}` : `（ffmpeg exit ${seg.code}）`}`)
    }

    const files = (await fsp.readdir(tmpRoot))
      .filter((n) => /^seg_\d+\.mp3$/i.test(n))
      .sort()
    if (files.length === 0) {
      throw new Error('音訊切割後沒有可用片段')
    }

    const parts = []
    for (let i = 0; i < files.length; i++) {
      if (killed || gen !== jobGen) throw new Error('轉錄已取消')
      const fp = path.join(tmpRoot, files[i])
      const buf = await fsp.readFile(fp)
      report(
        10 + ((i + 0.5) / files.length) * 80,
        `雲端轉錄中… (${i + 1}/${files.length})`,
        {
          chunk: i + 1,
          totalChunks: files.length,
          durationSec: durationSec ?? undefined
        }
      )
      let text = ''
      try {
        text = await cloudAsr.transcribeEncoded(
          { buffer: buf, format: 'mp3', language: lang },
          store
        )
      } catch (e) {
        throw e instanceof Error ? e : new Error(String(e))
      }
      if (text) parts.push(text)
      report(
        10 + ((i + 1) / files.length) * 80,
        `雲端轉錄中… (${i + 1}/${files.length})`,
        {
          chunk: i + 1,
          totalChunks: files.length,
          durationSec: durationSec ?? undefined
        }
      )
    }

    const text = parts.join('\n')
    report(95, '轉錄完成', {
      chunk: files.length,
      durationSec: durationSec ?? undefined
    })
    if (activeJob && activeJob.gen === gen) activeJob = null
    return {
      text,
      durationSec,
      chunks: files.length,
      fileBytes: size
    }
  } catch (e) {
    if (activeJob && activeJob.gen === gen) activeJob = null
    throw e
  } finally {
    fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  }
}

module.exports = {
  transcribeFile,
  transcribeFileCloud,
  cancel,
  MAX_FILE_BYTES,
  MAX_DURATION_SEC,
  MIN_GUARANTEED_DURATION_SEC,
  CHUNK_SECONDS,
  CLOUD_CHUNK_SECONDS,
  SUPPORTED_EXT,
  resolveFfmpegPath,
  validateFilePath,
  parseDurationSec
}
