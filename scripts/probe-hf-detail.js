'use strict'

/**
 * 探索頁詳情面板的真流量驗證：`hfmodels.detail(repoId)` 打真 HF，
 * 確認模型卡、README、每個量化的大小與「跑不跑得動」都組得起來。
 *
 * **mock 證明不了對面長什麼樣**：HF 的 `gguf` 欄位有時候是空的、
 * README 常常是一整塊 HTML、量化多的 repo 有二十幾個變體，
 * 這些都只有打真的才看得到。
 *
 *   node_modules/electron/dist/electron.exe scripts/probe-hf-detail.js [owner/repo]
 */

const { app } = require('electron')
const path = require('path')

// `npx electron <script>` 時 app 名是 Electron，不接回去就找不到模型與設定
app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))

// 腳本路徑本身也長得像 owner/repo，所以先剝掉前兩個 argv 再比對
const REPO = process.argv.slice(2).find((a) => /^[\w.-]+\/[\w.-]+$/.test(a) && !a.endsWith('.js'))
  || 'unsloth/Qwen3-4B-Instruct-2507-GGUF'

let failed = 0

/**
 * @param {boolean} ok @param {string} label @param {string} [detail]
 */
function check(ok, label, detail) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  → ${detail}` : ''}`)
}

app.whenReady().then(async () => {
  const hfmodels = require('../src/main/hfmodels')
  hfmodels.init({ userDataPath: app.getPath('userData') })

  console.log(`repo: ${REPO}\n`)
  const detail = await hfmodels.detail(REPO)

  check(detail.repoId === REPO, 'repoId 對得上', detail.repoId)
  check(!!detail.card, '拿得到模型卡', detail.card ? `↓${detail.card.downloads} ♥${detail.card.likes}` : '')
  check(
    typeof detail.readme === 'string' && detail.readme.length > 40,
    'README 有內容',
    `${detail.readme.length} 字`
  )
  check(!/<\w+[^>]*>/.test(detail.readme.slice(0, 2000)), 'README 的 HTML 標籤已剝掉',
    detail.readme.slice(0, 60).replace(/\n/g, '⏎'))
  check(detail.variants.length > 0, '列得出量化版本', `${detail.variants.length} 個`)
  check(!!detail.info?.arch, '讀得到 GGUF 檔頭', detail.info?.arch || '')

  const withPlan = detail.variants.filter((v) => v.plan)
  check(withPlan.length === detail.variants.length, '每個量化都算出可行性',
    `${withPlan.length}/${detail.variants.length}`)
  // 同一顆模型只抓一次檔頭，所以大的那顆一定不會比小的更好跑
  const rank = { gpu: 3, partial: 2, cpu: 1, no: 0 }
  const sorted = [...withPlan].sort((a, b) => a.bytes - b.bytes)
  const monotonic = sorted.every((v, i) => (
    i === 0 || rank[sorted[i - 1].plan.feasibility] >= rank[v.plan.feasibility]
  ))
  check(monotonic, '越大的量化不會被評得越好跑')

  console.log('')
  for (const v of detail.variants.slice(0, 8)) {
    const gb = (v.bytes / 1024 ** 3).toFixed(2)
    console.log(`  ${String(v.quant).padEnd(10)} ${gb.padStart(7)} GB  ${v.plan?.feasibility || '—'}`
      + `  ctx ${v.plan?.ctxSize || '—'}`)
  }
  console.log(`\n${failed ? `${failed} FAILED` : 'ALL PASS'}`)
  app.exit(failed ? 1 : 0)
}).catch((error) => {
  console.error('FAIL', error?.message || error)
  app.exit(1)
})
