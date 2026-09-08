/**
 * 取代 `window.confirm` / `window.prompt` / `window.alert` 的應用內彈窗。
 *
 * 原生那三支有三個問題：樣式跟 Aurora 完全不搭、會把整個 renderer 卡住
 * （動畫、串流、終端機輸出全停），而且在 frameless 視窗上長得像另一個 App。
 * 這裡沿用既有 `<dialog class="app-dialog">` 那一套（`.dialog-head` /
 * `.dialog-actions`），只是改成動態建、用完就丟。
 *
 * 全程 `createElement` + `textContent`，**零 innerHTML**（訊息裡會帶檔名、
 * 分支名、上游錯誤字串，那些都是外部輸入）。
 */

const OK = 'ok'

/**
 * 共用外殼：建 dialog、`showModal()`、關掉時 resolve 並把節點收掉。
 * Esc 與點「取消」都走 `close()` 的空 returnValue。
 *
 * @param {{ title: string, desc?: string, confirmText: string, cancelText?: string, danger?: boolean }} opts
 * @param {(body: HTMLElement) => void} [fillBody] 需要輸入欄位時用來塞內容
 * @returns {{ dialog: HTMLDialogElement, done: Promise<boolean> }}
 */
function openDialog(opts, fillBody) {
  const dialog = document.createElement('dialog')
  dialog.className = 'app-dialog app-dialog-compact'
  dialog.setAttribute('aria-label', opts.title)

  const head = document.createElement('div')
  head.className = 'dialog-head'
  const title = document.createElement('h2')
  title.className = 'dialog-title'
  title.textContent = opts.title
  head.appendChild(title)
  if (opts.desc) {
    const desc = document.createElement('p')
    // 訊息常常是多行的（刪除清單、git 的原因），交給 CSS 的 pre-line 斷行
    desc.className = 'dialog-desc dialog-desc-multiline'
    desc.textContent = opts.desc
    head.appendChild(desc)
  }
  dialog.appendChild(head)

  if (fillBody) {
    const body = document.createElement('div')
    body.className = 'simple-dialog-body'
    fillBody(body)
    dialog.appendChild(body)
  }

  const actions = document.createElement('div')
  actions.className = 'dialog-actions'
  if (opts.cancelText) {
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'btn btn-secondary btn-sm'
    cancel.textContent = opts.cancelText
    cancel.addEventListener('click', () => dialog.close(''))
    actions.appendChild(cancel)
  }
  const ok = document.createElement('button')
  ok.type = 'button'
  ok.className = `btn ${opts.danger ? 'btn-danger' : 'btn-primary'} btn-sm`
  ok.textContent = opts.confirmText
  ok.addEventListener('click', () => dialog.close(OK))
  actions.appendChild(ok)
  dialog.appendChild(actions)

  document.body.appendChild(dialog)
  const done = new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      const confirmed = dialog.returnValue === OK
      dialog.remove()
      resolve(confirmed)
    }, { once: true })
  })
  dialog.showModal()
  // 危險操作預設把焦點放在「取消」：連按 Enter 不該把東西刪掉
  const first = opts.danger ? actions.querySelector('.btn-secondary') : ok
  first?.focus()
  return { dialog, done }
}

/**
 * 二次確認。
 *
 * @param {string} title 一句話問完（例如「刪除這個檔案？」）
 * @param {{ desc?: string, confirmText?: string, danger?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export function askConfirm(title, opts = {}) {
  return openDialog({
    title,
    desc: opts.desc,
    confirmText: opts.confirmText || '確定',
    cancelText: '取消',
    danger: opts.danger === true
  }).done
}

/**
 * 單行輸入。取消回 `null`（跟 `window.prompt` 同一套約定，呼叫端不用改判斷）。
 *
 * @param {string} title
 * @param {{ desc?: string, value?: string, placeholder?: string, confirmText?: string }} [opts]
 * @returns {Promise<string | null>}
 */
export async function askInput(title, opts = {}) {
  let input
  const { dialog, done } = openDialog(
    { title, desc: opts.desc, confirmText: opts.confirmText || '確定', cancelText: '取消' },
    (body) => {
      const group = document.createElement('div')
      group.className = 'setting-group'
      input = document.createElement('input')
      input.type = 'text'
      input.className = 'input'
      input.value = opts.value || ''
      input.placeholder = opts.placeholder || ''
      input.setAttribute('aria-label', title)
      input.spellcheck = false
      // Enter 直接送出：這是單行輸入，多按一次滑鼠沒有意義
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          dialog.close(OK)
        }
      })
      group.appendChild(input)
      body.appendChild(group)
    }
  )
  input.focus()
  input.select()
  return (await done) ? input.value : null
}

/**
 * 只是告知，一顆按鈕。
 *
 * @param {string} title
 * @param {{ desc?: string, confirmText?: string }} [opts]
 * @returns {Promise<void>}
 */
export async function showAlert(title, opts = {}) {
  await openDialog({ title, desc: opts.desc, confirmText: opts.confirmText || '知道了' }).done
}
