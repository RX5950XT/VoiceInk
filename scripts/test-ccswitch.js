#!/usr/bin/env node
/**
 * VoiceInk — Claude Code 供應商切換的純邏輯回歸測試（node 直跑，不需 electron）
 *
 * 重點在「寫使用者的 ~/.claude/settings.json」這一段：那是本功能唯一會動到 App 之外
 * 真實資料的地方。測試把家目錄指到暫存夾，確認：
 *   - 使用者的 hooks／plugins／自訂 env 一個都不會少（上游 cc-switch 是整檔覆寫）
 *   - 換供應商時前一家的金鑰鍵真的被清掉（只 merge 的話會兩把金鑰一起送出去）
 *   - settings.json 壞掉時是拋錯不是當成空物件（當成空的就等於把設定洗掉）
 */

'use strict'

const path = require('path')
const fs = require('fs')
const os = require('os')
const { createHash } = require('crypto')

const ROOT = path.join(__dirname, '..')
const claudeSettings = require(path.join(ROOT, 'src/main/ccswitch/claude-settings.js'))
const presets = require(path.join(ROOT, 'src/main/ccswitch/presets.js'))
const providers = require(path.join(ROOT, 'src/main/ccswitch/providers.js'))
const modelsScan = require(path.join(ROOT, 'src/main/ccswitch/models-scan.js'))

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

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-ccswitch-'))
claudeSettings.configure({
  homeDir: tmpHome,
  backupDir: path.join(tmpHome, 'backup')
})

function writeLiveSettings(obj) {
  const file = claudeSettings.settingsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(obj, null, 2))
}

function readLiveSettings() {
  return JSON.parse(fs.readFileSync(claudeSettings.settingsPath(), 'utf8'))
}

// ===== 純函式：env 清理與合併 =====
console.log('\n[A] env 清理與合併')
{
  const clean = claudeSettings.sanitizeEnv({
    ANTHROPIC_BASE_URL: '  https://example.com  ',
    ANTHROPIC_MODEL: 'x',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: 372000,
    SOMETHING_ELSE: 'nope',
    ANTHROPIC_API_KEY: { nested: true },
    ANTHROPIC_AUTH_TOKEN: '   '
  })
  ok('去頭尾空白', clean.ANTHROPIC_BASE_URL === 'https://example.com')
  ok('數字轉字串', clean.CLAUDE_CODE_MAX_CONTEXT_TOKENS === '372000')
  ok('不管的鍵不會混進來', !('SOMETHING_ELSE' in clean))
  ok('物件值丟掉', !('ANTHROPIC_API_KEY' in clean))
  ok('純空白視同沒填', !('ANTHROPIC_AUTH_TOKEN' in clean))

  const tooLong = claudeSettings.sanitizeEnv({ ANTHROPIC_AUTH_TOKEN: 'k'.repeat(5000) })
  ok('超長值丟掉', !('ANTHROPIC_AUTH_TOKEN' in tooLong))

  const stripped = claudeSettings.stripManaged({
    ANTHROPIC_BASE_URL: 'https://old',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    MY_OWN: 'keep'
  })
  ok('使用者自己的 env 保留', stripped.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === '1' && stripped.MY_OWN === 'keep')
  ok('我們管的鍵被清掉', !('ANTHROPIC_BASE_URL' in stripped))

  // A 家用 API_KEY、B 家用 AUTH_TOKEN：只 merge 的話 A 的金鑰會殘留，兩把一起送出去
  const merged = claudeSettings.mergeEnv(
    { ANTHROPIC_API_KEY: 'from-a', ANTHROPIC_BASE_URL: 'https://a', MY_OWN: 'keep' },
    { ANTHROPIC_AUTH_TOKEN: 'from-b', ANTHROPIC_BASE_URL: 'https://b' }
  )
  ok('切換時舊供應商的金鑰鍵被清掉', !('ANTHROPIC_API_KEY' in merged))
  ok('新供應商的值寫進去', merged.ANTHROPIC_AUTH_TOKEN === 'from-b' && merged.ANTHROPIC_BASE_URL === 'https://b')
  ok('合併時仍保留使用者自己的 env', merged.MY_OWN === 'keep')

  ok('mergeEnv 對 undefined 安全', Object.keys(claudeSettings.mergeEnv(undefined, {})).length === 0)
  ok('mergeEnv 對陣列安全', Object.keys(claudeSettings.mergeEnv([1, 2], {})).length === 0)
}

// ===== 檔案：外科式寫入 =====
console.log('\n[B] settings.json 外科式寫入')
{
  writeLiveSettings({
    model: 'opusplan',
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
    enabledPlugins: { 'ponytail@x': true },
    permissions: { allow: ['Bash'] },
    env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ANTHROPIC_API_KEY: 'old-key' }
  })

  const result = claudeSettings.applyEnv({
    ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
    ANTHROPIC_AUTH_TOKEN: 'new-token',
    ANTHROPIC_MODEL: 'anthropic/claude-sonnet-5'
  })
  const after = readLiveSettings()

  ok('hooks 原樣保留', JSON.stringify(after.hooks) === JSON.stringify({ SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] }))
  ok('enabledPlugins 原樣保留', after.enabledPlugins['ponytail@x'] === true)
  ok('permissions 原樣保留', after.permissions.allow[0] === 'Bash')
  ok('model 原樣保留', after.model === 'opusplan')
  ok('使用者自訂 env 保留', after.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === '1')
  ok('舊金鑰被清掉', !('ANTHROPIC_API_KEY' in after.env))
  ok('新 env 寫進去', after.env.ANTHROPIC_AUTH_TOKEN === 'new-token')
  ok('有做備份', Boolean(result.backup) && fs.existsSync(result.backup))

  const backedUp = JSON.parse(fs.readFileSync(result.backup, 'utf8'))
  ok('備份是寫入前的內容', backedUp.env.ANTHROPIC_API_KEY === 'old-key')

  // 切回官方＝清乾淨，但使用者自己的 env 還在
  claudeSettings.applyEnv({})
  const official = readLiveSettings()
  ok('切回官方清掉我們管的鍵', !('ANTHROPIC_BASE_URL' in official.env) && !('ANTHROPIC_AUTH_TOKEN' in official.env))
  ok('切回官方仍保留使用者的 env', official.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === '1')
  ok('切回官方不動 hooks', Boolean(official.hooks))

  // 沒有 tmp 殘留
  const leftovers = fs.readdirSync(claudeSettings.claudeDir()).filter((n) => n.includes('voiceink-tmp'))
  ok('沒有留下暫存檔', leftovers.length === 0, leftovers.join(','))
}

console.log('\n[C] 壞掉的 settings.json 不可以當成空物件')
{
  fs.writeFileSync(claudeSettings.settingsPath(), '{ this is not json')
  let threw = ''
  try {
    claudeSettings.readSettings()
  } catch (error) {
    threw = error.code
  }
  ok('壞 JSON 會拋錯', threw === 'SETTINGS_INVALID_JSON', threw)
  ok('壞 JSON 時檔案沒被動過', fs.readFileSync(claudeSettings.settingsPath(), 'utf8') === '{ this is not json')

  fs.writeFileSync(claudeSettings.settingsPath(), '[1,2,3]')
  let shapeErr = ''
  try {
    claudeSettings.readSettings()
  } catch (error) {
    shapeErr = error.code
  }
  ok('最外層不是物件會拋錯', shapeErr === 'SETTINGS_INVALID_SHAPE', shapeErr)

  fs.unlinkSync(claudeSettings.settingsPath())
  ok('檔案不存在時回空物件', Object.keys(claudeSettings.readSettings()).length === 0)
  const fresh = claudeSettings.applyEnv({ ANTHROPIC_BASE_URL: 'https://x' })
  ok('第一次寫入沒有備份可做', fresh.backup === null)
  ok('第一次寫入有建出檔案', readLiveSettings().env.ANTHROPIC_BASE_URL === 'https://x')
}

