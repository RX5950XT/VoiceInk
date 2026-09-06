'use strict'

/**
 * 「這個專案跑過哪些 AI CLI 對話」（Main Process）。
 *
 * 只讀不寫，只認 Claude Code 與 Codex 兩家——**它們的 session 檔本來就存著 cwd**，
 * 才對得回專案。其餘幾家（Grok／OpenCode）的記錄裡沒有可靠的工作目錄，先不列。
 *
 * **家目錄不是只有 `~/.claude`／`~/.codex` 一個**：CLI 認 `CLAUDE_CONFIG_DIR`／`CODEX_HOME`，
 * 而且被別的工作台（Orca）代跑時，記錄會整包落在它自己的 runtime home 底下
 * （實測 `CODEX_HOME=%APPDATA%\orca\codex-runtime-home\home`）。只看預設家目錄的話，
 * 明明剛跑過的對話在面板上一筆都不會出現。同一個 session 可能同時出現在好幾個家目錄
 * （備份／回填），所以最後要照 `agent + id` 去重。
 *
 * `codeusage/index.js` 的 `jsonlSources()` 是另一組事實（它要游標與桶子，形狀不同），
 * 那邊維持只掃預設家目錄——**改這裡不必連動那裡**。
 *
 * 恢復指令是 main 的固定表（跟 `terminal/store.js` 的 shell／preset 同一條規則）：
 * renderer 只送 `{ agent, sessionId }`，指令字串在這裡組。
 */

const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')

/** 最多回幾筆（側欄看得完的量） */
const MAX_SESSIONS = 30
/** 只看這麼多天內動過的 */
const WINDOW_DAYS = 60
/** 掃描時最多碰幾個檔案（Codex 一天好幾份，半年下來上千） */
const MAX_SCAN_FILES = 600
/** 每個檔案只讀開頭這麼多位元組來找標題（Codex 的第一行帶著整份系統提示，很大） */
const HEAD_BYTES = 256 * 1024
/** 標題長度 */
const MAX_TITLE = 80
/** 檢視單一對話時最多讀多少（幾十 MB 的 log 整份讀進來會把 main 卡住） */
const MAX_DETAIL_BYTES = 3 * 1024 * 1024
/** 檢視單一對話時最多列幾輪 */
const MAX_TURNS = 60
/** 「改過／讀過」各列幾個檔案 */
const MAX_FILE_LIST = 30

/** session id 的樣子（會被組進指令，一定要卡死） */
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/

/** 別的工作台（Orca）的資料夾。它會用自己的 runtime home 代跑 Claude／Codex。 */
const ORCA_DATA = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'orca'
)

/**
 * 去掉不存在的、解開連結、去重。順序＝優先序（環境變數最前面）。
 * @param {string[]} list
 * @returns {string[]}
 */
function existingDirs(list) {
  const seen = new Set()
  const out = []
  for (const raw of list) {
    const dir = typeof raw === 'string' ? raw.trim() : ''
    if (!dir) continue
    let real = ''
    try {
      if (!fs.statSync(dir).isDirectory()) continue
      real = fs.realpathSync.native(dir)
    } catch {
      continue
    }
    const key = process.platform === 'win32' ? real.toLowerCase() : real
    if (seen.has(key)) continue
    seen.add(key)
    out.push(real)
  }
  return out
}

/**
 * Claude Code 的家目錄。`CLAUDE_CONFIG_DIR` 是官方的覆寫，可以用逗號給好幾個。
 * @returns {string[]}
 */
function claudeHomes() {
  return existingDirs([
    ...String(process.env.CLAUDE_CONFIG_DIR || '').split(','),
    path.join(os.homedir(), '.claude'),
    path.join(ORCA_DATA, 'claude-runtime-home', 'home')
  ])
}

/**
 * Codex 的家目錄。`CODEX_HOME` 是官方的覆寫——被 Orca 代跑時整份記錄都在那裡。
 * @returns {string[]}
 */
function codexHomes() {
  return existingDirs([
    process.env.CODEX_HOME || '',
    path.join(os.homedir(), '.codex'),
    path.join(ORCA_DATA, 'codex-runtime-home', 'home')
  ])
}

