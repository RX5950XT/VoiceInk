'use strict'

/**
 * 走 SQLite 的兩家用量來源（Main Process）。
 *
 * - **OpenCode**：`~/.local/share/opencode/opencode.db` 的 `message` 表，
 *   `data` 是一份 JSON，assistant 訊息帶 `cost`／`tokens`／`modelID`。
 *   **自帶花費**，不必靠單價表。
 * - **Antigravity**：本機沒有 session 記錄可讀（`~/.antigravitycli` 只有專案清單），
 *   唯一有 token 數字的是 **VoiceInk 自己的 AGY 反代日誌** `<userData>/agy-logs.db`。
 *   所以這一家統計到的是「經過本 App 反代的流量」，不含使用者直接用 IDE／CLI 打的那些。
 *   這個限制要讓 UI 講清楚，不能假裝是完整用量。
 *
 * 兩邊都用 Electron 內建 `node:sqlite`、`readOnly: true`、`allowExtension: false`
 * 與參數化固定 SQL（跟額度頁讀 OpenCode 同一套規矩）。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

/** 單次查詢的列數上限 */
const MAX_ROWS = 50000

/** @type {(() => object) | null} */
let sqliteModule = null

/**
 * `node:sqlite` 是 Electron 內建，但在純 node 測試環境可能沒有——延後 require，
 * 拿不到就讓呼叫端把這一家標成不可用，而不是讓整個同步掛掉。
 * @returns {object | null}
 */
function loadSqlite() {
  if (sqliteModule) return sqliteModule
  try {
    sqliteModule = require('node:sqlite')
  } catch {
    sqliteModule = null
  }
  return sqliteModule
}

/**
 * @param {string} file
 * @returns {object | null}
 */
function openReadOnly(file) {
  const sqlite = loadSqlite()
  if (!sqlite || !fs.existsSync(file)) return null
  try {
    return new sqlite.DatabaseSync(file, { readOnly: true, allowExtension: false })
  } catch {
    // 檔案被鎖住（OpenCode 正在寫）或版本不合：這一輪跳過，不影響其他家
    return null
  }
}

/** @returns {string} */
function opencodeDbPath() {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')
}

/**
 * OpenCode：`message` 表，只取 assistant 且帶 tokens 的那些。
 *
 * @param {number} sinceMs 只取這之後建立的（增量游標）
 * @param {string} [dbPath]
 * @returns {Array<object>} 標準用量事件
 */
function readOpencode(sinceMs, dbPath = opencodeDbPath()) {
  const db = openReadOnly(dbPath)
  if (!db) return []
  try {
    const rows = db.prepare(
      `SELECT time_created, data FROM message
       WHERE time_created > ? AND data LIKE '%"tokens"%'
       ORDER BY time_created ASC LIMIT ?`
    ).all(sinceMs, MAX_ROWS)

    const events = []
    for (const row of rows) {
      let data
      try {
        data = JSON.parse(row.data)
      } catch {
        continue
      }
      if (data?.role !== 'assistant' || !data.tokens) continue
      const tokens = data.tokens
      const cache = tokens.cache || {}
      const input = Number(tokens.input) || 0
      const cacheRead = Number(cache.read) || 0
      events.push({
        ts: Number(row.time_created) || 0,
        model: String(data.modelID || 'unknown'),
        // OpenCode 的 input 不含 cache（實測 input 152079 / cache.read 128 / total 152528）
        input,
        output: Number(tokens.output) || 0,
        reasoning: Number(tokens.reasoning) || 0,
        cacheRead,
        cacheWrite: Number(cache.write) || 0,
        requests: 1,
        // 自帶花費，比我們用單價表推算準
        costUsd: Number.isFinite(Number(data.cost)) ? Number(data.cost) : null
      })
    }
    return events
  } catch {
    return []
  } finally {
    try {
      db.close()
    } catch {
      // 已關閉
    }
  }
}

/**
 * Antigravity：讀 VoiceInk 自己的 AGY 反代日誌。
 *
 * @param {number} sinceMs
 * @param {string} dbPath `<userData>/agy-logs.db`
 * @returns {Array<object>}
 */
function readAntigravity(sinceMs, dbPath) {
  const db = openReadOnly(dbPath)
  if (!db) return []
  try {
    const rows = db.prepare(
      `SELECT ts, model, mapped_model, input_tokens, output_tokens, thought_tokens, cached_tokens
       FROM request_logs
       WHERE ts > ? AND status < 400
       ORDER BY ts ASC LIMIT ?`
    ).all(sinceMs, MAX_ROWS)

    return rows.map((row) => ({
      ts: Number(row.ts) || 0,
      model: String(row.mapped_model || row.model || 'unknown'),
      input: Number(row.input_tokens) || 0,
      output: Number(row.output_tokens) || 0,
      reasoning: Number(row.thought_tokens) || 0,
      cacheRead: Number(row.cached_tokens) || 0,
      cacheWrite: 0,
      requests: 1,
      costUsd: null
    }))
  } catch {
    return []
  } finally {
    try {
      db.close()
    } catch {
      // 已關閉
    }
  }
}

module.exports = {
  MAX_ROWS,
  opencodeDbPath,
  readOpencode,
  readAntigravity
}
