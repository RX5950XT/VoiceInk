'use strict'

/**
 * OpenCode Go 與 Ollama Cloud 的額度端點都只認一把 API 金鑰（`Authorization: Bearer`），
 * 而這兩把金鑰在使用者機器上可能落在三個地方。這裡是唯一的解析點，順序固定：
 *
 * 1. 環境變數（臨時覆蓋、CI／probe 用）
 * 2. OpenCode CLI 的 `auth.json`（**只讀不寫**，跟其他家的 CLI 憑證同一條規矩）
 * 3. VoiceInk 自己的 CC 代理供應商清單（只用 CC 代理頁設定、沒裝 OpenCode CLI 的人）
 *
 * 三個都拿不到就回空字串，呼叫端顯示「未連線」。
 */

const path = require('path')
const { readJsonFile } = require('./shared')

/**
 * `~/.local/share/opencode/auth.json` 是一個 `{ "<serviceId>": { type, key } }` 的表，
 * OpenCode 自己的金鑰與使用者加進去的第三方金鑰（ollama-cloud、xai…）都住在裡面。
 * @param {string} homeDir
 * @param {string} serviceId
 * @returns {Promise<string>}
 */
async function readOpenCodeAuthKey(homeDir, serviceId) {
  let auth
  try {
    auth = await readJsonFile(path.join(homeDir, '.local', 'share', 'opencode', 'auth.json'))
  } catch {
    return ''
  }
  const entry = auth?.[serviceId]
  const key = typeof entry?.key === 'string' ? entry.key.trim() : ''
  return key.length <= 400 ? key : ''
}

/**
 * CC 代理頁的供應商清單。動態 require：額度同步不該把整包 ccswitch 拉進啟動路徑，
 * 而且沒設定過的人這一步本來就會回空字串。
 * @param {string} presetId
 * @returns {Promise<string>}
 */
async function readCcSwitchKey(presetId) {
  try {
    const providers = require('../ccswitch/providers')
    const key = await providers.keyForPreset(presetId)
    return typeof key === 'string' && key.trim().length <= 400 ? key.trim() : ''
  } catch {
    return ''
  }
}

/**
 * @param {{ homeDir: string, envVar: string, serviceId: string, presetId: string, env?: NodeJS.ProcessEnv }} options
 * @returns {Promise<{ key: string, source: string }>}
 */
async function resolveApiKey({ homeDir, envVar, serviceId, presetId, env = process.env }) {
  const fromEnv = typeof env?.[envVar] === 'string' ? env[envVar].trim() : ''
  if (fromEnv) return { key: fromEnv, source: 'env' }
  const fromAuth = await readOpenCodeAuthKey(homeDir, serviceId)
  if (fromAuth) return { key: fromAuth, source: 'opencode-auth' }
  const fromStore = await readCcSwitchKey(presetId)
  if (fromStore) return { key: fromStore, source: 'ccswitch' }
  return { key: '', source: '' }
}

/**
 * Command Code 的 CLI（`cmd login`）把金鑰寫成 `~/.commandcode/auth.json` 的頂層 `apiKey`，
 * 跟 OpenCode 那份「以服務 id 分組」的表格式不一樣，所以另走一支。順序同樣是三段：
 *
 * 1. 環境變數（用 CLI 自己認的 `COMMAND_CODE_API_KEY`）
 * 2. `~/.commandcode/auth.json`（**只讀不寫**）
 * 3. VoiceInk 自己的 CC 代理供應商清單
 *
 * 第三段不能省：**在 Studio 開一把 API key 是官方支援的用法，不是每個人都跑過 `cmd login`**，
 * 只認那個檔案的話，有金鑰的人在 App 裡沒有任何地方填得進去。
 * @param {{ homeDir: string, env?: NodeJS.ProcessEnv }} options
 * @returns {Promise<{ key: string, source: string }>}
 */
async function resolveCommandCodeKey({ homeDir, env = process.env }) {
  const fromEnv = typeof env?.COMMAND_CODE_API_KEY === 'string' ? env.COMMAND_CODE_API_KEY.trim() : ''
  if (fromEnv) return { key: fromEnv, source: 'env' }
  let auth
  try {
    auth = await readJsonFile(path.join(homeDir, '.commandcode', 'auth.json'))
  } catch {
    auth = null
  }
  const fromFile = typeof auth?.apiKey === 'string' ? auth.apiKey.trim() : ''
  if (fromFile && fromFile.length <= 400) return { key: fromFile, source: 'commandcode-auth' }
  const fromStore = await readCcSwitchKey('commandcode')
  return fromStore ? { key: fromStore, source: 'ccswitch' } : { key: '', source: '' }
}

module.exports = {
  readCcSwitchKey,
  readOpenCodeAuthKey,
  resolveApiKey,
  resolveCommandCodeKey
}
