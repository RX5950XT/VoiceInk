/**
 * 工作區編輯器的 Monaco 外殼（語法高亮＋真正的 diff 編輯器）。
 *
 * **走 AMD 的 `min/vs`，不是 ESM 的 `esm/vs`**：ESM 那份裡面有 98 個
 * `import './x.css'`，瀏覽器沒有 bundler 幫忙把 CSS 變成模組，一 import 就死。
 * AMD 那份自帶 `loader.js`，CSS 是獨立一支 `editor.main.css`，直接 `<link>` 就好。
 *
 * **沒有 Worker，所以沒有 IntelliSense**：打包版的 renderer 跑在 `file://` 上，
 * Chromium 預設不准 `file://` 開 Worker（要 `--allow-file-access-from-files`，
 * 那等於把整台機器的檔案交出去）。所以四個要 Worker 的語言服務
 * （TS／JSON／CSS／HTML）一律關掉診斷，`getWorker` 回一顆什麼都不做的假 Worker——
 * **不能讓它拋例外**，否則每敲一個字 console 就噴一次。
 * 語法高亮本身是 Monarch、跑在主執行緒，完全不受影響。
 *
 * 載入失敗（檔案被排掉、CSP 擋住）時整支回 null，呼叫端退回原本的 `<textarea>`。
 */

/** monaco 的 AMD 根目錄。dev 走 vite 的 http、打包版走 file://，兩邊都是相對這支檔案 */
const VS = new URL('../../../node_modules/monaco-editor/min/vs', import.meta.url).href

/** @type {Promise<any> | null} 載入只跑一次；失敗也記住（不要每開一個檔就重試一輪） */
let loading = null

/** @type {Map<string, any>} 分頁 id → ITextModel（每個檔案各自留著捲動位置與復原歷程） */
const models = new Map()

/**
 * 載入 Monaco。**惰性**：只有真的開了編輯器分頁才會走到這裡
 * （那是 16MB 的 AMD 包，不該進開機路徑）。
 *
 * @returns {Promise<any | null>} monaco 的全域物件；載不起來回 null
 */
export function loadMonaco() {
  if (loading) return loading
  loading = new Promise((resolve, reject) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = `${VS}/editor/editor.main.css`
    document.head.appendChild(link)

    const globals = /** @type {any} */ (window)

    const script = document.createElement('script')
    script.src = `${VS}/loader.js`
    script.onerror = () => reject(new Error('MONACO_LOADER'))
    script.onload = () => {
      const amd = globals.require
      if (!amd || typeof amd.config !== 'function') {
        reject(new Error('MONACO_AMD'))
        return
      }
      amd.config({ paths: { vs: VS } })
      amd(['vs/editor/editor.main'], () => resolve(globals.monaco), reject)
    }
    document.head.appendChild(script)
  }).then((monaco) => {
    configure(monaco)
    return monaco
  }).catch(() => null)
  return loading
}

/**
 * 關掉會去要 Worker 的東西，並定義兩套跟 App 主題對齊的佈景。
 * @param {any} monaco
 */
function configure(monaco) {
  const langs = monaco.languages
  const off = { noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true }
  try {
    langs.typescript?.typescriptDefaults?.setDiagnosticsOptions(off)
    langs.typescript?.javascriptDefaults?.setDiagnosticsOptions(off)
    langs.json?.jsonDefaults?.setDiagnosticsOptions({ validate: false, schemaValidation: 'ignore' })
    langs.css?.cssDefaults?.setOptions({ validate: false })
    langs.css?.scssDefaults?.setOptions({ validate: false })
    langs.css?.lessDefaults?.setOptions({ validate: false })
  } catch {
    // 某個語言沒被打包進來就算了，高亮不受影響
  }

  // 背景給全透明（`#00000000`）讓底下的玻璃面板透出來——
  // 寫死顏色的話深／淺主題一切換就會看到一塊突兀的方塊。
  const shared = { 'editor.background': '#00000000', 'editorGutter.background': '#00000000' }
  monaco.editor.defineTheme('voiceink-dark', { base: 'vs-dark', inherit: true, rules: [], colors: shared })
  monaco.editor.defineTheme('voiceink-light', { base: 'vs', inherit: true, rules: [], colors: shared })
  applyTheme(monaco)
  // 主題是改 <html> 的 data-theme，沒有事件可以聽——盯著那個屬性就好
  new MutationObserver(() => applyTheme(monaco))
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
}

/**
 * 跟著 App 的 `data-theme` 換佈景。
 * @param {any} monaco
 */
function applyTheme(monaco) {
  if (!monaco) return
  const light = document.documentElement.getAttribute('data-theme') === 'light'
  monaco.editor.setTheme(light ? 'voiceink-light' : 'voiceink-dark')
}

