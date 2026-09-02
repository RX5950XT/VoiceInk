#!/usr/bin/env node
/**
 * VoiceInk — 用量統計的獨立稽核（`npx electron scripts/probe-code-usage-audit.js`）
 *
 * `test-code-usage.js` 用假資料證明「解析器照規格算」，`e2e-code-usage.js` 證明
 * 「真的讀得到本機記錄」。**兩支都證明不了「算出來的數字對不對」**——因為它們都是用
 * 同一份 `parsers.js`／`index.js` 算的，解析器少加一格、去重去錯，兩支照樣全綠。
 *
 * 這一支刻意**不碰 codeusage 的解析與分桶**：自己把 `~/.claude/projects` 的 jsonl
 * 從頭讀一次、自己去重、自己加總、自己套 `pricing.costOf`，再跟 `codeusage.stats()`
 * 的每模型數字對起來。對不上就是其中一邊錯了。
 *
 * 全程唯讀（暫存 userData 跑完刪掉）。逐模型對帳只做 Claude Code 那一家
 * （Codex／Grok 的 token 語意在單元測試裡已有針對性的斷言，而 Claude 是唯一
 * 「同一則訊息會被寫好幾行、去重錯就翻倍」的來源）；Codex 另外驗一條去重規則：
 * 子代理 rollout 開頭那批「母 thread 歷史的重播」有沒有被重複計算——
 * 那也是「同一份程式碼算兩次都會綠」的類型，要拿母檔逐筆核銷才看得出來。
 */

'use strict'

const { app } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const DAY_MS = 86_400_000
const RANGE_DAYS = 30

let failed = 0
function ok(name, cond, detail = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failed++
}

/** @param {string} dir @param {string[]} out */
function walk(dir, out) {
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.jsonl')) out.push(full)
  }
  return out
}

/**
 * 從原始 jsonl 自己重算一次（不經過 codeusage 的任何程式碼）。
 * @param {number} from 毫秒
 * @param {(raw: string) => string} normalize
 * @returns {Map<string, object>}
 */
function handCount(from, normalize) {
  const seen = new Set()
  /** @type {Map<string, object>} */
  const byModel = new Map()
  for (const file of walk(path.join(os.homedir(), '.claude', 'projects'), [])) {
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (row?.type !== 'assistant') continue
      const usage = row.message?.usage
      if (!usage || typeof usage !== 'object') continue
      const rawModel = String(row.message?.model || 'unknown')
      if (rawModel.startsWith('<')) continue
      const ts = Date.parse(row.timestamp)
      if (!Number.isFinite(ts) || ts < from) continue
      const id = String(row.message?.id || row.requestId || row.uuid || '')
      if (id) {
        if (seen.has(id)) continue
        seen.add(id)
      }
      const model = normalize(rawModel)
      const acc = byModel.get(model) || {
        requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0
      }
      const write1h = Number(usage.cache_creation?.ephemeral_1h_input_tokens) || 0
      const writeTotal = Number(usage.cache_creation_input_tokens) || 0
      acc.requests += 1
      acc.input += Number(usage.input_tokens) || 0
      acc.output += Number(usage.output_tokens) || 0
      acc.cacheRead += Number(usage.cache_read_input_tokens) || 0
      acc.cacheWrite += Math.max(0, writeTotal - write1h)
      acc.cacheWrite1h += write1h
      byModel.set(model, acc)
    }
  }
  return byModel
}

/**
 * 一份 Codex rollout 的 token_count 指紋：第一個 `turn_context` 之前／之後分開。
 * 前面那段在 fork 檔裡就是「母 thread 歷史的重播」。
 * @param {string} file
 * @returns {{ meta: object, before: string[], after: string[] }}
 */
function codexFingerprints(file) {
  const before = [], after = []
  let meta = null
  let tc = 0
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { meta: {}, before, after }
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"token_count"') && !line.includes('"turn_context"') && !line.includes('"session_meta"')) continue
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row?.type === 'session_meta') { meta = row.payload || {}; continue }
    if (row?.type === 'turn_context') { tc++; continue }
    if (row?.type !== 'event_msg' || row.payload?.type !== 'token_count') continue
    const u = row.payload?.info?.last_token_usage
    if (!u || (!Number(u.input_tokens) && !Number(u.output_tokens))) continue
    const fp = `${u.input_tokens}/${u.cached_input_tokens}/${u.output_tokens}/${u.reasoning_output_tokens}`
    ;(tc ? after : before).push(fp)
  }
  return { meta: meta || {}, before, after }
}

/**
 * 獨立驗「子代理 rollout 開頭那批 token_count 真的是母檔的同一批」。
 *
 * 這裡刻意**不看 codeusage 怎麼判**：自己找出帶 `forked_from_id` 的檔案，
 * 自己去母檔裡逐筆核銷。核銷得掉＝那些是重播、不是新的用量；核銷不掉＝我們在丟真資料。
 */
