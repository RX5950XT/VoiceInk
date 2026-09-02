'use strict'

/**
 * Claude Code 供應商預設表（Main Process 固定表）。
 *
 * 每一筆描述「這一家要往 `~/.claude/settings.json` 的 env 寫什麼」。renderer 只送 preset key
 * 與白名單格式；網址由這裡決定，避免 renderer 把 App 變成「幫你打任意網址」的代理
 * （跟聊天的 `chat:scanModels` 同一條理由）。
 *
 * 表上就是 UI 那一排：**內建固定供應商 ＋ `custom`**。內建的會在 `providers.list()` 自動播種
 * 各一筆（不可刪到少於一筆）；`custom` 是唯一讓使用者自己建的。
 *
 * `route` 是預設格式對應的初始路由；實例儲存的 `apiFormat` 可以覆寫它：
 * - `direct`：這家本來就講 Anthropic Messages 協議，env 直接指過去。
 * - `gateway`：講的是 OpenAI 協議（Responses 或 Chat），Claude Code 吃不了，
 *   要先進本機閘道轉換，所以 env 指到 `http://127.0.0.1:<port>/<id>`。
 *
 * `auth` 決定金鑰從哪來：
 * - `key`：使用者自己貼的 API key，寫進 `keyField` 指定的那個 env 鍵。
 * - `cli`：沿用已登入的 CLI 憑證（`~/.codex/auth.json`、`~/.grok/auth.json`），
 *   使用者不必貼任何東西；閘道自己去讀，過期時自動換一顆。
 * - `none`：**官方訂閱**。它不是「另一家上游」，而是「把我們寫進去的東西拿掉」——
 *   env 一個鍵都不留，Claude Code 就回去用自己的 OAuth 登入（`~/.claude/.credentials.json`）。
 *   少了這一筆，切過一次供應商之後就再也切不回官方了（要自己去手改 settings.json）。
 *
 * `wireBaseUrl` 是上游 API 根位址，格式路徑由 `providers.js` 接上。
 * `modelsUrl`／`modelsAuth` 只給「從 API 載入模型」的掃描用（`models-scan.js`），
 * 跟切換供應商的路徑無關。**兩個欄位一律實測過才寫進表**（`scripts/probe-ccswitch-models.js`）：
 * 200＝可用；`custom` 沒有固定端點，掃描時由使用者填的 baseUrl 推導。
 */

/**
 * @typedef {object} Preset
 * @property {string} id
 * @property {string} name
 * @property {'direct' | 'gateway'} route
 * @property {'key' | 'cli' | 'none'} auth
 * @property {'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY' | ''} keyField
 * @property {'anthropic' | 'openai_responses' | 'openai_chat'} apiFormat 預設上游格式
 * @property {string} baseUrl 上游位址（direct 直接寫進 env；gateway 給閘道用）
 * @property {string} wireBaseUrl 上游 API 根位址（接上格式路徑）
 * @property {Record<string, string>} env 這家要額外寫進去的 env（模型名、上下文窗等）
 * @property {string} [modelsUrl] 模型清單端點；不填＝這家不支援掃描
 * @property {'bearer' | 'x-api-key' | 'cli' | 'none'} [modelsAuth] 掃描時的鑑別方式
 * @property {string} hint UI 上那一行說明
 */

