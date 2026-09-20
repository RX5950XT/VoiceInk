'use strict'

/**
 * 量「官方 GitHub vs 更新鏡像」抓同一支安裝檔的實際速度（只取樣幾秒，不下完整包）。
 *
 * 為什麼要有這支：GitHub Releases 在 APAC 會被限到幾十 KB/s，檢查更新看起來像卡死。
 * `update-mirrors.js` 把 .exe 改走代理；這支打真流量確認代理還活著、而且比官方快。
 *
 * 用法：node scripts/probe-updater-mirrors.js
 */

const { OWNER, REPO, MIRRORS, downloadUrls } = require('../src/main/update-mirrors')

const SAMPLE_MS = 5000
const MIN_MIRROR_KBS = 500
const EXE = `https://github.com/${OWNER}/${REPO}/releases/download/v1.24.0/VoiceInk-Setup-1.24.0.exe`

async function sample(url) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), SAMPLE_MS)
  const t0 = Date.now()
  let bytes = 0
  let status = 0
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ac.signal })
    status = res.status
    if (!res.ok || !res.body) {
      return { url, status, bytes: 0, ms: Date.now() - t0, kbs: 0 }
    }
    for await (const chunk of res.body) {
      bytes += chunk.length
      if (Date.now() - t0 >= SAMPLE_MS) {
        ac.abort()
        break
      }
    }
  } catch (err) {
    if (err && err.name !== 'AbortError') {
      return { url, status, bytes, ms: Date.now() - t0, kbs: 0, err: err.message }
    }
  } finally {
    clearTimeout(timer)
  }
  const ms = Math.max(1, Date.now() - t0)
  return { url, status, bytes, ms, kbs: Math.round((bytes / 1024) / (ms / 1000)) }
}

function label(url) {
  if (url.startsWith('https://github.com/')) return 'github'
  const hit = MIRRORS.find((p) => url.startsWith(p))
  return hit ? new URL(hit).hostname : url.slice(0, 40)
}

async function main() {
  const urls = downloadUrls(EXE).map(String)
  assertOrder(urls)
  console.log(`取樣 ${SAMPLE_MS / 1000}s：${EXE}`)
  const rows = []
  for (const url of urls) {
    const row = await sample(url)
    rows.push(row)
    console.log(`  ${label(row.url).padEnd(16)}  HTTP ${row.status || '—'}  ${(row.bytes / 1048576).toFixed(1)}MB  ${row.kbs} KB/s${row.err ? `  ${row.err}` : ''}`)
  }
  const official = rows[rows.length - 1]
  const mirrors = rows.slice(0, -1)
  const best = mirrors.reduce((a, b) => (b.kbs > a.kbs ? b : a), mirrors[0])
  if (!best || best.kbs < MIN_MIRROR_KBS) {
    throw new Error(`鏡像都慢於 ${MIN_MIRROR_KBS} KB/s，更新會回到官方慢速路徑`)
  }
  if (official.kbs > 0 && best.kbs < official.kbs) {
    console.log(`\n→ 官方比較快（${official.kbs} vs 鏡像 ${best.kbs} KB/s），仍保留官方當最後一跳`)
  } else {
    console.log(`\n→ 最快鏡像 ${label(best.url)} ${best.kbs} KB/s，官方 ${official.kbs} KB/s`)
  }
}

function assertOrder(urls) {
  if (urls[urls.length - 1] !== EXE) throw new Error('官方網址必須最後')
  if (urls[0] === EXE) throw new Error('第一跳不可以是官方 GitHub')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
