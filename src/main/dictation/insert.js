/**
 * VoiceInk - 把整理好的文字送進「使用者現在正在打字的地方」
 *
 * 做法是剪貼簿 + 模擬 Ctrl+V，不是逐字模擬輸入：
 *   - 逐字送鍵在中文／表情符號上不可靠（要拆成 unicode 事件，而且輸入法會插手）
 *   - 一段話逐字送要數百次事件，慢而且中途被使用者打斷就是半句話
 *
 * 代價是會動到剪貼簿，所以貼完要還原。只還原純文字：原本若是圖片或帶格式的內容，
 * Electron 的 clipboard API 沒辦法無損搬回來，這一點在 UI 上講清楚比假裝做得到好。
 */

const { clipboard } = require('electron')
const { sanitizeInsertText, MAX_INSERT_CHARS } = require('./text')

/** UiohookKey.Ctrl / UiohookKey.V / UiohookKey.Shift / UiohookKey.Insert */
const CTRL = 29
const V = 47
const SHIFT = 42
const INSERT = 3666
/** 貼上後等多久才還原剪貼簿。目標程式要時間去讀——實測某些程式（大型編輯器、
 * 開著其他工作的視窗）400ms 內還沒消化貼上內容，還原太早會貼出舊的剪貼簿內容。
 * 加長的代價只是「剪貼簿晚一點變回原內容」，比貼錯內容便宜得多。 */
const RESTORE_DELAY_MS = 800

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {string} text
 * @param {{ load?: () => { uIOhook: object }, delayMs?: number }} [deps] 測試用注入
 * @returns {Promise<{ ok: boolean, error?: string, chars?: number }>}
 */
async function insertText(text, deps = {}) {
  const payload = sanitizeInsertText(text)
  if (!payload) return { ok: false, error: 'EMPTY' }

  let uIOhook
  try {
    ;({ uIOhook } = (deps.load || (() => require('uiohook-napi')))())
  } catch (err) {
    console.error('[dictation] 載入鍵盤 hook 失敗:', err?.message || err)
    return { ok: false, error: 'HOOK_UNAVAILABLE' }
  }

  const previous = clipboard.readText()
  clipboard.writeText(payload)
  // 寫完讀回來驗：剪貼簿寫入被系統或安全軟體擋掉時，硬按 Ctrl+V 貼出來的會是
  // 使用者原本的舊內容——寧可留在剪貼簿讓他自己貼，也不要貼錯東西
  if (clipboard.readText() !== payload) {
    console.error('[dictation] 剪貼簿寫入未生效')
    return { ok: false, error: 'CLIPBOARD_WRITE_FAILED' }
  }
  try {
    try {
      uIOhook.keyTap(V, [CTRL])
    } catch {
      // 有些程式不吃 Ctrl+V（部分終端機、遊戲）；Shift+Insert 是第二條通用貼上路徑
      uIOhook.keyTap(INSERT, [SHIFT])
    }
  } catch (err) {
    clipboard.writeText(previous)
    console.error('[dictation] 模擬貼上失敗:', err?.message || err)
    return { ok: false, error: 'PASTE_FAILED' }
  }

  await sleep(Number.isFinite(deps.delayMs) ? Number(deps.delayMs) : RESTORE_DELAY_MS)
  // 使用者在這段空檔自己複製了別的東西：那是他要的，不要蓋回去
  if (clipboard.readText() === payload) clipboard.writeText(previous)
  return { ok: true, chars: payload.length }
}

module.exports = { insertText, RESTORE_DELAY_MS }
