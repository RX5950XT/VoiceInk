/**
 * 「這個專案跑過的 AI 對話」那個分頁的畫面。
 *
 * 從 `ws-tabs.js` 拆出來的：那支已經很大，而這裡的規則跟分頁機制無關。
 *
 * 三件跟以前不一樣的事：
 * 1. **讀過的檔案跟改過的檔案分開**（main 也分開回了）。混在一起的話，
 *    使用者以為 agent 動過三十個檔案，其實只是看過。
 * 2. **工具細節預設收起來**（`<details>`）：一輪對話動輒上百次工具呼叫，
 *    全部攤開之後看不到自己講過什麼。
 * 3. **可以直接接續**：開新終端機，或送進**已經開著**的那個終端機
 *    （常見情況是 agent 就在那裡等，只是被別的分頁蓋住）。
 */

/**
 * @param {string} text
 * @param {string} [className]
 * @returns {HTMLElement}
 */
function note(text, className = 'ws-ai-note') {
  const el = document.createElement('p')
  el.className = className
  el.textContent = text
  return el
}

/**
 * 一組可以收合的清單。
 * @param {string} title
 * @param {boolean} open
 * @returns {{ box: HTMLDetailsElement, body: HTMLElement }}
 */
function foldable(title, open) {
  const box = document.createElement('details')
  box.className = 'ws-ai-fold'
  box.open = open
  const head = document.createElement('summary')
  head.className = 'ws-ai-fold-head'
  head.textContent = title
  const body = document.createElement('div')
  body.className = 'ws-ai-fold-body'
  box.append(head, body)
  return { box, body }
}

/**
 * 一組檔案徽章。
 * @param {string[]} list
 * @param {(rel: string) => void} onOpen
 * @returns {HTMLElement}
 */
function fileChips(list, onOpen) {
  const host = document.createElement('div')
  host.className = 'ws-ai-files-list'
  for (const rel of list) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ws-ai-file-pill'
    btn.textContent = rel
    btn.title = `開啟 ${rel}`
    btn.addEventListener('click', () => onOpen(rel))
    host.appendChild(btn)
  }
  return host
}

/**
 * 畫一個 AI 會話分頁。
 *
 * @param {object} opts
 * @param {any} opts.tab 分頁本身（帶 sessionData／sessionRow）
 * @param {{ title: HTMLElement | null, meta: HTMLElement | null, body: HTMLElement | null, resumeBtn: HTMLButtonElement | null, resumeIntoBtn: HTMLButtonElement | null }} opts.els
 * @param {(rel: string) => void} opts.onOpenFile
 * @param {() => Array<{ id: string, title: string }>} opts.terminals 這個專案現在開著哪些終端機
 * @param {(terminalId: string) => void} opts.onResume 接續（空字串＝開一個新的）
 */
