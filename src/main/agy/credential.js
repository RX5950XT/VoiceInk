'use strict'

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const {
  fetchLoadCodeAssist,
  parseCredential,
  readAntigravityCredential,
  refreshAccessToken,
  tokenIsStale
} = require('../usage/antigravity')

/**
 * 反代用的 Antigravity 憑證來源。
 *
 * 與額度頁共用同一條憑證鏈（Windows Credential Manager → OAuth refresh → loadCodeAssist），
 * 差別在反代是熱路徑：每個請求都要 token，所以這裡多一層記憶體快取與 in-flight 合併。
 * 憑證與 project id 一律不出 main。
 */

const TOKEN_SKEW_MS = 5 * 60 * 1000
const PROJECT_TTL_MS = 6 * 60 * 60 * 1000
/** 兩次 CLI 續期之間的最短間隔：token 進入尾聲後每個請求都會走到這裡，不能每次都開一個程序 */
const NUDGE_COOLDOWN_MS = 60 * 1000
/** CLI 正常 2～3 秒就跑完；這只是防它真的卡住，別讓使用者的請求陪著等一分鐘 */
const NUDGE_TIMEOUT_MS = 30 * 1000

let cache = { token: '', expiresAt: 0, project: '', tier: '', projectAt: 0 }
let inFlight = null
/** 上游回過 401：下次一定要走 refresh，不能再信任本機憑證的 expiry */
let mustRefresh = false
let lastNudgeAt = 0
let nudgeInFlight = null

function reset() {
  cache = { token: '', expiresAt: 0, project: '', tier: '', projectAt: 0 }
  inFlight = null
  mustRefresh = false
  lastNudgeAt = 0
  nudgeInFlight = null
}

/**
 * 401 之後呼叫：丟掉 token 但保留 project（project 不會因為 token 過期而失效）。
 * 一定要連帶設 mustRefresh——憑證檔裡的 expiry 可能還沒到，但上游已經說這個 token 不能用了，
 * 少了這個旗標，重試會拿同一個死 token 再送一次，等於沒重試。
 */
function invalidateToken() {
  cache.token = ''
  cache.expiresAt = 0
  mustRefresh = true
}

/**
 * 誰在維護這台機器上的 Antigravity 憑證。
 *
 * Antigravity CLI 或 IDE 任一個在跑，就會把 Credential Manager 裡的 token 續期，
 * 我們只負責讀。兩個都沒有的話使用者永遠拿不到憑證，頁面得講清楚下一步是什麼，
 * 而不是只丟一句「請先在 Antigravity 登入」。
 *
 * 只認執行檔、不認資料夾：解除安裝後 %LOCALAPPDATA%\\Programs\\Antigravity 會留下空目錄，
 * 看資料夾存在與否會誤判成已安裝（本機實測就是這個狀況）。
 */
function detectSources(env) {
  const localAppData = (env || process.env).LOCALAPPDATA || ''
  if (!localAppData) return { cli: false, ide: false }
  return {
    cli: !!agyCliPath(env),
    ide: dirHasExecutable(path.join(localAppData, 'Programs', 'Antigravity'))
  }
}

/** @returns {string} agy.exe 的完整路徑，沒裝就是空字串 */
function agyCliPath(env) {
  const localAppData = (env || process.env).LOCALAPPDATA || ''
  if (!localAppData) return ''
  const target = path.join(localAppData, 'agy', 'bin', 'agy.exe')
  return fileExists(target) ? target : ''
}