/**
 * 檔名 → monaco 的語言 id。**問 monaco 自己的註冊表**，不要自己維護一張對照表
 * （那張表一定會跟它的 90 幾種語言脫節）。
 *
 * @param {any} monaco
 * @param {string} relPath
 * @returns {string}
 */
export function languageFor(monaco, relPath) {
  const name = (String(relPath || '').split('/').pop() || '').toLowerCase()
  const dot = name.lastIndexOf('.')
  const ext = dot < 0 ? '' : name.slice(dot)
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((one) => String(one).toLowerCase() === name)) return lang.id
    if (ext && lang.extensions?.some((one) => String(one).toLowerCase() === ext)) return lang.id
  }
  return 'plaintext'
}

/** 兩種編輯器都只有一顆，切分頁時換 model（跟其他四種內容同一個「單一擁有者」規則） */
let editor = null
let diffEditor = null

/** 共用的編輯器選項 */
const OPTIONS = {
  automaticLayout: true,
  fontSize: 13,
  lineHeight: 20,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderLineHighlight: 'line',
  smoothScrolling: true,
  fontLigatures: false,
  fixedOverflowWidgets: true,
  tabSize: 2
}

/**
 * 建（或取回）那顆編輯器。
 *
 * @param {any} monaco
 * @param {HTMLElement} host
 * @param {(value: string) => void} onChange 內容變動（同步回 textarea，其餘流程照舊）
 * @param {() => void} onCursor 游標／選取變動（餵狀態列）
 * @returns {any}
 */
export function ensureEditor(monaco, host, onChange, onCursor) {
  if (editor) return editor
  editor = monaco.editor.create(host, { ...OPTIONS, value: '', language: 'plaintext' })
  editor.onDidChangeModelContent(() => onChange(editor.getValue()))
  editor.onDidChangeCursorSelection(() => onCursor())
  return editor
}

/**
 * 把某個分頁的內容掛上去。每個分頁一份 model，所以切回來時
 * 捲動位置、選取與復原歷程都還在（`setValue` 會全部洗掉）。
 *
 * @param {any} monaco
 * @param {{ id: string, relPath?: string, content?: string, readonly?: string }} tab
 */
export function showTab(monaco, tab) {
  if (!editor) return
  let model = models.get(tab.id)
  const language = languageFor(monaco, tab.relPath || '')
  if (!model || model.isDisposed()) {
    model = monaco.editor.createModel(tab.content || '', language)
    models.set(tab.id, model)
  } else {
    if (model.getValue() !== (tab.content || '')) model.setValue(tab.content || '')
    monaco.editor.setModelLanguage(model, language)
  }
  editor.setModel(model)
  editor.updateOptions({ readOnly: Boolean(tab.readonly) })
}

/**
 * 分頁 id 換了（檔案改名／搬家）→ model 也要跟著換鍵。
 *
 * 不換的話舊 model 永遠留在 map 裡沒人收（每改一次名漏一份），而分頁再點回來時
 * 會用新 id 重建一份新的——**復原歷程就這樣安靜消失**。
 *
 * @param {string} oldId
 * @param {string} newId
 */
export function retargetModel(oldId, newId) {
  if (oldId === newId) return
  const model = models.get(oldId)
  if (!model) return
  models.delete(oldId)
  models.set(newId, model)
}

/**
 * 分頁關掉了 → 把它的 model 收掉（不收的話開一整天會愈積愈多）。
 * @param {string} tabId
 */
export function disposeModel(tabId) {
  const model = models.get(tabId)
  models.delete(tabId)
  if (model && !model.isDisposed()) model.dispose()
}

/**
 * @param {number} line 1 起算
 */
export function revealLine(line) {
  if (!editor || line <= 0) return
  editor.revealLineInCenter(line)
  editor.setPosition({ lineNumber: line, column: 1 })
  editor.focus()
}

/**
 * 狀態列要的三個數字。沒有編輯器時回 null，呼叫端就退回 textarea 那一套。
 * @returns {{ line: number, column: number, selected: number, lines: number } | null}
 */
export function cursorInfo() {
  const model = editor?.getModel()
  if (!editor || !model) return null
  const pos = editor.getPosition()
  const sel = editor.getSelection()
  return {
    line: pos?.lineNumber || 1,
    column: pos?.column || 1,
    selected: sel && !sel.isEmpty() ? model.getValueInRange(sel).length : 0,
    lines: model.getLineCount()
  }
}

/**
 * 現在選了哪一段（「把這段帶進聊天」用）。沒有選取時回 `null`——
 * 沒選就把整份檔案塞進聊天不是使用者要的。
 * @returns {{ text: string, startLine: number, endLine: number } | null}
 */
