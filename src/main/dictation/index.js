/**
 * VoiceInk - 語音輸入服務（Main Process）
 *
 * 一條管線：右 Alt → renderer 錄音 → ASR → 個人字典 → LLM 整理 → 插入游標處 → 存紀錄。
 *
 * 分工的理由：
 *   - 錄音留在 renderer（既有的 16k PCM 路徑已經在那裡，而且視窗藏起來時也照樣跑）
 *   - 其餘全部在 main：ASR 模型、供應商金鑰、剪貼簿與模擬按鍵都不該讓 renderer 碰
 *
 * 失敗策略：LLM 整理是加分項，掛掉就退回「套過字典的 ASR 原文」照樣插入。
 * 使用者講的話不能因為清理模型連不上就整段消失。
 */

const hotkey = require('./hotkey')
const insert = require('./insert')
const store = require('./store')
const text = require('./text')
const modelScope = require('../model-scope')

/** 雲端整理的逾時（口述通常 1～3 秒回來，這只是防它卡住） */
const CLOUD_TIMEOUT_MS = 20000
/** 長錄音（幾千字）的整理逾時 */
const CLOUD_TIMEOUT_LONG_MS = 120000
/**
 * 送進整理模型的字數上限（超過就不整理，直接用原文）。
 * 雲端 20 分鐘的口述也吃得下；本地那顆的上限是「切完幾段」而不是「一段多長」，
 * 見 `LOCAL_CHUNK_CHARS`。
 */
const MAX_CLEANUP_CHARS_LOCAL = 6000
const MAX_CLEANUP_CHARS_CLOUD = 12000
/**
 * 本地整理一次送多少字。**那顆的 context 只有 2048 token**，system prompt 加上
 * 字典就先吃掉一半，輸入與輸出還要一起放進去——整段送過去會被無聲截掉後半段
 * （症狀是「講的話少了一截」，而且沒有任何錯誤訊息）。
 */
const LOCAL_CHUNK_CHARS = 500
/** 本地一次最多切幾段（再多就是使用者講了 20 分鐘，逐段跑會等太久） */
const LOCAL_MAX_CHUNKS = 12

const LANG_VALUES = new Set(Object.keys(text.LANG_NAMES))

/** @type {{ get: (k: string, d?: unknown) => unknown } | null} */
let storeRef = null
/** @type {((payload: object) => void) | null} */
let emit = null
/** @type {((req: object) => Promise<string>) | null} */
let transcribeFn = null
/**
 * 插入文字的實作。測試一定要換掉：真的送 Ctrl+V 會貼進當下的前景視窗
 * （跑測試時那多半是使用者自己的編輯器）。
 * @type {((text: string) => Promise<{ ok: boolean, error?: string }>) | null}
 */
let insertFn = null
/** 一次只跑一條管線：講話期間再按一次不該疊第二條 */
let busy = false
/** 熱鍵掛不上時等多久再試一次 */
const HOOK_RETRY_MS = 5000
/** @type {NodeJS.Timeout | null} */
let retryTimer = null

/**
 * @param {object} s
 */
function setStore(s) {
  storeRef = /** @type {{ get: (k: string, d?: unknown) => unknown }} */ (s)
}

/**
 * @param {{ emit?: (payload: object) => void, transcribe?: (req: object) => Promise<string> }} deps
 */
function configure(deps = {}) {
  if (typeof deps.emit === 'function') emit = deps.emit
  if (typeof deps.transcribe === 'function') transcribeFn = deps.transcribe
  if (typeof deps.insert === 'function') insertFn = deps.insert
}

function send(type, data) {
  if (emit) emit({ type, data: data || {} })
}

/**
 * @returns {string}
 */
function currentLang() {
  const raw = String(storeRef?.get('dictationLang', 'zh-TW') || 'zh-TW')
  return LANG_VALUES.has(raw) ? raw : 'zh-TW'
}

/**
 * 整理用的模型（`dictationLlm`）。解析與另外兩頁共用 `model-scope`，
 * 不在這裡再寫一份 `local:`／`cloud:` 的字串拆解。
 * @returns {ReturnType<typeof modelScope.readLlm>}
 */
