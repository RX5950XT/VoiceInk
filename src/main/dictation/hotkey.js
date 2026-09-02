/**
 * VoiceInk - 語音輸入的全域熱鍵（右 Alt）
 *
 * `uiohook-napi` 是低階鍵盤 hook：它看得到所有按鍵，所以這裡只做一件事——
 * 認出右 Alt 與 Esc，其餘一律不看、不記、不送出去。
 *
 * 為什麼不是 `globalShortcut`：Electron 的 accelerator 認不出「單獨一顆修飾鍵」，
 * 更分不出左右 Alt。實測 `npx electron scripts/probe-uiohook.js`：
 * 右 Alt = 3640、左 Alt = 56，兩者分得開。
 *
 * 狀態機（`createMachine`）是純函式，可 node 直測：
 *   - 按下就開始錄（不等長短，開頭才不會丟字）
 *   - 放開時按住 ≥ longPressMs → 停（push-to-talk）
 *   - 放開時按住 < longPressMs → 繼續錄（短按＝切換），再按一次才停
 *   - 錄音中按 Esc → 取消
 */

/** 右 Alt（UiohookKey.AltRight）。左 Alt 是 56，刻意不理。 */
const RIGHT_ALT = 3640
/** Esc（UiohookKey.Escape） */
const ESCAPE = 1
/**
 * 按下右 Alt 之後補送的「無害鍵」（UiohookKey.F24）。
 *
 * 低階 hook 只能監聽、攔不下按鍵，所以右 Alt 還是會送到使用者當下的程式：
 * Windows 看到「Alt 按下又放開、中間沒有別的鍵」就會去啟動選單列——瀏覽器因此
 * 把焦點跳到上面的工具列（使用者回報的症狀）。補一顆沒有人綁的鍵，那個組合就
 * 不再是「單獨一顆 Alt」，選單也就不會被叫出來。
 * ponytail: 這是繞過去不是擋下來，真要攔掉得自己寫一顆 WH_KEYBOARD_LL 原生模組。
 */
const NEUTRALIZER = 107
/** 按住多久算「講完就放開」而不是「點一下切換」 */
const LONG_PRESS_MS = 400

/**
 * @param {{ longPressMs?: number }} [opts]
 */
function createMachine(opts = {}) {
  const longPressMs = Number.isFinite(opts.longPressMs) ? Number(opts.longPressMs) : LONG_PRESS_MS
  let recording = false
  /** 這一次按下時是不是「還沒在錄」——決定放開時要不要停 */
  let startedByThisPress = false
  let pressed = false
  let pressedAt = 0

  return {
    /**
     * @param {number} now
     * @returns {'start' | null}
     */
    down(now) {
      if (pressed) return null // 按住時作業系統會一直重送 keydown
      pressed = true
      pressedAt = now
      if (recording) {
        startedByThisPress = false
        return null
      }
      recording = true
      startedByThisPress = true
      return 'start'
    },
    /**
     * @param {number} now
     * @returns {'stop' | null}
     */
    up(now) {
      if (!pressed) return null
      pressed = false
      if (!recording) return null
      const held = now - pressedAt
      // 這次按下時已經在錄（第二次點）→ 放開就停，不管按多久
      if (!startedByThisPress) {
        recording = false
        return 'stop'
      }
      if (held >= longPressMs) {
        recording = false
        return 'stop'
      }
      return null // 短按：留在錄音狀態，等下一次按
    },
    /**
     * @returns {'cancel' | null}
     */
    escape() {
      if (!recording) return null
      recording = false
      pressed = false
      startedByThisPress = false
      return 'cancel'
    },
    isRecording() {
      return recording
    },
    reset() {
      recording = false
      pressed = false
      startedByThisPress = false
    }
  }
}

/** @type {{ mode: 'native'|'uiohook', machine: ReturnType<typeof createMachine>,
 *            uIOhook?: any, handlers?: object, stopNative?: () => void } | null} */
let active = null

/**
 * 讓這一次的右 Alt 不再是「單獨一顆 Alt」，前景程式就不會把選單列叫出來。
 * 失敗不影響錄音——只是那個副作用還在。
 * @param {{ keyTap?: (key: number) => void }} uIOhook
 */
function neutralizeAlt(uIOhook) {
  try {
    uIOhook.keyTap?.(NEUTRALIZER)
  } catch (err) {
    console.error('[dictation] 中和右 Alt 失敗:', err?.message || err)
  }
}

