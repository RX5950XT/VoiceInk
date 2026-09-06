'use strict'

/**
 * 「這個專案跑過哪些 AI CLI 對話」（Main Process）。
 *
 * 只讀不寫，只認 Claude Code 與 Codex 兩家——**它們的 session 檔本來就存著 cwd**，
 * 才對得回專案。其餘幾家（Grok／OpenCode）的記錄裡沒有可靠的工作目錄，先不列。
 *
 * 路徑跟 `codeusage/index.js` 的 `jsonlSources()` 是同一組事實，但那邊沒有匯出、
 * 而且形狀是給「逐行算 token」用的（要 parser、要游標、要桶子），這裡只要
 * 「檔案在哪、第一則使用者訊息是什麼」。硬接過去比各留兩個常數更貴。
 * **改路徑時兩邊都要動。**
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

/** session id 的樣子（會被組進指令，一定要卡死） */
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/

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
 * 實測：`D:\Workspace\Personal_Project\VoiceInk` → `D--Workspace-Personal-Project-VoiceInk`。
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
  const home = os.homedir()
  const sinceMs = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000
  /** @type {Array<{ agent: string, agentLabel: string, id: string, title: string, mtime: number }>} */
  const out = []

  // Claude：資料夾名就是編碼過的 cwd，不必逐檔開來確認
  const claudeDir = path.join(home, '.claude', 'projects', encodeClaudeDir(projectPath))
  /** @type {Array<{ file: string, mtime: number }>} */
  const claudeFiles = []
  collect(claudeDir, sinceMs, claudeFiles)
  claudeFiles.sort((a, b) => b.mtime - a.mtime)
  for (const item of claudeFiles.slice(0, MAX_SESSIONS)) {
    const id = path.basename(item.file, '.jsonl')
    if (!ID_RE.test(id)) continue
    const title = claudeTitle(await headLines(item.file))
    out.push({ agent: 'claude', agentLabel: AGENTS.claude.label, id, title, mtime: item.mtime })
  }

  // Codex：檔名不含 cwd，只能開第一行看 session_meta
  /** @type {Array<{ file: string, mtime: number }>} */
  const codexFiles = []
  for (const root of ['sessions', 'archived_sessions']) {
    collect(path.join(home, '.codex', root), sinceMs, codexFiles)
  }
  codexFiles.sort((a, b) => b.mtime - a.mtime)
  for (const item of codexFiles) {
    if (out.length >= MAX_SESSIONS * 2) break
    const head = codexHead(await headLines(item.file))
    if (!head.sessionId || !samePath(head.cwd, projectPath)) continue
    if (!ID_RE.test(head.sessionId)) continue
    out.push({
      agent: 'codex',
      agentLabel: AGENTS.codex.label,
      id: head.sessionId,
      title: head.title,
      mtime: item.mtime
    })
  }

  out.sort((a, b) => b.mtime - a.mtime)
  return out.slice(0, MAX_SESSIONS)
}

/**
 * 讀取並結構化解析單一會話（卡片式檢視，不需 resume）
 * @param {string} projectPath
 * @param {string} agent
 * @param {string} sessionId
 */
async function sessionDetail(projectPath, agent, sessionId) {
  if (typeof sessionId !== 'string' || !ID_RE.test(sessionId)) {
    throw fail('BAD_SESSION', '對話代碼不合法')
  }
  const home = os.homedir()
  let targetFile = ''

  if (agent === 'claude') {
    const candidate = path.join(home, '.claude', 'projects', encodeClaudeDir(projectPath), `${sessionId}.jsonl`)
    if (fs.existsSync(candidate)) targetFile = candidate
  } else if (agent === 'codex') {
    for (const root of ['sessions', 'archived_sessions']) {
      const dir = path.join(home, '.codex', root)
      const matches = []
      collect(dir, Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000, matches)
      for (const match of matches) {
        const head = codexHead(await headLines(match.file))
        if (head.sessionId !== sessionId || !samePath(head.cwd, projectPath)) continue
        targetFile = match.file
        break
      }
      if (targetFile) break
    }
  }

  if (!targetFile || !fs.existsSync(targetFile)) {
    throw fail('SESSION_NOT_FOUND', '找不到該會話的本機記錄檔')
  }

  const stat = await fsp.stat(targetFile).catch(() => null)
  // 最多讀取前 3MB，防止幾十 MB 的巨型 log 卡住
  const handle = await fsp.open(targetFile, 'r')
  let content = ''
  try {
    const buf = Buffer.alloc(Math.min(stat ? stat.size : 1024 * 1024, 3 * 1024 * 1024))
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
  const affectedFiles = new Set()

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
              if (fileTarget) affectedFiles.add(fileTarget)
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
          tools.push({ name, detail: String(call.arguments || '').slice(0, 120) })
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
    if (turns.length >= 60) break
  }

  const prompts = turns.filter((turn) => turn.role === 'user').map((turn) => ({ text: turn.text }))
  const modifiedFiles = Array.from(affectedFiles).slice(0, 20)
  const toolCallsCount = Object.values(toolUsage).reduce((sum, count) => sum + count, 0)
  return {
    agent,
    agentLabel: AGENTS[agent]?.label || agent,
    id: sessionId,
    sessionId,
    title: turns.find((t) => t.role === 'user')?.text?.slice(0, 60) || sessionId,
    mtime: stat ? stat.mtimeMs : Date.now(),
    prompts,
    toolCallsCount,
    toolCallsBreakdown: toolUsage,
    modifiedFiles,
    turns,
    stats: {
      totalTurns: turns.length,
      toolUsage,
      affectedFiles: modifiedFiles
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