function fileExists(target) {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

function dirHasExecutable(dir) {
  try {
    return fs.readdirSync(dir).some((name) => name.toLowerCase().endsWith('.exe'))
  } catch {
    return false
  }
}

/**
 * 跑一次 Antigravity CLI，讓它自己去續期。
 *
 * 我們手上沒有 client id／secret（那是 Antigravity IDE 的憑證，不該進原始碼），
 * `refreshAccessToken` 因此一定回空字串——token 一到期就只能等使用者手動跑一次 agy 指令，
 * 這正是「用一下就斷線」的成因。CLI 自己帶著 OAuth 憑證，任何一個要連上游的子指令
 * （`models` 最便宜，約 2 秒）都會在 token 快過期時換新並寫回 Windows Credential Manager，
 * 而那就是我們讀的同一個項目——所以這一下由我們代跑就好。
 *
 * 失敗一律吞掉：這只是「試著續期」，不是憑證鏈本身；成功與否由呼叫端重讀憑證來判斷。
 */
function nudgeCli(deps) {
  if (nudgeInFlight) return nudgeInFlight
  if (deps.now() - lastNudgeAt < NUDGE_COOLDOWN_MS) return Promise.resolve(false)
  const exe = agyCliPath(deps.env)
  if (!exe) return Promise.resolve(false)

  lastNudgeAt = deps.now()
  const work = deps.runCli(exe).then(() => true, () => false)
  nudgeInFlight = work
  work.finally(() => {
    if (nudgeInFlight === work) nudgeInFlight = null
  })
  return work
}

/**
 * 代跑 CLI 的 spawn 參數。
 *
 * **`stdin` 一定要是 `ignore`，而且一定要用 `spawn` 不能用 `execFile`。**
 * `execFile` 會把三個 stdio 都接成 pipe，並且**不會把 stdin 那條關掉**——child 拿到的是
 * 一條開著、永遠收不到 EOF 的管線，`agy.exe` 就在那裡等到天荒地老。症狀是使用者的請求
 * 卡滿整個逾時才回 `TOKEN_EXPIRED`，而同一支指令從主控台跑只要 2～3 秒。
 * 實測矩陣（`scripts/probe-agy-nudge.js`）：execFile 逾時；spawn + stdin 繼承 2.1s；
 * spawn + stdin ignore 2.8s；**spawn + stdin pipe（不寫也不關）逾時**。
 *
 * stdout／stderr 也一起 ignore：輸出我們完全不需要（成功與否由重讀憑證判斷），
 * 接成 pipe 反而要自己排乾，不然 64KB buffer 滿了 child 一樣會卡住。
 */
const CLI_SPAWN_OPTIONS = { windowsHide: true, stdio: 'ignore' }

/**
 * @param {string} exe
 * @returns {Promise<void>} 離開碼 0 才算成功
 */
function runAgyCli(exe) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['models'], CLI_SPAWN_OPTIONS)
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 已經結束 */ }
      finish(reject, new Error('NUDGE_TIMEOUT'))
    }, NUDGE_TIMEOUT_MS)
    child.on('error', (error) => finish(reject, error))
    child.on('exit', (code) => {
      if (code === 0) finish(resolve, undefined)
      else finish(reject, new Error(`NUDGE_EXIT_${code}`))
    })
  })
}

class CredentialError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CredentialError'
    this.code = code
    // 這些訊息是我們自己寫的固定字串，不含上游 body／token／路徑，
    // 標記成可以外送給 renderer。沒有這個標記的錯誤一律收斂成通用訊息。
    this.userMessage = message
  }
}

/**
 * 讀憑證並在必要時 refresh。
 * refresh 需要 ANTIGRAVITY_CLIENT_ID／SECRET 環境變數，缺了就只能用還沒過期的 access token。
 */
async function loadToken(deps) {
  const raw = await deps.readCredential()
  const credential = parseCredential(raw || '')
  if (!credential) {
    throw new CredentialError('NO_CREDENTIAL', '找不到 Antigravity 登入憑證，請先在 Antigravity 登入。')
  }

  const nowMs = deps.now()
  if (!mustRefresh && !tokenIsStale(credential.expiry, nowMs)) {
    const expiryMs = Date.parse(credential.expiry)
    return {
      token: credential.accessToken,
      expiresAt: Number.isFinite(expiryMs) ? expiryMs : nowMs + TOKEN_SKEW_MS
    }
  }

  const fresh = await deps.refresh(credential.refreshToken, deps.env, deps.fetchImpl)
  if (fresh) {
    mustRefresh = false
    // Google 的 access token 固定 1 小時，回應沒帶到期時間就用這個保守值
    return { token: fresh, expiresAt: deps.now() + 55 * 60 * 1000 }
  }

  // refresh 不可用時，還沒真的過期的 access token 仍然能用。
  // tokenIsStale 的 15 分鐘是「該去續期了」的提前量，不是「已經不能用了」——
  // 把兩者混為一談，等於每個 token 的最後 15 分鐘都被自己作廢（實測就是這樣：
  // 憑證還有 7 分鐘壽命，頁面卻回報 TOKEN_EXPIRED）。
  // mustRefresh 是唯一的例外：上游回過 401 就代表這個 token 真的死了，
  // 不管本機 expiry 寫什麼都不能再用。
  const expiryMs = Date.parse(credential.expiry)
  if (!mustRefresh && Number.isFinite(expiryMs) && expiryMs > deps.now()) {
    // 還能用，但已進入「該續期」區間：背景請 CLI 去換新，這次照常回舊 token。
    // 使用者不必等，而下一輪讀憑證時多半就已經是新的了。
    void nudgeCli(deps)
    return { token: credential.accessToken, expiresAt: expiryMs }
  }

  // 真的不能用了：等 CLI 跑完再讀一次憑證。
  // 不看 nudgeCli 的回傳值——冷卻期內它會直接回 false，但那代表「剛剛才跑過」，
  // 憑證可能已經換新，還是該重讀一次。
  await nudgeCli(deps)
  const renewed = parseCredential((await deps.readCredential()) || '')
  const renewedMs = renewed ? Date.parse(renewed.expiry) : NaN
  // 必須是「不同的」access token：同一顆 token 不會因為重讀就復活，
  // 401 的情境下更會把死 token 再送一次。
  if (renewed && renewed.accessToken !== credential.accessToken &&
      Number.isFinite(renewedMs) && renewedMs > deps.now()) {
    mustRefresh = false
    return { token: renewed.accessToken, expiresAt: renewedMs }
  }

  throw new CredentialError(
    'TOKEN_EXPIRED',
    'Antigravity token 已過期且自動續期失敗，請在 Antigravity CLI 或 IDE 重新登入一次。'
  )
}