/**
 * 這份記錄是誰跑的（給 UI 標一下）。預設家目錄不標，免得每一列都掛個沒資訊量的標籤。
 * @param {string} home
 * @returns {string}
 */
function sourceLabel(home) {
  const key = process.platform === 'win32' ? home.toLowerCase() : home
  const orca = process.platform === 'win32' ? ORCA_DATA.toLowerCase() : ORCA_DATA
  if (key.startsWith(orca)) return 'Orca'
  const base = path.basename(home)
  return base === '.claude' || base === '.codex' ? '' : base
}

/**
 * 這些工具是真的動到磁碟。**判斷只看這一條**：不認得的工具名一律算「讀過」——
 * 不可以憑空說 agent 改過人家的檔案。所以刻意沒有對應的 READ_TOOLS
 * （多一份「看起來會參與判斷、其實不會」的清單只會誤導下一個人）。
 */
const EDIT_TOOLS = /^(edit|write|multiedit|notebookedit|apply_patch|str_replace(_based)?_edit_tool|create_file)$/i

/**
 * 恢復指令的固定表。**renderer 不准送指令字串。**
 * @type {Record<string, { label: string, resume: (id: string) => string }>}
 */
const AGENTS = {
  claude: { label: 'Claude Code', resume: (id) => `claude --resume ${id}` },
  codex: { label: 'Codex', resume: (id) => `codex resume ${id}` }
}

/**
 * @param {string} code
 * @param {string} message
 */
function fail(code, message) {
  const error = new Error(code)
  error.code = code
  error.userMessage = message
  return error
}

/**
 * Claude Code 用「把工作目錄裡所有非英數字元換成 `-`」當資料夾名。
 * 例：`D:\Code\My_Project\App` → `D--Code-My-Project-App`（底線也算非英數字元）。
 * @param {string} full
 * @returns {string}
 */
function encodeClaudeDir(full) {
  return full.replace(/[^A-Za-z0-9-]/g, '-')
}

/**
 * 讀檔案開頭。整份讀進來會爆（單一 session 可以到幾十 MB）。
 * @param {string} file
 * @returns {Promise<string[]>} 開頭那幾行
 */
async function headLines(file) {
  let handle
  try {
    handle = await fsp.open(file, 'r')
  } catch {
    return []
  }
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, bytesRead).toString('utf8').split('\n')
  } catch {
    return []
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * 這段文字適不適合當標題。CLI 開場都會先塞一整份 AGENTS.md／系統提示進第一則
 * 「使用者訊息」，拿它當標題的話每一筆看起來都一模一樣。
 * @param {unknown} text
 * @returns {boolean}
 */
function looksLikePrompt(text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (trimmed.length < 2) return false
  if (trimmed.startsWith('<')) return false
  if (trimmed.startsWith('#') && /INSTRUCTIONS|AGENTS\.md/i.test(trimmed.slice(0, 200))) return false
  if (/^Caveat: The messages below/i.test(trimmed)) return false
  return true
}

/**
 * @param {string} text
 * @returns {string}
 */
function toTitle(text) {
  return text.trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE)
}

/**
 * 從 Claude 的 jsonl 開頭找第一則真的是使用者打的訊息。
 * @param {string[]} lines
 * @returns {string}
 */
function claudeTitle(lines) {
  for (const line of lines) {
    if (!line.includes('"type":"user"')) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const content = obj?.message?.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.find((part) => part?.type === 'text')?.text
        : ''
    if (looksLikePrompt(text)) return toTitle(text)
  }
  return ''
}

/**
 * 從 Codex 的 rollout 檔開頭取 `{ cwd, sessionId, title }`。
 * @param {string[]} lines
 * @returns {{ cwd: string, sessionId: string, title: string }}
 */