function auditCodexForkReplay() {
  const home = os.homedir()
  const files = []
  for (const root of [path.join(home, '.codex', 'sessions'), path.join(home, '.codex', 'archived_sessions')]) {
    walk(root, files)
  }
  /** @type {Map<string, string>} thread id → 檔案 */
  const byId = new Map()
  for (const file of files) {
    const m = /-([0-9a-f-]{36})\.jsonl$/.exec(file)
    if (m) byId.set(m[1], file)
  }
  let checked = 0, replayed = 0, missing = 0, noParent = 0
  for (const file of files) {
    const child = codexFingerprints(file)
    if (!child.before.length) continue
    const parentId = child.meta.forked_from_id || child.meta.parent_thread_id
    if (!parentId || !byId.has(parentId)) { noParent++; continue }
    checked++
    replayed += child.before.length
    const parent = codexFingerprints(byId.get(parentId))
    /** @type {Map<string, number>} */
    const pool = new Map()
    for (const fp of [...parent.before, ...parent.after]) pool.set(fp, (pool.get(fp) || 0) + 1)
    for (const fp of child.before) {
      const n = pool.get(fp) || 0
      if (n > 0) pool.set(fp, n - 1)
      else missing++
    }
  }
  console.log(`  ${checked} 份子代理 rollout、${replayed} 筆重播記錄（母檔找不到的：${missing}）`)
  if (noParent) console.log(`  SKIP ${noParent} 份（母檔已經不在本機，無從核銷）`)
  if (!checked) {
    console.log('  SKIP 本機沒有帶重播段落的子代理 rollout')
    return
  }
  ok('重播的每一筆都能在母檔裡核銷（＝丟掉不會少算）', missing === 0, `${missing} 筆對不到`)
}

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-usage-audit-'))
app.setPath('userData', tmpUserData)

app.whenReady().then(async () => {
  const codeusage = require(path.join(ROOT, 'src/main/codeusage'))
  const pricing = require(path.join(ROOT, 'src/main/codeusage/pricing'))
  codeusage.configure({ userDataPath: tmpUserData })

  try {
    const from = Date.now() - RANGE_DAYS * DAY_MS
    console.log(`\n[A] 手算（直接讀 ~/.claude/projects，最近 ${RANGE_DAYS} 天）`)
    const hand = handCount(from, pricing.normalizeModel)
    console.log(`  ${hand.size} 顆模型、${[...hand.values()].reduce((n, m) => n + m.requests, 0)} 次請求`)

    console.log('\n[B] App 算的（codeusage.sync + stats）')
    await codeusage.sync()
    const stats = await codeusage.stats({ range: '30d', provider: 'claude' })
    console.log(`  ${stats.models.length} 顆模型、${stats.summary.requests} 次請求、$${stats.summary.costUsd.toFixed(2)}`)

    console.log('\n[C] 逐模型對帳')
    // 分桶是「每小時」的，30 天視窗的邊界會切在整點 → 邊界那一小時兩邊算法不同，
    // 所以比對只看差異比例，不要求完全相等
    const tolerance = 0.01
    let handCost = 0
    for (const [model, mine] of [...hand.entries()].sort((a, b) => b[1].requests - a[1].requests)) {
      const app_ = stats.models.find((m) => m.key === model)
      const price = pricing.priceFor(model)
      const cost = pricing.costOf(mine, price)
      // 不是模型名的 id（`m` 那種）App 刻意不收，手算這邊沒有這條規則 → 不比也不算進總額
      if (pricing.isJunkModel(model)) {
        console.log(`  SKIP ${model}（不是模型名，App 刻意不收）`)
        continue
      }
      handCost += cost || 0
      // 只有幾次請求的模型，邊界那一小時就足以讓比例差超過容差 → 沒有比對價值
      if (mine.requests < 10) {
        console.log(`  SKIP ${model}（只有 ${mine.requests} 次請求，樣本太小）`)
        continue
      }
      if (!app_) {
        ok(`${model} 有出現在統計裡`, false, `手算 ${mine.requests} 次、App 沒有這一筆`)
        continue
      }
      const drift = (a, b) => (Math.max(a, b) === 0 ? 0 : Math.abs(a - b) / Math.max(a, b))
      const tokensMine = mine.input + mine.output + mine.cacheRead + mine.cacheWrite + mine.cacheWrite1h
      ok(
        `${model} 請求數對得上`,
        drift(mine.requests, app_.requests) <= tolerance,
        `手算 ${mine.requests} / App ${app_.requests}`
      )
      ok(
        `${model} token 數對得上`,
        drift(tokensMine, app_.tokens) <= tolerance,
        `手算 ${tokensMine} / App ${app_.tokens}`
      )
      if (cost !== null && Number.isFinite(app_.costUsd)) {
        ok(
          `${model} 金額對得上`,
          drift(cost, app_.costUsd) <= tolerance,
          `手算 $${cost.toFixed(2)} / App $${app_.costUsd.toFixed(2)}`
        )
      } else {
        console.log(`  SKIP ${model} 金額（沒有單價：手算 ${cost === null ? 'null' : cost}）`)
      }
    }

    console.log('\n[E] Codex 子代理重播（母檔已經算過的那一批不可以再算一次）')
    auditCodexForkReplay()
    const codex = await codeusage.stats({ range: 'all', provider: 'codex' })
    ok(
      'Codex 沒有 unknown 模型（重播段落讀不到模型，收下來就會變成這一列）',
      !codex.models.some((m) => m.key === 'unknown'),
      codex.models.filter((m) => m.key === 'unknown').map((m) => `${m.requests} 次`).join('')
    )

    console.log('\n[D] 總額')
    console.log(`  手算 $${handCost.toFixed(2)} / App $${stats.summary.costUsd.toFixed(2)}`)
    if (stats.uncostedModels.length) {
      console.log(`  未設單價：${stats.uncostedModels.join(', ')}（${stats.summary.uncostedRequests} 次請求）`)
    }

    console.log(`\n${failed === 0 ? '全部對得上' : `${failed} 項對不上`}`)
  } catch (err) {
    console.error('稽核失敗:', err)
    failed++
  } finally {
    try {
      fs.rmSync(tmpUserData, { recursive: true, force: true })
    } catch {
      // Windows 上 SQLite 釋放較慢，刪不掉就留給系統的暫存清理
    }
    app.exit(failed === 0 ? 0 : 1)
  }
})
