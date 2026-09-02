#!/usr/bin/env node
/**
 * VoiceInk — 五家 CLI token 用量統計的純邏輯回歸（node 直跑，不需 electron）
 *
 * fixture 都照本機真實記錄的形狀寫。三個最容易算錯的地方各有一條：
 *   - Claude 串流會把同一則 assistant 訊息寫好幾行 → 要靠 message.id 去重
 *   - Codex 的 token_count 同時有累計（total）與單輪（last）→ 只能加 last
 *   - 三家的 input 有沒有含 cache 不一樣 → Claude 沒含、Codex 與 Grok 有含
 */

'use strict'

const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.join(__dirname, '..')
const pricing = require(path.join(ROOT, 'src/main/codeusage/pricing.js'))
const parsers = require(path.join(ROOT, 'src/main/codeusage/parsers.js'))
const scan = require(path.join(ROOT, 'src/main/codeusage/scan.js'))
const codeusage = require(path.join(ROOT, 'src/main/codeusage/index.js'))

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

const HOUR = 3600_000

// ===== 模型正規化與單價 =====
console.log('\n[A] 模型正規化與單價')
{
  ok('供應商前綴剝掉', pricing.normalizeModel('anthropic/claude-opus-5') === 'claude-opus-5')
  ok('日期後綴剝掉', pricing.normalizeModel('claude-sonnet-5-20260101') === 'claude-sonnet-5')
  ok('大小寫收斂', pricing.normalizeModel('Claude-Opus-5') === 'claude-opus-5')
  ok('-latest 剝掉', pricing.normalizeModel('gpt-5.6-sol-latest') === 'gpt-5.6-sol')
  ok('別名合併（Grok 端點名）', pricing.normalizeModel('grok-4.6-build') === 'grok-4.6')
  ok('多層前綴只取最後一段', pricing.normalizeModel('openrouter/anthropic/claude-opus-5') === 'claude-opus-5')
  // Claude Code 實際寫 `claude-haiku-4-5-20251001`，公開報價寫 `claude-haiku-4.5`
  ok('大版本-小版本收斂成小數點', pricing.normalizeModel('claude-haiku-4-5-20251001') === 'claude-haiku-4.5')
  ok('收斂後對得到內建單價', pricing.priceFor(pricing.normalizeModel('claude-haiku-4-5'))?.input === 1)
  ok('單一版號不受影響', pricing.normalizeModel('claude-opus-5') === 'claude-opus-5')
  // AGY 型錄的 Gemini 是同一顆模型的不同思考檔位，價錢一樣要合起來
  ok('Gemini 思考檔位合併', pricing.normalizeModel('gemini-3.7-flash-high') === 'gemini-3.7-flash')
  ok('Gemini extra-low 也合併', pricing.normalizeModel('gemini-3.7-flash-extra-low') === 'gemini-3.7-flash')
  ok('非 Gemini 不套檔位規則', pricing.normalizeModel('some-model-high') === 'some-model-high')
  // Flash-Lite 是另一顆模型（價格只有 Flash 的三分之一），剝掉 lite 會算成貴的那顆
  ok('Flash-Lite 不可以被當成檔位剝掉',
    pricing.normalizeModel('gemini-3.1-flash-lite') === 'gemini-3.1-flash-lite')
  ok('Flash-Lite 有自己的單價',
    pricing.priceFor('gemini-3.1-flash-lite')?.input === 0.25)
  ok('thinking 檔位合併回本體',
    pricing.normalizeModel('claude-opus-4-6-thinking') === 'claude-opus-4.6')
  ok('thinking 合併後對得到單價',
    pricing.priceFor(pricing.normalizeModel('claude-opus-4-6-thinking'))?.output === 25)
  ok('空值回 unknown', pricing.normalizeModel('') === 'unknown')
  ok('非字串回 unknown', pricing.normalizeModel(null) === 'unknown')

  // 不是模型名的 id（實測有代理往 Claude Code 的記錄寫 `model: "m"`）
  ok('一個字元的假 id 認得出來', pricing.isJunkModel('m'))
  ok('兩個字元的假 id 也認得出來', pricing.isJunkModel('x1'))
  ok('unknown 不算假 id（真的有用量，丟掉等於少算）', !pricing.isJunkModel('unknown'))
  ok('真的模型名不會被誤判', !pricing.isJunkModel('claude-opus-5') && !pricing.isJunkModel('glm-5.3'))
  // 同一顆模型從三個來源進來要合成同一個 key
  const same = new Set([
    pricing.normalizeModel('claude-opus-5'),
    pricing.normalizeModel('anthropic/claude-opus-5'),
    pricing.normalizeModel('Claude-Opus-5-20260214')
  ])
  ok('跨來源同一顆模型合併成一個 key', same.size === 1, [...same].join(','))

  const opus = pricing.priceFor('claude-opus-5')
  ok('內建單價讀得到', opus?.input === 5 && opus?.output === 25)
  ok('沒查證過的模型回 null（不是 0）', pricing.priceFor('never-priced-model') === null)
  ok('不認得的模型回 null', pricing.priceFor('made-up-model') === null)
  // Antigravity 的 agent 檔位就是 Gemini 3.1 Pro，價錢要跟它一樣
  const agent = pricing.priceFor('gemini-pro-agent')
  const pro31 = pricing.priceFor('gemini-3.1-pro')
  ok('gemini-pro-agent 套 3.1 Pro 的價',
    agent?.input === pro31.input && agent?.output === pro31.output)

  // 1M input + 1M output = 5 + 25
  const cost = pricing.costOf({ input: 1e6, output: 1e6 }, opus)
  ok('金額換算正確', Math.abs(cost - 30) < 1e-9, String(cost))
  // cacheWrite 預設 input×1.25、cacheRead 預設 input×0.1
  const cached = pricing.costOf({ input: 0, output: 0, cacheWrite: 1e6, cacheRead: 1e6 }, opus)
  ok('快取單價有預設倍率', Math.abs(cached - (6.25 + 0.5)) < 1e-9, String(cached))
  // 1 小時快取寫入是 input × 2（＝5 分鐘價的 1.6 倍），用 5m 價算會低估三成多
  const long = pricing.costOf({ input: 0, output: 0, cacheWrite1h: 1e6 }, opus)
  ok('1 小時快取寫入照 input × 2 計價', Math.abs(long - 10) < 1e-9, String(long))
  const guessed = pricing.costOf({ cacheWrite1h: 1e6 }, { input: 4, output: 8, cacheWrite: 5 })
  ok('沒填 1h 價時用 5m × 1.6 推', Math.abs(guessed - 8) < 1e-9, String(guessed))
  ok('沒有單價時回 null 不回 0', pricing.costOf({ input: 1e6, output: 1e6 }, null) === null)

  const custom = pricing.sanitizeCustomPrices({
    'GPT-5.6-Sol': { input: 1.25, output: 10 },
    bad: { input: 'x', output: 1 },
    negative: { input: -1, output: 1 },
    nope: null
  })
  ok('自訂單價會正規化 key', Boolean(custom['gpt-5.6-sol']))
  ok('壞掉的自訂單價丟掉', Object.keys(custom).length === 1, Object.keys(custom).join(','))
  ok('自訂單價蓋過內建', pricing.priceFor('gpt-5.6-sol', custom).input === 1.25)

  // 桶子存的是正規化後的名字，規則改過的話舊桶子掛在舊 key 上、增量掃描碰不到，
  // 所以要靠版本戳自己整份重讀一次（使用者不必去按「全部重讀」）
  ok('沒有版本戳（舊檔）要整份重讀', pricing.needsFullRescan(undefined) === true)
  ok('版本對得上就走增量', pricing.needsFullRescan(pricing.RULES_VERSION) === false)
  ok('版本落後要整份重讀', pricing.needsFullRescan(pricing.RULES_VERSION - 1) === true)
}