async function resolveProject(token, deps) {
  const nowMs = deps.now()
  if (cache.project && nowMs - cache.projectAt < PROJECT_TTL_MS) {
    return { project: cache.project, tier: cache.tier }
  }
  const result = await deps.loadCodeAssist(token, deps.fetchImpl, deps.log)
  cache.project = result.project || ''
  cache.tier = result.tier || ''
  cache.projectAt = nowMs
  return { project: cache.project, tier: cache.tier }
}

/**
 * 取得可用的 { token, project, tier }。
 * 併發請求共用同一次 refresh——同時開十個對話不該打十次 OAuth。
 */
function acquire(options = {}) {
  const deps = {
    env: options.env || process.env,
    now: options.now || Date.now,
    fetchImpl: options.fetchImpl,
    log: options.log || (() => {}),
    readCredential: options.readCredential || readAntigravityCredential,
    refresh: options.refresh || refreshAccessToken,
    loadCodeAssist: options.loadCodeAssist || fetchLoadCodeAssist,
    runCli: options.runCli || runAgyCli
  }

  const nowMs = deps.now()
  if (cache.token && nowMs + TOKEN_SKEW_MS < cache.expiresAt && cache.project) {
    return Promise.resolve({ token: cache.token, project: cache.project, tier: cache.tier })
  }
  if (inFlight) return inFlight

  const work = (async () => {
    if (mustRefresh || !cache.token || deps.now() + TOKEN_SKEW_MS >= cache.expiresAt) {
      const { token, expiresAt } = await loadToken(deps)
      cache.token = token
      cache.expiresAt = expiresAt
    }
    const { project, tier } = await resolveProject(cache.token, deps)
    return { token: cache.token, project, tier }
  })()

  inFlight = work
  const clear = () => {
    if (inFlight === work) inFlight = null
  }
  work.then(clear, () => {
    // 失敗不留快取，下次請求重新走完整條鏈——但**不准設 mustRefresh**。
    // mustRefresh 是「上游回過 401，這個 token 真的死了」的專屬旗標，只有 401 能設。
    // 這裡原本呼叫 invalidateToken() 連帶把它設起來，於是任何一次暫時性失敗
    // （PowerShell 讀憑證逾時、loadCodeAssist 網路抖動）都會讓之後每一輪都強制 refresh；
    // 而沒有 ANTIGRAVITY_CLIENT_ID／SECRET 時 refresh 一定回 null，loadToken 就一律拋
    // TOKEN_EXPIRED。結果是 CLI 明明登入著、憑證檔也沒過期，頁面卻永遠紅字卡住，
    // 重登 CLI 也救不了（旗標在記憶體裡），只有重開 App 才會好。
    cache.token = ''
    cache.expiresAt = 0
    clear()
  })
  return work
}

/**
 * 給 UI 的去敏狀態：只回連線與否、方案名稱，不回 token／project／refresh token。
 * @returns {Promise<{ connected: boolean, tier: string, code: string, message: string }>}
 */
async function status(options = {}) {
  // sources 只有兩個布林值，不含路徑，可以安全過 IPC
  const sources = detectSources(options.env)
  try {
    const { tier } = await acquire(options)
    return { connected: true, tier: tier || '', code: '', message: '', sources }
  } catch (error) {
    const code = error instanceof CredentialError ? error.code : 'CREDENTIAL_ERROR'
    const message = error instanceof CredentialError
      ? error.message
      : 'Antigravity 憑證暫時無法使用。'
    return { connected: false, tier: '', code, message, sources }
  }
}

module.exports = {
  detectSources,
  CLI_SPAWN_OPTIONS,
  CredentialError,
  acquire,
  invalidateToken,
  reset,
  status
}