export function paintAiSession({ tab, els, onOpenFile, terminals, onResume }) {
  const data = tab.sessionData
  const row = tab.sessionRow
  if (els.title) els.title.textContent = tab.title
  if (els.meta) {
    const bits = []
    if (data?.source) bits.push(`來源：${data.source}`)
    if (row?.mtime) bits.push(new Date(row.mtime).toLocaleString('zh-TW'))
    if (data?.truncated) bits.push('記錄很長，只讀了前面一段')
    els.meta.textContent = bits.join(' · ')
  }

  // 接續：兩顆鈕都掛在工具列上（第二顆只有真的有終端機開著時才出現）
  if (els.resumeBtn) {
    els.resumeBtn.onclick = () => onResume('')
    els.resumeBtn.hidden = false
  }
  if (els.resumeIntoBtn) {
    const list = terminals()
    els.resumeIntoBtn.hidden = list.length === 0
    els.resumeIntoBtn.onclick = (event) => {
      const rect = /** @type {HTMLElement} */ (event.currentTarget).getBoundingClientRect()
      import('./ws-menu.js').then((mod) => {
        mod.showMenu(
          { x: rect.left, y: rect.bottom + 4 },
          list.map((one) => ({
            label: one.title,
            onSelect: () => onResume(one.id)
          }))
        )
      })
    }
  }

  if (!els.body) return
  els.body.replaceChildren()

  if (!data || data.error) {
    els.body.appendChild(note(data?.error ? `解析失敗：${data.error}` : '無法解析這份對話記錄', 'ws-ai-card'))
    return
  }

  // ── 1. 概況 ──
  const summary = document.createElement('div')
  summary.className = 'ws-ai-card'
  const summaryTitle = document.createElement('h3')
  summaryTitle.className = 'ws-ai-card-title'
  summaryTitle.textContent = '會話概況'
  summary.appendChild(summaryTitle)

  const grid = document.createElement('div')
  grid.className = 'ws-ai-meta-grid'
  const addMeta = (label, value) => {
    const item = document.createElement('div')
    item.className = 'ws-ai-meta-item'
    const l = document.createElement('span')
    l.className = 'ws-ai-meta-label'
    l.textContent = label
    const v = document.createElement('span')
    v.className = 'ws-ai-meta-value'
    v.textContent = value
    item.append(l, v)
    grid.appendChild(item)
  }
  addMeta('代理類型', row?.agentLabel || data.agent)
  addMeta('會話識別碼', data.sessionId)
  addMeta('提問輪數', `${data.prompts?.length || 0} 輪`)
  addMeta('工具呼叫次數', `${data.toolCallsCount || 0} 次`)
  addMeta('記錄來源', data.source || '本機預設位置')
  summary.appendChild(grid)

  // ── 2. 改過的／讀過的（分開，不可以混）──
  const edited = Array.isArray(data.editedFiles) ? data.editedFiles : []
  const read = Array.isArray(data.readFiles) ? data.readFiles : []
  if (edited.length) {
    const title = document.createElement('div')
    title.className = 'ws-ai-sub-title'
    title.textContent = `改過的檔案（${edited.length}）：`
    summary.append(title, fileChips(edited, onOpenFile))
  }
  if (read.length) {
    const fold = foldable(`只是讀過的檔案（${read.length}）`, false)
    fold.body.appendChild(fileChips(read, onOpenFile))
    summary.appendChild(fold.box)
  }
  if (!edited.length && !read.length) {
    summary.appendChild(note('這段記錄裡沒有對到這個專案裡的檔案。'))
  }
  els.body.appendChild(summary)

  // ── 3. 工具呼叫統計（收起來）──
  const breakdown = data.toolCallsBreakdown || {}
  if (Object.keys(breakdown).length) {
    const card = document.createElement('div')
    card.className = 'ws-ai-card'
    const fold = foldable(`工具呼叫統計（${Object.keys(breakdown).length} 種）`, false)
    const tools = document.createElement('div')
    tools.className = 'ws-ai-tools-grid'
    for (const [name, count] of Object.entries(breakdown)) {
      const badge = document.createElement('span')
      badge.className = 'ws-ai-tool-badge'
      const label = document.createElement('span')
      label.className = 'ws-ai-tool-name'
      label.textContent = name
      const num = document.createElement('span')
      num.className = 'ws-ai-tool-count'
      num.textContent = String(count)
      badge.append(label, document.createTextNode(' '), num)
      tools.appendChild(badge)
    }
    fold.body.appendChild(tools)
    card.appendChild(fold.box)
    els.body.appendChild(card)
  }

  // ── 4. 對話內容（工具細節各自收起來）──
  const turns = Array.isArray(data.turns) ? data.turns : []
  if (turns.length) {
    const card = document.createElement('div')
    card.className = 'ws-ai-card'
    const title = document.createElement('h3')
    title.className = 'ws-ai-card-title'
    title.textContent = '對話內容'
    card.appendChild(title)
    const list = document.createElement('div')
    list.className = 'ws-ai-turns'
    for (const turn of turns) {
      const item = document.createElement('div')
      item.className = turn.role === 'user' ? 'ws-ai-turn is-user' : 'ws-ai-turn'
      const who = document.createElement('span')
      who.className = 'ws-ai-turn-role'
      who.textContent = turn.role === 'user' ? '我' : (row?.agentLabel || 'AI')
      const text = document.createElement('div')
      text.className = 'ws-ai-turn-text'
      text.textContent = turn.text || ''
      item.append(who, text)
      if (Array.isArray(turn.tools) && turn.tools.length) {
        const fold = foldable(`工具 ${turn.tools.length} 次`, false)
        for (const tool of turn.tools) {
          const line = document.createElement('div')
          line.className = 'ws-ai-turn-tool'
          const name = document.createElement('span')
          name.className = 'ws-ai-tool-name'
          name.textContent = tool.name
          const detail = document.createElement('span')
          detail.className = 'ws-ai-turn-tool-detail'
          detail.textContent = tool.detail || ''
          line.append(name, detail)
          fold.body.appendChild(line)
        }
        item.appendChild(fold.box)
      }
      list.appendChild(item)
    }
    card.appendChild(list)
    if (data.truncated) card.appendChild(note('這份記錄太長，只讀了前面一段。'))
    els.body.appendChild(card)
  }
}