function currentCleaner() {
  return modelScope.readLlm(storeRef, 'dictation')
}

/**
 * 熱鍵事件轉給 renderer（真正的錄音在那一側）
 * @param {'start'|'stop'|'cancel'} action
 */
function onHotkey(action) {
  if (action === 'start' && busy) {
    // 上一段還在轉錄／整理：不接新的，也不要讓狀態機以為正在錄
    hotkey.reset()
    send('busy', {})
    return
  }
  send(action, {})
}

/**
 * 依設定啟用或停用全域熱鍵。
 * @returns {{ ok: boolean, enabled: boolean, error?: string }}
 */
async function refresh() {
  const enabled = storeRef?.get('dictationEnabled', false) === true
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  if (!enabled) {
    hotkey.stop()
    return { ok: true, enabled: false }
  }
  const r = await hotkey.start({ onAction: onHotkey })
  if (!r.ok) {
    // 開機自啟動時 hook 偶爾會搶不到（登入那幾秒系統還在忙）。失敗就靜靜地再試一次——
    // 沒有這一條的話使用者要自己去設定頁把開關關掉再打開才會好
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (storeRef?.get('dictationEnabled', false) === true) {
        hotkey.start({ onAction: onHotkey })
          .then((again) => {
            if (!again.ok) console.error('[dictation] 熱鍵重試仍失敗:', again.error)
          })
          .catch((err) => console.error('[dictation] 熱鍵重試失敗:', err?.message || err))
      }
    }, HOOK_RETRY_MS)
    if (retryTimer.unref) retryTimer.unref()
    return { ok: false, enabled: false, error: r.error }
  }
  return { ok: true, enabled: true, mode: r.mode }
}

/**
 * @returns {{ enabled: boolean, listening: boolean, recording: boolean, busy: boolean,
 *             lang: string, cleaner: object }}
 */
function status() {
  return {
    enabled: storeRef?.get('dictationEnabled', false) === true,
    listening: hotkey.isRunning(),
    // `native`＝原生 sidecar 真的把熱鍵吞掉；`uiohook`＝只監聽（前景程式還是收得到那顆鍵）
    mode: hotkey.currentMode(),
    recording: hotkey.isRecording(),
    busy,
    lang: currentLang(),
    cleaner: currentCleaner()
  }
}

/**
 * 雲端整理：OpenAI 相容 `/chat/completions`，非串流。
 * 錯誤只留狀態碼——body 由使用者自填的端點決定內容，不能進 UI 或 log。
 * @param {{ apiUrl: string, apiKey: string, modelId: string }} cfg
 * @param {string} system
 * @param {string} content
 * @returns {Promise<string>}
 */