// ===== 預設表 =====
console.log('\n[D] 預設表')
{
  const list = presets.catalog()
  const ids = list.map((p) => p.id)
  // 官方訂閱（回到原本的登入）排第一、自訂收尾，中間是內建各家；順序就是 tile 那一排的順序
  ok('官方訂閱排第一、自訂收尾', ids[0] === 'official' && ids.at(-1) === 'custom', ids.join(','))
  ok('Command Code 預設走 OpenAI Chat',
    presets.getPreset('commandcode')?.route === 'gateway' &&
    presets.getPreset('commandcode')?.apiFormat === 'openai_chat' &&
    presets.getPreset('commandcode')?.baseUrl === 'https://api.commandcode.ai/provider')
  ok('官方訂閱不需要金鑰也沒有端點',
    presets.getPreset('official').auth === 'none' && presets.getPreset('official').baseUrl === '')
  ok('官方訂閱不寫任何 env',
    Object.keys(presets.getPreset('official').env).length === 0)
  // 每一筆都要有名字與 hint，不然下拉會出現空白列
  ok('每一筆都有名稱與說明', list.every((p) => p.name && p.hint))
  ok('id 不重複', new Set(ids).size === ids.length)
  // 自訂沒有固定端點；官方訂閱刻意不寫端點（寫了會蓋掉使用者原本的自架／企業代理設定）
  const noUrl = list.filter((p) => p.route === 'direct' && !p.baseUrl).map((p) => p.id)
  ok('直連的都有端點（自訂與官方訂閱除外）',
    noUrl.every((id) => id === 'custom' || id === 'official'), noUrl.join(','))
  // 端點是探測過才寫進表的，這裡守「格式」——真的能不能通要跑 probe-ccswitch-endpoints.js
  const badUrl = list.filter((p) => p.baseUrl && !/^https?:\/\//.test(p.baseUrl)).map((p) => p.id)
  ok('端點只用 http(s)', badUrl.length === 0, badUrl.join(','))
  const trailing = list.filter((p) => p.baseUrl.endsWith('/')).map((p) => p.id)
  ok('端點沒有結尾斜線（接路徑時會變兩條斜線）', trailing.length === 0, trailing.join(','))
  // modelsUrl 是掃描按鈕的開關：五家內建都要有（格式守在這裡，真的通不通跑 probe-ccswitch-models.js）
  const builtin = list.filter((p) => p.id !== 'custom' && p.auth !== 'none')
  ok('六家內建都有 modelsUrl', builtin.every((p) => /^https?:\/\//.test(p.modelsUrl)),
    builtin.filter((p) => !p.modelsUrl).map((p) => p.id).join(','))
  ok('自訂沒有 modelsUrl（由 baseUrl 推導）', presets.getPreset('custom').modelsUrl === undefined)
  ok('modelsAuth 都在白名單', builtin.every((p) => ['bearer', 'x-api-key', 'cli', 'none'].includes(p.modelsAuth)))
  ok('OpenCode Go 用 ANTHROPIC_API_KEY', presets.getPreset('opencode-go').keyField === 'ANTHROPIC_API_KEY')
  ok('Codex 走閘道', presets.getPreset('codex').route === 'gateway')
  ok('Grok 走閘道', presets.getPreset('grok-build').route === 'gateway')
  ok('Ollama Cloud 走閘道', presets.getPreset('ollama-cloud').route === 'gateway')
  ok('OpenRouter 直連', presets.getPreset('openrouter').route === 'direct')
  ok('不認得的 id 回 null', presets.getPreset('nope') === null)
  ok('被下架的預設回 null（舊實例會被 sanitize 丟掉）', presets.getPreset('z-ai') === null)
  ok('原型污染字串不會命中', presets.getPreset('constructor') === null)

  // 所有預設寫出來的 env 鍵都必須在我們管得到的範圍內，否則切換時清不掉
  const managed = new Set(claudeSettings.MANAGED_ENV_KEYS)
  const stray = presets.PRESETS.flatMap((p) => Object.keys(p.env)).filter((k) => !managed.has(k))
  ok('預設用到的 env 鍵都在 MANAGED_ENV_KEYS 內', stray.length === 0, stray.join(','))
}

// ===== 內建供應商格式與驗證格式 =====
console.log('\n[D1] 內建供應商格式')
{
  const expectedFormats = {
    'grok-build': 'openai_responses',
    codex: 'openai_responses',
    'ollama-cloud': 'openai_responses',
    'opencode-go': 'openai_responses',
    commandcode: 'openai_chat',
    openrouter: 'anthropic'
  }
  const expectedValidation = {
    'grok-build': 'openai_chat',
    codex: 'openai_responses',
    'ollama-cloud': 'openai_responses',
    'opencode-go': 'openai_chat',
    commandcode: 'anthropic',
    openrouter: 'anthropic'
  }
  for (const [id, format] of Object.entries(expectedFormats)) {
    const preset = presets.getPreset(id)
    ok(`${id} 預設上游格式正確`, preset?.apiFormat === format, preset?.apiFormat)
    ok(`${id} 預設驗證格式正確`, preset?.validationFormat === expectedValidation[id], preset?.validationFormat)
  }
  const expectedWireUrls = {
    'grok-build': 'https://cli-chat-proxy.grok.com/v1/responses',
    codex: 'https://chatgpt.com/backend-api/codex/responses',
    'ollama-cloud': 'https://ollama.com/v1/responses',
    'opencode-go': 'https://opencode.ai/zen/go/v1/responses',
    commandcode: 'https://api.commandcode.ai/provider/v1/chat/completions',
    openrouter: 'https://openrouter.ai/api/v1/messages'
  }
  for (const [id, expected] of Object.entries(expectedWireUrls)) {
    const preset = presets.getPreset(id)
    const actual = providers.wireUrlFor({ presetId: id }, preset, preset.apiFormat)
    ok(`${id} 上游 URL 正確`, actual === expected, actual)
  }
  ok('內建供應商可以改上游格式',
    providers.routeFor(
      { presetId: 'opencode-go', apiFormat: 'openai_chat' },
      presets.getPreset('opencode-go')
    ) === 'gateway')
  ok('有上游測試功能', typeof modelsScan.testProvider === 'function')
}

// ===== 自訂供應商與路由開關 =====
console.log('\n[D2] 自訂供應商（協議＝路由開關）')
{
  const custom = presets.getPreset('custom')
  ok('自訂那筆沒有預設端點', custom.baseUrl === '')
  ok('三種協議都收', providers.API_FORMATS.join(',') === 'anthropic,openai_chat,openai_responses')

  const mk = (apiFormat) => ({
    id: 'p_abc', presetId: 'custom', apiFormat, baseUrl: 'https://api.example.com/v1', apiKey: 'sk-1'
  })
  ok('anthropic → 直連', providers.routeFor(mk('anthropic'), custom) === 'direct')
  ok('openai_chat → 經閘道', providers.routeFor(mk('openai_chat'), custom) === 'gateway')
  ok('openai_responses → 經閘道', providers.routeFor(mk('openai_responses'), custom) === 'gateway')
  ok('看不懂的協議退回 anthropic', providers.routeFor(mk('bogus'), custom) === 'direct')

  // 路由 key 用 provider id：兩筆自訂共用 `custom` 的話，閘道會把後面那筆的端點
  // 套到前面那筆身上（症狀是切過去之後打到別人的上游）
  ok('自訂的路由 key 是 provider id', providers.routeKeyFor(mk('openai_chat'), custom) === 'p_abc')
  ok('內建的路由 key 還是 preset id',
    providers.routeKeyFor({ id: 'p_x' }, presets.getPreset('codex')) === 'codex')

  const direct = providers.resolveEnv(mk('anthropic'))
  ok('自訂直連寫自己的端點', direct.ANTHROPIC_BASE_URL === 'https://api.example.com/v1')
  ok('自訂直連寫自己的金鑰', direct.ANTHROPIC_AUTH_TOKEN === 'sk-1')

  const viaGw = providers.resolveEnv(mk('openai_chat'), { baseUrl: 'http://127.0.0.1:8791', apiKey: 'gw' })
  ok('自訂走閘道時指到本機', viaGw.ANTHROPIC_BASE_URL === 'http://127.0.0.1:8791/p_abc')
  ok('走閘道時 settings.json 拿到的是閘道金鑰、不是使用者的', viaGw.ANTHROPIC_AUTH_TOKEN === 'gw')
  ok('使用者的金鑰沒有進 settings.json',
    JSON.stringify(viaGw).includes('sk-1') === false, JSON.stringify(viaGw))

  // 沒填端點就擋在這裡，不要等到 Claude Code 打去 Anthropic 官方回 401 才發現
  let code = ''
  try {
    providers.resolveEnv({ id: 'p_z', presetId: 'custom', apiFormat: 'anthropic', baseUrl: '', apiKey: 'k' })
  } catch (error) {
    code = error.code
  }
  ok('自訂沒填端點會擋下來', code === 'MISSING_BASE_URL', code)

  // 存檔路徑：壞掉的協議與網址都要收斂，而且自訂的 baseUrl 不可以被清掉
  const [saved] = providers.sanitizeAll([{
    id: 'p_1', presetId: 'custom', apiFormat: 'openai_chat', baseUrl: 'https://ok.example/v1', apiKey: 'k'
  }])
  ok('自訂存得下協議', saved.apiFormat === 'openai_chat')
  ok('自訂存得下端點', saved.baseUrl === 'https://ok.example/v1')
  const [bad] = providers.sanitizeAll([{
    id: 'p_2', presetId: 'custom', apiFormat: 'javascript', baseUrl: 'javascript:alert(1)', apiKey: 'k'
  }])
  ok('非 http(s) 的端點被清掉', bad.baseUrl === '')
  ok('看不懂的協議收斂成 anthropic', bad.apiFormat === 'anthropic')
  // 內建走閘道那幾家的端點在閘道固定表裡，存使用者填的沒有意義也不該生效
  const [builtin] = providers.sanitizeAll([{
    id: 'p_3', presetId: 'codex', baseUrl: 'https://evil.example', apiKey: ''
  }])
  ok('內建閘道預設不吃使用者填的端點', builtin.baseUrl === '')
}

// ===== resolveEnv =====
console.log('\n[E] resolveEnv')
{
  const direct = providers.resolveEnv({ presetId: 'openrouter', apiKey: 'sk-or-1', model: '' })
  ok('直連寫上游網址', direct.ANTHROPIC_BASE_URL === 'https://openrouter.ai/api')
  ok('直連寫金鑰', direct.ANTHROPIC_AUTH_TOKEN === 'sk-or-1')
  ok('直連帶預設模型', direct.ANTHROPIC_MODEL === 'anthropic/claude-sonnet-5')

  // 主模型只動 ANTHROPIC_MODEL；沒填的等級沿用預設表（cc-switch 的模型映射一樣是分格的）
  const overridden = providers.resolveEnv({ presetId: 'openrouter', apiKey: 'sk-or-1', model: 'x-ai/grok-4.6' })
  ok('主模型只寫兜底那個鍵', overridden.ANTHROPIC_MODEL === 'x-ai/grok-4.6')
  ok('沒填的等級沿用預設', overridden.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'anthropic/claude-haiku-4.5')

  const perTier = providers.resolveEnv({
    presetId: 'openrouter', apiKey: 'k', model: 'a', haikuModel: 'b', sonnetModel: 'c', opusModel: 'd'
  })
  ok('四個等級各自寫各自的鍵',
    perTier.ANTHROPIC_MODEL === 'a' && perTier.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'b' &&
    perTier.ANTHROPIC_DEFAULT_SONNET_MODEL === 'c' && perTier.ANTHROPIC_DEFAULT_OPUS_MODEL === 'd')

  // 內建各家的端點是實測查證過的事實，**不吃**使用者（或被手改的 store）塞的網址；
  // 要接自架端點就開一筆自訂。少了這條守衛，UI 藏起輸入格也只是藏起來而已
  const forced = providers.resolveEnv({ presetId: 'openrouter', apiKey: 'k', baseUrl: 'https://my.host/api/' })
  ok('內建不吃自填 Base URL', forced.ANTHROPIC_BASE_URL === 'https://openrouter.ai/api', forced.ANTHROPIC_BASE_URL)
  const gw = { baseUrl: 'http://127.0.0.1:8790/p', apiKey: 'gw-key' }
  const ccGateway = providers.resolveEnv({ presetId: 'commandcode', apiKey: 'k' }, gw)
  ok('Command Code 預設走閘道',
    ccGateway.ANTHROPIC_BASE_URL === 'http://127.0.0.1:8790/p/commandcode' &&
    ccGateway.ANTHROPIC_AUTH_TOKEN === 'gw-key')
  // 自訂那筆才是使用者說了算，而且只放行 http(s)
  const mine = providers.resolveEnv({ presetId: 'custom', apiKey: 'k', baseUrl: 'https://my.host/api/' })
  ok('自訂用自填 Base URL', mine.ANTHROPIC_BASE_URL === 'https://my.host/api')
  let badUrlCode = ''
  try {
    providers.resolveEnv({ presetId: 'custom', apiKey: 'k', baseUrl: 'javascript:alert(1)' })
  } catch (error) {
    badUrlCode = error.code
  }
  ok('非 http(s) 的 Base URL 當成沒填', badUrlCode === 'MISSING_BASE_URL', badUrlCode)

  // 金鑰欄位填錯的症狀是靜默 401，所以要能自己選；只收白名單裡那兩個
  const authSwap = providers.resolveEnv({ presetId: 'openrouter', apiKey: 'k', authField: 'ANTHROPIC_API_KEY' })
  ok('金鑰寫進使用者選的欄位',
    authSwap.ANTHROPIC_API_KEY === 'k' && authSwap.ANTHROPIC_AUTH_TOKEN === undefined)
  const authBad = providers.resolveEnv({ presetId: 'openrouter', apiKey: 'k', authField: 'MY_SECRET' })
  ok('不認得的金鑰欄位退回預設', authBad.ANTHROPIC_AUTH_TOKEN === 'k' && authBad.MY_SECRET === undefined)

  const viaGateway = providers.resolveEnv({ presetId: 'codex', apiKey: '', model: '' }, gw)
  ok('閘道路由指向本機', viaGateway.ANTHROPIC_BASE_URL === 'http://127.0.0.1:8790/p/codex')
  ok('閘道路由帶閘道自己的金鑰', viaGateway.ANTHROPIC_AUTH_TOKEN === 'gw-key')
  ok('Codex 釘住 372K 窗口', viaGateway.CLAUDE_CODE_MAX_CONTEXT_TOKENS === '372000')

  const trailing = providers.resolveEnv({ presetId: 'grok-build', apiKey: '', model: '' }, { baseUrl: 'http://127.0.0.1:8790/p/', apiKey: 'k' })
  ok('閘道網址尾斜線不會變成雙斜線', trailing.ANTHROPIC_BASE_URL === 'http://127.0.0.1:8790/p/grok-build')

  // 使用者的 Ollama 金鑰由閘道自己去拿，不可以寫進 settings.json
  const ollama = providers.resolveEnv({ presetId: 'ollama-cloud', apiKey: 'ollama-secret', model: '' }, gw)
  ok('閘道路由的使用者金鑰不進 settings.json',
    JSON.stringify(ollama).indexOf('ollama-secret') === -1)

  let missingKey = ''
  try {
    providers.resolveEnv({ presetId: 'openrouter', apiKey: '', model: '' })
  } catch (error) {
    missingKey = error.code
  }
  ok('沒填金鑰會擋下來', missingKey === 'MISSING_API_KEY', missingKey)

  let offline = ''
  try {
    providers.resolveEnv({ presetId: 'codex', apiKey: '', model: '' })
  } catch (error) {
    offline = error.code
  }
  ok('閘道沒起來會擋下來', offline === 'GATEWAY_OFFLINE', offline)

  ok('不認得的預設回空物件', Object.keys(providers.resolveEnv({ presetId: 'nope' })).length === 0)

  // 官方訂閱＝什麼都不寫。就算那一筆殘留著金鑰／模型／端點也一個都不能寫出去，
  // 不然「切回官方」只是換成另一種被我們改過的狀態
  const back = providers.resolveEnv({
    presetId: 'official', apiKey: 'leftover', model: 'leftover', baseUrl: 'https://leftover'
  })
  ok('切回官方寫出空 env', Object.keys(back).length === 0, Object.keys(back).join(','))
}

// ===== sanitizeAll / detectActiveId =====
console.log('\n[F] 清單正規化與作用中判定')
{
  const items = providers.sanitizeAll([
    { id: 'a', presetId: 'openrouter', name: '  我的 OR  ', apiKey: 'k', model: 'm', createdAt: 1 },
    { id: 'a', presetId: 'openrouter' },
    { id: 'b', presetId: '不存在' },
    { id: '', presetId: 'openrouter' },
    null,
    { id: 'c', presetId: 'z-ai', apiKey: 'should-be-dropped' }
  ])
  ok('重複 id 只留一筆', items.filter((i) => i.id === 'a').length === 1)
  ok('未知預設整筆丟掉', !items.some((i) => i.id === 'b'))
  ok('被下架的預設整筆丟掉（金鑰一併消失）', !items.some((i) => i.id === 'c'))
  ok('空 id 丟掉', items.length === 1, String(items.length))
  ok('名稱去空白', items[0].name === '我的 OR')
  ok('非陣列回空陣列', providers.sanitizeAll('nope').length === 0)

  // 舊檔只有一個 model，語意是四個等級全套；升級後不能悄悄變成「只有兜底」
  const legacy = providers.sanitizeAll([{ id: 'l', presetId: 'openrouter', apiKey: 'k', model: 'x' }])[0]
  ok('舊檔的單一模型補到三個等級',
    legacy.haikuModel === 'x' && legacy.sonnetModel === 'x' && legacy.opusModel === 'x')
  // 反過來，使用者刻意清空某一格不可以被補回去（所以判斷要看鍵在不在，不是看值空不空）
  const cleared = providers.sanitizeAll([
    { id: 'l', presetId: 'openrouter', apiKey: 'k', model: 'x', haikuModel: '', sonnetModel: '', opusModel: '' }
  ])[0]
  ok('清空的等級不會被補回去', cleared.haikuModel === '' && cleared.opusModel === '')
  const badUrlItem = providers.sanitizeAll([
    { id: 'u', presetId: 'openrouter', apiKey: 'k', baseUrl: 'file:///c:/x', haikuModel: '' },
    { id: 'v', presetId: 'codex', baseUrl: 'https://evil.example', haikuModel: '' }
  ])
  ok('壞 Base URL 讀檔時就清掉', badUrlItem[0].baseUrl === '')
  ok('閘道路由不留自訂 Base URL', badUrlItem[1].baseUrl === '')

  const gw = { baseUrl: 'http://127.0.0.1:8790/p' }
  ok('Base URL 對得上就是作用中',
    providers.detectActiveId(items, 'a', 'https://openrouter.ai/api') === 'a')
  ok('Base URL 對不上視為外部修改',
    providers.detectActiveId(items, 'a', 'https://elsewhere') === '')
  // 沒有端點可言的（自訂沒填 baseUrl）：settings.json 也沒東西時才算作用中
  const noUrl = providers.sanitizeAll([{ id: 'c', presetId: 'custom', baseUrl: '' }])
  ok('沒端點：env 空的就是作用中',
    providers.detectActiveId(noUrl, 'c', '') === 'c')
  ok('沒端點：env 有東西就不是作用中',
    providers.detectActiveId(noUrl, 'c', 'https://openrouter.ai/api') === '')
  ok('currentId 不存在回空', providers.detectActiveId(items, 'zzz', '') === '')

  // 官方訂閱那一筆：沒有端點可設，而且「還沒切過 ＋ env 空的」就該亮起來
  const withOfficial = providers.sanitizeAll([
    { id: 'o', presetId: 'official', baseUrl: 'https://leftover', haikuModel: '' },
    { id: 'a', presetId: 'openrouter', apiKey: 'k', haikuModel: '' }
  ])
  ok('官方訂閱不留 Base URL', withOfficial[0].baseUrl === '')
  ok('沒切過而 env 也空的＝官方訂閱作用中', providers.detectActiveId(withOfficial, '', '') === 'o')
  ok('沒切過但 env 有 Base URL＝不算官方（外部設定）',
    providers.detectActiveId(withOfficial, '', 'https://x') === '')
  ok('切到官方之後仍是作用中', providers.detectActiveId(withOfficial, 'o', '') === 'o')
  // 曾經切過 Codex（currentId 還指著它），但設定檔的 env 已經被清乾淨了：
  // 走閘道那幾家一定會寫一個閘道位址，設定檔空的就代表它沒被套用——現在是官方登入
  const gwPlusOfficial = providers.sanitizeAll([
    { id: 'o', presetId: 'official', haikuModel: '' },
    { id: 'g', presetId: 'codex', haikuModel: '' }
  ])
  ok('切過閘道那幾家但 env 已清空＝回到官方，不是「Codex 使用中」',
    providers.detectActiveId(gwPlusOfficial, 'g', '') === 'o',
    providers.detectActiveId(gwPlusOfficial, 'g', ''))
  ok('閘道有起來且位址對得上才算作用中',
    providers.detectActiveId(gwPlusOfficial, 'g', 'http://127.0.0.1:8790/p/codex', gw) === 'g')

  const gwItems = providers.sanitizeAll([{ id: 'g', presetId: 'codex' }])
  ok('閘道路由比對閘道網址',
    providers.detectActiveId(gwItems, 'g', 'http://127.0.0.1:8790/p/codex', gw) === 'g')
  ok('閘道沒起來時不算作用中',
    providers.detectActiveId(gwItems, 'g', 'http://127.0.0.1:8790/p/codex') === '')
}

// MCP 與版本檢查有 async 段落，這裡先接住，最後統一等它跑完再收尾
/** @type {Promise<unknown>} */
let asyncSections = Promise.resolve()

// ===== 內建播種與刪除守衛（假 store，不碰 electron-store） =====
console.log('\n[G0] 內建播種與刪除守衛')
const providerBag = new Map()
const providerFakeStore = {
  get: (key, fallback) => (providerBag.has(key) ? providerBag.get(key) : fallback),
  set: (key, value) => providerBag.set(key, value)
}
providers.configure({ getStore: async () => providerFakeStore })

async function runBuiltin() {
  // 空清單 → 內建每一家各播一筆（tile 那一排的資料來源）。筆數從 `presets.PRESETS` 推導，
  // 不寫死數字——加一家就得改測試的話，改的人會直接把數字調大而不去看順序對不對
  const BUILTIN_IDS = presets.PRESETS.filter((p) => p.id !== 'custom').map((p) => p.id)
  const seeded = await providers.list()
  const builtins = seeded.providers.filter((p) => p.presetId !== 'custom')
  ok('空清單把內建各家都播種了', builtins.length === BUILTIN_IDS.length, String(builtins.length))
  ok('播種照表上順序', builtins.map((p) => p.presetId).join(',') === BUILTIN_IDS.join(','))
  const again = await providers.list()
  ok('播種冪等', again.providers.length === seeded.providers.length,
    `${again.providers.length}/${seeded.providers.length}`)
  const raw = providerBag.get('providers') || []
  ok('播種有落盤', raw.length === BUILTIN_IDS.length, String(raw.length))

  // currentId 指向不存在的實例 → 清掉（不然 UI 會一直顯示「被外部修改」）
  providerBag.set('currentId', 'ghost')
  const orphan = await providers.list()
  ok('孤兒 currentId 被清掉', orphan.currentId === '' && providerBag.get('currentId') === '')

  // 內建各家刪到剩最後一筆要擋
  const grokId = raw.find((p) => p.presetId === 'grok-build').id
  let guard = ''
  try {
    await providers.remove(grokId)
  } catch (error) {
    guard = error.code
  }
  ok('內建最後一筆不可刪', guard === 'PROVIDER_REQUIRED', guard)
  ok('擋下來後清單沒動', (providerBag.get('providers') || []).length === BUILTIN_IDS.length)

  // 官方訂閱那筆也是內建：刪掉就再也切不回官方了
  let officialGuard = ''
  try {
    await providers.remove(raw.find((p) => p.presetId === 'official').id)
  } catch (error) {
    officialGuard = error.code
  }
  ok('官方訂閱不可刪', officialGuard === 'PROVIDER_REQUIRED', officialGuard)

  // 同一家建第二筆（兩把金鑰的情境）就可以刪
  const dup = await providers.create({ presetId: 'grok-build', name: 'Grok 2' })
  await providers.remove(dup.id)
  ok('重複的那筆可以刪', !(providerBag.get('providers') || []).some((p) => p.id === dup.id))

  // 自訂可以刪
  const custom = await providers.create({ presetId: 'custom', name: '我的中繼站', baseUrl: 'https://x.example/v1', apiFormat: 'anthropic' })
  await providers.remove(custom.id)
  ok('自訂可以刪', !(providerBag.get('providers') || []).some((p) => p.id === custom.id))

  // 既有清單只補缺的那幾家
  const keepId = (providerBag.get('providers') || []).find((p) => p.presetId === 'openrouter').id
  providerBag.set('providers', (providerBag.get('providers') || []).filter((p) => p.id === keepId))
  const topped = await providers.list()
  ok('只補缺的那幾家',
    topped.providers.length === BUILTIN_IDS.length && topped.providers.some((p) => p.id === keepId))

  const codex = (providerBag.get('providers') || []).find((p) => p.presetId === 'codex')
  await providers.update(codex.id, { apiFormat: 'openai_chat' })
  const codexRoute = await providers.resolveRoute('codex')
  ok('內建切換上游格式會改閘道路徑', codexRoute?.wire === 'chat' &&
    codexRoute.url === 'https://chatgpt.com/backend-api/codex/chat/completions', JSON.stringify(codexRoute))
  await providers.update(codex.id, { apiFormat: 'openai_responses' })
  const openrouter = (providerBag.get('providers') || []).find((p) => p.presetId === 'openrouter')
  await providers.update(openrouter.id, { apiFormat: 'openai_responses' })
  const openrouterRoute = await providers.resolveRoute('openrouter')
  ok('原本直連的內建也能切到閘道', openrouterRoute?.wire === 'responses' &&
    openrouterRoute.url === 'https://openrouter.ai/api/v1/responses', JSON.stringify(openrouterRoute))
  await providers.update(openrouter.id, { apiFormat: 'anthropic' })
}

// ===== 模型掃描（models-scan） =====
console.log('\n[H0] 模型掃描')
{
  const modelsScan = require(path.join(ROOT, 'src/main/ccswitch/models-scan.js'))
  const chatModels = require(path.join(ROOT, 'src/main/chat-models.js'))

  const codexTarget = modelsScan.resolveScanTarget({ presetId: 'codex' })
  ok('codex 的掃描端點帶 client_version', Boolean(codexTarget?.url.includes('client_version=')))
  ok('codex 標記要專屬標頭', codexTarget?.codex === true)
  const customAnthropic = modelsScan.resolveScanTarget({ presetId: 'custom', apiFormat: 'anthropic', baseUrl: 'https://api.example.com' })
  ok('自訂 anthropic 打 /v1/models', customAnthropic?.url === 'https://api.example.com/v1/models' && customAnthropic?.auth === 'x-api-key')
  const customChat = modelsScan.resolveScanTarget({ presetId: 'custom', apiFormat: 'openai_chat', baseUrl: 'https://api.example.com/v1/' })
  ok('自訂 openai 打 /models（尾斜線清掉）', customChat?.url === 'https://api.example.com/v1/models')
  ok('自訂沒填端點回 null', modelsScan.resolveScanTarget({ presetId: 'custom', apiFormat: 'anthropic', baseUrl: '' }) === null)
  ok('不認得的預設回 null', modelsScan.resolveScanTarget({ presetId: 'nope' }) === null)
}

async function runModelsScan() {
  const modelsScan = require(path.join(ROOT, 'src/main/ccswitch/models-scan.js'))
  const chatModels = require(path.join(ROOT, 'src/main/chat-models.js'))
  /** @type {Array<{ url: string, headers: Record<string, string> }>} */
  const seen = []
  const respondWith = (payload, status = 200) => async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body })
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) }
  }

  // headers 疊在 Bearer 之上（兩個都在，上游自己挑要認哪個）
  await chatModels.fetchModels({
    url: 'https://x.example/models', apiKey: 'sk-1', headers: { 'x-api-key': 'kk' },
    fetchImpl: respondWith({ data: [{ id: 'm1' }] })
  })
  ok('自訂標頭有送出去', seen[0]?.headers['x-api-key'] === 'kk')
  ok('金鑰還是走 Bearer', seen[0]?.headers.Authorization === 'Bearer sk-1')

  // slug 形狀（ChatGPT Codex 後端回 {models:[{slug}]}）
  const slugScan = await chatModels.fetchModels({
    url: 'https://x.example/models', fetchImpl: respondWith({ models: [{ slug: 'gpt-5.6-sol' }] })
  })
  ok('吃得下 {models:[{slug}]}', slugScan.ok && slugScan.models[0] === 'gpt-5.6-sol')

  // cli 那兩家：憑證經 acquire 取得，codex 另帶帳號標頭
  seen.length = 0
  let acquired = null
  modelsScan.configure({
    acquire: async (providerKey, options) => {
      acquired = { providerKey, options }
      return { token: 'tok-1', accountId: 'acc-1' }
    }
  })
  const codexScan = await modelsScan.scanProviderModels(
    { presetId: 'codex', oauthAccountId: 'oa-1' },
    { fetchImpl: respondWith({ models: [{ slug: 'gpt-5.6-sol' }] }) }
  )
  ok('codex 掃得到模型', codexScan.ok && codexScan.models[0] === 'gpt-5.6-sol', codexScan.error || '')
  ok('acquire 收到 oauthAccountId', acquired?.options?.oauthAccountId === 'oa-1')
  ok('codex 帶 chatgpt-account-id', seen[0]?.headers['chatgpt-account-id'] === 'acc-1')
  ok('codex 帶 originator', seen[0]?.headers.originator === 'codex_cli_rs')
  ok('codex 掃描端點真的有 client_version', seen[0]?.url.includes('client_version='))

  // acquire 拋錯 → 回憑證錯誤，不發請求
  seen.length = 0
  const noCred = new Error('NO_CREDENTIAL')
  noCred.userMessage = '找不到 Grok 登入資訊'
  modelsScan.configure({ acquire: async () => { throw noCred } })
  const grokFail = await modelsScan.scanProviderModels(
    { presetId: 'grok-build' }, { fetchImpl: respondWith({ data: [] }) }
  )
  ok('憑證錯誤原樣回白名單訊息', !grokFail.ok && grokFail.error === '找不到 Grok 登入資訊', grokFail.error)
  ok('憑證錯誤時沒有發請求', seen.length === 0)

  // cli 的 403 不可以講「API Key 可能不正確」（那是金鑰制的提示）
  const grok403 = await modelsScan.scanProviderModels(
    { presetId: 'grok-build' },
    { fetchImpl: respondWith({ error: 'spending-limit' }, 403) }
  )
  ok('cli 的 403 不提 API Key', !grok403.ok && !/API Key/.test(grok403.error), grok403.error)
  ok('上游 body 不外洩', !/spending-limit/.test(grok403.error || ''), grok403.error)

  // 不支援掃描的家（custom 沒端點）
  const unsupported = await modelsScan.scanProviderModels({ presetId: 'custom', baseUrl: '' })
  ok('不支援掃描回 UNSUPPORTED', unsupported.ok === false && unsupported.code === 'UNSUPPORTED')

  // x-api-key 那家：金鑰進標頭、不進 Bearer
  seen.length = 0
  await modelsScan.scanProviderModels(
    { presetId: 'opencode-go', apiKey: 'sk-oc' },
    { fetchImpl: respondWith({ data: [{ id: 'm2' }] }) }
  )
  ok('x-api-key 家的金鑰走 x-api-key 標頭', seen[0]?.headers['x-api-key'] === 'sk-oc')
  ok('x-api-key 家不送 Bearer', seen[0]?.headers.Authorization === undefined)

  // 測試按鈕只送最小請求，並且只回報狀態，不讀上游錯誤本文
  seen.length = 0
  const probe = await modelsScan.testProvider({
    presetId: 'commandcode', apiKey: 'cmd-key', model: 'deepseek/deepseek-v4-flash',
    validationFormat: 'openai_chat'
  }, { fetchImpl: respondWith({ ok: true }) })
  ok('上游測試回報 HTTP 成功', probe.ok && probe.responded && probe.status === 200)
  ok('測試用了選定格式的端點', seen[0]?.url === 'https://api.commandcode.ai/provider/v1/chat/completions')
  ok('測試請求是最小 Chat 形狀',
    JSON.parse(seen[0]?.body || '{}').max_tokens === 1 && !('input' in JSON.parse(seen[0]?.body || '{}')))

  const rejected = await modelsScan.testProvider({
    presetId: 'commandcode', apiKey: 'cmd-key', model: 'claude-sonnet-5',
    validationFormat: 'openai_chat'
  }, { fetchImpl: respondWith({ error: 'probe-secret' }, 401) })
  ok('HTTP 401 仍算收到上游回應', !rejected.ok && rejected.responded && rejected.status === 401)
  ok('測試錯誤不帶上游本文', !String(rejected.error).includes('probe-secret'))

  seen.length = 0
  const anthropicProbe = await modelsScan.testProvider({
    presetId: 'openrouter', apiKey: 'or-key', model: 'anthropic/claude-sonnet-5',
    validationFormat: 'anthropic'
  }, { fetchImpl: respondWith({ ok: true }) })
  ok('Anthropic 測試回報 HTTP 成功', anthropicProbe.ok && anthropicProbe.responded)
  ok('Anthropic 測試帶版本標頭', seen[0]?.headers['anthropic-version'] === '2023-06-01')
}

