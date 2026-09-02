/**
 * VoiceInk - 語音輸入桌面指示器（Renderer）
 *
 * 只做兩件事：把 main 送來的狀態畫成波形／訊息，以及把 ✕ ✓ 轉成一則 IPC。
 * 這裡沒有麥克風、沒有模型、沒有金鑰——錄音在主視窗，其餘都在 main。
 */

const BAR_COUNT = 17
/** 音量歷史：新的從右邊進來，整排往左推，看起來就是「正在講」 */
const history = new Array(BAR_COUNT).fill(0)

const pill = document.getElementById('pill')
const wave = document.getElementById('hudWave')
const msg = document.getElementById('hudMsg')

/** @type {HTMLElement[]} */
const bars = []
for (let i = 0; i < BAR_COUNT; i++) {
  const bar = document.createElement('span')
  wave.appendChild(bar)
  bars.push(bar)
}

/**
 * 兩端壓低、中間放大的包絡。沒有它整排等高，看起來像進度條而不是波形。
 * @param {number} i
 * @returns {number}
 */
function envelope(i) {
  const t = (i / (BAR_COUNT - 1)) * 2 - 1 // -1…1
  return 0.35 + 0.65 * Math.cos((t * Math.PI) / 2) ** 2
}

/**
 * 峰值 → 條高。人耳是對數的，線性映射會讓正常說話只動一點點。
 * @param {number} level 0…1
 * @returns {number}
 */
function toHeight(level) {
  const shaped = Math.sqrt(Math.min(1, Math.max(0, level)))
  return 3 + shaped * 23
}

function paint() {
  for (let i = 0; i < BAR_COUNT; i++) {
    bars[i].style.height = `${Math.round(3 + (toHeight(history[i]) - 3) * envelope(i))}px`
  }
}

function reset() {
  history.fill(0)
  paint()
}

/**
 * @param {{ state?: string, level?: number, message?: string }} payload
 */
function render(payload) {
  const state = payload?.state || 'idle'
  pill.classList.toggle('is-processing', state === 'processing')
  pill.classList.toggle('is-error', state === 'error')
  pill.classList.add('is-shown')

  if (state === 'recording') {
    history.shift()
    history.push(Number(payload?.level) || 0)
    paint()
  } else if (state === 'error') {
    msg.textContent = payload?.message || '語音輸入失敗'
    msg.title = msg.textContent
    reset()
  } else {
    // 處理中：交給 CSS 的脈動，行內高度會蓋掉 keyframes，要清掉
    for (const bar of bars) bar.style.height = ''
  }
}

/** @param {'cancel'|'stop'} action */
function fire(action) {
  window.electronAPI?.dictation?.hudAction(action)
}

document.getElementById('hudCancel').addEventListener('click', () => fire('cancel'))
document.getElementById('hudStop').addEventListener('click', () => fire('stop'))

window.electronAPI?.dictation?.onHud(render)
reset()

// 測試用：CDP 可以直接驅動畫面，不必真的錄音
window.__hudRender = render