function codexHead(lines) {
  let cwd = ''
  let sessionId = ''
  let title = ''
  for (const line of lines) {
    if (!line) continue
    if (!cwd && line.includes('"session_meta"')) {
      try {
        const obj = JSON.parse(line)
        cwd = typeof obj?.payload?.cwd === 'string' ? obj.payload.cwd : ''
        sessionId = typeof obj?.payload?.id === 'string'
          ? obj.payload.id
          : typeof obj?.payload?.session_id === 'string'
            ? obj.payload.session_id
            : ''
        // fork 出來的子代理是母 thread 的重播，列出來只會多一份一模一樣的
        if (obj?.payload?.forked_from_id || obj?.payload?.parent_thread_id) {
          return { cwd: '', sessionId: '', title: '' }
        }
      } catch {
        // 壞掉的第一行 → 這份跳過
      }
      continue
    }
    if (!title && line.includes('"role":"user"')) {
      try {
        const obj = JSON.parse(line)
        const text = obj?.payload?.content?.find?.((part) => part?.type === 'input_text')?.text
        if (looksLikePrompt(text)) title = toTitle(text)
      } catch {
        // 這行不是就算了
      }
    }
    if (cwd && title) break
  }
  return { cwd, sessionId, title }
}

/**
 * 遞迴收檔案（不追 symlink，跟 `codeusage/scan.js` 同一條規矩）。
 * @param {string} dir
 * @param {number} sinceMs
 * @param {Array<{ file: string, mtime: number }>} out
 * @param {number} depth
 */
function collect(dir, sinceMs, out, depth = 0) {
  if (depth > 6 || out.length >= MAX_SCAN_FILES) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_SCAN_FILES) return
    if (entry.isSymbolicLink()) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collect(full, sinceMs, out, depth + 1)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    let stat
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    if (stat.mtimeMs < sinceMs) continue
    out.push({ file: full, mtime: stat.mtimeMs })
  }
}

/**
 * 從 Codex 的工具參數（一整包 JSON 字串）裡挑出檔案路徑。挑不到就回空字串——
 * 猜不到不是問題，硬猜才是（會把不相干的字串當成專案裡的檔案）。
 * @param {string} args
 * @returns {string}
 */