// ===== Claude =====
console.log('\n[B] Claude Code 解析')
{
  const line = (id, out) => JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-30T07:00:00.000Z',
    message: {
      id,
      model: 'claude-opus-5',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 56183,
        cache_read_input_tokens: 17212,
        output_tokens: out,
        output_tokens_details: { thinking_tokens: 206 }
      }
    }
  })

  const state = parsers.newState()
  const first = parsers.parseClaudeLine(line('msg_1', 349), state)
  ok('解析出一筆', first.length === 1)
  ok('input 不扣 cache（Claude 的 input 本來就不含）', first[0].input === 2)
  ok('cacheWrite 讀得到', first[0].cacheWrite === 56183)
  ok('沒有細目時整包當 5 分鐘快取', first[0].cacheWrite1h === 0)
  ok('cacheRead 讀得到', first[0].cacheRead === 17212)

  // 新版帶 `cache_creation` 細目：1h 寫入的單價是 5m 的 1.6 倍，混在一起算會低估
  const split = parsers.parseClaudeLine(JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-30T07:00:00.000Z',
    message: {
      id: 'msg_split',
      model: 'claude-opus-5',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 0,
        output_tokens: 10,
        cache_creation: { ephemeral_1h_input_tokens: 700, ephemeral_5m_input_tokens: 300 }
      }
    }
  }), state)
  ok('1 小時快取寫入分開記', split[0].cacheWrite1h === 700)
  ok('5 分鐘快取寫入是總量扣掉 1 小時的', split[0].cacheWrite === 300)
  ok('output 讀得到', first[0].output === 349)
  ok('時間戳轉毫秒', first[0].ts === Date.parse('2026-08-30T07:00:00.000Z'))

  // 串流會把同一則訊息重寫好幾次
  const again = parsers.parseClaudeLine(line('msg_1', 349), state)
  ok('同一個 message.id 只算一次', again.length === 0)
  const other = parsers.parseClaudeLine(line('msg_2', 100), state)
  ok('不同 message.id 照算', other.length === 1)

  ok('非 assistant 行跳過', parsers.parseClaudeLine(JSON.stringify({ type: 'user', message: { usage: {} } }), state).length === 0)
  ok('壞 JSON 不炸', parsers.parseClaudeLine('{ broken', state).length === 0)
  ok('沒有 usage 的行跳過', parsers.parseClaudeLine(JSON.stringify({ type: 'assistant', message: {} }), state).length === 0)
  // 本機錯誤／中斷時 Claude Code 會補一則假訊息，實測資料裡真的有
  ok('<synthetic> 假訊息不算', parsers.parseClaudeLine(JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-30T07:00:00.000Z',
    message: { id: 'syn', model: '<synthetic>', usage: { input_tokens: 1, output_tokens: 1 } }
  }), state).length === 0)
}

