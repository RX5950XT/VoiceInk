/**
 * 打包版 CDP 驗證：專案工作區（借 Orca 的三欄版面）。
 *
 *  [A] 側欄三顆模式鈕：專案／對話／終端機，切換只換下面那一塊
 *  [B] 檔案總管列得出檔案、展得開資料夾
 *  [C] 點檔案開編輯器分頁 → 改內容 → 存檔真的落到磁碟
 *  [D] `.md` 預覽真的跑過 markdown.js（畫面上有 .md-h 節點）
 *  [D2] 圖片預覽（data: URI）、中鍵關分頁、「在檔案總管開啟」按鈕
 *  [E] Git 面板讀得到分支與未提交的變更
 *  [F] 瀏覽器分頁只吃 http(s)
 *  [H] 專案內搜尋：找得到、點一下開檔並跳到那一行
 *  [I] 檔案樹右鍵：新增／改名／刪除真的落到磁碟
 *  [J] 埠號面板列得出本機在聽的埠
 *  [K] PDF 預覽真的畫出 canvas（Electron 沒有內建檢視器，見 probe-workspace-pdf.js）
 *  [L] 分頁右鍵選單與拖曳排序
 *  [G] 三種內容不會疊在一起、路徑逃逸被 main 擋下來
 *  [N] 檔案樹增量展開（不整棵重畫）與鍵盤導覽
 *  [O] Ctrl+P 快速開檔（模糊排序）
 *  [P] 開著的檔案在樹上標出來，藏起來的會自動展開
 *  [Q] Ctrl+W 關掉目前分頁
 *  [R] Ctrl+F／Ctrl+H 尋找取代、外部變更提示條
 *  [S] Git「全部暫存」
 *  [U] Monaco：語法高亮（不同 token 不同顏色）與真正的並排 diff
 *  [V] 檔案樹多選（Ctrl 點）與拖曳搬檔（moveEntry）
 *  [W] git worktree 面板與「列舉當白名單」的移除守衛
 *
 * **不碰使用者的東西**：暫存 user-data-dir ＋ 暫存專案資料夾（自己 git init），
 * 收尾只 taskkill 自己 spawn 的那個 pid。
 *
 * 專案是**啟動前先把 `workspaces.json` 寫進暫存 userData**——
 * 「加入專案」走的是系統對話框（renderer 不送路徑，這是信任邊界），CDP 點不到它。
 * 不要為了測試在 App 裡開一個收路徑的後門。
 *
 * 用法：node scripts/e2e-workspace-cdp.js
 *      （要驗別的建置版：VOICEINK_EXE=... node scripts/e2e-workspace-cdp.js）
 */
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const http = require('http')
const os = require('os')
const fs = require('fs')

const PORT = 9274
const EXE = process.env.VOICEINK_EXE || path.join(__dirname, '..', 'dist', 'win-unpacked', 'VoiceInk.exe')
const USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-e2e-ws-'))
fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false }))
const PROJECT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-proj-'))
const DROP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-drop-'))
/** 專案外面的資料夾：用來驗「專案裡的資料夾連結指到這裡會被擋下來」 */
const OUTSIDE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-outside-'))
const PROJECT_ID = 'w_e2e_workspace'
/** 第二個專案：只用來驗「每個專案自己一組分頁」，裡面不放東西 */
const PROJECT2_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-proj2-'))
const PROJECT2_ID = 'w_e2e_workspace_2'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.ws = null; this.id = 0; this.pending = new Map() }
  async connect() {
    this.ws = new globalThis.WebSocket(this.wsUrl)
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res)
      this.ws.addEventListener('error', rej)
    })
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    })
    this.ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP 連線已關閉'))
      this.pending.clear()
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(d.exception?.description || d.exception?.value || d.text || 'eval error')
    }
    return r.result?.value
  }
  close() { try { this.ws.close() } catch { /* 已斷線 */ } }
}

async function waitTargets(timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
      const pages = list.filter((t) => t.type === 'page')
      if (pages.length) return pages
    } catch { /* 還沒起來 */ }
    await sleep(400)
  }
  throw new Error('timeout waiting for CDP targets')
}

/**
 * 等磁碟上的檔案變成預期的樣子（存檔是非同步的，量到就算過）。
 * @param {() => boolean} check
 * @param {number} [timeoutMs]
 */
async function waitDisk(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (check()) return true
    } catch { /* 檔案還在換 */ }
    await sleep(300)
  }
  return false
}

async function waitInPage(cdp, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cdp.eval(`(() => { try { return !!(${expression}) } catch { return false } })()`)) return true
    await sleep(300)
  }
  return false
}

function stopTestApp(child) {
  if (!child?.pid) return
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已結束 */ }
}

/**
 * 種一個小專案：一個 md、一個子資料夾、一個 git repo（留一個未提交的變更）。
 * @returns {boolean} 有沒有 git
 */
