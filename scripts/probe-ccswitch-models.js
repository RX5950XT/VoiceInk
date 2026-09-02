'use strict'

/**
 * 探測 `presets.js` 裡每一家的 `modelsUrl` 到底在不在。**動 modelsUrl 之前先跑這支。**
 *
 * 判準：200＝可用；401／403＝端點在但憑證不對（cli 那兩家換真憑證再試一輪）；
 * 404＝不支援（表上就不該有 modelsUrl）。
 *
 *     node scripts/probe-ccswitch-models.js
 */

const path = require('path')

const presets = require(path.join(__dirname, '..', 'src', 'main', 'ccswitch', 'presets.js'))
const modelsScan = require(path.join(__dirname, '..', 'src', 'main', 'ccswitch', 'models-scan.js'))

const TIMEOUT_MS = 15_000

/**
 * @param {string} url
 * @param {Record<string, string>} headers
 * @returns {Promise<{ status: number, sample: string, ids: string[] }>}
 */
async function get(url, headers) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: controller.signal })
    let sample = ''
    /** @type {string[]} */
    let found = []
    try {
      const data = await response.json()
      const ids = Array.isArray(data?.data)
        ? data.data.map((row) => row?.id ?? row?.slug).filter(Boolean)
        : Array.isArray(data?.models)
          ? data.models.map((row) => row?.id ?? row?.slug).filter(Boolean)
          : []
      sample = ids.length ? `${ids.length} 顆，前 3：${ids.slice(0, 3).join(', ')}` : '(解析不到模型 id)'
      found = ids
    } catch {
      sample = ''
    }
    return { status: response.status, sample, ids: found }
  } catch (error) {
    return { status: 0, sample: error?.name === 'AbortError' ? '逾時' : '連不上', ids: [] }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 走跟 App 同一條路（models-scan 的目標解析＋憑證取得），不是自己另寫一份。
 * @param {{ id: string, presetId: string }} provider
 */
async function probeProvider(provider) {
  const target = modelsScan.resolveScanTarget(provider)
  if (!target) {
    console.log(`--  ${provider.presetId.padEnd(14)} 這家不支援掃描（表上沒有 modelsUrl）`)
    return { ok: true, ids: [] }
  }
  const fake = target.auth === 'x-api-key'
    ? { 'x-api-key': 'probe' }
    : target.auth === 'bearer' ? {} : null // cli 沒有「假金鑰」可打，直接走真憑證
  if (fake) {
    const r = await get(target.url, fake)
    if (r.status === 200) {
      console.log(`OK  ${provider.presetId.padEnd(14)} ${target.url}  ${r.sample}`)
      return { ok: true, ids: r.ids }
    }
    // 假金鑰不通就換 App 真的憑證路徑（cli / 有金鑰的形狀交給 acquire 之後重打）
  }
  const real = await modelsScan.scanProviderModels(provider).catch(() => null)
  if (real?.ok) {
    console.log(`OK  ${provider.presetId.padEnd(14)} ${target.url}  ${real.models.length} 顆（走 App 憑證路徑）`)
    return { ok: true, ids: real.models }
  }
  console.log(`BAD ${provider.presetId.padEnd(14)} ${target.url}  ${real ? `${real.code}：${real.error}` : '例外'}`)
  return { ok: false, ids: [] }
}

async function main() {
  const targets = presets.PRESETS.filter((preset) => preset.id !== 'custom')
  console.log(`探測 ${targets.length} 家的 modelsUrl（200 = 可用）\n`)
  let bad = 0
  /** @type {Array<[string, string[]]>} */
  const stale = []
  for (const preset of targets) {
    const result = await probeProvider({ id: 'probe', presetId: preset.id })
    if (!result.ok) bad++
    // 表上寫死的四個等級預設模型如果上游已經下架，第一次用就是 400，而且看不出原因
    if (result.ids.length) {
      const wanted = [...new Set(Object.entries(preset.env)
        .filter(([key]) => key.endsWith('_MODEL')).map(([, value]) => value))]
      const missing = wanted.filter((id) => !result.ids.includes(id))
      if (missing.length) stale.push([preset.id, missing])
    }
  }
  if (stale.length) {
    console.log('\n預設模型已經不在上游清單裡（表要更新）：')
    for (const [id, missing] of stale) console.log(`  ${id.padEnd(14)} ${missing.join(', ')}`)
    bad += stale.length
  } else {
    console.log('\n每一家表上的預設模型都還在上游清單裡。')
  }
  console.log(`\n${bad} 項失敗。cli 那兩家失敗多半是「沒登入」或「訂閱額度用完」，訊息會講清楚。`)
  process.exitCode = bad ? 1 : 0
}

main().catch((error) => {
  console.error('探測失敗：', error?.message || error)
  process.exitCode = 1
})