export function selectionInfo() {
  const model = editor?.getModel()
  const sel = editor?.getSelection()
  if (!model || !sel || sel.isEmpty()) return null
  return {
    text: model.getValueInRange(sel),
    startLine: sel.startLineNumber,
    endLine: sel.endLineNumber
  }
}

/** 目前顯示中的內容（存檔前用，避免 textarea 還沒同步到） */
export function currentValue() {
  return editor?.getModel() ? editor.getValue() : null
}

/**
 * 從外面把內容推進來（有人直接改了那份 `<textarea>` 影子）。
 *
 * 走 `executeEdits` 不走 `setValue`：後者會把復原歷程整個清掉，
 * 使用者按 Ctrl+Z 就回不去了。
 *
 * @param {string} value
 */
export function pushValue(value) {
  const model = editor?.getModel()
  if (!model || model.getValue() === value) return
  editor.executeEdits('external', [{ range: model.getFullModelRange(), text: value }])
}

/**
 * 真正的並排 diff 編輯器。
 *
 * @param {any} monaco
 * @param {HTMLElement} host
 * @param {{ original: string, modified: string, relPath: string }} data
 */
export function showDiff(monaco, host, data) {
  if (!diffEditor) {
    diffEditor = monaco.editor.createDiffEditor(host, {
      ...OPTIONS,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      ignoreTrimWhitespace: false
    })
  }
  const language = languageFor(monaco, data.relPath)
  const old = diffEditor.getModel()
  diffEditor.setModel({
    original: monaco.editor.createModel(data.original || '', language),
    modified: monaco.editor.createModel(data.modified || '', language)
  })
  // 換掉的那兩顆要自己收，`setModel` 不會幫忙
  old?.original?.dispose()
  old?.modified?.dispose()
}


/**
 * 並排 diff 的「上一個／下一個變更」。0.55 的 standalone diff editor 有
 * `goToDiff`，用不了時退回自己算（`getLineChanges` 仍在，只是標了 deprecated）。
 *
 * @param {'next' | 'previous'} dir
 * @returns {boolean} 有沒有真的跳
 */
export function diffGoTo(dir) {
  if (!diffEditor) return false
  const target = dir === 'previous' ? 'previous' : 'next'
  if (typeof diffEditor.goToDiff === 'function') {
    diffEditor.goToDiff(target)
    diffEditor.getModifiedEditor?.()?.focus()
    return true
  }
  const changes = diffEditor.getLineChanges?.() || []
  if (!changes.length) return false
  const modified = diffEditor.getModifiedEditor?.()
  if (!modified) return false
  const here = modified.getPosition()?.lineNumber || 1
  const lines = changes.map((c) => c.modifiedStartLineNumber || 1)
  const next = target === 'next'
    ? lines.find((line) => line > here) ?? lines[0]
    : [...lines].reverse().find((line) => line < here) ?? lines[lines.length - 1]
  modified.revealLineInCenter(next)
  modified.setPosition({ lineNumber: next, column: 1 })
  modified.focus()
  return true
}

/** 這份 diff 有幾塊變更（畫在標題列上，讓人知道還有沒有下一個） */
export function diffChangeCount() {
  return diffEditor?.getLineChanges?.()?.length || 0
}

/**
 * 並排 diff 右邊（修改後那一側）現在的游標與選取——「逐行意見」要釘在哪一行。
 * @returns {{ line: number, endLine: number, text: string } | null}
 */
export function diffCursor() {
  const modified = diffEditor?.getModifiedEditor?.()
  const model = modified?.getModel?.()
  if (!modified || !model) return null
  const sel = modified.getSelection()
  const line = sel?.startLineNumber || modified.getPosition()?.lineNumber || 1
  const endLine = sel?.endLineNumber || line
  const text = sel && !sel.isEmpty()
    ? model.getValueInRange(sel)
    : model.getLineContent(line)
  return { line, endLine, text }
}

/**
 * 跑一個 Monaco 內建動作（尋找、取代…）。編輯器還沒起來就回 false，
 * 呼叫端可以退回自己那套。
 *
 * @param {string} id 例如 `actions.find`／`editor.action.startFindReplaceAction`
 * @returns {boolean}
 */
export function runAction(id) {
  if (!editor) return false
  const action = editor.getAction(id)
  if (action) {
    editor.focus()
    void action.run()
    return true
  }
  // 有些是「命令」不是「動作」（`closeFindWidget` 就是），`getAction` 找不到，
  // 要用 `trigger` 送進去。
  editor.trigger('voiceink', id, null)
  return true
}
