'use strict'

/**
 * AGY 反代：真實上游探測。
 *
 * 為什麼需要這支：`agy/model-map.js` 的映射目標、`agy/upstream.js` 的端點順序、
 * 以及「哪些模型不接受 thinkingBudget: 0」都是**實測結果**，不是規格文件抄來的。
 * 上游改了就會失準，改映射表之前先跑這支拿到當下的真相。
 *
 *   npx electron scripts/probe-agy-upstream.js
 *
 * 需要本機有可用的 Antigravity 憑證。token 過期時要能 refresh，需另外提供
 * ANTIGRAVITY_CLIENT_ID／ANTIGRAVITY_CLIENT_SECRET 環境變數（Antigravity IDE
 * 自己的 public desktop OAuth client；本專案刻意不硬編碼，見 CLAUDE.md 安全底線）。
 *
 * 會消耗少量額度：每格是一次 max_tokens=8 的生成。
 */

const { app } = require('electron')
const path = require('path')

const AGY = path.join(__dirname, '..', 'src', 'main', 'agy')
const credential = require(path.join(AGY, 'credential'))
const openai = require(path.join(AGY, 'openai'))
const { UPSTREAM_MODELS, REJECTS_ZERO_BUDGET } = require(path.join(AGY, 'model-map'))
const { USER_AGENT } = require(path.join(__dirname, '..', 'src', 'main', 'usage', 'antigravity'))

const BASES = [
  ['sandbox', 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal'],
  ['daily', 'https://daily-cloudcode-pa.googleapis.com/v1internal'],
  ['prod', 'https://cloudcode-pa.googleapis.com/v1internal']
]

/** 印出去的東西一律先抹掉像 token 的字串 */
function redact(text) {
  return String(text)
    .replace(/ya29\.[\w.-]+/g, 'ya29.<redacted>')
    .replace(/1\/\/[\w-]+/g, '1//<redacted>')
}

function messageOf(text) {
  const matched = redact(text).match(/"message"\s*:\s*"([^"]{0,110})/)
  return matched ? matched[1] : redact(text).replace(/\s+/g, ' ').slice(0, 110)
}

async function generate({ base, token, project, model, thinkingConfig }) {
  const inner = openai.toGeminiRequest(
    { model, messages: [{ role: 'user', content: '說「好」' }], max_tokens: 8 }, model
  )
  if (thinkingConfig !== undefined) {
    inner.generationConfig = { ...inner.generationConfig }
    if (thinkingConfig === null) delete inner.generationConfig.thinkingConfig
    else inner.generationConfig.thinkingConfig = thinkingConfig
  }
  try {
    const response = await fetch(`${base}:generateContent`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: '*/*',
        'User-Agent': USER_AGENT
      },
      body: JSON.stringify({ project, request: inner, model, userAgent: USER_AGENT })
    })
    const text = await response.text()
    return { status: response.status, message: response.ok ? '' : messageOf(text) }
  } catch (error) {
    return { status: 0, message: redact(error?.message || 'network error') }
  }
}

async function main() {
  const status = await credential.status()
  console.log('憑證：', JSON.stringify(status))
  if (!status.connected) {
    console.log('\n憑證不可用，無法探測。開一次 Antigravity IDE 讓它更新 token，')
    console.log('或提供 ANTIGRAVITY_CLIENT_ID／ANTIGRAVITY_CLIENT_SECRET 讓本機自行 refresh。')
    app.exit(1)
    return
  }
  const { token, project } = await credential.acquire({})

  console.log('\n=== 模型 × 端點 ===')
  const head = 'model'.padEnd(28) + BASES.map(([label]) => label.padEnd(10)).join('')
  console.log(head)
  console.log('-'.repeat(head.length))

  const notes = new Set()
  const usable = []
  for (const model of UPSTREAM_MODELS) {
    let row = model.padEnd(28)
    let anyOk = false
    for (const [label, base] of BASES) {
      const result = await generate({ base, token, project, model })
      row += `${result.status}`.padEnd(10)
      if (result.status === 200) anyOk = true
      else if (result.message) notes.add(`${model}: ${result.message}`)
    }
    console.log(row)
    if (anyOk) usable.push(model)
  }

  console.log('\n=== thinkingBudget: 0 相容性 ===')
  console.log('（不接受的模型必須列進 model-map.js 的 REJECTS_ZERO_BUDGET）')
  const [, sandbox] = BASES[0]
  const shouldBeThinkingOnly = []
  for (const model of usable) {
    const withBudget = await generate({
      base: sandbox, token, project, model,
      thinkingConfig: { includeThoughts: false, thinkingBudget: 0 }
    })
    const accepts = withBudget.status === 200
    const listed = REJECTS_ZERO_BUDGET.has(model)
    if (!accepts) shouldBeThinkingOnly.push(model)
    const flag = accepts === !listed ? 'ok' : '不一致'
    console.log(`  ${model.padEnd(28)} budget0=${accepts ? '接受' : '拒絕'}  名單內=${listed ? '是' : '否'}  ${flag}`)
  }

  console.log('\n=== 結論 ===')
  console.log('可用模型：', usable.join(', ') || '(無)')
  console.log('應列入 REJECTS_ZERO_BUDGET：', shouldBeThinkingOnly.join(', ') || '(無)')
  const listed = [...REJECTS_ZERO_BUDGET]
  const drift = listed.filter((m) => usable.includes(m) && !shouldBeThinkingOnly.includes(m))
  if (drift.length) console.log('名單多餘（實測其實接受 budget 0）：', drift.join(', '))
  if (notes.size) {
    console.log('\n失敗訊息：')
    for (const note of notes) console.log('  ' + note)
  }

  app.exit(0)
}

app.whenReady().then(() => {
  app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))
  main().catch((error) => {
    console.error(redact(error?.stack || error))
    app.exit(1)
  })
})