async function cleanupCloud(cfg, system, content) {
  let res
  try {
    res = await fetch(`${cfg.apiUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: cfg.modelId,
        temperature: 0,
        // 整理後長度跟原文差不多。寫死 1200 的話，長錄音會被切掉後半段
        // （20 分鐘的口述有好幾千字）
        max_tokens: Math.min(16000, Math.max(1200, content.length * 2)),
        // 整理不需要思考內容。`exclude` 而不是 `enabled: false`——後者對強制思考的
        // 模型會回 400（跟雲端翻譯同一個坑，見 local-llm.translateCloud）
        reasoning: { exclude: true },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content }
        ]
      }),
      // 長錄音整理本來就要跑比較久，用固定 20 秒會把它砍在半路
      signal: AbortSignal.timeout(content.length > 2000 ? CLOUD_TIMEOUT_LONG_MS : CLOUD_TIMEOUT_MS)
    })
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error('整理逾時')
    }
    throw new Error('整理服務連線失敗')
  }
  const body = await res.text()
  if (!res.ok) {
    console.error(`[dictation] 整理 API error: HTTP ${res.status}`)
    throw new Error(`整理 API 錯誤: ${res.status}`)
  }
  let data = null
  try {
    data = body ? JSON.parse(body) : null
  } catch {
    console.error('[dictation] 整理 API 回應無法解析')
    throw new Error('整理 API 回傳無法解析的內容')
  }
  return String(data?.choices?.[0]?.message?.content || '')
}

/**
 * 本地整理：先切成 context 吃得下的段，逐段跑，再接回去。
 *
 * `promptOnce` 的 `maxTokens` 預設只有 640——那是給翻譯短句用的，口述整段丟過去
 * 會在中途被切斷。這裡按這一段的字數給額度（中文 1 字約 1 token，再留一點餘裕）。
 *
 * 單段整理失敗（模型輸出怪怪的）就用那一段的原文，不讓整段話消失。
 *
 * @param {string} content 已套過字典的文字
 * @param {string} system
 * @param {string} modelKey
 * @returns {Promise<string>}
 */
async function cleanupLocalChunked(content, system, modelKey) {
  const localLlm = require('../local-llm')
  // ponytail: 重寫模式下每一段各自重組，跨段的合併與搬移做不到（本地那顆 context 就 2048）。
  // 想要整篇一起重組就得挑雲端模型，或換一顆 context 更大的本地模型。
  const chunks = text.splitForCleanup(content, LOCAL_CHUNK_CHARS).slice(0, LOCAL_MAX_CHUNKS)
  if (!chunks.length) return content
  /** @type {string[]} */
  const parts = []
  for (const chunk of chunks) {
    const out = await localLlm.promptOnce({
      text: chunk,
      system,
      modelKey,
      maxTokens: Math.min(1024, Math.max(160, Math.ceil(chunk.length * 1.4)))
    })
    const cleaned = text.cleanupOutput(out, chunk)
    parts.push(text.looksReasonable(cleaned, chunk) ? cleaned : chunk)
  }
  return text.joinSegments(parts)
}

/**
 * 套字典 → LLM 整理 → 學新詞。
 * @param {string} raw ASR 原文
 * @returns {Promise<{ text: string, cleaned: boolean, warning?: string }>}
 */
async function cleanup(raw) {
  const dictionary = await store.listDictionary()
  const active = text.activeEntries(dictionary)
  const dictApplied = text.applyDictionary(raw, active)
  const cleaner = currentCleaner()
  if (cleaner.mode === 'off' || !dictApplied.trim()) {
    // 使用者本來有選整理模型、只是那組供應商被刪掉了 → 要講一句，不能無聲退回
    return {
      text: dictApplied,
      cleaned: false,
      warning: cleaner.stale ? '整理模型已不在清單裡，這次只套了個人字典' : ''
    }
  }
  const limit = cleaner.mode === 'local' ? MAX_CLEANUP_CHARS_LOCAL : MAX_CLEANUP_CHARS_CLOUD
  if (dictApplied.length > limit) {
    return { text: dictApplied, cleaned: false, warning: '這段太長，略過整理' }
  }

  // 長篇改用重寫模式（重新組織、分段），短句維持保守整理。
  // 本地那條是切段逐段跑的，模式要在**切段之前**用整段長度決定，不然每一段都被當成短句。
  const mode = text.cleanupMode(dictApplied)
  const system = text.buildSystemPrompt({
    lang: currentLang(),
    dictionary,
    mode,
    text: dictApplied
  })
  try {
    let finalText = ''
    if (cleaner.mode === 'local') {
      finalText = await cleanupLocalChunked(dictApplied, system, cleaner.modelKey)
    } else {
      // readLlm 已對「目前真的存在」的供應商與模型驗過，這裡只需檢查有沒有填金鑰
      if (!cleaner.apiUrl || !cleaner.apiKey) throw new Error('整理用的雲端供應商還沒設好')
      const out = await cleanupCloud(
        { apiUrl: cleaner.apiUrl, apiKey: cleaner.apiKey, modelId: cleaner.modelId },
        system,
        dictApplied
      )
      finalText = text.cleanupOutput(out, dictApplied)
    }
    // 模型回答了問題、加了前言或整段複誦時，長度會明顯偏離原文 → 當作沒整理過
    if (!text.looksReasonable(finalText, dictApplied)) {
      return { text: dictApplied, cleaned: false, warning: '整理結果看起來不像原本那段話，已使用原文' }
    }
    // 學詞用「套字典後 → 整理後」比對：已經在字典裡的詞不會被重複學一次。
    // 現有字典要一起傳進去，才擋得掉反向對與接力對（見 text.learnPairs）
    if (finalText && finalText !== dictApplied) {
      await store.learn(text.learnPairs(dictApplied, finalText, dictionary))
    }
    // 字典是使用者的權威用詞，整理模型不是：它把換好的詞又改回去（小模型很常這樣）的話，
    // 出來再蓋一次。學詞在這之前做，才看得到模型真正的意見（反向證據要拿來扣分）。
    return { text: text.applyDictionary(finalText, active), cleaned: true }
  } catch (err) {
    // 整理失敗照樣把原文交出去：使用者講的話不能因為清理模型連不上就消失
    console.error('[dictation] 整理失敗:', err?.message || err)
    return { text: dictApplied, cleaned: false, warning: err?.message || '整理失敗，已使用原文' }
  }
}

/**
 * 錄音結束後的完整流程。
 * @param {{ samples: unknown, sampleRate?: number, durationMs?: number }} req
 * @returns {Promise<{ ok: boolean, raw?: string, text?: string, inserted?: boolean,
 *                     warning?: string, error?: string }>}
 */
async function submit(req) {
  if (busy) return { ok: false, error: '上一段還在處理中' }
  busy = true
  send('processing', {})
  try {
    if (!transcribeFn) return { ok: false, error: '語音轉文字尚未就緒' }
    const lang = currentLang()
    const sampleRate = Number(req?.sampleRate) || 16000
    // 長錄音一定要切開再逐段送：本地 sherpa 的硬上限是 30 秒，整段丟過去只會拿到
    // 「音訊過長」而不是文字（20 分鐘的錄音就是這樣整段消失的）
    const segments = text.splitSamples(
      /** @type {Float32Array} */ (req?.samples),
      sampleRate
    )
    /** @type {string[]} */
    const parts = []
    for (let i = 0; i < segments.length; i++) {
      if (segments.length > 1) send('processing', { part: i + 1, total: segments.length })
      parts.push(String(await transcribeFn({ samples: segments[i], sampleRate, lang }) || ''))
    }
    const raw = text.joinSegments(parts).trim()
    if (!raw) return { ok: false, error: '沒有聽到內容' }

    send('transcribed', { raw })
    const result = await cleanup(raw)
    const finalText = result.text.trim()
    if (!finalText) return { ok: false, error: '整理後是空的' }

    const pasted = await (insertFn ? insertFn(finalText) : insert.insertText(finalText))
    const record = await store.addRecord({
      raw,
      text: finalText,
      durationMs: Number(req?.durationMs) || 0,
      asr: modelScope.readAsr(storeRef, 'dictation').engine === 'cloud' ? '雲端' : '本地',
      llm: result.cleaned ? '已整理' : '未整理',
      inserted: pasted.ok
    })
    send('done', { record, inserted: pasted.ok })
    return {
      ok: true,
      raw,
      text: finalText,
      inserted: pasted.ok,
      warning: result.warning || (pasted.ok ? '' : '文字已複製到剪貼簿，但自動貼上失敗')
    }
  } catch (err) {
    console.error('[dictation] 處理失敗:', err?.message || err)
    return { ok: false, error: err?.message || '語音輸入失敗' }
  } finally {
    busy = false
    hotkey.reset()
    send('idle', {})
  }
}

/** 結束前把 hook 收掉（低階鍵盤 hook 留著不放會擋住程序退出） */
function shutdown() {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  hotkey.stop()
}

module.exports = {
  setStore,
  configure,
  refresh,
  status,
  submit,
  cleanup,
  shutdown,
  listRecords: store.listRecords,
  removeRecord: store.removeRecord,
  clearRecords: store.clearRecords,
  listDictionary: store.listDictionary,
  upsertDictionary: store.upsertDictionary,
  removeDictionary: store.removeDictionary
}