/** @type {Preset[]} */
const PRESETS = [
  {
    id: 'official',
    name: 'Claude 官方訂閱',
    route: 'direct',
    auth: 'none',
    keyField: '',
    apiFormat: 'anthropic',
    // 官方端點是 Claude Code 的內建預設，我們什麼都不寫才是對的——寫一個
    // `https://api.anthropic.com` 進去反而會蓋掉企業版／自架代理的既有設定
    baseUrl: '',
    env: {},
    hint: '把本工作台寫進 settings.json 的那幾個 env 鍵清掉，回到你原本的 Claude 官方登入。'
  },
  {
    id: 'grok-build',
    name: 'Grok',
    route: 'gateway',
    auth: 'cli',
    keyField: '',
    apiFormat: 'openai_responses',
    // CLI 的 OAuth token 打 api.x.ai 一律 403 spending-limit（那條是給 API 金鑰用的、
    // 看的是儲值餘額）；訂閱制的 Grok CLI 走 cli-chat-proxy.grok.com（實測 200）
    baseUrl: 'https://cli-chat-proxy.grok.com/v1',
    wireBaseUrl: 'https://cli-chat-proxy.grok.com/v1',
    modelsUrl: 'https://cli-chat-proxy.grok.com/v1/models',
    modelsAuth: 'cli',
    env: {
      ANTHROPIC_MODEL: 'grok-4.6',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'grok-4.6',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'grok-4.6',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'grok-4.6'
    },
    hint: 'xAI 訂閱（Grok Build），用已登入的 CLI 憑證經本機閘道轉換。'
  },
  {
    id: 'codex',
    name: 'Codex',
    route: 'gateway',
    auth: 'cli',
    keyField: '',
    apiFormat: 'openai_responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    wireBaseUrl: 'https://chatgpt.com/backend-api/codex',
    // 沒帶 client_version 會回 400 missing field；帶舊版（0.55.0）會拿到空清單
    modelsUrl: 'https://chatgpt.com/backend-api/codex/models?client_version=0.151.0',
    modelsAuth: 'cli',
    env: {
      ANTHROPIC_MODEL: 'gpt-5.6-sol',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gpt-5.6-luna',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'gpt-5.6-sol',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-5.6-sol',
      // Claude Code 遇到不認得的非 Claude 模型 id 會退回 200K 窗口；
      // ChatGPT Codex 後端登記 gpt-5.6-sol 是 372K，兩個鍵一起釘住才不會被遠端實驗改掉。
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '372000',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '372000'
    },
    hint: 'ChatGPT 訂閱，用已登入的 Codex CLI 憑證經本機閘道轉換。'
  },
  {
    id: 'ollama-cloud',
    name: 'Ollama Cloud',
    route: 'gateway',
    auth: 'key',
    keyField: 'ANTHROPIC_AUTH_TOKEN',
    apiFormat: 'openai_responses',
    baseUrl: 'https://ollama.com/v1',
    wireBaseUrl: 'https://ollama.com/v1',
    modelsUrl: 'https://ollama.com/v1/models',
    modelsAuth: 'bearer',
    // 2026-09-01 實測：`qwen3-coder:480b-cloud` 已經不在上游 `/models` 裡了，
    // 換成當時清單上真的有的（`probe-ccswitch-models.js` 會盯著這件事）
    env: {
      ANTHROPIC_MODEL: 'kimi-k2.7-code',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k2.7-code',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k2.7-code'
    },
    hint: '只有 OpenAI 相容端點，經本機閘道轉換。金鑰在 ollama.com 拿。'
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    route: 'gateway',
    auth: 'key',
    // Go 閘道的 /v1/messages 只認 x-api-key，Bearer 會被靜默忽略 → 必須用 ANTHROPIC_API_KEY
    keyField: 'ANTHROPIC_API_KEY',
    apiFormat: 'openai_responses',
    baseUrl: 'https://opencode.ai/zen/go',
    wireBaseUrl: 'https://opencode.ai/zen/go/v1',
    modelsUrl: 'https://opencode.ai/zen/go/v1/models',
    modelsAuth: 'x-api-key',
    env: {
      ANTHROPIC_MODEL: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-flash'
    },
    hint: '訂閱制。金鑰要放 ANTHROPIC_API_KEY，放 AUTH_TOKEN 會被忽略。'
  },
  {
    id: 'commandcode',
    name: 'Command Code',
    route: 'gateway',
    auth: 'key',
    keyField: 'ANTHROPIC_AUTH_TOKEN',
    apiFormat: 'openai_chat',
    baseUrl: 'https://api.commandcode.ai/provider',
    wireBaseUrl: 'https://api.commandcode.ai/provider/v1',
    // 模型清單是 OpenAI 形狀（`data[].id`），跟 messages 端點不同層
    modelsUrl: 'https://api.commandcode.ai/provider/v1/models',
    modelsAuth: 'bearer',
    env: {
      ANTHROPIC_MODEL: 'claude-sonnet-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5-20251001',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5'
    },
    hint: '訂閱制聚合站，可選 OpenAI Chat 或 Anthropic Messages。金鑰在 commandcode.ai 拿。'
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    route: 'direct',
    auth: 'key',
    keyField: 'ANTHROPIC_AUTH_TOKEN',
    apiFormat: 'anthropic',
    baseUrl: 'https://openrouter.ai/api',
    wireBaseUrl: 'https://openrouter.ai/api/v1',
    // preset 的 baseUrl 是 Anthropic 形狀（/api），模型清單在 OpenAI 形狀的 /api/v1 那邊
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    modelsAuth: 'bearer',
    env: {
      ANTHROPIC_MODEL: 'anthropic/claude-sonnet-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-haiku-4.5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic/claude-sonnet-5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic/claude-opus-5'
    },
    hint: '原生支援 Anthropic 協議，直連。金鑰在 openrouter.ai/keys 拿。'
  },
  {
    id: 'custom',
    name: '自訂',
    route: 'direct',
    auth: 'key',
    keyField: 'ANTHROPIC_AUTH_TOKEN',
    apiFormat: 'anthropic',
    baseUrl: '',
    wireBaseUrl: '',
    env: {},
    hint: '端點、協議、金鑰欄位、四個等級的模型全部自己決定。'
  }
]

const BY_ID = new Map(PRESETS.map((preset) => [preset.id, preset]))

/**
 * @param {unknown} id
 * @returns {Preset | null}
 */
function getPreset(id) {
  return (typeof id === 'string' && BY_ID.get(id)) || null
}

/**
 * 給 renderer 填清單用（不含任何憑證）。
 * @returns {Array<{ id: string, name: string, route: string, auth: string, keyField: string, apiFormat: string, baseUrl: string, wireBaseUrl: string, modelsUrl: string, modelsAuth: string, hint: string, models: string[] }>}
 */
function catalog() {
  return PRESETS.map((preset) => ({
    id: preset.id,
    name: preset.name,
    route: preset.route,
    auth: preset.auth,
    keyField: preset.keyField,
    apiFormat: preset.apiFormat,
    baseUrl: preset.baseUrl,
    wireBaseUrl: preset.wireBaseUrl || '',
    modelsUrl: preset.modelsUrl || '',
    modelsAuth: preset.modelsAuth || '',
    hint: preset.hint,
    models: [...new Set(Object.entries(preset.env)
      .filter(([key]) => key.endsWith('_MODEL'))
      .map(([, value]) => value))],
    // 表單四個等級的 placeholder：留空就是用這些
    defaults: {
      model: preset.env.ANTHROPIC_MODEL || '',
      haikuModel: preset.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '',
      sonnetModel: preset.env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
      opusModel: preset.env.ANTHROPIC_DEFAULT_OPUS_MODEL || ''
    }
  }))
}

module.exports = { PRESETS, getPreset, catalog }
