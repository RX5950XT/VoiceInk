'use strict'

/**
 * Claude Code 的 OAuth access token 續期（Main Process）。
 *
 * **為什麼要自己續**：access token 幾個小時就過期，而只有 Claude Code 在跑的時候才會去續——
 * 一陣子沒開 CLI，額度 API 就回 401，使用者看到的是「額度跑掉了，要去終端機開一次 claude 才讀得到」。
 *
 * **為什麼這一家可以寫回憑證檔（其他家一律只讀）**：Anthropic 的 refresh token 會輪替，
 * 只換在記憶體裡等於把 CLI 手上那顆作廢（下次 CLI 續期就 invalid_grant，整個登出）。
 * 所以照 Claude Code 自己的協定，當成「另一個 Claude Code」來續：
 *  1. 先拿兩把鎖：`~/.claude/.oauth_refresh.lock` 與舊版的 `~/.claude.lock`
 *     （proper-lockfile 格式：鎖＝一個資料夾，mtime 超過 60 秒視為沒人要了）
 *  2. 拿到鎖之後重讀一次：access token 已經換過＝別人剛續好，直接用那顆
 *  3. 續完 CAS 寫回：檔案裡的 refresh token 還是我們送出去那顆才寫，不是就一個字都不動
 *  4. 原子替換（先寫暫存檔再 rename），其他欄位（`mcpOAuth` 等）原樣保留
 *
 * 端點、client_id、JSON body 的形狀都是從已安裝的 Claude Code 讀出來的（2.1.280）。
 * client_id 是公開的 CLI client，沒有 secret。
 */

const fs = require('fs/promises')
const path = require('path')
const { UsageError } = require('./shared')

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
/** 剩不到這麼久就先續（跟 Claude Code 同一個 5 分鐘提前量） */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000
/** proper-lockfile 的 stale：鎖資料夾的 mtime 超過這麼久就當成前一個人當掉了 */
const LOCK_STALE_MS = 60_000
const LOCK_ATTEMPTS = 5
const REFRESH_TIMEOUT_MS = 30_000

/** 同一個 App 裡同時只會有一個續期在跑（額度同步本身已經合併，這裡再保險一次） */
let inflight = null

function credentialsPath(homeDir) {
  return path.join(homeDir, '.claude', '.credentials.json')
}

async function readCredentials(homeDir) {
  const raw = await fs.readFile(credentialsPath(homeDir), 'utf8')
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad credentials')
  return parsed
}

/**
 * @param {object} oauth `claudeAiOauth`
 * @param {number} nowMs
 */
function isExpiring(oauth, nowMs) {
  const expiresAt = Number(oauth?.expiresAt)
  // 沒有 expiresAt 的舊檔：當成還能用，交給 401 那條路決定要不要續
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false
  return nowMs + EXPIRY_MARGIN_MS >= expiresAt
}

/**
 * 拿一把 proper-lockfile 格式的鎖。
 * @param {string} dir 鎖資料夾
 * @returns {Promise<boolean>}
 */
async function tryLock(dir) {
  try {
    await fs.mkdir(dir)
    return true
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const stat = await fs.stat(dir).catch(() => null)
  if (!stat || Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return false
  await fs.rmdir(dir).catch(() => {})
  try {
    await fs.mkdir(dir)
    return true
  } catch {
    return false
  }
}

/**
 * 跟 Claude Code 同一個順序拿兩把鎖（新的先、舊版的後），拿不到舊版那把要把新的放掉。
 * ponytail: 持鎖期間不更新 mtime（proper-lockfile 每 5 秒刷一次）；整段續期有 30 秒逾時，
 * 遠低於 60 秒的 stale 門檻。哪天續期要做更久的事再補刷新計時器。
 * @param {string} homeDir
 * @returns {Promise<() => Promise<void>>} 放鎖
 */
async function acquireLocks(homeDir) {
  const configDir = path.join(homeDir, '.claude')
  const real = await fs.realpath(configDir).catch(() => configDir)
  const locks = [path.join(configDir, '.oauth_refresh.lock'), `${real}.lock`]
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 1000))
    if (!(await tryLock(locks[0]))) continue
    if (await tryLock(locks[1])) {
      return async () => {
        await fs.rmdir(locks[1]).catch(() => {})
        await fs.rmdir(locks[0]).catch(() => {})
      }
    }
    await fs.rmdir(locks[0]).catch(() => {})
  }
  throw new UsageError('LOCK_BUSY', 'Claude Code 正在續期登入，稍後再試')
}

/**
 * @param {object} oauth
 * @param {{ fetchImpl?: Function }} options
 */