// ===== Codex =====
console.log('\n[C] Codex 解析')
{
  const state = parsers.newState()
  parsers.parseCodexLine(JSON.stringify({
    type: 'turn_context',
    payload: { turn_id: 't1', model: 'gpt-5.6-sol' }
  }), state)
  ok('turn_context 記下模型', state.model === 'gpt-5.6-sol')

  const tokenLine = (last, total) => JSON.stringify({
    timestamp: '2026-08-30T07:05:51.298Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: total, last_token_usage: last }
    }
  })

  const usage1 = { input_tokens: 28843, cached_input_tokens: 9984, cache_write_input_tokens: 0, output_tokens: 1095, reasoning_output_tokens: 516 }
  const usage2 = { input_tokens: 40541, cached_input_tokens: 28416, cache_write_input_tokens: 0, output_tokens: 1099, reasoning_output_tokens: 516 }
  const cumulative = { input_tokens: 69384, cached_input_tokens: 38400, cache_write_input_tokens: 0, output_tokens: 2194, reasoning_output_tokens: 1032 }

  const a = parsers.parseCodexLine(tokenLine(usage1, usage1), state)
  const b = parsers.parseCodexLine(tokenLine(usage2, cumulative), state)
  ok('兩輪各解析出一筆', a.length === 1 && b.length === 1)
  ok('用的是 last 不是 total（第二輪 output 是 1099 不是 2194）', b[0].output === 1099)
  ok('input 扣掉 cached（28843 - 9984）', a[0].input === 28843 - 9984)
  ok('cacheRead 記 cached_input_tokens', a[0].input + a[0].cacheRead === 28843)
  ok('模型沿用 turn_context', a[0].model === 'gpt-5.6-sol')
  ok('reasoning 讀得到', a[0].reasoning === 516)

  // 兩輪相加要等於「這個 session 真正用掉的量」，而不是累計值再相加
  ok('兩輪 output 相加等於累計值', a[0].output + b[0].output === cumulative.output_tokens)

  ok('沒有 last_token_usage 就跳過',
    parsers.parseCodexLine(tokenLine(null, cumulative), state).length === 0)
  ok('全 0 的那一輪跳過',
    parsers.parseCodexLine(tokenLine({ input_tokens: 0, output_tokens: 0 }, cumulative), state).length === 0)

  // 子代理／fork 的 rollout：開頭是母 thread 整份歷史的重播（母檔已經算過），
  // 收下來就是憑空多一份用量，而且重播段落沒有 turn_context → 全記成 unknown
  const forked = parsers.newState()
  parsers.parseCodexLine(JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-07-26T07:48:40.222Z',
    payload: { id: 'child', forked_from_id: 'parent', thread_source: 'subagent' }
  }), forked)
  ok('fork 的 session_meta 標成重播', forked.replay === true)
  ok('重播段落的 token_count 不計',
    parsers.parseCodexLine(tokenLine(usage1, usage1), forked).length === 0)
  parsers.parseCodexLine(JSON.stringify({
    type: 'turn_context',
    payload: { turn_id: 't1', model: 'gpt-5.6-sol' }
  }), forked)
  ok('第一個 turn_context 之後重播結束', forked.replay === false)
  const real = parsers.parseCodexLine(tokenLine(usage2, usage2), forked)
  ok('新的一輪照常計入', real.length === 1 && real[0].model === 'gpt-5.6-sol')

  const plain = parsers.newState()
  parsers.parseCodexLine(JSON.stringify({
    type: 'session_meta', timestamp: '2026-07-26T07:48:40.222Z', payload: { id: 'solo' }
  }), plain)
  parsers.parseCodexLine(JSON.stringify({
    type: 'turn_context', payload: { model: 'gpt-5.5' }
  }), plain)
  ok('沒有 fork 標記的 session 不受影響',
    plain.replay === false && parsers.parseCodexLine(tokenLine(usage1, usage1), plain).length === 1)
}

