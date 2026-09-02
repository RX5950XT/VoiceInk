#!/usr/bin/env node
/**
 * VoiceInk — 本機 token 用量統計的真實資料驗證（`npx electron scripts/e2e-code-usage.js`）
 *
 * 純函式那層由 `scripts/test-code-usage.js` 涵蓋；這一支跑的是**真的去讀使用者本機的
 * session 記錄**——那才看得出解析器有沒有漏掉真實世界的變化形（`<synthetic>` 那條就是這樣抓到的）。
 *
 * 全程唯讀，只寫自己的暫存 userData（跑完刪掉），不碰使用者的任何設定。
 */

'use strict'

const { app } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-codeusage-e2e-'))
app.setPath('userData', tmpUserData)

app.whenReady().then(async () => {
  const codeusage = require(path.join(ROOT, 'src/main/codeusage'))
  codeusage.configure({ userDataPath: tmpUserData })

  try {
    console.log('\n[A] 掃描本機記錄（第一次會讀滿保留期內的資料）')
    const started = Date.now()
    const report = await codeusage.sync()
    const elapsed = Date.now() - started
    console.log(`  掃描 ${(report.scannedBytes / 1048576).toFixed(0)}MB，耗時 ${(elapsed / 1000).toFixed(1)}s，折成 ${report.buckets} 個桶`)
    for (const [provider, info] of Object.entries(report.providers)) {
      console.log(`    ${provider}: ${JSON.stringify(info)}`)
    }
    ok('掃描有回報結果', Number.isFinite(report.buckets))
    ok('掃描有記錄時間', report.syncedAt > 0)

    console.log('\n[B] 第二次掃描應該幾乎不用讀東西（增量游標生效）')
    const again = await codeusage.sync()
    ok('第二次讀到的位元組遠少於第一次',
      again.scannedBytes < Math.max(1024 * 1024, report.scannedBytes / 10),
      `${again.scannedBytes} vs ${report.scannedBytes}`)

    console.log('\n[C] 統計')
    const stats = await codeusage.stats({ range: '30d' })
    console.log(`  30 天：${stats.summary.requests} 次請求、輸入 ${stats.summary.input}、輸出 ${stats.summary.output}、花費 $${stats.summary.costUsd.toFixed(2)}`)
    console.log(`  模型：${stats.models.map((m) => `${m.key}×${m.requests}`).join(', ') || '（無）'}`)
    console.log(`  工具：${stats.providers.filter((p) => p.requests).map((p) => `${p.label}×${p.requests}`).join(', ') || '（無）'}`)
    if (stats.uncostedModels.length) {
      console.log(`  未設單價：${stats.uncostedModels.join(', ')}`)
    }

    ok('時間範圍照送出去的 key', stats.range === '30d')
    ok('分桶格式由 main 決定', stats.bucket === 'day')
    ok('序列有補零（長度固定）', stats.series.length > 1)
    ok('序列時間遞增', stats.series.every((item, i) => i === 0 || item.ts > stats.series[i - 1].ts))
    ok('未知的 range 退回預設', (await codeusage.stats({ range: 'rm -rf' })).range === '7d')
    ok('摘要不含負數', Object.values(stats.summary).every((value) => value >= 0))
    ok('模型清單已正規化（沒有供應商前綴）',
      stats.models.every((row) => !row.key.includes('/')),
      stats.models.map((r) => r.key).join(','))
    ok('沒有 <synthetic> 這種假模型',
      !stats.models.some((row) => row.key.startsWith('<')),
      stats.models.map((r) => r.key).join(','))
    ok('五家都出現在分佈裡（沒資料的是 0）', stats.providers.length === 5)
    ok('Antigravity 有標明資料來源限制',
      stats.providers.find((p) => p.key === 'antigravity')?.note.includes('AGY'))

    console.log('\n[D] 自訂單價')
    const list = await codeusage.savePrices({ 'GPT-5.6-Sol': { input: 1.25, output: 10 } })
    ok('自訂單價存得起來', list.some((item) => item.model === 'gpt-5.6-sol' && item.source === 'custom'))
    const withPrice = await codeusage.stats({ range: '30d' })
    ok('填了單價之後未計價模型會變少',
      withPrice.uncostedModels.length <= stats.uncostedModels.length,
      `${withPrice.uncostedModels.length} vs ${stats.uncostedModels.length}`)

    console.log('\n[E] 重設')
    await codeusage.reset()
    const empty = await codeusage.stats({ range: '30d' })
    ok('重設後統計歸零', empty.summary.requests === 0)
  } catch (error) {
    failed++
    console.log(`  FAIL 例外 — ${error && (error.stack || error.message)}`)
  }

  try {
    fs.rmSync(tmpUserData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  } catch {
    // 刪不掉不影響結果
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  app.exit(failed === 0 ? 0 : 1)
})
