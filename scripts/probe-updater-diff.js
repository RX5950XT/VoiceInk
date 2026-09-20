'use strict'

/**
 * 差分下載到底划不划算（唯讀，打真的 GitHub Releases，不下載整包）。
 *
 * 為什麼要有這支：`updater.js` 關掉了 `disableDifferentialDownload`，理由是實測差分比
 * 整包慢 36 倍。那個數字會隨安裝檔大小、變動比例與 GitHub CDN 的 range 延遲漂移，
 * 所以要重新評估時跑這支——它拿最近兩版**真的** blockmap 算出差分計畫（幾段、多少 MB），
 * 再實測幾個 range 請求的往返時間，印出「差分 vs 整包」的預估秒數。
 *
 * 用法：node scripts/probe-updater-diff.js [取樣次數，預設 8]
 */

const assert = require('assert')
const zlib = require('zlib')
const { execFileSync } = require('child_process')

const REPO = 'RX5950XT/VoiceInk'
const SAMPLES = Number(process.argv[2]) || 8
const { computeOperations, OperationKind } = require('electron-updater/out/differentialDownloader/downloadPlanBuilder')

/** `gh` 沒吃到 PATH 的話這支就沒得跑（專案慣例：先補 PATH 再繼續） */
function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 8 << 20 })
}

/** 最近兩個 release 的 tag（新 → 舊） */
function recentTags() {
  const out = gh(['release', 'list', '--repo', REPO, '--limit', '2', '--json', 'tagName'])
  const tags = JSON.parse(out).map(r => r.tagName)
  assert.ok(tags.length === 2, '至少要有兩個 release 才比得出差分')
  return tags
}

function assetUrl(tag, suffix) {
  const ver = tag.replace(/^v/, '')
  return `https://github.com/${REPO}/releases/download/${tag}/VoiceInk-Setup-${ver}.exe${suffix}`
}

/** blockmap 是 deflate／gzip 過的 JSON，兩種格式都見過 */
function decodeBlockMap(buf) {
  for (const fn of ['gunzipSync', 'inflateRawSync', 'inflateSync', 'brotliDecompressSync']) {
    try {
      return JSON.parse(zlib[fn](buf))
    } catch {
      // 換下一種
    }
  }
  throw new Error('blockmap 解不開（格式變了？）')
}

async function fetchBuffer(url, range) {
  const res = await fetch(url, { headers: range ? { range, accept: '*/*' } : { accept: '*/*' } })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0, 80)}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * github.com 的下載網址每次都 302 到簽過名的 release-assets CDN，走 redirect 量的是兩段往返。
 * electron-updater 自己會記住 redirect 後的網址（`request.on('redirect')` 更新 requestOptions），
 * 所以量測也要先換成 CDN 網址，量到的才是它真正逐段付出的成本。
 */
async function resolveCdnUrl(url) {
  const res = await fetch(url, { method: 'HEAD', redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}（拿不到 CDN 網址）`)
  return res.url || url
}

/** 量「一段 range 請求要多久」——差分下載是完全序列的，所以量的就是逐段往返 */
async function measureRangeRtt(url, size, bytesPerRange) {
  const times = []
  for (let i = 0; i < SAMPLES; i++) {
    // 取樣點散開，避免一直打同一段被快取
    const start = Math.floor((size / (SAMPLES + 1)) * (i + 1))
    const t0 = Date.now()
    const buf = await fetchBuffer(url, `bytes=${start}-${start + bytesPerRange - 1}`)
    times.push(Date.now() - t0)
    assert.strictEqual(buf.length, bytesPerRange, 'range 請求回的長度不對，CDN 可能不吃 Range')
  }
  times.sort((a, b) => a - b)
  return times[Math.floor(times.length / 2)]
}

/** 整包單連線速度：只抓前 24MB 推估，不下載 400MB */
async function measureFullSpeed(url) {
  const probeBytes = 24 << 20
  const t0 = Date.now()
  const buf = await fetchBuffer(url, `bytes=0-${probeBytes - 1}`)
  const secs = (Date.now() - t0) / 1000
  assert.strictEqual(buf.length, probeBytes)
  return buf.length / secs
}

async function main() {
  const [newTag, oldTag] = recentTags()
  console.log(`比對 ${oldTag} → ${newTag}`)

  const [oldBm, newBm] = await Promise.all([
    fetchBuffer(assetUrl(oldTag, '.blockmap')).then(decodeBlockMap),
    fetchBuffer(assetUrl(newTag, '.blockmap')).then(decodeBlockMap)
  ])

  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: null }
  const ops = computeOperations(oldBm, newBm, logger)

  let downloadBytes = 0
  let copyBytes = 0
  let downloadOps = 0
  for (const op of ops) {
    const len = op.end - op.start
    if (op.kind === OperationKind.DOWNLOAD) {
      downloadBytes += len
      downloadOps += 1
    } else {
      copyBytes += len
    }
  }
  const fullBytes = downloadBytes + copyBytes
  const mb = (n) => (n / 1048576).toFixed(1)

  console.log(`  區塊數 ${oldBm.files[0].checksums.length} → ${newBm.files[0].checksums.length}`)
  console.log(`  差分要發 ${downloadOps} 段 range 請求，共 ${mb(downloadBytes)} MB（沿用舊檔 ${mb(copyBytes)} MB）`)
  assert.ok(downloadOps > 0, '兩版一模一樣？沒東西可比')

  const avgRange = Math.round(downloadBytes / downloadOps)
  const exeUrl = await resolveCdnUrl(assetUrl(newTag, ''))
  const rttMs = await measureRangeRtt(exeUrl, fullBytes, avgRange)
  const fullSpeed = await measureFullSpeed(exeUrl)

  // electron-updater 的序列迴圈每 100 段強制 setTimeout 1 秒（DifferentialDownloader.doDownloadFile）
  const diffSecs = (downloadOps * rttMs) / 1000 + Math.floor(downloadOps / 100)
  const fullSecs = fullBytes / fullSpeed

  console.log(`  每段 ${(avgRange / 1024).toFixed(0)} KB 的 range 請求中位數 ${rttMs} ms`)
  console.log(`  整包單連線 ${(fullSpeed / 1048576).toFixed(1)} MB/s`)
  console.log('')
  console.log(`差分預估：${diffSecs.toFixed(0)} 秒（${(diffSecs / 60).toFixed(1)} 分）`)
  console.log(`整包預估：${fullSecs.toFixed(0)} 秒`)

  const ratio = diffSecs / fullSecs
  if (ratio > 1) {
    console.log(`\n→ 差分慢 ${ratio.toFixed(1)} 倍，維持 disableDifferentialDownload = true ✓`)
  } else {
    console.log(`\n→ 差分快 ${(1 / ratio).toFixed(1)} 倍了，可以考慮把 disableDifferentialDownload 拿掉`)
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