// ===== Grok =====
console.log('\n[D] Grok Build 解析')
{
  const state = parsers.newState()
  const turn = (promptId, model) => JSON.stringify({
    timestamp: 1785834935,
    method: '_x.ai/session/update',
    params: {
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: promptId,
        usage: {
          inputTokens: 103020,
          outputTokens: 1234,
          cachedReadTokens: 72192,
          cacheCreationTokens: 0,
          reasoningTokens: 738,
          modelCalls: 3,
          costUsdTicks: 957176000,
          modelUsage: {
            [model]: {
              inputTokens: 103020,
              outputTokens: 1234,
              cachedReadTokens: 72192,
              cacheCreationTokens: 0,
              reasoningTokens: 738,
              modelCalls: 3,
              costUsdTicks: 957176000
            }
          }
        }
      }
    }
  })

  const events = parsers.parseGrokLine(turn('p1', 'grok-4.5-build'), state)
  ok('解析出一筆', events.length === 1)
  ok('模型取自 modelUsage', events[0].model === 'grok-4.5-build')
  ok('input 扣掉 cachedRead', events[0].input === 103020 - 72192)
  ok('requests 用 modelCalls', events[0].requests === 3)
  ok('花費由來源提供（1e9 ticks = 1 USD）', Math.abs(events[0].costUsd - 0.957176) < 1e-9, String(events[0].costUsd))
  ok('秒級時間戳轉毫秒', events[0].ts === 1785834935 * 1000)

  ok('同一個 prompt_id 只算一次', parsers.parseGrokLine(turn('p1', 'grok-4.5-build'), state).length === 0)
  ok('不同 prompt_id 照算', parsers.parseGrokLine(turn('p2', 'grok-4.5-build'), state).length === 1)
  ok('非 turn_completed 跳過',
    parsers.parseGrokLine(JSON.stringify({ params: { update: { sessionUpdate: 'tool_call' } } }), state).length === 0)

  // 沒有 modelUsage 時退回整輪
  const noDetail = parsers.parseGrokLine(JSON.stringify({
    timestamp: 1785834935,
    params: { update: { sessionUpdate: 'turn_completed', prompt_id: 'p3', usage: { inputTokens: 10, outputTokens: 5 } } }
  }), state)
  ok('沒有逐模型細目時仍算得出來', noDetail.length === 1 && noDetail[0].model === 'unknown')
}