/**
 * 開始監聽。重複呼叫是 no-op。
 *
 * 兩條路徑，優先用第一條：
 *   1. **原生 sidecar**（`hook.js` → `VoiceInkHook.exe`）：真的把熱鍵吞掉，前景程式收不到。
 *   2. **uiohook 退路**：只監聽、攔不下來，所以要補送 F24 中和「單獨一顆 Alt」。
 *      sidecar 沒建置（乾淨 clone 沒跑 `npm run build:hook`）或起不來時才走這條。
 *
 * @param {{ onAction: (action: 'start'|'stop'|'cancel') => void, longPressMs?: number,
 *           load?: () => { uIOhook: object }, native?: boolean,
 *           startHook?: (deps: object) => Promise<{ ok: boolean, stop?: () => void }> }} deps
 * @returns {Promise<{ ok: boolean, mode?: 'native'|'uiohook', error?: string }>}
 */
async function start(deps) {
  if (active) return { ok: true, mode: active.mode }
  const onAction = typeof deps?.onAction === 'function' ? deps.onAction : () => {}

  if (deps?.native !== false) {
    const machine = createMachine({ longPressMs: deps?.longPressMs })
    const fire = (action) => {
      if (!action) return
      try {
        onAction(action)
      } catch (err) {
        console.error('[dictation] 熱鍵處理失敗:', err?.message || err)
      }
    }
    const startHook = deps?.startHook || require('./hook').startHook
    const res = await startHook({
      onEvent: (kind) => {
        if (kind === 'down') fire(machine.down(Date.now()))
        else if (kind === 'up') fire(machine.up(Date.now()))
        else if (kind === 'escape') fire(machine.escape())
      }
    })
    if (res?.ok) {
      active = { mode: 'native', machine, stopNative: res.stop }
      return { ok: true, mode: 'native' }
    }
    console.warn('[dictation] 原生熱鍵不可用，退回監聽模式:', res?.error || 'UNKNOWN')
  }

  let uIOhook
  try {
    ;({ uIOhook } = (deps?.load || (() => require('uiohook-napi')))())
  } catch (err) {
    // 沒有這顆原生模組時整個功能關掉，其他分頁照常用
    console.error('[dictation] 載入鍵盤 hook 失敗:', err?.message || err)
    return { ok: false, error: 'HOOK_UNAVAILABLE' }
  }

  const machine = createMachine({ longPressMs: deps?.longPressMs })
  const fire = (action) => {
    if (!action) return
    try {
      onAction(action)
    } catch (err) {
      console.error('[dictation] 熱鍵處理失敗:', err?.message || err)
    }
  }
  // 按住時 Windows 會一直重送 keydown，每一次都補一顆等於灌一串按鍵給前景程式；
  // 一次按放只補一次就夠了（狀態機也有自己的 pressed，但那管的是錄音、不是注入）
  let altDown = false
  const handlers = {
    keydown: (e) => {
      if (e?.keycode === RIGHT_ALT) {
        if (!altDown) {
          altDown = true
          neutralizeAlt(uIOhook)
        }
        fire(machine.down(Date.now()))
      } else if (e?.keycode === ESCAPE) fire(machine.escape())
    },
    keyup: (e) => {
      if (e?.keycode === RIGHT_ALT) {
        altDown = false
        fire(machine.up(Date.now()))
      }
    }
  }

  uIOhook.on('keydown', handlers.keydown)
  uIOhook.on('keyup', handlers.keyup)
  try {
    uIOhook.start()
  } catch (err) {
    uIOhook.off?.('keydown', handlers.keydown)
    uIOhook.off?.('keyup', handlers.keyup)
    console.error('[dictation] 啟動鍵盤 hook 失敗:', err?.message || err)
    return { ok: false, error: 'HOOK_START_FAILED' }
  }
  active = { mode: 'uiohook', uIOhook, machine, handlers }
  return { ok: true, mode: 'uiohook' }
}

/**
 * 停止監聽並拔掉 listener（`uIOhook` 是模組單例，不拔會在重新啟用時疊起來）
 */
function stop() {
  if (!active) return
  const { uIOhook, handlers, stopNative } = active
  active = null
  if (stopNative) {
    stopNative()
    return
  }
  try {
    uIOhook.off?.('keydown', handlers.keydown)
    uIOhook.off?.('keyup', handlers.keyup)
    uIOhook.stop()
  } catch (err) {
    console.error('[dictation] 停止鍵盤 hook 失敗:', err?.message || err)
  }
}

/**
 * @returns {boolean}
 */
function isRunning() {
  return !!active
}

/** 錄音狀態（給 UI 顯示用；沒啟用時一律 false） */
function isRecording() {
  return !!active?.machine.isRecording()
}

/** 外部（例如錄音失敗）把狀態機拉回未錄音 */
function reset() {
  active?.machine.reset()
}

/** 目前走的是哪一條路徑：`native`＝真的把鍵吞掉，`uiohook`＝只監聽 */
function currentMode() {
  return active?.mode || ''
}

module.exports = {
  createMachine,
  currentMode,
  start,
  stop,
  isRunning,
  isRecording,
  reset,
  RIGHT_ALT,
  ESCAPE,
  NEUTRALIZER,
  LONG_PRESS_MS
}