// ===== MCP =====
console.log('\n[G] MCP')
{
  const mcp = require(path.join(ROOT, 'src/main/ccswitch/mcp.js'))

  // 停用清單借用供應商那份 electron-store，測試給一個假的
  const fake = new Map()
  mcp.configure(async () => ({
    get: (key, fallback) => (fake.has(key) ? fake.get(key) : fallback),
    set: (key, value) => fake.set(key, value)
  }))

  // --- 純函式 ---
  const stdio = mcp.sanitizeSpec({ command: 'npx', args: ['-y', 'pkg', 123], extra: 'drop' })
  ok('省略 type 視同 stdio', stdio.type === 'stdio')
  ok('args 去掉非字串', JSON.stringify(stdio.args) === JSON.stringify(['-y', 'pkg', '123']))
  ok('不認得的欄位丟掉', !('extra' in stdio))

  const http = mcp.sanitizeSpec({ type: 'http', url: 'https://x/mcp', headers: { A: 'b' } })
  ok('http 保留 url 與 headers', http.url === 'https://x/mcp' && http.headers.A === 'b')

  const codes = []
  for (const bad of [null, 'string', { type: 'stdio' }, { type: 'http' }, { type: 'weird', command: 'x' }]) {
    try {
      mcp.sanitizeSpec(bad)
      codes.push('NO_THROW')
    } catch (error) {
      codes.push(error.code)
    }
  }
  ok('壞定義全部擋下來',
    codes.join(',') === 'MCP_INVALID,MCP_INVALID,MCP_MISSING_COMMAND,MCP_MISSING_URL,MCP_INVALID_TYPE',
    codes.join(','))

  let protoErr = ''
  try {
    mcp.sanitizeId('__proto__')
  } catch (error) {
    protoErr = error.code
  }
  ok('__proto__ 當名稱會被擋', protoErr === 'MCP_INVALID_ID', protoErr)

  const wrapped = mcp.wrapForWindows({ type: 'stdio', command: 'npx', args: ['-y', 'p'] }, true)
  ok('Windows 上 npx 包成 cmd /c',
    wrapped.command === 'cmd' && JSON.stringify(wrapped.args) === JSON.stringify(['/c', 'npx', '-y', 'p']))
  const twice = mcp.wrapForWindows(wrapped, true)
  ok('已經是 cmd 不重複包', JSON.stringify(twice.args) === JSON.stringify(wrapped.args))
  ok('npx.cmd 也認得', mcp.wrapForWindows({ type: 'stdio', command: 'npx.cmd' }, true).command === 'cmd')
  ok('python 不包', mcp.wrapForWindows({ type: 'stdio', command: 'python', args: ['s.py'] }, true).command === 'python')
  ok('http 不包', mcp.wrapForWindows({ type: 'http', url: 'https://x' }, true).type === 'http')
  ok('非 Windows 不包', mcp.wrapForWindows({ type: 'stdio', command: 'npx' }, false).command === 'npx')

  // --- 檔案 I/O：~/.claude.json 的其他欄位一個都不能少 ---
  const claudeJson = claudeSettings.claudeJsonPath()
  fs.writeFileSync(claudeJson, JSON.stringify({
    numStartups: 42,
    projects: { '/some/path': { history: [1, 2, 3] } },
    mcpServers: { existing: { type: 'stdio', command: 'python', args: ['a.py'] } }
  }, null, 2))

  const runMcp = async () => {
    let listed = await mcp.list()
    ok('讀得到現有伺服器', listed.servers.length === 1 && listed.servers[0].id === 'existing')

    await mcp.upsert('ctx7', { type: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] }, true)
    const root = JSON.parse(fs.readFileSync(claudeJson, 'utf8'))
    ok('numStartups 沒被動到', root.numStartups === 42)
    ok('projects 沒被動到', root.projects['/some/path'].history.length === 3)
    ok('新伺服器寫進去了', Boolean(root.mcpServers.ctx7))
    ok('原有伺服器還在', Boolean(root.mcpServers.existing))

    await mcp.toggle('existing', false)
    const afterDisable = JSON.parse(fs.readFileSync(claudeJson, 'utf8'))
    ok('停用後從 claude.json 移除', !('existing' in afterDisable.mcpServers))
    listed = await mcp.list()
    const disabled = listed.servers.find((s) => s.id === 'existing')
    ok('停用後仍在清單裡', Boolean(disabled) && disabled.enabled === false)
    ok('停用的設定有留著', disabled.spec.command === 'python')

    await mcp.toggle('existing', true)
    const afterEnable = JSON.parse(fs.readFileSync(claudeJson, 'utf8'))
    ok('重新啟用會放回去', afterEnable.mcpServers.existing.command === 'python')
    listed = await mcp.list()
    ok('重新啟用後不會兩份', listed.servers.filter((s) => s.id === 'existing').length === 1)

    await mcp.remove('ctx7')
    const afterRemove = JSON.parse(fs.readFileSync(claudeJson, 'utf8'))
    ok('刪除只刪那一台', !('ctx7' in afterRemove.mcpServers) && Boolean(afterRemove.mcpServers.existing))

    let notFound = ''
    try {
      await mcp.toggle('nope', true)
    } catch (error) {
      notFound = error.code
    }
    ok('切換不存在的伺服器會擋下來', notFound === 'NOT_FOUND', notFound)
  }

  // ===== CLI 版本 =====
  const cli = require(path.join(ROOT, 'src/main/ccswitch/cli-version.js'))

  const runVersionChecks = async () => {
    console.log('\n[H] CLI 版本')
    ok('純版本號', cli.parseVersion('1.2.3') === '1.2.3')
    ok('夾在字串中間也抓得到', cli.parseVersion('claude 2.0.14 (Claude Code)') === '2.0.14')
    ok('抓得到預發布版', cli.parseVersion('v1.2.3-beta.4 built') === '1.2.3-beta.4')
    ok('沒有版本號回空字串', cli.parseVersion('command not found') === '')

    ok('大版本比較', cli.compareVersions('2.0.0', '1.9.9') === 1)
    ok('修訂號比較', cli.compareVersions('1.2.3', '1.2.4') === -1)
    ok('一樣回 0', cli.compareVersions('1.2.3', '1.2.3') === 0)
    ok('位數不同也對', cli.compareVersions('1.2', '1.2.0') === 0)
    // 預發布視為比正式版舊，next tag 的使用者才不會被一直提示有新版
    ok('預發布比正式版舊', cli.compareVersions('1.2.3-beta.1', '1.2.3') === -1)
    ok('正式版比預發布新', cli.compareVersions('1.2.3', '1.2.3-beta.1') === 1)

    // 更新一律用該工具自己的 updater：claude／grok／agy 多半不是 npm 裝的，
    // 對它們跑 `npm i -g` 會裝出第二份互相蓋掉
    ok('更新指令用工具自己的 updater', cli.updateCommand('claude') === 'claude update')
    ok('opencode 用 upgrade 不是 update', cli.updateCommand('opencode') === 'opencode upgrade')
    ok('沒發 npm 的也有更新指令', cli.updateCommand('agy') === 'agy update')
    ok('更新指令不含 npm i -g', cli.TOOLS.every((tool) => !/npm\s+i/.test(tool.update)))
    let unknown = ''
    try {
      cli.updateCommand('rm -rf /')
    } catch (error) {
      unknown = error.code
    }
    ok('不認得的工具 key 擋下來', unknown === 'NO_UPDATE_PATH', unknown)

    const fakeFetch = async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => {
          let done = false
          return {
            read: async () => (done
              ? { done: true }
              : (done = true, { done: false, value: Buffer.from('{"version":"9.9.9"}') })),
            releaseLock: () => {}
          }
        }
      }
    })
    ok('查得到 npm 最新版', await cli.fetchLatest('@anthropic-ai/claude-code', { fetchImpl: fakeFetch }) === '9.9.9')
    ok('沒有套件名回空字串', await cli.fetchLatest('', { fetchImpl: fakeFetch }) === '')
  }

  // ===== OAuth 登入 =====
  async function runOauth() {
    console.log('\n[I] OAuth 登入')
    const oauth = require('../src/main/ccswitch/gateway/oauth')

    // 假 store：登入帳號存在 cc-providers.json 的 oauthAccounts，這裡用記憶體頂替
    const bag = new Map()
    const fakeStore = {
      get: (key, fallback) => (bag.has(key) ? bag.get(key) : fallback),
      set: (key, value) => bag.set(key, value)
    }
    const opened = []
    oauth.configure({ getStore: async () => fakeStore, openExternal: (url) => opened.push(url) })

    // 兩家都必須是各自官方支援的流程：OpenAI 的 discovery 沒有 device code，所以只能 PKCE
    ok('Codex 走 PKCE', oauth.FLOWS.codex.kind === 'pkce')
    ok('Grok 走 device code', oauth.FLOWS['grok-build'].kind === 'device')
    ok('Codex redirect 綁本機 loopback',
      oauth.FLOWS.codex.redirectUri === 'http://localhost:1455/auth/callback')
    ok('不認得的 provider 回 null', oauth.getFlow('nope') === null)
    ok('原型污染字串不會命中', oauth.getFlow('constructor') === null)
    // 固定表裡不可以出現 client secret（公開桌面 client 沒有 secret）
    const flowText = JSON.stringify(oauth.FLOWS)
    ok('固定表不含 secret 欄位', !/secret/i.test(flowText), flowText.slice(0, 80))

    // PKCE：challenge 必須是 verifier 的 S256，而且每次都不一樣
    const a = oauth.makePkce()
    const b = oauth.makePkce()
    const expected = createHash('sha256').update(a.verifier).digest('base64url')
    ok('PKCE challenge 是 verifier 的 S256', a.challenge === expected)
    ok('PKCE 每次都不同', a.verifier !== b.verifier)
    ok('PKCE 是 base64url（沒有 + / =）', !/[+/=]/.test(a.verifier + a.challenge))

    // token 回應 → 帳號記錄；email 從 id_token 取，過期時間以 access token 的 exp 為準
    const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`
    const exp = Math.floor(Date.now() / 1000) + 3600
    const account = oauth.toAccount(oauth.FLOWS.codex, {
      access_token: jwt({ exp }),
      refresh_token: 'r1',
      id_token: jwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_account_id: 'acc-1' } })
    })
    ok('帳號標籤用 email', account.label === 'me@example.com')
    ok('抓得到 chatgpt_account_id', account.accountId === 'acc-1')
    ok('到期時間取自 access token', Math.abs(account.expiresAt - exp * 1000) < 1000)

    // 缺 refresh token 一定要擋下來：存了也續不了期，只會在幾十分鐘後莫名失效
    let incomplete = ''
    try {
      oauth.toAccount(oauth.FLOWS.codex, { access_token: jwt({ exp }) })
    } catch (error) {
      incomplete = error.code
    }
    ok('沒有 refresh token 就不收', incomplete === 'OAUTH_INCOMPLETE', incomplete)

    // 清單給 UI 用，**不可以帶出任何 token**
    await oauth.writeAccounts([{ ...account, provider: 'codex' }])
    const listed = await oauth.list()
    ok('清單看得到帳號', listed.length === 1 && listed[0].label === 'me@example.com')
    ok('清單不含任何 token', !/accessToken|refreshToken|"r1"/.test(JSON.stringify(listed)),
      JSON.stringify(listed))

    // 續期：發證方換發新的 refresh token（rotation）時要跟著換掉，不然下一次就用到作廢的那顆
    const rotated = jwt({ exp: exp + 3600 })
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: rotated, refresh_token: 'r2', expires_in: 3600 })
    })
    const token = await oauth.tokenFor(account.id, { force: true, fetchImpl })
    ok('續期拿到新 token', token.token === rotated)
    const stored = (await oauth.readAccounts())[0]
    ok('輪替的 refresh token 有存回去', stored.refreshToken === 'r2', stored.refreshToken)

    // 續期失敗只留狀態碼，不可以把上游 body 原樣丟給使用者
    const failFetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'leaked-secret-xyz' })
    })
    let refreshError = null
    try {
      await oauth.tokenFor(account.id, { force: true, fetchImpl: failFetch })
    } catch (error) {
      refreshError = error
    }
    ok('續期失敗有明確錯誤', refreshError?.code === 'OAUTH_REFRESH_FAILED')
    ok('錯誤訊息不含上游內容',
      !/leaked-secret-xyz|invalid_grant/.test(refreshError?.userMessage || ''),
      refreshError?.userMessage)

    // 刪掉之後拿不到 token
    await oauth.remove(account.id)
    ok('刪掉的帳號查不到', (await oauth.list()).length === 0)
    let gone = ''
    try {
      await oauth.tokenFor(account.id, { force: true, fetchImpl })
    } catch (error) {
      gone = error.code
    }
    ok('刪掉之後拿不到 token', gone === 'NO_ACCOUNT', gone)

    // 綁著已刪帳號的供應商要解綁，否則切過去只會說「找不到登入帳號」
    ok('unbindAccount 是對外方法', typeof providers.unbindAccount === 'function')
    ok('accountForPreset 是對外方法', typeof providers.accountForPreset === 'function')
    ok('登入未開始時狀態是 idle', oauth.status('codex').status === 'idle')
    ok('取消沒開始的流程不會炸', oauth.cancel('codex') === true)

    // ===== PKCE 全程（真的開本機 1455 埠，只有換 token 那一步用假 fetch）=====
    opened.length = 0
    const exchanged = []
    const pkceFetch = async (url, init) => {
      exchanged.push(Object.fromEntries(new URLSearchParams(String(init.body))))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: jwt({ exp }),
          refresh_token: 'pkce-r',
          id_token: jwt({ email: 'pkce@example.com' })
        })
      }
    }
    const started = await oauth.begin('codex', { fetchImpl: pkceFetch })
    ok('PKCE 回授權網址', started.verificationUri.startsWith('https://auth.openai.com/oauth/authorize'))
    ok('有把瀏覽器打開', opened.length === 1 && opened[0] === started.verificationUri)
    const authUrl = new URL(started.verificationUri)
    const state = authUrl.searchParams.get('state')
    ok('授權網址帶 S256 challenge', authUrl.searchParams.get('code_challenge_method') === 'S256')
    ok('授權網址不含 secret', !/secret/i.test(started.verificationUri))

    const hit = (query) => fetch(`http://127.0.0.1:1455/auth/callback?${query}`).then((r) => r.status)
    // state 對不上就是別人（或別次）打進來的，絕不能拿去換 token
    ok('state 對不上回 400', await hit(`code=zzz&state=wrong`) === 400)
    ok('state 對不上不會去換 token', exchanged.length === 0, String(exchanged.length))

    // 重新開一次（上一次已經因為 state 不符收掉了），這次走正確的 state
    const again = await oauth.begin('codex', { fetchImpl: pkceFetch })
    const goodState = new URL(again.verificationUri).searchParams.get('state')
    ok('每次的 state 都不一樣', goodState !== state)
    ok('正確回呼回 200', await hit(`code=good-code&state=${encodeURIComponent(goodState)}`) === 200)

    for (let i = 0; i < 40 && oauth.status('codex').status === 'waiting'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    ok('PKCE 登入完成', oauth.status('codex').status === 'done', oauth.status('codex').message)
    ok('拿 code 去換 token', exchanged[0]?.code === 'good-code' && exchanged[0]?.grant_type === 'authorization_code')
    ok('換 token 帶 code_verifier', Boolean(exchanged[0]?.code_verifier))
    ok('帳號存進清單', (await oauth.list()).some((a) => a.label === 'pkce@example.com'))

    // 流程結束後那個埠一定要放掉，不然使用者之後跑 codex login 會被我們卡住
    const stillBound = await new Promise((resolve) => {
      const probe = require('http').createServer()
      probe.on('error', () => resolve(true))
      probe.listen(1455, '127.0.0.1', () => probe.close(() => resolve(false)))
    })
    ok('登入結束後本機 1455 埠有放掉', stillBound === false)
  }

  // 這幾段是 async，串起來跑完再收尾
  asyncSections = asyncSections.then(runBuiltin).then(runModelsScan).then(runMcp).then(runVersionChecks).then(runOauth)
}

asyncSections
  .catch((error) => {
    failed++
    console.log(`  FAIL 非同步測試拋錯 — ${error && error.message}`)
  })
  .then(() => {
    // 收尾：把暫存家目錄刪乾淨
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    } catch {
      // 刪不掉不影響結果
    }
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
  })