// ===== 桶子與統計 =====
console.log('\n[E] 桶子與統計')
{
  const buckets = new Map()
  const base = Math.floor(Date.now() / HOUR) * HOUR
  codeusage.addEvent(buckets, 'claude', {
    ts: base + 60_000, model: 'anthropic/claude-opus-5', input: 100, output: 50, reasoning: 10, cacheRead: 5, cacheWrite: 3, requests: 1, costUsd: null
  })
  codeusage.addEvent(buckets, 'claude', {
    ts: base + 120_000, model: 'claude-opus-5', input: 200, output: 60, reasoning: 0, cacheRead: 0, cacheWrite: 0, requests: 1, costUsd: null
  })
  ok('同一小時同一模型合成一桶', buckets.size === 1, String(buckets.size))
  const bucket = [...buckets.values()][0]
  ok('桶子累加 input', bucket.input === 300)
  ok('桶子累加 requests', bucket.requests === 2)
  ok('桶子的時間對齊小時', bucket.ts === base)
  ok('不同來源的 id 正規化後合併', bucket.model === 'claude-opus-5')

  codeusage.addEvent(buckets, 'grok', {
    ts: base + 60_000, model: 'grok-4.6', input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, requests: 1, costUsd: 0.5
  })
  ok('不同供應商分開一桶', buckets.size === 2)
  const grok = [...buckets.values()].find((item) => item.provider === 'grok')
  ok('來源自帶花費有記下來', grok.reportedCost === 0.5)

  codeusage.addEvent(buckets, 'claude', { ts: 0, model: 'x', input: 1 })
  ok('沒有時間戳的事件丟掉', buckets.size === 2)

  codeusage.addEvent(buckets, 'claude', { ts: base + 60_000, model: 'm', input: 2, output: 2, requests: 1 })
  ok('不是模型名的 id 不進桶子', buckets.size === 2, String(buckets.size))
  codeusage.addEvent(buckets, 'claude', { ts: base + 60_000, model: '', input: 2, output: 2, requests: 1 })
  ok('讀不到模型（unknown）照樣要記，不能一起丟掉',
    [...buckets.values()].some((item) => item.model === 'unknown'))
  // 舊檔裡已經記進去的假 id，讀檔時就要濾掉（不必等使用者去按重掃）
  const junkFile = codeusage.loadBuckets([
    { ts: base, provider: 'claude', model: 'm', input: 2, output: 2, requests: 1, reportedCost: null },
    { ts: base, provider: 'claude', model: 'claude-opus-5', input: 10, output: 1, requests: 1, reportedCost: null }
  ])
  ok('舊檔裡的假 id 讀檔時濾掉', junkFile.size === 1 && junkFile.has(`${base}|claude|claude-opus-5`),
    String(junkFile.size))

  // withCost：有來源花費用來源的，沒有就用單價表，都沒有就 null
  const reported = codeusage.withCost({ ...grok }, {})
  ok('有來源花費就直接用', reported.costUsd === 0.5 && reported.costSource === 'reported')
  const estimated = codeusage.withCost({ ...bucket, reportedCost: null }, {})
  ok('沒有來源花費就用單價表推', estimated.costSource === 'estimated' && estimated.costUsd > 0)
  const none = codeusage.withCost({ model: 'never-priced-model', input: 100, output: 10, reportedCost: null }, {})
  ok('連單價都沒有就是 null（不可以填 0）', none.costUsd === null && none.costSource === 'none')

  // 落盤再讀回來：`reportedCost: null` 不可以被讀成 0。
  // `Number(null)` 是 0，用 `Number.isFinite(Number(x))` 當守衛會讓每一桶都變成
  // 「來源說花了 0 元」→ 整頁花費恆為 0，而且連「未設單價」的警語都不會出現。
  const roundTrip = codeusage.loadBuckets([
    { ts: base, provider: 'claude', model: 'claude-opus-5', input: 1_000_000, output: 0, requests: 1, reportedCost: null },
    { ts: base, provider: 'grok', model: 'grok-4.6', input: 10, output: 5, requests: 1, reportedCost: 0.5 }
  ])
  const rtClaude = roundTrip.get(`${base}|claude|claude-opus-5`)
  const rtGrok = roundTrip.get(`${base}|grok|grok-4.6`)
  ok('讀回來的 null 花費還是 null', rtClaude.reportedCost === null, String(rtClaude.reportedCost))
  ok('讀回來的真花費保留', rtGrok.reportedCost === 0.5)
  const rtCost = codeusage.withCost(rtClaude, {})
  ok('讀回來的桶子照樣用單價表算錢', rtCost.costSource === 'estimated' && rtCost.costUsd === 5, String(rtCost.costUsd))

  // 補零：SQL 只回有資料的桶，直接畫會把三小時的量攤成整條軸
  const series = codeusage.fillSeries(
    [{ ts: base, requests: 3, input: 10, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 1 }],
    base - 5 * HOUR,
    base,
    'hour'
  )
  ok('序列補到六格', series.length === 6, String(series.length))
  ok('沒資料的格是 0', series[0].requests === 0)
  ok('有資料的格在最後', series[series.length - 1].requests === 3)
  ok('序列時間遞增', series.every((item, i) => i === 0 || item.ts > series[i - 1].ts))

  // 每一格都要帶 token 明細：只回一個總數的話，「幾十億 token」看不出是真的在打模型
  // 還是在讀快取（價差 10 倍）。1h 快取寫入要併進 cacheWrite，不然那一段會憑空消失
  const detailed = codeusage.fillSeries(
    [{ ts: base, requests: 2, input: 10, output: 4, cacheRead: 100, cacheWrite: 3, cacheWrite1h: 7, costUsd: 1 }],
    base, base, 'hour'
  )[0]
  ok('序列帶輸入／輸出明細', detailed.input === 10 && detailed.output === 4)
  ok('序列的 1h 快取寫入併進 cacheWrite', detailed.cacheWrite === 10, String(detailed.cacheWrite))
  ok('序列的 tokens 是四項總和',
    detailed.tokens === 10 + 4 + 100 + 10, String(detailed.tokens))
  ok('沒資料的格四項都是 0',
    series[0].input === 0 && series[0].output === 0 &&
    series[0].cacheRead === 0 && series[0].cacheWrite === 0)

  ok('時間範圍是白名單', Object.keys(codeusage.STAT_RANGES).join(',') === '24h,7d,30d,all')
  ok('五家供應商', codeusage.PROVIDERS.length === 5)
  ok('Antigravity 有標明資料來源限制',
    codeusage.PROVIDERS.find((item) => item.key === 'antigravity').note.includes('AGY'))
}