function codexFileArg(args) {
  const match = /"(?:path|file_path|file)"\s*:\s*"((?:[^"\\]|\\.){1,400})"/.exec(args || '')
  if (!match) return ''
  try {
    return JSON.parse(`"${match[1]}"`)
  } catch {
    return ''
  }
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function samePath(a, b) {
  if (!a || !b) return false
  const norm = (v) => path.resolve(v).replace(/[\\/]+$/, '')
  const x = norm(a)
  const y = norm(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/**
 * 把 agent log 裡的檔案路徑限制在目前專案，並回傳 renderer 可用的相對路徑。
 * Log 常會記絕對路徑；專案外的路徑不能交給 renderer 的開檔 IPC。
 * @param {string} projectPath
 * @param {unknown} rawPath
 * @returns {string}
 */
function normalizeProjectFile(projectPath, rawPath) {
  if (typeof projectPath !== 'string' || typeof rawPath !== 'string') return ''
  const value = rawPath.trim()
  if (!value || value.includes('\0') || value.includes('://')) return ''
  if (/^[A-Za-z]:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) return ''

  const root = path.resolve(projectPath)
  const full = path.resolve(root, value)
  const rootKey = root.toLowerCase()
  const fullKey = full.toLowerCase()
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  const inside = process.platform === 'win32'
    ? (fullKey === rootKey || fullKey.startsWith(rootPrefix.toLowerCase()))
    : (full === root || full.startsWith(rootPrefix))
  if (!inside || samePath(root, full)) return ''
  return path.relative(root, full).split(path.sep).join('/')
}

/**
 * 這個專案底下跑過的 agent 對話。
 * @param {string} projectPath 專案根目錄（絕對路徑，由 main 從 store 取）
 * @returns {Promise<Array<{ agent: string, agentLabel: string, id: string, title: string, mtime: number }>>}
 */
async function sessions(projectPath) {
  const sinceMs = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000
  /** @type {Array<{ agent: string, agentLabel: string, id: string, title: string, mtime: number, source: string }>} */
  const out = []

  // Claude：資料夾名就是編碼過的 cwd，不必逐檔開來確認
  for (const home of claudeHomes()) {
    /** @type {Array<{ file: string, mtime: number }>} */
    const found = []
    collect(path.join(home, 'projects', encodeClaudeDir(projectPath)), sinceMs, found)
    found.sort((a, b) => b.mtime - a.mtime)
    for (const item of found.slice(0, MAX_SESSIONS)) {
      const id = path.basename(item.file, '.jsonl')
      if (!ID_RE.test(id)) continue
      const title = claudeTitle(await headLines(item.file))
      out.push({
        agent: 'claude',
        agentLabel: AGENTS.claude.label,
        id,
        title,
        mtime: item.mtime,
        source: sourceLabel(home)
      })
    }
  }

  // Codex：檔名不含 cwd，只能開第一行看 session_meta
  for (const home of codexHomes()) {
    /** @type {Array<{ file: string, mtime: number }>} */
    const found = []
    for (const root of ['sessions', 'archived_sessions']) {
      collect(path.join(home, root), sinceMs, found)
    }
    found.sort((a, b) => b.mtime - a.mtime)
    let taken = 0
    for (const item of found) {
      if (taken >= MAX_SESSIONS) break
      const head = codexHead(await headLines(item.file))
      if (!head.sessionId || !samePath(head.cwd, projectPath)) continue
      if (!ID_RE.test(head.sessionId)) continue
      taken += 1
      out.push({
        agent: 'codex',
        agentLabel: AGENTS.codex.label,
        id: head.sessionId,
        title: head.title,
        mtime: item.mtime,
        source: sourceLabel(home)
      })
    }
  }

  return dedupeSessions(out).slice(0, MAX_SESSIONS)
}

/**
 * 同一個 session 可能同時躺在好幾個家目錄（備份／回填）或 `sessions` 與
 * `archived_sessions` 兩邊。留最新的那一份，並依時間由新到舊排好。
 * 純函式，可直接 node 測。
 * @template {{ agent: string, id: string, mtime: number, title?: string }} T
 * @param {T[]} rows
 * @returns {T[]}
 */
function dedupeSessions(rows) {
  /** @type {Map<string, T>} */
  const best = new Map()
  for (const row of rows) {
    const key = `${row.agent}:${row.id}`
    const prev = best.get(key)
    if (!prev) {
      best.set(key, row)
      continue
    }
    // 新的比較新就換掉；標題只有一邊讀得到時，補上有標題的那一份
    const next = row.mtime > prev.mtime ? row : prev
    const other = row.mtime > prev.mtime ? prev : row
    if (!next.title && other.title) next.title = other.title
    best.set(key, next)
  }
  return [...best.values()].sort((a, b) => b.mtime - a.mtime)
}

/**
 * 找出「這個專案的這一段對話」的記錄檔。**這是接續與檢視共用的那道門**：
 * 專案對不上（Codex 的 `session_meta.cwd`、Claude 的資料夾名）就找不到，
 * 也就接續不了——renderer 只送 id，配不配得起來由這裡說了算。
 *
 * 同一個 id 可能在好幾個家目錄各有一份，取最新的。
 * @param {string} projectPath
 * @param {string} agent
 * @param {string} sessionId
 * @returns {Promise<{ file: string, home: string, mtime: number }>}
 */
async function findSessionFile(projectPath, agent, sessionId) {
  if (!AGENTS[agent]) throw fail('BAD_AGENT', '不支援的 AI 工具')
  if (typeof sessionId !== 'string' || !ID_RE.test(sessionId)) {
    throw fail('BAD_SESSION', '對話代碼不合法')
  }
  /** @type {{ file: string, home: string, mtime: number } | null} */
  let best = null
  const take = (file, home) => {
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      return
    }
    if (!best || stat.mtimeMs > best.mtime) best = { file, home, mtime: stat.mtimeMs }
  }
  if (agent === 'claude') {
    for (const home of claudeHomes()) {
      take(path.join(home, 'projects', encodeClaudeDir(projectPath), `${sessionId}.jsonl`), home)
    }
  } else {
    const sinceMs = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000
    for (const home of codexHomes()) {
      /** @type {Array<{ file: string, mtime: number }>} */
      const matches = []
      for (const root of ['sessions', 'archived_sessions']) {
        collect(path.join(home, root), sinceMs, matches)
      }
      // 由新到舊，命中第一個就停。不停的話每按一次接續／檢視都要把這個家目錄底下
      // 最多 MAX_SCAN_FILES 份記錄各讀 HEAD_BYTES 的檔頭，只為了挑出同一份的最新版。
      matches.sort((a, b) => b.mtime - a.mtime)
      for (const match of matches) {
        const head = codexHead(await headLines(match.file))
        if (head.sessionId !== sessionId || !samePath(head.cwd, projectPath)) continue
        take(match.file, home)
        break
      }
    }
  }
  if (!best) throw fail('SESSION_NOT_FOUND', '這個專案底下找不到那一段對話的記錄')
  return best
}

/**
 * 接續一段對話。**指令由 main 組，而且要先確認這段對話真的屬於這個專案**——
 * 光驗 id 格式的話，renderer 送別的專案（甚至別人的）session id 進來照樣接得起來。
 * @param {string} projectPath
 * @param {string} agent
 * @param {string} sessionId
 * @returns {Promise<{ agent: string, agentLabel: string, sessionId: string, command: string, source: string }>}
 */
async function resume(projectPath, agent, sessionId) {
  const found = await findSessionFile(projectPath, agent, sessionId)
  return {
    agent,
    agentLabel: AGENTS[agent].label,
    sessionId,
    command: resumeCommand(agent, sessionId),
    source: sourceLabel(found.home)
  }
}

/**
 * 讀取並結構化解析單一會話（卡片式檢視，不需 resume）
 * @param {string} projectPath
 * @param {string} agent
 * @param {string} sessionId
 */
async function sessionDetail(projectPath, agent, sessionId) {
  const found = await findSessionFile(projectPath, agent, sessionId)
  const targetFile = found.file

  const stat = await fsp.stat(targetFile).catch(() => null)
  // 最多讀取前 MAX_DETAIL_BYTES，防止幾十 MB 的巨型 log 卡住
  const handle = await fsp.open(targetFile, 'r')
  let content = ''
  try {
    const buf = Buffer.alloc(Math.min(stat ? stat.size : 1024 * 1024, MAX_DETAIL_BYTES))
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    content = buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close().catch(() => {})
  }

  const lines = content.split('\n')
  /** @type {Array<{ role: 'user'|'assistant', text: string, tools?: Array<{ name: string, detail?: string }>, files?: string[], time?: string }>} */
  const turns = []
  /** @type {Record<string, number>} */
  const toolUsage = {}
  /** 真的動到磁碟的檔案 */
  const editedFiles = new Set()
  /** 只是看過的檔案（工具名不認得時也算這邊——不可以憑空說人家改過） */
  const readFiles = new Set()
  /** 讀到一半就停了（檔案太大或輪數到上限），UI 要講明白 */
  let truncated = stat ? stat.size > MAX_DETAIL_BYTES : false

  for (const line of lines) {
    if (!line.trim()) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }

    // Claude Code 格式
    if (agent === 'claude') {
      if (obj.type === 'user') {
        const rawContent = obj?.message?.content
        let text = typeof rawContent === 'string'
          ? rawContent
          : Array.isArray(rawContent)
            ? rawContent.filter((p) => p?.type === 'text').map((p) => p.text).join('\n')
            : ''
        if (text && !text.startsWith('<')) {
          turns.push({ role: 'user', text: text.trim().slice(0, 500) })
        }
      } else if (obj.type === 'assistant') {
        const rawContent = obj?.message?.content
        if (Array.isArray(rawContent)) {
          const texts = []
          const tools = []
          for (const part of rawContent) {
            if (part?.type === 'text' && part.text) {
              texts.push(part.text.trim())
            } else if (part?.type === 'tool_use') {
              const name = part.name || 'tool'
              toolUsage[name] = (toolUsage[name] || 0) + 1
              const input = part.input || {}
              const rawFileTarget = [input.path, input.file_path, input.file]
                .find((value) => typeof value === 'string' && value.trim()) || ''
              const fileTarget = normalizeProjectFile(projectPath, rawFileTarget)
              if (fileTarget) {
                if (EDIT_TOOLS.test(name)) editedFiles.add(fileTarget)
                else readFiles.add(fileTarget)
              }
              const detail = fileTarget || input.command || (typeof input === 'string' ? input : '')
              tools.push({ name, detail: typeof detail === 'string' ? detail.slice(0, 120) : '' })
            }
          }
          if (texts.length || tools.length) {
            turns.push({
              role: 'assistant',
              text: texts.join('\n\n').slice(0, 800),
              tools: tools.length ? tools.slice(0, 10) : undefined
            })
          }
        }
      }
    } else if (agent === 'codex') {
      // Codex 的現行格式把 role 放在 response_item.payload，文字型別是 output_text。
      const payload = obj?.type === 'response_item' ? obj.payload : obj
      const role = payload?.role || obj?.role
      if (role === 'user') {
        const text = payload?.content?.find?.((p) => p?.type === 'input_text')?.text
        if (text && looksLikePrompt(text)) {
          turns.push({ role: 'user', text: text.trim().slice(0, 500) })
        }
      } else if (role === 'assistant') {
        const text = payload?.content?.find?.((p) => p?.type === 'output_text' || p?.type === 'text')?.text || ''
        const call = payload?.tool_calls?.[0]
        const tools = []
        if (call) {
          const name = call.name || 'tool'
          toolUsage[name] = (toolUsage[name] || 0) + 1
          const args = String(call.arguments || '')
          // Codex 的參數是一整包 JSON 字串，只挑得出路徑的話就順手歸個類
          const guess = normalizeProjectFile(projectPath, codexFileArg(args))
          if (guess) {
            if (EDIT_TOOLS.test(name)) editedFiles.add(guess)
            else readFiles.add(guess)
          }
          tools.push({ name, detail: args.slice(0, 120) })
        }
        if (text || tools.length) {
          turns.push({
            role: 'assistant',
            text: text.slice(0, 800),
            tools: tools.length ? tools : undefined
          })
        }
      }
    }
    if (turns.length >= MAX_TURNS) {
      truncated = true
      break
    }
  }

  const prompts = turns.filter((turn) => turn.role === 'user').map((turn) => ({ text: turn.text }))
  // 「改過」與「讀過」分開：同一個檔案兩邊都有時只算改過的那一邊
  const edited = Array.from(editedFiles).slice(0, MAX_FILE_LIST)
  const read = Array.from(readFiles).filter((one) => !editedFiles.has(one)).slice(0, MAX_FILE_LIST)
  const toolCallsCount = Object.values(toolUsage).reduce((sum, count) => sum + count, 0)
  return {
    agent,
    agentLabel: AGENTS[agent]?.label || agent,
    id: sessionId,
    sessionId,
    title: turns.find((t) => t.role === 'user')?.text?.slice(0, 60) || sessionId,
    mtime: stat ? stat.mtimeMs : Date.now(),
    source: sourceLabel(found.home),
    truncated,
    prompts,
    toolCallsCount,
    toolCallsBreakdown: toolUsage,
    editedFiles: edited,
    readFiles: read,
    turns,
    stats: {
      totalTurns: turns.length,
      toolUsage,
      editedFiles: edited,
      readFiles: read
    }
  }
}

/**
 * 組出恢復對話的指令字串（安全白名單，防止指令注入）。
 * @param {string} agent
 * @param {string} sessionId
 * @returns {string}
 */
function resumeCommand(agent, sessionId) {
  const spec = AGENTS[agent]
  if (!spec) throw fail('BAD_AGENT', '不支援的 AI 工具')
  if (typeof sessionId !== 'string' || !ID_RE.test(sessionId)) {
    throw fail('BAD_SESSION', '對話代碼不合法')
  }
  return spec.resume(sessionId)
}

module.exports = {
  AGENTS,
  MAX_SESSIONS,
  WINDOW_DAYS,
  ID_RE,
  EDIT_TOOLS,
  claudeHomes,
  codexHomes,
  existingDirs,
  sourceLabel,
  dedupeSessions,
  codexFileArg,
  findSessionFile,
  resume,
  encodeClaudeDir,
  looksLikePrompt,
  claudeTitle,
  codexHead,
  samePath,
  normalizeProjectFile,
  sessions,
  resumeCommand,
  sessionDetail
}