function seedProject() {
  fs.writeFileSync(path.join(PROJECT_DIR, 'README.md'), '# 標題\n\n一段內文。\n')
  // 1x1 透明 PNG：真的含 NUL byte，所以能證明圖片沒被判成「二進位檔」
  fs.writeFileSync(path.join(PROJECT_DIR, 'pic.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  ))
  // 最小單頁 PDF：只要 pdf.js 讀得懂就行
  fs.writeFileSync(path.join(PROJECT_DIR, 'doc.pdf'), Buffer.from(
    'JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8'
    + 'PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdl'
    + 'L1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgMjAwIDEwMF0+PmVuZG9iagp4cmVmCjAgNAowMDAwMDAw'
    + 'MDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1NiAwMDAwMCBuIAowMDAwMDAw'
    + 'MTExIDAwMDAwIG4gCnRyYWlsZXI8PC9TaXplIDQvUm9vdCAxIDAgUj4+CnN0YXJ0eHJlZgoxODIKJSVF'
    + 'T0YK',
    'base64'
  ))
  fs.mkdirSync(path.join(PROJECT_DIR, 'src'))
  fs.writeFileSync(path.join(PROJECT_DIR, 'src', 'app.js'), 'const a = 1\n')
  // 專案裡一個指向專案外的資料夾連結：字面路徑看起來完全在專案內，
  // 只做字串比對的守衛會放它過去（實際讀到的是專案外面）
  try {
    fs.mkdirSync(OUTSIDE_DIR, { recursive: true })
    fs.writeFileSync(path.join(OUTSIDE_DIR, 'secret.txt'), 'TOP SECRET')
    fs.symlinkSync(OUTSIDE_DIR, path.join(PROJECT_DIR, 'out'), 'junction')
  } catch {
    // 這台建不了連結就跳過那一項斷言
  }
  try {
    const opt = { cwd: PROJECT_DIR, stdio: 'ignore' }
    execFileSync('git', ['init', '-q', '-b', 'main'], opt)
    execFileSync('git', ['config', 'user.email', 'e2e@example.com'], opt)
    execFileSync('git', ['config', 'user.name', 'e2e'], opt)
    execFileSync('git', ['add', '-A'], opt)
    execFileSync('git', ['commit', '-q', '-m', 'init'], opt)
    // 留一條分支當「跟誰比」的對象（審閱流程要有共同起點才算得出差異）
    execFileSync('git', ['branch', 'e2e-base'], opt)
    fs.appendFileSync(path.join(PROJECT_DIR, 'src', 'app.js'), 'const b = 2\n')
    return true
  } catch {
    return false
  }
}

/** 啟動前把專案寫進暫存 userData（「加入專案」走系統對話框，CDP 點不到） */
function seedWorkspacesJson() {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(USER_DATA_DIR, 'workspaces.json'),
    JSON.stringify({
      projects: [
        { id: PROJECT_ID, name: 'e2e 專案', path: PROJECT_DIR, createdAt: Date.now() },
        { id: PROJECT2_ID, name: 'e2e 專案二', path: PROJECT2_DIR, createdAt: Date.now() }
      ]
    }, null, 2)
  )
}

async function main() {
  const results = []
  const ok = (name, pass, detail = '') => {
    results.push({ name, pass: !!pass })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }

  const hasGit = seedProject()
  seedWorkspacesJson()

  const child = spawn(EXE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--disable-backgrounding-occluded-windows'
  ], { stdio: 'ignore' })
  let cdp = null

  try {
    const pages = await waitTargets()
    // 語音輸入的指示器也是一個 page target，主視窗一律用 /index\.html/ 認
    const mainPage = pages.find((p) => /index\.html/i.test(p.url)) || pages[0]
    cdp = new Cdp(mainPage.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await sleep(1500)
    // 感測器 sidecar 會跳 UAC，測試一律先關掉
    await cdp.eval(`window.electronAPI.store.set('sysmonSensors', false)`)

    await cdp.eval(`document.querySelector('.nav-tab[data-page="chat"]').click()`)
    ok('聊天頁打開', await waitInPage(cdp, `document.getElementById('page-chat').classList.contains('active')`))

    // ===== [A] 側欄兩顆模式鈕（側欄只列專案與對話，終端機在分頁列上） =====
    ok('[A] 兩顆模式鈕都在', await cdp.eval(`document.querySelectorAll('.sidebar-mode').length === 2`))
    ok('[A] 側欄沒有終端機清單，也沒有「＋ 終端機」',
      await cdp.eval(`!document.getElementById('termList') && !document.getElementById('termNewBtn')`))
    // 量 offsetHeight：只看 hidden 屬性抓不到「作者規則的 display 壓過 [hidden]」那種壞法
    const modes = await cdp.eval(`(async () => {
      const heights = () => ({
        proj: document.getElementById('projPanel').offsetHeight,
        chat: document.getElementById('chatPanel').offsetHeight
      })
      const out = {}
      for (const mode of ['projects', 'chats']) {
        document.querySelector('.sidebar-mode[data-mode="' + mode + '"]').click()
        await new Promise((r) => setTimeout(r, 300))
        out[mode] = heights()
      }
      return out
    })()`)
    ok('[A] 切到「專案」時只有專案清單量得到高度',
      modes.projects.proj > 0 && modes.projects.chat === 0,
      JSON.stringify(modes.projects))
    ok('[A] 切到「對話」時只有對話清單量得到高度',
      modes.chats.chat > 0 && modes.chats.proj === 0,
      JSON.stringify(modes.chats))

    // ===== [B] 專案清單與檔案總管 =====
    await cdp.eval(`document.querySelector('.sidebar-mode[data-mode="projects"]').click()`)
    const seenProject = await waitInPage(cdp, `document.querySelector('#projList [data-id="${PROJECT_ID}"]')`, 10000)
    ok('[B] 種下的專案出現在側欄', seenProject)
    if (!seenProject) throw new Error('專案沒有出現，後面的都不用測了')

    await cdp.eval(`document.querySelector('#projList [data-id="${PROJECT_ID}"] .chat-list-open').click()`)
    ok('[B] 選了專案之後右側欄不再是空狀態',
      await waitInPage(cdp, `document.getElementById('wsRightEmpty').offsetHeight === 0`, 8000))
    const projectMenu = await cdp.eval(`(() => {
      const row = document.querySelector('#projList .proj-list-item')
      if (!row) return JSON.stringify({ buttons: -1, menu: [] })
      row.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 120, clientY: 120
      }))
      return JSON.stringify({
        buttons: row.querySelectorAll('.chat-list-btn').length,
        menu: [...document.querySelectorAll('.ws-menu-item')].map((one) => one.textContent)
      })
    })()`)
    ok('[B] 專案列移除舊按鈕', String(projectMenu).includes('"buttons":0'), projectMenu)
    ok('[B] 專案列右鍵會開選單',
      String(projectMenu).includes('在此開啟終端機') && String(projectMenu).includes('重新命名'), projectMenu)
    await cdp.eval(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
    const treeReady = await waitInPage(cdp, `document.querySelectorAll('#wsTree .ws-tree-row').length >= 2`, 10000)
    ok('[B] 檔案總管列得出東西', treeReady)
    const names = await cdp.eval(
      `[...document.querySelectorAll('#wsTree .ws-tree-name')].map((n) => n.textContent)`
    )
    ok('[B] 列得到 README.md 與 src', names.includes('README.md') && names.includes('src'), JSON.stringify(names))
    ok('[B] .git 不會列出來（點進去只有雜訊）', !names.includes('.git'), JSON.stringify(names))
    const workspaceLayout = await cdp.eval(`(() => {
      const layout = document.querySelector('.chat-layout')
      const term = document.getElementById('termMain')
      const px = (value) => Number.parseFloat(value) || 0
      const layoutStyle = getComputedStyle(layout)
      const termStyle = getComputedStyle(term)
      return {
        workspace: layout.classList.contains('is-workspace'),
        gap: px(layoutStyle.gap),
        padding: px(layoutStyle.padding),
        termGap: px(termStyle.gap),
        termPadding: px(termStyle.padding)
      }
    })()`)
    ok('[B] 工作區滿版使用緊湊間距', workspaceLayout.workspace
      && workspaceLayout.gap <= 2 && workspaceLayout.padding <= 2
      && workspaceLayout.termGap <= 2 && workspaceLayout.termPadding <= 2,
    JSON.stringify(workspaceLayout))

    // 展開子資料夾：一次只展一層，所以 src 展開後才會看到 app.js
    await cdp.eval(`[...document.querySelectorAll('#wsTree .ws-tree-row')]
      .find((r) => r.textContent.includes('src')).click()`)
    const expanded = await waitInPage(cdp,
      `[...document.querySelectorAll('#wsTree .ws-tree-name')].some((n) => n.textContent === 'app.js')`, 8000)
    ok('[B] 資料夾展得開', expanded)

    // ===== [C] 編輯器分頁 ＋ 存檔 =====
    await cdp.eval(`[...document.querySelectorAll('#wsTree .ws-tree-row')]
      .find((r) => r.textContent.includes('README.md')).click()`)
    ok('[C] 開得出編輯器分頁',
      await waitInPage(cdp, `document.querySelectorAll('#wsTabStrip .ws-tab').length >= 1`, 8000))
    ok('[C] 編輯器真的顯示出來（量高度，不是只看 hidden）',
      await waitInPage(cdp, `document.getElementById('wsEditor').offsetHeight > 0`, 8000))
    const loaded = await cdp.eval(`document.getElementById('wsEditorText').value`)
    ok('[C] 讀得到檔案內容', typeof loaded === 'string' && loaded.includes('# 標題'), JSON.stringify(loaded))

    const marker = 'ponytail_saved_ok'
    await cdp.eval(`(() => {
      const t = document.getElementById('wsEditorText')
      t.value = '# 標題\\n\\n${marker}\\n'
      t.dispatchEvent(new Event('input'))
    })()`)
    ok('[C] 改過就標成未儲存',
      await waitInPage(cdp, `document.querySelector('#wsTabStrip .ws-tab-dirty')`, 5000))
    await cdp.eval(`document.getElementById('wsEditorSaveBtn').click()`)
    const savedOnDisk = await (async () => {
      for (let i = 0; i < 20; i++) {
        if (fs.readFileSync(path.join(PROJECT_DIR, 'README.md'), 'utf8').includes(marker)) return true
        await sleep(300)
      }
      return false
    })()
    ok('[C] 存檔真的落到磁碟', savedOnDisk)
    ok('[C] 存完未儲存標記消失',
      await waitInPage(cdp, `!document.querySelector('#wsTabStrip .ws-tab-dirty')`, 5000))

    // ===== [D] Markdown 預覽 =====
    await cdp.eval(`document.getElementById('wsEditorPreviewBtn').click()`)
    const previewed = await waitInPage(cdp, `document.querySelector('#wsEditorPreview .md-h')`, 5000)
    ok('[D] 預覽真的跑過 markdown.js（有 .md-h 節點）', previewed)
    ok('[D] 預覽開著時編輯區收起來',
      await cdp.eval(`document.getElementById('wsIdeContainer').offsetHeight === 0`))
    await cdp.eval(`document.getElementById('wsEditorFindBtn').click()`)
    ok('[D] 預覽中的尋找會切回編輯並開啟尋找列',
      await waitInPage(cdp,
        `document.getElementById('wsIdeContainer').offsetHeight > 0
          && !!document.querySelector('#wsMonacoHost .find-widget.visible')`, 8000))
    await cdp.eval(`document.getElementById('wsEditorFindBtn').click()`)
    ok('[D] 尋找列可以收起來',
      await waitInPage(cdp, `!document.querySelector('#wsMonacoHost .find-widget.visible')`, 5000))
    await cdp.eval(`document.getElementById('wsEditorPreviewBtn').click()`)
    ok('[D] 尋找後仍可重新開啟預覽',
      await waitInPage(cdp, `document.querySelector('#wsEditorPreview .md-h')`, 5000))
    await cdp.eval(`document.getElementById('wsEditorPreviewBtn').click()`)
    ok('[D] 切回編輯時預覽收起來',
      await waitInPage(cdp, `document.getElementById('wsEditorPreview').offsetHeight === 0`, 5000))

    // ===== [D2] 圖片預覽（點開圖片不該只看到「二進位檔案」） =====
    await cdp.eval(`[...document.querySelectorAll('#wsTree .ws-tree-row')]
      .find((r) => r.textContent.includes('pic.png')).click()`)
    ok('[D2] 圖片真的畫出來（量高度，不是只看 src）',
      await waitInPage(cdp, `document.querySelector('#wsEditorPreview .ws-editor-img')?.offsetHeight > 0`, 5000))
    ok('[D2] 圖片分頁不給存檔',
      await cdp.eval(`document.getElementById('wsEditorSaveBtn').offsetHeight === 0`))
    ok('[D2] 圖片預覽不顯示無效的尋找鈕',
      await cdp.eval(`document.getElementById('wsEditorFindBtn').offsetHeight === 0`))
    await cdp.eval(`(() => {
      const tab = document.querySelector('#wsTabStrip .ws-tab[data-kind="editor"].is-active')
      tab?.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }))
    })()`)
    ok('[D2] 中鍵關得掉分頁',
      await waitInPage(cdp,
        `![...document.querySelectorAll('#wsTabStrip .ws-tab-open')].some((b) => b.title.includes('pic.png'))`, 5000))
    ok('[D2] 「在檔案總管開啟」按鈕在（刻意不點，那會搶前景焦點）',
      await cdp.eval(`document.getElementById('wsFilesRevealBtn')?.offsetHeight > 0`))

    // 回到 README.md：後面的 [E] 假設它是作用中的分頁
    await cdp.eval(`[...document.querySelectorAll('#wsTabStrip .ws-tab-open')]
      .find((b) => b.title.includes('README.md'))?.click()`)

    // ===== [E] Git 面板 =====
    if (hasGit) {
      await cdp.eval(`document.querySelector('.ws-right-tab[data-panel="git"]').click()`)
      const branchOk = await waitInPage(cdp,
        `document.getElementById('wsGitBranch').textContent.includes('main')`, 10000)
      ok('[E] 讀得到分支名', branchOk,
        String(await cdp.eval(`document.getElementById('wsGitBranch').textContent`)))
      const changed = await cdp.eval(
        `[...document.querySelectorAll('#wsGitFiles .ws-git-name')].map((n) => n.textContent)`
      )
      ok('[E] 列得出未提交的變更', changed.includes('src/app.js'), JSON.stringify(changed))
      ok('[E] 剛存過的 README.md 也算一筆變更', changed.includes('README.md'), JSON.stringify(changed))
      const gitSections = await cdp.eval(`(() => {
        const toggles = [...document.querySelectorAll('.ws-git-sec-toggle')]
        const review = document.getElementById('wsGitSecReview')
        const scroll = document.querySelector('.ws-git-scroll')
        const files = document.querySelector('.ws-git-files')
        const changes = toggles.find((one) => one.textContent === '變更')
        changes?.click()
        const collapsed = changes?.getAttribute('aria-expanded') === 'false'
          && document.getElementById('wsGitSecChanges')?.hidden === true
        changes?.click()
        const expanded = changes?.getAttribute('aria-expanded') === 'true'
          && document.getElementById('wsGitSecChanges')?.hidden === false
        const arrow = changes ? getComputedStyle(changes, '::before').content : ''
        return JSON.stringify({
          count: toggles.length,
          reviewClosed: review?.hidden === true,
          collapsed,
          expanded,
          arrow,
          scroll: scroll ? getComputedStyle(scroll).overflowY : '',
          files: files ? getComputedStyle(files).overflowY : ''
        })
      })()`)
      ok('[E] Git 區塊可收合與展開',
        String(gitSections).includes('"count":4')
        && String(gitSections).includes('"collapsed":true')
        && String(gitSections).includes('"expanded":true'), gitSections)
      ok('[E] Git 預設收起次要區塊且只有外層捲軸',
        String(gitSections).includes('"reviewClosed":true')
        && String(gitSections).includes('"scroll":"auto"')
        && String(gitSections).includes('"files":"visible"'), gitSections)
    } else {
      console.log('SKIP  [E] 這台沒有 git')
    }

    // ===== [F] 瀏覽器分頁的網址白名單（<webview>） =====
    await cdp.eval(`(() => {
      document.getElementById('wsNewBtn').click()
    })()`)
    ok('[F] 「＋」開得出選單', await waitInPage(cdp, `document.querySelector('.ws-new-menu')`, 5000))
    await cdp.eval(`[...document.querySelectorAll('.ws-new-menu .ws-new-item')]
      .find((b) => b.textContent === '瀏覽器').click()`)
    ok('[F] 開得出瀏覽器分頁',
      await waitInPage(cdp, `document.getElementById('wsBrowser').offsetHeight > 0`, 8000))
    ok('[F] X-Frame-Options 警示已移除',
      await cdp.eval(`!document.getElementById('wsBrowserNote')`))
    const guestSrc = () => `(document.querySelector('#wsBrowserFrame webview')?.dataset.src || '')`
    const jsUrl = await cdp.eval(`(async () => {
      const input = document.getElementById('wsBrowserUrl')
      input.value = 'javascript:alert(1)'
      document.getElementById('wsBrowserGoBtn').click()
      await new Promise((r) => setTimeout(r, 400))
      return ${guestSrc()}
    })()`)
    ok('[F] javascript: 不會進 webview', !String(jsUrl).startsWith('javascript:'), JSON.stringify(jsUrl))
    const fileUrl = await cdp.eval(`(async () => {
      const input = document.getElementById('wsBrowserUrl')
      input.value = 'file:///C:/Windows/win.ini'
      document.getElementById('wsBrowserGoBtn').click()
      await new Promise((r) => setTimeout(r, 400))
      return ${guestSrc()}
    })()`)
    // 只斷言「開頭不是 file:」不夠：補成 http://file/// 也通得過，但那是去查一個叫 file 的主機。
    // webview 版被拒時**不動**（留在上一個網址），fresh tab 就是初始的 about:blank
    ok('[F] file: 整個被拒（不是硬轉成 http）',
      fileUrl === 'about:blank' || fileUrl === '' || String(fileUrl).startsWith('http://localhost:5173'),
      JSON.stringify(fileUrl))
    const httpUrl = await cdp.eval(`(async () => {
      const input = document.getElementById('wsBrowserUrl')
      input.value = 'localhost:5173'
      document.getElementById('wsBrowserGoBtn').click()
      await new Promise((r) => setTimeout(r, 400))
      return ${guestSrc()}
    })()`)
    ok('[F] 沒寫協定的補成 http://', String(httpUrl).startsWith('http://localhost:5173'), JSON.stringify(httpUrl))
    ok('[F] webview 真的長出來了',
      await waitInPage(cdp, `document.querySelector('#wsBrowserFrame webview') !== null`, 8000))
    ok('[F] webview 的 partition 是持久 session',
      await cdp.eval(`document.querySelector('#wsBrowserFrame webview').getAttribute('partition') === 'persist:wsbrowser'`))

    // ===== [H] 專案內搜尋 =====
    await cdp.eval(`document.querySelector('.ws-right-tab[data-panel="files"]').click()`)
    await cdp.eval(`document.querySelector('.ws-files-mode[data-view="search"]').click()`)
    ok('[H] 切到搜尋時檔案樹收起來',
      await waitInPage(cdp, `document.getElementById('wsTree').offsetHeight === 0`, 5000))
    await cdp.eval(`(() => {
      const box = document.getElementById('wsSearchInput')
      box.value = 'const a'
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    ok('[H] 找得到 src/app.js',
      await waitInPage(cdp,
        `[...document.querySelectorAll('#wsSearchResults .ws-search-where')].some((n) => n.textContent.includes('src/app.js'))`,
        8000))
    await cdp.eval(`[...document.querySelectorAll('#wsSearchResults .ws-search-hit')]
      .find((r) => r.textContent.includes('src/app.js')).click()`)
    ok('[H] 點一下開得出那個檔案',
      await waitInPage(cdp,
        `[...document.querySelectorAll('#wsTabStrip .ws-tab-open')].some((b) => b.title.includes('src/app.js'))`,
        5000))
    ok('[H] 游標停在命中的那一行（讀狀態列，Monaco 接手後 textarea 不會動）',
      await waitInPage(cdp, `/^Ln 1,/.test(document.getElementById('wsIdeCursorPos').textContent)`, 5000))
    await cdp.eval(`document.querySelector('.ws-files-mode[data-view="tree"]').click()`)

    // ===== [M] 拖資料夾加入專案 =====
    // 走真的 CDP 拖放（Input.dispatchDragEvent 的 files 會變成真路徑的 File），
    // 全鏈路都是真的：Chromium drop → preload 轉路徑 → IPC → main 驗證 → 磁碟與 store。
    fs.mkdirSync(path.join(DROP_DIR, 'inner'), { recursive: true })
    fs.writeFileSync(path.join(DROP_DIR, 'inner', 'a.txt'), 'x')
    const fileSink = path.join(DROP_DIR, 'inner', 'a.txt')
    const badPath = 'Z:' + String.fromCharCode(92) + 'definitely-not-here-9999'

    const dropAt = JSON.parse(String(await cdp.eval(`(() => {
      const r = document.getElementById('projPanel').getBoundingClientRect()
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
    })()`)))
    const dragData = { items: [], files: [DROP_DIR, fileSink, badPath], dragOperationsMask: 1 }
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: dropAt.x, y: dropAt.y, data: dragData })
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: dropAt.x, y: dropAt.y, data: dragData })
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: dropAt.x, y: dropAt.y, data: dragData })
    ok('[M] 拖資料夾真的進了專案清單',
      await waitInPage(cdp, `[...document.querySelectorAll('#projList [data-id]')]
        .some((n) => (n.textContent || '').includes('voiceink-drop'))`, 10000))

    const dropInfo = JSON.parse(String(await cdp.eval(`(async () => {
      const r = await window.electronAPI.workspace.listProjects()
      if (!r.ok) return 'ERR'
      const hit = r.data.find((p) => p.path.toLowerCase().includes('voiceink-drop'))
      return JSON.stringify({
        total: r.data.length,
        hitId: hit ? hit.id : '',
        activeId: document.querySelector('#projList .proj-list-item.active')?.dataset.id || ''
      })
    })()`)))
    ok('[M] 只有目錄進得來（檔案與不存在的路徑被略過，兩個種子專案 ＋ 這一個）',
      !!dropInfo && dropInfo.total === 3 && Boolean(dropInfo.hitId), JSON.stringify(dropInfo))
    ok('[M] 拖完選中的是新專案',
      await waitInPage(cdp,
        `document.querySelector('#projList [data-id="${dropInfo.hitId}"]')?.classList.contains('active') === true`, 5000))

    // 重複拖同一夾 → 略過，總數不變
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: dropAt.x, y: dropAt.y, data: dragData })
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: dropAt.x, y: dropAt.y, data: dragData })
    await waitInPage(cdp, `String(document.querySelector('#toast .toast-message')?.textContent || '').includes('略過')`, 8000)
    const reDropInfo = JSON.parse(String(await cdp.eval(`(async () => {
      const r = await window.electronAPI.workspace.listProjects()
      return JSON.stringify({
        total: r.ok ? r.data.length : -1,
        toast: document.querySelector('#toast .toast-message')?.textContent || ''
      })
    })()`)))
    ok('[M] 重複拖同一夾會略過（總數維持 3）',
      Number(reDropInfo.total) === 3 && String(reDropInfo.toast).includes('略過'), JSON.stringify(reDropInfo))

    // 接線：合成 drop 事件有沒有真的被 handler 接住（空路徑 → main 回「沒有收到資料夾」）。
    // 合成的 File 沒有真路徑，preload 轉不出路徑 → IPC 收到空陣列 → BAD_PATH。
    const wiring = await cdp.eval(`(async () => {
      const panel = document.getElementById('projPanel')
      const dt = new DataTransfer()
      dt.items.add(new File(['x'], 'a.txt'))
      panel.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }))
      const duringEnter = panel.classList.contains('is-drop')
      panel.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
      await new Promise((r) => setTimeout(r, 500))
      const toastText = document.querySelector('#toast .toast-message')?.textContent || ''
      return JSON.stringify({ duringEnter, afterDrop: panel.classList.contains('is-drop'), toast: toastText })
    })()`)
    ok('[M] dragenter 有亮出拖放提示', String(wiring).includes('"duringEnter":true'), String(wiring))
    ok('[M] drop 有接到 handler（空路徑回「沒有收到資料夾」）',
      String(wiring).includes('沒有收到資料夾'), String(wiring))
    ok('[M] drop 之後拖放提示收起來', String(wiring).includes('"afterDrop":false'), String(wiring))

    // [M] 新專案會被選中；切回種子專案，後面的檔案樹測試才有 doc.pdf 可以點
    await cdp.eval(`document.querySelector('#projList [data-id="${PROJECT_ID}"] .chat-list-open')?.click()`)
    ok('[M] 切回種子專案',
      await waitInPage(cdp,
        `document.querySelector('#projList [data-id="${PROJECT_ID}"]')?.classList.contains('active') === true`, 5000))

    // ===== [I] 檔案樹右鍵：新增／改名／刪除 =====
    // ===== [I] 檔案樹右鍵：新增／改名／刪除 =====
    // 直接打 IPC（右鍵選單用 window.prompt，CDP 點不到系統對話框），
    // 但落地與否一律看磁碟，不看 UI 說了什麼。
    const made = await cdp.eval(`(async () => {
      const r = await window.electronAPI.workspace.createEntry('${PROJECT_ID}', 'src', 'created.txt', false)
      return r.ok ? r.data.rel : 'ERR:' + (r.error && r.error.message)
    })()`)
    ok('[I] 新增檔案', made === 'src/created.txt'
      && fs.existsSync(path.join(PROJECT_DIR, 'src', 'created.txt')), String(made))

    const renamed = await cdp.eval(`(async () => {
      const r = await window.electronAPI.workspace.renameEntry('${PROJECT_ID}', 'src/created.txt', 'renamed.txt')
      return r.ok ? r.data.rel : 'ERR:' + (r.error && r.error.message)
    })()`)
    ok('[I] 改名', renamed === 'src/renamed.txt'
      && fs.existsSync(path.join(PROJECT_DIR, 'src', 'renamed.txt')), String(renamed))

    const escapedName = await cdp.eval(`(async () => {
      const tries = ['../evil.txt', 'a/b.txt', '..', 'CON']
      const out = []
      for (const name of tries) {
        const r = await window.electronAPI.workspace.createEntry('${PROJECT_ID}', '', name, false)
        out.push(r.ok === false)
      }
      return out
    })()`)
    ok('[I] 名稱含分隔符號／保留字被 main 擋掉',
      Array.isArray(escapedName) && escapedName.every(Boolean), JSON.stringify(escapedName))
    ok('[I] 沒有在專案外面建出東西',
      !fs.existsSync(path.join(PROJECT_DIR, '..', 'evil.txt')))

    const removed = await cdp.eval(`(async () => {
      const r = await window.electronAPI.workspace.removeEntry('${PROJECT_ID}', 'src/renamed.txt')
      return r.ok
    })()`)
    ok('[I] 刪除', removed === true
      && !fs.existsSync(path.join(PROJECT_DIR, 'src', 'renamed.txt')))

    const rootGuard = await cdp.eval(`(async () => {
      const r = await window.electronAPI.workspace.removeEntry('${PROJECT_ID}', '')
      return r.ok === false
    })()`)
    ok('[I] 刪不掉專案根目錄', rootGuard === true && fs.existsSync(PROJECT_DIR))

    // ===== [J] 埠號面板 =====
    await cdp.eval(`document.querySelector('.ws-right-tab[data-panel="ports"]').click()`)
    ok('[J] 埠號面板顯示出來',
      await waitInPage(cdp, `document.getElementById('wsPanelPorts').offsetHeight > 0`, 5000))
    // 這台機器上 App 自己就在聽 CDP 的埠，所以一定至少有一筆
    ok('[J] 列得出本機在聽的埠',
      await waitInPage(cdp, `document.querySelectorAll('#wsPortList .ws-port-row').length > 0`, 15000))
    ok('[J] 每一列都有埠號',
      await cdp.eval(`[...document.querySelectorAll('#wsPortList .ws-port-num')]
        .every((n) => /^[0-9]+$/.test(n.textContent.trim()))`))
    await cdp.eval(`document.querySelector('.ws-right-tab[data-panel="files"]').click()`)

    // ===== [K] PDF 預覽 =====
    // 切回檔案面板之後樹是非同步重畫的，要等它長出來再點（睡固定時間會假紅燈）
    ok('[K] 檔案樹重畫回來了', await waitInPage(cdp,
      `[...document.querySelectorAll('#wsTree .ws-tree-row')].some((r) => r.textContent.includes('doc.pdf'))`, 8000))
    await cdp.eval(`[...document.querySelectorAll('#wsTree .ws-tree-row')]
      .find((r) => r.textContent.includes('doc.pdf')).click()`)
    ok('[K] PDF 真的畫出 canvas（不是空白）',
      await waitInPage(cdp,
        `(() => { const c = document.querySelector('#wsEditorPreview .ws-pdf-canvas'); return c && c.width > 0 && c.offsetHeight > 0 })()`,
        20000))
    ok('[K] 有頁數列', await cdp.eval(`/第 1 \\/ \\d+ 頁/.test(document.querySelector('.ws-pdf-page')?.textContent || '')`))
    ok('[K] PDF 分頁不給存檔',
      await cdp.eval(`document.getElementById('wsEditorSaveBtn').offsetHeight === 0`))

    // ===== [L] 分頁右鍵選單與拖曳排序 =====
    const order0 = await cdp.eval(`[...document.querySelectorAll('#wsTabStrip .ws-tab')].map((t) => t.dataset.id)`)
    ok('[L] 現在至少有三個分頁', Array.isArray(order0) && order0.length >= 3, JSON.stringify(order0))
    // pointer 拖曳要用真的滑鼠事件（Input.dispatchMouseEvent）：合成 PointerEvent 走不了
    // pointerdown → window 監聽的拖曳狀態機（CLAUDE.md：tile 拖曳同一條教訓）。
    // 落點判定是「拖曳中的那顆的中心離哪個**靜態槽位**中心最近」（closestCenter，
    // 跟額度卡片同一套），不是「有沒有跨過鄰居中點」。所以終點要放鄰居的**正中心**：
    // 放右緣時，只要鄰居比再下一顆寬，拖曳中心就會離下一個槽位更近而一次跳兩格。
    const dragXY = JSON.parse(String(await cdp.eval(`(() => {
      const tabs = [...document.querySelectorAll('#wsTabStrip .ws-tab')]
      const a = tabs[0].getBoundingClientRect()
      const b = tabs[1].getBoundingClientRect()
      return JSON.stringify({
        x0: a.x + a.width / 2, y: a.y + a.height / 2,
        x1: b.x + b.width / 2
      })
    })()`)))
    await cdp.send('Input.dispatchMouseEvent', {
      // 座標給浮點（Electron 43 的 CDP 反序列化只吃 double，整數會 Invalid parameters）
      type: 'mousePressed', x: dragXY.x0, y: dragXY.y, button: 'left', clickCount: 1
    })
    for (let step = 1; step <= 6; step += 1) {
      const x = dragXY.x0 + ((dragXY.x1 - dragXY.x0) * step) / 6
      // eslint-disable-next-line no-await-in-loop
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: dragXY.y, button: 'left', buttons: 1 })
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: dragXY.x1, y: dragXY.y, button: 'left', clickCount: 1
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const swapped = await cdp.eval(`[...document.querySelectorAll('#wsTabStrip .ws-tab')].map((t) => t.dataset.id)`)
    ok('[L] pointer 拖曳真的換了順序',
      Array.isArray(swapped) && swapped[0] === order0[1] && swapped[1] === order0[0],
      JSON.stringify({ before: order0, after: swapped }))

    await cdp.eval(`document.querySelector('#wsTabStrip .ws-tab')
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }))`)
    ok('[L] 右鍵開得出選單',
      await waitInPage(cdp, `document.querySelector('.ws-menu')?.offsetHeight > 0`, 5000))
    ok('[L] 選單有「關閉其他」',
      await cdp.eval(`[...document.querySelectorAll('.ws-menu-item')].some((b) => b.textContent.includes('關閉其他'))`))
    await cdp.eval(`[...document.querySelectorAll('.ws-menu-item')].find((b) => b.textContent.includes('關閉其他')).click()`)
    ok('[L] 「關閉其他」只留一個分頁',
      await waitInPage(cdp, `document.querySelectorAll('#wsTabStrip .ws-tab').length === 1`, 8000))
    ok('[L] 選單自己收起來', await cdp.eval(`!document.querySelector('.ws-menu')`))

    // ===== [G] 內容不會疊在一起 ＋ main 的路徑守衛 =====
    const stacked = await cdp.eval(`(() => ({
      editor: document.getElementById('wsEditor').offsetHeight,
      browser: document.getElementById('wsBrowser').offsetHeight,
      termHost: document.getElementById('termHost').offsetHeight,
      empty: document.getElementById('termEmpty').offsetHeight
    }))()`)
    ok('[G] 瀏覽器分頁作用中時，只有它量得到高度',
      stacked.browser > 0 && stacked.editor === 0 && stacked.termHost === 0 && stacked.empty === 0,
      JSON.stringify(stacked))

    const escape = await cdp.eval(`(async () => {
      const bad = ['../', '..\\\\', 'C:\\\\Windows\\\\win.ini', '/etc/passwd', 'a/../../b']
      const out = []
      for (const rel of bad) {
        const res = await window.electronAPI.workspace.readFile('${PROJECT_ID}', rel)
        out.push(res?.ok === false)
      }
      return out
    })()`)
    ok('[G] main 擋掉所有路徑逃逸', Array.isArray(escape) && escape.every(Boolean), JSON.stringify(escape))

    if (fs.existsSync(path.join(PROJECT_DIR, 'out'))) {
      const viaLink = await cdp.eval(`(async () => {
        const res = await window.electronAPI.workspace.readFile('${PROJECT_ID}', 'out/secret.txt')
        return res?.ok === false
      })()`)
      ok('[G] 專案內指向外面的資料夾連結也擋掉', viaLink)
    } else {
      console.log('SKIP  [G] 這台建不了資料夾連結')
    }

    const goodRead = await cdp.eval(`(async () => {
      const res = await window.electronAPI.workspace.readFile('${PROJECT_ID}', 'src/app.js')
      return res?.ok === true && typeof res.data?.content === 'string'
    })()`)
    ok('[G] 專案內的檔案照樣讀得到（守衛沒有把正常路徑也擋掉）', goodRead)

    const noSuchProject = await cdp.eval(`(async () => {
      const res = await window.electronAPI.workspace.readFile('w_not_exist', 'README.md')
      return res?.ok === false
    })()`)
    ok('[G] 不存在的專案 id 被擋', noSuchProject)

    // ===== [N] 檔案樹：增量展開、鍵盤導覽 =====
    await cdp.eval(`document.querySelector('.ws-right-tab[data-panel="files"]').click()`)
    await waitInPage(cdp, `document.querySelectorAll('#wsTree .ws-tree-row').length >= 2`, 8000)
    // 收合 src（[B] 已經把它展開了），順便在 README 那一列做記號：
    // 展開如果是「整棵重畫」，這個記號會不見。
    await cdp.eval(`(() => {
      const src = document.querySelector('#wsTree .ws-tree-row[data-rel="src"]')
      if (src && src.getAttribute('aria-expanded') === 'true') src.click()
      return true
    })()`)
    await sleep(400)
    await cdp.eval(`(() => {
      document.querySelector('#wsTree .ws-tree-row[data-rel="README.md"]').dataset.probe = '1'
      return true
    })()`)
    await cdp.eval(`document.querySelector('#wsTree .ws-tree-row[data-rel="src"]').click()`)
    ok('[N] 資料夾展得開（增量插在自己這一列後面）',
      await waitInPage(cdp, `document.querySelector('#wsTree .ws-tree-row[data-rel="src/app.js"]')`, 8000))
    ok('[N] 展開不會整棵重畫（別列的狀態留著）',
      await cdp.eval(`document.querySelector('#wsTree .ws-tree-row[data-rel="README.md"]')?.dataset.probe === '1'`))

    // 鍵盤導覽走的是我們自己掛的 listener，合成 KeyboardEvent 就到得了
    const nav = await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('#wsTree .ws-tree-row')]
      const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
      rows[0].focus()
      const first = document.activeElement?.dataset.rel
      key(document.activeElement, 'ArrowDown')
      const down = document.activeElement?.dataset.rel
      key(document.activeElement, 'End')
      const end = document.activeElement?.dataset.rel
      key(document.activeElement, 'Home')
      const home = document.activeElement?.dataset.rel
      return { first, down, end, home,
        last: rows[rows.length - 1].dataset.rel,
        tabbable: rows.filter((r) => r.tabIndex === 0).length }
    })()`)
    ok('[N] ↓ 走到下一列', nav && nav.down && nav.down !== nav.first, JSON.stringify(nav))
    ok('[N] End 跳到最後一列', nav && nav.end === nav.last, JSON.stringify(nav))
    ok('[N] Home 跳回第一列', nav && nav.home === nav.first, JSON.stringify(nav))
    ok('[N] roving tabindex：整棵樹只有一列可以 Tab 進來', nav && nav.tabbable === 1, JSON.stringify(nav))

    // ===== [O] Ctrl+P 快速開檔 =====
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true }))`)
    ok('[O] Ctrl+P 開得出快速開檔面板',
      await waitInPage(cdp, `document.querySelector('.ws-qo')?.offsetHeight > 0`, 5000))
    ok('[O] 讀得到專案的檔案清單',
      await waitInPage(cdp, `document.querySelectorAll('.ws-qo-row').length >= 2`, 8000))
    await cdp.eval(`(() => {
      const input = document.querySelector('.ws-qo-input')
      input.value = 'appjs'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    const qoRows = await cdp.eval(`[...document.querySelectorAll('.ws-qo-row')].map((r) => r.textContent)`)
    ok('[O] 跳著打路徑片段也找得到，而且排第一',
      Array.isArray(qoRows) && /app\.js/.test(qoRows[0] || ''), JSON.stringify(qoRows))
    await cdp.eval(`document.querySelector('.ws-qo-input')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
    ok('[O] Enter 就開成編輯器分頁',
      await waitInPage(cdp,
        `[...document.querySelectorAll('#wsTabStrip .ws-tab')].some((t) => t.textContent.includes('app.js'))`, 8000))
    ok('[O] 選完面板自己收起來（量高度，不是只看 hidden）',
      await cdp.eval(`document.querySelector('.ws-qo').offsetHeight === 0`))

    // ===== [P] 開著的檔案在樹上標出來，藏在收合的資料夾裡也要自己展開 =====
    ok('[P] 樹上標出目前開著的檔案',
      await waitInPage(cdp,
        `document.querySelector('#wsTree .ws-tree-row[data-rel="src/app.js"]')?.classList.contains('is-open')`, 5000))
    await cdp.eval(`document.querySelector('#wsTree .ws-tree-row[data-rel="src"]').click()`)
    await sleep(400)
    ok('[P] 收合之後那一列真的不見了',
      await cdp.eval(`!document.querySelector('#wsTree .ws-tree-row[data-rel="src/app.js"]')`))
    // 切分頁的 click 掛在 `.ws-tab-open` 上（`.ws-tab` 那層只有拖曳／中鍵／右鍵）
    await cdp.eval(`[...document.querySelectorAll('#wsTabStrip .ws-tab')]
      .find((t) => t.textContent.includes('app.js')).querySelector('.ws-tab-open').click()`)
    ok('[P] 切回那個分頁會自動把上層展開並標出來',
      await waitInPage(cdp,
        `document.querySelector('#wsTree .ws-tree-row[data-rel="src/app.js"]')?.classList.contains('is-open')`, 8000))

    // ===== [Q] Ctrl+W 關掉目前分頁 =====
    const tabsBefore = await cdp.eval(`document.querySelectorAll('#wsTabStrip .ws-tab').length`)
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true }))`)
    ok('[Q] Ctrl+W 關掉目前這個分頁',
      await waitInPage(cdp, `document.querySelectorAll('#wsTabStrip .ws-tab').length === ${tabsBefore - 1}`, 5000),
      `before=${tabsBefore}`)

    // ===== [R] 尋找取代（Ctrl+F）與外部變更提示條 =====
    await cdp.eval(`document.querySelector('#wsTree .ws-tree-row[data-rel="README.md"]').click()`)
    await waitInPage(cdp, `document.getElementById('wsEditorText').offsetHeight > 0`, 8000)
    // 尋找／取代由 Monaco 自己那顆負責（我們那份 widget 只在 Monaco 載不起來時才用）
    await cdp.eval(`document.getElementById('wsEditorFindBtn').click()`)
    ok('[R] 尋找列叫得出來（看 .visible，收起來時高度還在）',
      await waitInPage(cdp, `!!document.querySelector('#wsMonacoHost .find-widget.visible')`, 8000))
    await cdp.eval(`document.getElementById('wsEditorFindBtn').click()`)
    ok('[R] 再按一次就收起來',
      await waitInPage(cdp, `!(!!document.querySelector('#wsMonacoHost .find-widget.visible'))`, 5000))

    // Monaco 尋找列：三個條件按鈕、上下筆、取代展開與關閉都走真實 DOM 事件。
    await cdp.eval(`document.getElementById('wsEditorFindBtn').click()`)
    ok('[R2] 尋找列重新開啟',
      await waitInPage(cdp, `!!document.querySelector('#wsMonacoHost .find-widget.visible')`, 5000))
    const findControls = await cdp.eval(`(() => {
      const widget = document.querySelector('#wsMonacoHost .find-widget.visible')
      if (!widget) return null
      const input = widget.querySelector('.find-part .monaco-findInput textarea')
      return {
        input: Boolean(input),
        toggles: [...widget.querySelectorAll('.find-part .monaco-findInput .monaco-custom-toggle')]
          .map((one) => one.getAttribute('aria-label')),
        buttons: [...widget.querySelectorAll('.button')]
          .map((one) => one.getAttribute('aria-label'))
      }
    })()`)
    ok('[R2] 找得到輸入框、三個條件鈕與操作鈕',
      findControls?.input && findControls.toggles.length === 3
        && findControls.buttons.length >= 5,
      JSON.stringify(findControls))
    const findToggleStates = await cdp.eval(`(() => {
      const toggles = [...document.querySelectorAll(
        '#wsMonacoHost .find-widget.visible .find-part .monaco-findInput .monaco-custom-toggle'
      )]
      const before = toggles.map((one) => one.getAttribute('aria-checked'))
      toggles.forEach((one) => one.click())
      const after = toggles.map((one) => one.getAttribute('aria-checked'))
      toggles.forEach((one) => one.click())
      const restored = toggles.map((one) => one.getAttribute('aria-checked'))
      return { before, after, restored }
    })()`)
    ok('[R2] Aa／整字／正規表示式三顆都能切換並恢復',
      findToggleStates?.before?.every((one, i) => one !== findToggleStates.after[i])
        && findToggleStates.restored.join(',') === findToggleStates.before.join(','),
      JSON.stringify(findToggleStates))

    const selectionToggle = '#wsMonacoHost .find-widget.visible .find-actions .monaco-custom-toggle'
    const selectionReady = await cdp.eval(`(() => {
      const editor = window.monaco?.editor?.getEditors?.()[0]
      const one = document.querySelector('${selectionToggle}')
      if (!editor || !one) return null
      editor.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 })
      return one.getAttribute('aria-disabled')
    })()`)
    ok('[R2] 選取文字後「只在選取範圍找」會解除停用', selectionReady === 'false', selectionReady)
    const selectionStates = await cdp.eval(`(() => {
      const one = document.querySelector('${selectionToggle}')
      const before = one?.getAttribute('aria-checked')
      one?.click()
      const checked = one?.getAttribute('aria-checked')
      one?.click()
      return { before, checked, restored: one?.getAttribute('aria-checked') }
    })()`)
    ok('[R2] 選取範圍按鈕能開關並恢復',
      selectionStates?.before !== selectionStates?.checked
        && selectionStates?.restored === selectionStates?.before,
      JSON.stringify(selectionStates))

    const hoverTarget = await cdp.eval(`(() => {
      const one = document.querySelector('#wsMonacoHost .find-widget.visible .find-part .monaco-custom-toggle')
      const rect = one?.getBoundingClientRect()
      return rect && { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })()`)
    let hoverStable = false
    let hoverFrames = []
    if (hoverTarget) {
      // 先等尋找列自己的開啟動畫結束，否則量到的是開啟中的位移，不是 hover。
      await sleep(300)
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: hoverTarget.x, y: hoverTarget.y
      })
      await sleep(120)
      for (let i = 0; i < 5; i += 1) {
        hoverFrames.push(await cdp.eval(`(() => {
          const widget = document.querySelector('#wsMonacoHost .find-widget.visible')
          const one = document.elementFromPoint(${hoverTarget.x}, ${hoverTarget.y})
          return {
            transform: getComputedStyle(widget).transform,
            rect: JSON.stringify(widget.getBoundingClientRect().toJSON()),
            target: one?.getAttribute('aria-label') || one?.className || ''
          }
        })()`))
        await sleep(60)
      }
      hoverStable = hoverFrames.every((one) => JSON.stringify(one) === JSON.stringify(hoverFrames[0]))
    }
    ok('[R2] 滑過條件按鈕時尋找列位置不閃跳', hoverStable, hoverStable ? '' : JSON.stringify(hoverFrames))
    let hoverPixelsStable = false
    if (hoverTarget) {
      await cdp.eval(`document.querySelector('#wsMonacoHost .find-widget.visible .find-part .monaco-custom-toggle')?.focus()`)
      await sleep(700)
      const screenshots = []
      for (let i = 0; i < 4; i += 1) {
        screenshots.push((await cdp.send('Page.captureScreenshot', { format: 'png' })).data)
        await sleep(100)
      }
      hoverPixelsStable = screenshots.every((one) => one === screenshots[0])
    }
    ok('[R2] hover 後畫面連續取樣保持穩定', hoverPixelsStable)

    const closeHoverTarget = await cdp.eval(`(() => {
      const one = document.querySelector('#wsMonacoHost .find-widget.visible > .button.codicon-widget-close')
      const rect = one?.getBoundingClientRect()
      return rect && { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })()`)
    let closeHoverStable = false
    let closeHoverFrames = []
    if (closeHoverTarget) {
      // 先離開上一顆條件鈕，避免上一個 tooltip 蓋住這次的實際滑鼠路徑。
      await cdp.eval(`document.activeElement?.blur()`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10 })
      ok('[R2] 先收掉上一個 tooltip', await waitInPage(cdp,
        `![...document.querySelectorAll('#wsMonacoHost .monaco-hover')]
          .some((one) => getComputedStyle(one).display !== 'none' && !one.classList.contains('hidden'))`, 3000))
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: closeHoverTarget.x, y: closeHoverTarget.y
      })
      await sleep(700)
      for (let i = 0; i < 6; i += 1) {
        closeHoverFrames.push(await cdp.eval(`(() => {
          const hovers = [...document.querySelectorAll('.monaco-hover')]
          const hover = hovers.find((one) => one.textContent.includes('Close'))
          if (!hover) return { present: false }
          const style = getComputedStyle(hover)
          return {
            present: true,
            hidden: hover.classList.contains('hidden'),
            display: style.display,
            opacity: style.opacity,
            animationName: style.animationName,
            rect: JSON.stringify(hover.getBoundingClientRect().toJSON()),
            parent: hover.parentElement?.className || '',
            hostClass: document.getElementById('wsMonacoHost')?.className || '',
            target: document.elementFromPoint(${closeHoverTarget.x}, ${closeHoverTarget.y})?.className || ''
          }
        })()`))
        await sleep(80)
      }
      closeHoverStable = closeHoverFrames.every((one) => JSON.stringify(one) === JSON.stringify(closeHoverFrames[0]))
    }
    const closeHoverPassThrough = closeHoverFrames[0]?.target !== 'hover-contents'
    ok('[R2] 關閉鈕 tooltip 顯示後不閃爍',
      closeHoverStable && closeHoverFrames[0]?.present && !closeHoverFrames[0].hidden
        && closeHoverPassThrough,
      closeHoverStable && closeHoverPassThrough ? '' : JSON.stringify(closeHoverFrames))
    if (closeHoverTarget) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: closeHoverTarget.x, y: closeHoverTarget.y,
        button: 'left', clickCount: 1
      })
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: closeHoverTarget.x, y: closeHoverTarget.y,
        button: 'left', clickCount: 1
      })
    }
    ok('[R2] tooltip 不會擋住關閉鈕',
      await waitInPage(cdp, `!document.querySelector('#wsMonacoHost .find-widget.visible')`, 3000))
    await cdp.eval(`document.getElementById('wsEditorFindBtn').click()`)
    ok('[R2] 點擊測試後尋找列可重新開啟',
      await waitInPage(cdp, `!!document.querySelector('#wsMonacoHost .find-widget.visible')`, 3000))

    await cdp.eval(`(() => {
      const input = document.querySelector('#wsMonacoHost .find-widget.visible .find-part .monaco-findInput textarea')
      input.value = 'ponytail_saved_ok'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    ok('[R2] 輸入搜尋字串會更新結果數',
      await waitInPage(cdp,
        `document.querySelector('#wsMonacoHost .find-widget.visible .matchesCount')?.textContent !== ''`,
        5000))
    const replaceButton = '#wsMonacoHost .find-widget.visible > .button.toggle.left'
    await cdp.eval(`document.querySelector('${replaceButton}')?.click()`)
    ok('[R2] 左箭頭能展開取代列',
      await waitInPage(cdp, `document.querySelector('#wsMonacoHost .find-widget.visible')?.classList.contains('replaceToggled')`, 3000))
    await cdp.eval(`document.querySelector('${replaceButton}')?.click()`)
    ok('[R2] 左箭頭再按一次能收回取代列',
      await waitInPage(cdp, `!document.querySelector('#wsMonacoHost .find-widget.visible')?.classList.contains('replaceToggled')`, 3000))
    await cdp.eval(`document.querySelector('#wsMonacoHost .find-widget.visible > .button.codicon-widget-close')?.click()`)
    ok('[R2] X 能關閉尋找列',
      await waitInPage(cdp, `!document.querySelector('#wsMonacoHost .find-widget.visible')`, 3000))

    // 有未存草稿 ＋ 磁碟被別人改過 → 提示條（沒有草稿時是靜靜自動重載，不該跳）
    await cdp.eval(`(() => {
      const text = document.getElementById('wsEditorText')
      text.value = text.value + '\\n草稿'
      text.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    fs.writeFileSync(path.join(PROJECT_DIR, 'README.md'), '# 標題\n\n外面改過了。\n')
    await cdp.eval(`window.dispatchEvent(new Event('focus'))`)
    ok('[R] 外部改過又有未存草稿時跳提示條',
      await waitInPage(cdp, `document.getElementById('wsEditorExtBanner').offsetHeight > 0`, 8000))
    await cdp.eval(`document.getElementById('wsEditorReloadDiskBtn').click()`)
    ok('[R] 按「重新載入」拿到磁碟上的新內容',
      await waitInPage(cdp, `document.getElementById('wsEditorText').value.includes('外面改過了')`, 8000))
    ok('[R] 重新載入之後提示條收起來',
      await cdp.eval(`document.getElementById('wsEditorExtBanner').offsetHeight === 0`))

    // 存檔守衛：手上有草稿、磁碟又被別人改過 → 這次存檔要被擋下來，不可以直接蓋掉
    await cdp.eval(`(() => {
      const text = document.getElementById('wsEditorText')
      text.value = '# 我的草稿\\n'
      text.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    fs.writeFileSync(path.join(PROJECT_DIR, 'README.md'), '# 標題\n\n又被外面改了。\n')
    await cdp.eval(`document.getElementById('wsEditorSaveBtn').click()`)
    ok('[R] 存檔被擋下來並說明原因',
      await waitInPage(cdp,
        `document.getElementById('wsEditorExtBanner').offsetHeight > 0`
        + ` && document.querySelector('#wsEditorExtBanner .ws-ext-banner-msg').textContent.includes('存不進去')`, 8000))
    ok('[R] 磁碟上外部那一版沒有被蓋掉',
      fs.readFileSync(path.join(PROJECT_DIR, 'README.md'), 'utf8').includes('又被外面改了'))
    await cdp.eval(`document.getElementById('wsEditorOverwriteDiskBtn').click()`)
    ok('[R] 按「覆寫」才真的寫得進去',
      await waitDisk(() => fs.readFileSync(path.join(PROJECT_DIR, 'README.md'), 'utf8').includes('我的草稿')))

    // ===== [S] Git「全部暫存」 =====
    if (hasGit) {
      await cdp.eval(`document.querySelector('.ws-right-tab[data-panel="git"]').click()`)
      await waitInPage(cdp, `document.querySelectorAll('#wsGitFiles .ws-git-row').length > 0`, 10000)
      await cdp.eval(`document.getElementById('wsGitStageAllBtn').click()`)
      const staged = await waitInPage(cdp,
        `[...document.querySelectorAll('#wsGitFiles .ws-git-act')].some((b) => b.textContent === '取消')`, 10000)
      ok('[S] 「全部暫存」之後變更移到暫存區（列上出現「取消」）', staged)
    } else {
      console.log('SKIP  [S] 這台沒有 git')
    }

    // ===== [U] Monaco：語法高亮與並排 diff =====
    // 高亮只有「不同的 token 有不同的顏色」才算數——整片同一色代表 tokenizer 根本沒載到，
    // 而畫面上看起來跟「這個語言沒支援」一模一樣。
    await cdp.eval(`document.querySelector('.ws-right-tab[data-panel="files"]').click()`)
    await cdp.eval(`(() => {
      const row = document.querySelector('#wsTree .ws-tree-row[data-rel="src"]')
      if (row && row.getAttribute('aria-expanded') !== 'true') row.click()
    })()`)
    await waitInPage(cdp, `document.querySelector('#wsTree .ws-tree-row[data-rel="src/app.js"]')`, 8000)
    await cdp.eval(`document.querySelector('#wsTree .ws-tree-row[data-rel="src/app.js"]').click()`)
    ok('[U] Monaco 真的接手了編輯器（textarea 收起來、Monaco 有高度）',
      await waitInPage(cdp,
        `document.getElementById('wsMonacoHost').offsetHeight > 0`
        + ` && document.getElementById('wsEditorText').offsetHeight === 0`, 15000))
    const COLOURS = `(() => {
      const nodes = [...document.querySelectorAll('#wsMonacoHost span[class*="mtk"]')]
      return new Set(nodes.map((one) => getComputedStyle(one).color)).size
    })()`
    const coloured = await waitInPage(cdp, `${COLOURS} > 1`, 20000)
    ok('[U] 不同 token 真的有不同顏色（不是整片同一色）', coloured, `colours=${await cdp.eval(COLOURS)}`)

    if (hasGit) {
      fs.writeFileSync(path.join(PROJECT_DIR, 'src', 'app.js'), 'console.log(2)\nconsole.log(3)\n')
      await cdp.eval(`document.querySelector('.ws-right-tab[data-panel="git"]').click()`)
      await waitInPage(cdp, `document.querySelectorAll('#wsGitFiles .ws-git-row').length > 0`, 10000)
      await cdp.eval(`[...document.querySelectorAll('#wsGitFiles .ws-git-row .ws-git-name')]
        .find((one) => one.textContent.includes('app.js'))?.click()`)
      ok('[U] Diff 走真正的並排編輯器（兩邊各一顆，不是自繪的逐行清單）',
        await waitInPage(cdp,
          `document.querySelectorAll('#wsDiffMonaco .monaco-editor').length >= 2`
          + ` && document.getElementById('wsDiffContent').offsetHeight === 0`, 15000))
      ok('[U] Diff 真的標出了新增／刪除的行',
        await waitInPage(cdp,
          `document.querySelectorAll('#wsDiffMonaco .line-insert, #wsDiffMonaco .line-delete').length > 0`, 10000))
    } else {
      console.log('SKIP  [U] diff 需要 git')
    }

    // ===== [V] 檔案樹多選與拖曳搬檔 =====
    await cdp.eval(`document.querySelector('.ws-right-tab[data-panel="files"]').click()`)
    await waitInPage(cdp, `document.querySelector('#wsTree .ws-tree-row[data-rel="README.md"]')`, 8000)
    if (hasGit) {
      fs.writeFileSync(path.join(PROJECT_DIR, 'src', 'new-untracked.txt'), '新檔案內容\n')
      await cdp.eval(`document.getElementById('wsFilesRefreshBtn').click()`)
      const changedRow = '#wsTree .ws-tree-row[data-rel="src/app.js"]'
      const newRow = '#wsTree .ws-tree-row[data-rel="src/new-untracked.txt"]'
      const folderStatus = '#wsTree .ws-tree-row[data-rel="src"] .ws-tree-status'
      ok('[V] 檔案頁標出修改檔案',
        await waitInPage(cdp, `document.querySelector('${changedRow} .ws-tree-status')`, 8000))
      ok('[V] 檔案頁標出新增檔案',
        await waitInPage(cdp, `document.querySelector('${newRow} .ws-tree-status.is-new')`, 8000))
      const folderStatusInfo = await cdp.eval(`(() => {
        const status = document.querySelector('${folderStatus}')
        return status ? { text: status.textContent, title: status.title } : null
      })()`)
      ok('[V] 變更檔的父資料夾顯示狀態與檔名', Boolean(folderStatusInfo)
        && folderStatusInfo.text.includes('改') && folderStatusInfo.title.includes('app.js'),
      JSON.stringify(folderStatusInfo))
      await cdp.eval(`document.querySelector('${changedRow} .ws-tree-name')?.click()`)
      ok('[V] 變更檔編輯器有未提交變更按鈕',
        await waitInPage(cdp,
          `document.getElementById('wsEditorDiffBtn')?.offsetHeight > 0`
          + ` && !document.getElementById('wsEditorDiffBtn')?.hidden`, 15000))
      await cdp.eval(`document.getElementById('wsEditorDiffBtn')?.click()`)
      ok('[V] 編輯器按鈕可以開未提交 Diff',
        await waitInPage(cdp,
          `document.getElementById('wsDiffTitle')?.textContent.includes('[工作區]')`, 15000))
      await cdp.eval(`document.querySelector('.ws-right-tab[data-panel="files"]').click()`)
      await waitInPage(cdp, `document.querySelector('#wsTree .ws-tree-row[data-rel="README.md"]')`, 8000)
      await cdp.eval(`document.querySelector('.sidebar-mode[data-mode="chats"]').click()`)
      await waitInPage(cdp, `document.getElementById('chatNewBtn')?.offsetHeight > 0`, 5000)
      await cdp.eval(`document.getElementById('chatNewBtn')?.click()`)
      ok('[V] 切到聊天會自動收起工作區右欄',
        await waitInPage(cdp,
          `document.getElementById('chatMain')?.classList.contains('hidden') === false`
          + ` && document.getElementById('wsRight')?.classList.contains('hidden')`
          + ` && document.getElementById('wsRightResizer')?.classList.contains('hidden')`, 8000))
      await cdp.eval(`document.querySelector('.sidebar-mode[data-mode="projects"]').click()`)
      await waitInPage(cdp, `document.querySelector('#projList [data-id="${PROJECT_ID}"] .chat-list-open')`, 5000)
      await cdp.eval(`document.querySelector('#projList [data-id="${PROJECT_ID}"] .chat-list-open')?.click()`)
      await waitInPage(cdp, `document.querySelector('#wsTree .ws-tree-row[data-rel="README.md"]')`, 10000)
      await cdp.eval(`(() => {
        const row = document.querySelector('#wsTree .ws-tree-row[data-rel="src"]')
        if (row && row.getAttribute('aria-expanded') !== 'true') row.click()
      })()`)
      await waitInPage(cdp, `document.querySelector('${newRow} .ws-tree-status')`, 8000)
      await cdp.eval(`document.querySelector('${newRow} .ws-tree-status')?.click()`)
      ok('[V] 檔案頁的狀態標記可以開未提交 Diff',
        await waitInPage(cdp,
          `document.getElementById('wsDiffTitle')?.textContent.includes('[工作區]')`
          + ` && /\\+[1-9][0-9]*/.test(document.getElementById('wsDiffStats')?.textContent || '')`, 15000))
      await cdp.eval(`document.querySelector('.ws-right-tab[data-panel="files"]').click()`)
      await waitInPage(cdp, `document.querySelector('#wsTree .ws-tree-row[data-rel="README.md"]')`, 8000)
    }
    await cdp.eval(`document.querySelector('#wsTree .ws-tree-row[data-rel="README.md"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await cdp.eval(`document.querySelector('#wsTree .ws-tree-row[data-rel="pic.png"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))`)
    ok('[V] Ctrl 點得起來兩筆',
      await waitInPage(cdp, `document.querySelectorAll('#wsTree .ws-tree-row.is-selected').length === 2`, 5000))
    await cdp.eval(`document.querySelector('#wsTree .ws-tree-row[data-rel="pic.png"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))`)
    ok('[V] 再 Ctrl 點一次就取消那一筆',
      await waitInPage(cdp, `document.querySelectorAll('#wsTree .ws-tree-row.is-selected').length === 1`, 5000))

    // 搬檔走真的 IPC（DnD 的 DataTransfer 沒辦法用合成事件跑完整條，
    // 這裡驗的是 main 那一端與樹的重畫——擋路徑逃逸的部分在 test-workspace 的 [S]）
    const movedRes = await cdp.eval(`window.electronAPI.workspace.moveEntry(
      document.querySelector('#projList .proj-list-item.active')?.dataset.id || '', 'README.md', 'src')`)
    ok('[V] 搬檔的 IPC 回 ok', Boolean(movedRes && movedRes.ok), JSON.stringify(movedRes))
    ok('[V] 磁碟上真的搬過去了',
      fs.existsSync(path.join(PROJECT_DIR, 'src', 'README.md'))
      && !fs.existsSync(path.join(PROJECT_DIR, 'README.md')))
    const badMove = await cdp.eval(`window.electronAPI.workspace.moveEntry(
      document.querySelector('#projList .proj-list-item.active')?.dataset.id || '', 'src', 'src')`)
    ok('[V] 資料夾搬進自己底下會被 main 擋掉', Boolean(badMove && badMove.ok === false), JSON.stringify(badMove))

    // ===== [W] git worktree 面板 =====
    if (hasGit) {
      await cdp.eval(`document.querySelector('.ws-right-tab[data-panel="git"]').click()`)
      ok('[W] 工作樹那一區畫得出來（只有主工作樹時要講明白，不是留白）',
        await waitInPage(cdp,
          `document.getElementById('wsWorktrees').textContent.trim().length > 0`, 10000),
        await cdp.eval(`document.getElementById('wsWorktrees').textContent.trim()`))
      const trees = await cdp.eval(`window.electronAPI.workspace.worktreeList(
        document.querySelector('#projList .proj-list-item.active')?.dataset.id || '')`)
      ok('[W] worktreeList 認得出這是 git 儲存庫，而且列得到主工作樹',
        Boolean(trees && trees.ok && trees.data.supported && trees.data.trees.length >= 1
          && trees.data.trees[0].main === true),
        JSON.stringify(trees))
      const badTree = await cdp.eval(`window.electronAPI.workspace.worktreeRemove(
        document.querySelector('#projList .proj-list-item.active')?.dataset.id || '', 'D:/不存在的工作樹')`)
      ok('[W] 移除不在清單裡的路徑會被擋掉（列舉當白名單）',
        Boolean(badTree && badTree.ok === false), JSON.stringify(badTree))
    } else {
      console.log('SKIP  [W] 工作樹需要 git')
    }

    // ===== [X] 每個專案自己一組分頁（終端機也算） =====
    // 分頁列是終端機唯一的入口，所以切走時只能「摘掉畫面」——pty 必須還活著，
    // 切回來要原樣接上；漏掉的話那個工作階段就再也叫不出來了。
    const isolation = await cdp.eval(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      const pick = (id) => document.querySelector('#projList [data-id="' + id + '"] .chat-list-open')
      const tabIds = () => [...document.querySelectorAll('#wsTabStrip .ws-tab')].map((t) => t.dataset.id)
      document.querySelector('.sidebar-mode[data-mode="projects"]').click()
      await wait(300)

      // 專案一：開一個瀏覽器分頁（不碰檔案系統，最便宜）
      pick('${PROJECT_ID}').click()
      await wait(1500)
      document.getElementById('wsNewBtn').click()
      await wait(250)
      ;[...document.querySelectorAll('.ws-new-item')].find((b) => b.textContent === '瀏覽器').click()
      await wait(600)
      const p1Tabs = tabIds()

      // 專案二：開一個終端機分頁
      pick('${PROJECT2_ID}').click()
      await wait(1800)
      const p2Empty = tabIds()
      document.getElementById('wsNewBtn').click()
      await wait(250)
      ;[...document.querySelectorAll('.ws-new-item')].find((b) => b.textContent === '終端機').click()
      await wait(3500)
      const p2Tabs = tabIds()
      const termId = p2Tabs.find((id) => !p1Tabs.includes(id)) || ''

      // 切回專案一：專案二的終端機分頁不該出現，但工作階段要還活著
      pick('${PROJECT_ID}').click()
      await wait(2000)
      const backTo1 = tabIds()
      const aliveWhileAway = (await window.electronAPI.terminal.list()).data.some((x) => x.id === termId)

      // 再切回專案二：終端機分頁接回來，畫布也重新掛上
      pick('${PROJECT2_ID}').click()
      await wait(2500)
      const backTo2 = tabIds()
      return {
        p1Tabs, p2Empty, p2Tabs, termId, backTo1, backTo2, aliveWhileAway,
        pane: !!document.querySelector('.term-pane[data-id="' + termId + '"]')
      }
    })()`)
    ok('[X] 切到另一個專案時看不到前一個專案的分頁',
      Array.isArray(isolation.p2Empty) && isolation.p2Empty.length === 0, JSON.stringify(isolation))
    ok('[X] 終端機開在分頁列上（不在側欄）', !!isolation.termId, JSON.stringify(isolation.p2Tabs))
    ok('[X] 切走時終端機分頁跟著收起來，但工作階段還活著',
      !isolation.backTo1.includes(isolation.termId) && isolation.aliveWhileAway === true,
      JSON.stringify({ backTo1: isolation.backTo1, alive: isolation.aliveWhileAway }))
    // 只比對瀏覽器分頁：檔案分頁的還原會去讀磁碟，而 [V] 已經把 README.md 搬走了，
    // 那一顆本來就該消失（拿總數比會變成假紅燈）
    ok('[X] 切回原本的專案，分頁與畫布都接得回來',
      isolation.p1Tabs.filter((id) => id.startsWith('b:')).every((id) => isolation.backTo1.includes(id)) &&
      isolation.backTo2.includes(isolation.termId) && isolation.pane === true,
      JSON.stringify(isolation))
    if (isolation.termId) {
      await cdp.eval(`window.electronAPI.terminal.delete(${JSON.stringify(isolation.termId)})`)
    }
    // ── [Y] 審閱：跟指定分支的整體比較 ──
    const branches = await cdp.eval(
      `window.electronAPI.workspace.gitBranches(${JSON.stringify(PROJECT_ID)}).then(JSON.stringify)`
    )
    ok('[Y] 分支清單讀得到剛開的那條', String(branches).includes('e2e-base'), String(branches).slice(0, 200))

    const compared = await cdp.eval(
      `window.electronAPI.workspace.gitCompareBranch(${JSON.stringify(PROJECT_ID)}, 'e2e-base').then(JSON.stringify)`
    )
    ok('[Y] 跟那條分支比得出改過的檔案',
      String(compared).includes('src/app.js') && String(compared).includes('"ok":true'),
      String(compared).slice(0, 240))

    const badRef = await cdp.eval(
      `window.electronAPI.workspace.gitCompareBranch(${JSON.stringify(PROJECT_ID)}, '--upload-pack=x').then(JSON.stringify)`
    )
    ok('[Y] 不合法的分支名被 main 擋掉', String(badRef).includes('BAD_REF'), String(badRef))

    // 走 UI：切回有 git 的那個專案（前面的隔離測試停在第二個專案上）→
    // 選分支 → 比較 → 點第一個檔案 → 應該開出審閱分頁（沒有暫存鈕）
    await cdp.eval(`document.querySelector('#projList [data-id="${PROJECT_ID}"] .chat-list-open')?.click()`)
    await sleep(900)
    await cdp.eval(`document.querySelector('.ws-right-tab[data-panel="git"]').click()`)
    await sleep(600)
    const reviewOpened = await waitInPage(cdp, `(() => {
      const select = document.getElementById('wsReviewRef')
      if (!select || !select.options.length) return false
      select.value = 'e2e-base'
      document.getElementById('wsReviewCompareBtn').click()
      return true
    })()`)
    ok('[Y] 審閱工具列上選得到分支', reviewOpened)
    const reviewFile = await waitInPage(cdp, `!!document.querySelector('.ws-review-file')`)
    ok('[Y] 比較結果列得出檔案', reviewFile, await cdp.eval(`JSON.stringify({
      value: document.getElementById('wsReviewRef')?.value,
      options: [...(document.getElementById('wsReviewRef')?.options || [])].map((o) => o.value),
      html: document.getElementById('wsReviewFiles')?.textContent?.slice(0, 200),
      gitPanel: !document.getElementById('wsPanelGit')?.hidden
    })`))
    await cdp.eval(`document.querySelector('.ws-review-file').click()`)
    const reviewTab = await waitInPage(cdp, `(() => {
      const title = document.getElementById('wsDiffTitle')
      return !!title && title.textContent.includes('跟 e2e-base 比')
    })()`)
    ok('[Y] 審閱分頁開得起來，標題講清楚在跟誰比', reviewTab)
    ok('[Y] 審閱分頁沒有「暫存」鈕（那跟暫存區無關）',
      await cdp.eval(`document.getElementById('wsDiffStageBtn').hidden === true`))
    ok('[Y] 上一個／下一個變更兩顆鈕都在',
      await cdp.eval(`!!document.getElementById('wsDiffPrevBtn') && !!document.getElementById('wsDiffNextBtn')`))

    // 逐行意見：加一則 → 交給 AI 會把文字帶進聊天輸入框
    const commented = await cdp.eval(`(async () => {
      const mod = await import('./scripts/ws-review.js')
      mod.clearComments(${JSON.stringify(PROJECT_ID)})
      mod.addComment(${JSON.stringify(PROJECT_ID)}, {
        relPath: 'src/app.js', line: 2, snippet: 'const b = 2', text: '這一行請補註解'
      })
      const text = mod.formatComments(${JSON.stringify(PROJECT_ID)}, 'e2e-base')
      mod.sendToChat(text)
      return text
    })()`)
    ok('[Y] 意見排得出可以直接交給 AI 的文字',
      String(commented).includes('src/app.js') && String(commented).includes('這一行請補註解'),
      String(commented).slice(0, 160))
    const inComposer = await waitInPage(cdp, `(() => {
      const input = document.getElementById('chatInput')
      return !!input && input.value.includes('這一行請補註解')
    })()`)
    ok('[Y] 「交給 AI」真的把意見帶進聊天輸入框', inComposer)
    await cdp.eval(`(async () => {
      const mod = await import('./scripts/ws-review.js')
      mod.clearComments(${JSON.stringify(PROJECT_ID)})
      const input = document.getElementById('chatInput')
      if (input) input.value = ''
    })()`)

    // ── [Z] 工作樹：移除前先講清楚是什麼擋著、既有的可以直接加入 ──
    const mainTreeCheck = await cdp.eval(
      `window.electronAPI.workspace.worktreeCheck(${JSON.stringify(PROJECT_ID)}, ${JSON.stringify(PROJECT_DIR)}).then(JSON.stringify)`
    )
    ok('[Z] 主工作樹說得出「不能移除」的原因',
      String(mainTreeCheck).includes('"removable":false') && String(mainTreeCheck).includes('主工作樹'),
      String(mainTreeCheck).slice(0, 200))
    const adoptBad = await cdp.eval(
      `window.electronAPI.workspace.worktreeAdopt(${JSON.stringify(PROJECT_ID)}, 'C:/nope-not-a-worktree').then(JSON.stringify)`
    )
    ok('[Z] 加入不在清單裡的路徑會被擋（列舉當白名單）',
      String(adoptBad).includes('NOT_FOUND'), String(adoptBad))

    // ── [AA] AI 接續：session 一定要屬於這個專案 ──
    const resumeBad = await cdp.eval(
      `window.electronAPI.workspace.agentResume(${JSON.stringify(PROJECT_ID)}, 'claude', 'not-a-real-session-id').then(JSON.stringify)`
    )
    ok('[AA] 不屬於這個專案的對話接續不了',
      String(resumeBad).includes('SESSION_NOT_FOUND'), String(resumeBad))
    const resumeInjection = await cdp.eval(
      `window.electronAPI.workspace.agentResume(${JSON.stringify(PROJECT_ID)}, 'claude', 'a; rm -rf /').then(JSON.stringify)`
    )
    ok('[AA] session id 的注入寫法照樣被擋',
      String(resumeInjection).includes('BAD_SESSION'), String(resumeInjection))

    // ── [AB] 資料夾監看：別人改了檔案，renderer 收得到通知 ──
    const watchStarted = await cdp.eval(`(async () => {
      window.__wsChanged = []
      window.electronAPI.workspace.onChanged((payload) => window.__wsChanged.push(payload))
      const res = await window.electronAPI.workspace.watch(${JSON.stringify(PROJECT_ID)})
      return JSON.stringify(res)
    })()`)
    ok('[AB] 監看掛得起來', String(watchStarted).includes('"watching":true'), String(watchStarted))
    fs.writeFileSync(path.join(PROJECT_DIR, 'watched.txt'), '外面改的\n')
    const gotChange = await waitInPage(cdp, `(() => {
      const rows = window.__wsChanged || []
      return rows.some((row) => (row.paths || []).some((one) => one.includes('watched.txt')))
    })()`, 10000)
    ok('[AB] 外面新增檔案時 renderer 收得到通知', gotChange,
      await cdp.eval(`JSON.stringify(window.__wsChanged || [])`))
    ok('[AB] 通知也說了「Git 狀態可能變了」',
      await cdp.eval(`(window.__wsChanged || []).some((row) => row.git === true)`))

    // ── [AC] 對話歸屬：可選欄位，缺值＝未分類 ──
    const owned = await cdp.eval(`(async () => {
      const made = await window.electronAPI.chat.create(${JSON.stringify(PROJECT_ID)})
      const listed = await window.electronAPI.chat.list()
      const mine = listed.find((one) => one.id === made.id)
      await window.electronAPI.chat.setProject(made.id, '')
      const after = (await window.electronAPI.chat.list()).find((one) => one.id === made.id)
      await window.electronAPI.chat.delete(made.id)
      return JSON.stringify({ created: mine?.projectId, cleared: after?.projectId })
    })()`)
    ok('[AC] 在專案裡開的新對話掛在那個專案底下',
      String(owned).includes(`"created":"${PROJECT_ID}"`), String(owned))
    ok('[AC] 取消歸屬之後變成未分類', String(owned).includes('"cleared":""'), String(owned))

    // ── [AD] 選取的內容帶進聊天 ──
    const toChat = await cdp.eval(`(async () => {
      const mod = await import('./scripts/ws-review.js')
      mod.sendToChat('\`src/app.js:2\`')
      await new Promise((r) => setTimeout(r, 200))
      const input = document.getElementById('chatInput')
      const value = input ? input.value : ''
      if (input) input.value = ''
      return value
    })()`)
    ok('[AD] 帶進聊天的內容有標出是哪個檔案的哪一行',
      String(toChat).includes('src/app.js:2'), String(toChat))

  } finally {
    cdp?.close()
    stopTestApp(child)
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); break } catch { await sleep(600) }
    }
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(PROJECT_DIR, { recursive: true, force: true }); break } catch { await sleep(600) }
    }
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(DROP_DIR, { recursive: true, force: true }); break } catch { await sleep(600) }
    }
    for (let i = 0; i < 5; i += 1) {
      try { fs.rmSync(OUTSIDE_DIR, { recursive: true, force: true }); break } catch { await sleep(600) }
    }
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(PROJECT2_DIR, { recursive: true, force: true }); break } catch { await sleep(600) }
    }
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => { console.error(err); process.exit(1) })