async function postRefresh(oauth, { fetchImpl = globalThis.fetch } = {}) {
  const scopes = Array.isArray(oauth.scopes) ? oauth.scopes.filter((s) => typeof s === 'string') : []
  const body = {
    grant_type: 'refresh_token',
    refresh_token: oauth.refreshToken,
    client_id: typeof oauth.clientId === 'string' && oauth.clientId ? oauth.clientId : CLIENT_ID,
    scope: scopes.join(' ')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS)
  let response
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
  } catch {
    throw new UsageError('REFRESH_NETWORK', '無法連線 Claude 登入伺服器')
  } finally {
    clearTimeout(timer)
  }
  // 上游回應內容一律不往外送（見 AGENTS.md「雲端路徑的 HTTP 錯誤只記狀態摘要」）
  if (!response?.ok) {
    throw new UsageError('REFRESH_FAILED', `Claude 登入續期失敗（HTTP ${Number(response?.status) || 0}）`, Number(response?.status) || 0)
  }
  let data
  try { data = await response.json() } catch { data = null }
  const accessToken = typeof data?.access_token === 'string' ? data.access_token : ''
  const expiresIn = Number(data?.expires_in)
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new UsageError('REFRESH_FAILED', 'Claude 登入伺服器回應格式錯誤')
  }
  const now = Date.now()
  const update = {
    accessToken,
    refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : oauth.refreshToken,
    expiresAt: now + expiresIn * 1000
  }
  const rtExpiresIn = Number(data.refresh_token_expires_in)
  if (Number.isFinite(rtExpiresIn) && rtExpiresIn > 0) update.refreshTokenExpiresAt = now + rtExpiresIn * 1000
  if (typeof data.scope === 'string' && data.scope.trim()) update.scopes = data.scope.trim().split(/\s+/)
  return update
}

/**
 * CAS 寫回：檔案裡的 refresh token 還是我們送出去那顆才寫。
 * @returns {Promise<boolean>} 有沒有寫
 */
async function writeBack(homeDir, postedRefreshToken, update) {
  const file = credentialsPath(homeDir)
  const current = await readCredentials(homeDir)
  const onDisk = current.claudeAiOauth?.refreshToken
  if (!current.claudeAiOauth || (onDisk !== '' && onDisk !== postedRefreshToken)) return false
  const next = { ...current, claudeAiOauth: { ...current.claudeAiOauth, ...update } }
  const tmp = `${file}.voiceink-${process.pid}-${Date.now()}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tmp, file)
  } catch (error) {
    await fs.unlink(tmp).catch(() => {})
    throw error
  }
  return true
}

/**
 * @param {string} homeDir
 * @param {string} usedToken 呼叫端手上那顆（用來判斷「別人已經續好了」）
 * @param {{ fetchImpl?: Function, force?: boolean, log?: Function }} options
 */
async function refreshLocked(homeDir, usedToken, options) {
  const release = await acquireLocks(homeDir)
  try {
    const creds = await readCredentials(homeDir)
    const oauth = creds.claudeAiOauth
    if (!oauth?.accessToken) throw new UsageError('NOT_LOGGED_IN', 'Claude Code 目前未登入 OAuth')
    if (oauth.accessToken !== usedToken) return oauth.accessToken
    if (!options.force && !isExpiring(oauth, Date.now())) return oauth.accessToken
    if (!oauth.refreshToken) throw new UsageError('NO_REFRESH_TOKEN', 'Claude Code 登入已過期，請重新登入')
    const update = await postRefresh(oauth, options)
    const wrote = await writeBack(homeDir, oauth.refreshToken, update)
    options.log?.(`claude: token refreshed${wrote ? '' : ' (file changed meanwhile, not written)'}`)
    return update.accessToken
  } finally {
    await release()
  }
}

/**
 * 取一顆可用的 access token：快過期就先續。
 * @param {string} homeDir
 * @param {{ fetchImpl?: Function, force?: boolean, usedToken?: string, log?: Function, nowMs?: number }} [options]
 * @returns {Promise<{ token: string, credentials: object }>}
 */
async function ensureFreshToken(homeDir, options = {}) {
  const creds = await readCredentials(homeDir)
  const oauth = creds.claudeAiOauth
  const token = typeof oauth?.accessToken === 'string' ? oauth.accessToken : ''
  if (!token) return { token: '', credentials: creds }
  const needs = options.force || isExpiring(oauth, options.nowMs ?? Date.now())
  if (!needs || !oauth.refreshToken) return { token, credentials: creds }
  if (!inflight) {
    inflight = refreshLocked(homeDir, options.usedToken || token, options).finally(() => { inflight = null })
  }
  const fresh = await inflight
  return { token: fresh, credentials: await readCredentials(homeDir).catch(() => creds) }
}

module.exports = {
  CLIENT_ID,
  TOKEN_URL,
  LOCK_STALE_MS,
  ensureFreshToken,
  isExpiring,
  _resetForTests: () => { inflight = null }
}