// 增量掃描是 async，這裡先接住，最後統一等它跑完再收尾
/** @type {Promise<unknown>} */
let asyncSections = Promise.resolve()

// ===== 增量掃描 =====
console.log('\n[F] 增量掃描')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-codeusage-'))
  const file = path.join(tmp, 'a.jsonl')
  const mkLine = (id) => JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: { id, model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5 } }
  })

  fs.writeFileSync(file, `${mkLine('m1')}\n${mkLine('m2')}\n`)

  const run = async () => {
    const cursors = {}
    const source = {
      provider: 'claude',
      roots: [tmp],
      match: (name) => name.endsWith('.jsonl'),
      parseLine: parsers.parseClaudeLine,
      newState: parsers.newState
    }
    const first = []
    await scan.scanSource(source, cursors, (event) => first.push(event), 0)
    ok('第一次讀到兩筆', first.length === 2, String(first.length))
    ok('游標記下位移', cursors[file].offset === fs.statSync(file).size)

    // 沒有新內容 → 不應該再算一次
    const second = []
    await scan.scanSource(source, cursors, (event) => second.push(event), 0)
    ok('沒有新內容時不重複計算', second.length === 0, String(second.length))

    // 附加一行 → 只讀新的那一段
    fs.appendFileSync(file, `${mkLine('m3')}\n`)
    const third = []
    await scan.scanSource(source, cursors, (event) => third.push(event), 0)
    ok('附加後只讀新的那一行', third.length === 1, String(third.length))

    // 檔案被截斷（Grok rewind）→ 整份重讀
    fs.writeFileSync(file, `${mkLine('m9')}\n`)
    const fourth = []
    await scan.scanSource(source, cursors, (event) => fourth.push(event), 0)
    ok('檔案變小時整份重讀', fourth.length === 1, String(fourth.length))

    // 保留期外的檔案不掃
    const outside = []
    await scan.scanSource(source, {}, (event) => outside.push(event), Date.now() + 60_000)
    ok('保留期外的檔案不掃', outside.length === 0)

    // Codex 的模型名只在 session 開頭寫一次；增量掃描下一次讀不到那幾行，
    // 沒把模型跟著游標留下來的話，之後每一筆用量都會被記成 `unknown`
    const cxFile = path.join(tmp, 'rollout-x.jsonl')
    const cxTokens = () => JSON.stringify({
      type: 'event_msg',
      timestamp: new Date().toISOString(),
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 20, output_tokens: 3 } } }
    })
    fs.writeFileSync(cxFile, `${JSON.stringify({
      type: 'session_meta', timestamp: new Date().toISOString(), payload: { model: 'gpt-5.6-sol' }
    })}\n${cxTokens()}\n`)
    const cxSource = {
      provider: 'codex',
      roots: [tmp],
      match: (name) => name.startsWith('rollout-'),
      parseLine: parsers.parseCodexLine,
      newState: parsers.newState
    }
    const cxCursors = {}
    const cx1 = []
    await scan.scanSource(cxSource, cxCursors, (event) => cx1.push(event), 0)
    ok('第一次掃到模型名', cx1[0]?.model === 'gpt-5.6-sol', JSON.stringify(cx1[0]))
    fs.appendFileSync(cxFile, `${cxTokens()}\n`)
    const cx2 = []
    await scan.scanSource(cxSource, cxCursors, (event) => cx2.push(event), 0)
    ok('增量掃描不會把模型變成 unknown', cx2[0]?.model === 'gpt-5.6-sol', JSON.stringify(cx2[0]))

    // 掃到一半還在重播（fork 檔正在寫）：重播旗標沒跟著游標留下來的話，
    // 剩下那半份重播會在下一次被當成新用量收進去
    const fkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-usage-fork-'))
    const fkFile = path.join(fkDir, 'rollout-fork.jsonl')
    fs.writeFileSync(fkFile, `${JSON.stringify({
      type: 'session_meta', timestamp: new Date().toISOString(), payload: { forked_from_id: 'parent' }
    })}\n${cxTokens()}\n`)
    const fkSource = { ...cxSource, roots: [fkDir] }
    const fkCursors = {}
    const fk1 = []
    await scan.scanSource(fkSource, fkCursors, (event) => fk1.push(event), 0)
    ok('重播段落第一次掃不計', fk1.length === 0, String(fk1.length))
    fs.appendFileSync(fkFile, `${cxTokens()}\n`)
    const fk2 = []
    await scan.scanSource(fkSource, fkCursors, (event) => fk2.push(event), 0)
    ok('重播旗標跨次留著（增量也不計）', fk2.length === 0, String(fk2.length))
    fs.appendFileSync(fkFile, `${JSON.stringify({
      type: 'turn_context', payload: { model: 'gpt-5.6-sol' }
    })}\n${cxTokens()}\n`)
    const fk3 = []
    await scan.scanSource(fkSource, fkCursors, (event) => fk3.push(event), 0)
    ok('turn_context 之後的新用量照收', fk3.length === 1 && fk3[0].model === 'gpt-5.6-sol', String(fk3.length))
    fs.rmSync(fkDir, { recursive: true, force: true })

    // 檔案不見了 → 游標清掉
    fs.unlinkSync(cxFile)
    fs.unlinkSync(file)
    scan.pruneCursors(cursors)
    ok('檔案不見時游標清掉', Object.keys(cursors).length === 0)

    fs.rmSync(tmp, { recursive: true, force: true })
  }

  asyncSections = run()
}

asyncSections
  .catch((error) => {
    failed++
    console.log(`  FAIL 非同步測試拋錯 — ${error && error.message}`)
  })
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
  })
