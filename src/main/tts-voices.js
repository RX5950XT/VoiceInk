/**
 * Edge TTS 精選語音（allowlist）
 * main / IPC 唯一真相來源；renderer 透過 tts:listVoices 取得
 */

/** @type {Record<string, { id: string, label: string }[]>} */
const VOICES_BY_LANG = {
  'zh-TW': [
    { id: 'zh-TW-HsiaoChenNeural', label: '曉臻（女）' },
    { id: 'zh-TW-YunJheNeural', label: '雲哲（男）' },
    { id: 'zh-TW-HsiaoYuNeural', label: '曉雨（女）' }
  ],
  'zh-CN': [
    { id: 'zh-CN-XiaoxiaoNeural', label: '曉曉（女）' },
    { id: 'zh-CN-YunxiNeural', label: '雲希（男）' },
    { id: 'zh-CN-XiaoyiNeural', label: '曉伊（女）' }
  ],
  en: [
    { id: 'en-US-AvaNeural', label: 'Ava（女）' },
    { id: 'en-US-AndrewNeural', label: 'Andrew（男）' },
    { id: 'en-US-JennyNeural', label: 'Jenny（女）' }
  ],
  ja: [
    { id: 'ja-JP-NanamiNeural', label: '七海（女）' },
    { id: 'ja-JP-KeitaNeural', label: '圭太（男）' }
  ],
  ko: [
    { id: 'ko-KR-SunHiNeural', label: '선히（女）' },
    { id: 'ko-KR-InJoonNeural', label: '인준（男）' }
  ]
}

const LANGS = Object.keys(VOICES_BY_LANG)

/** 預設每語一聲 */
const DEFAULT_TTS_VOICES = Object.fromEntries(
  LANGS.map((lang) => [lang, VOICES_BY_LANG[lang][0].id])
)

/** 全部允許的 shortName */
const VOICE_ALLOWLIST = new Set(
  LANGS.flatMap((lang) => VOICES_BY_LANG[lang].map((v) => v.id))
)

/**
 * @param {string} voice
 * @returns {boolean}
 */
function isAllowedVoice(voice) {
  return typeof voice === 'string' && VOICE_ALLOWLIST.has(voice)
}

/**
 * 深度校驗並正規化 ttsVoices 物件
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function sanitizeTtsVoices(value) {
  const base = { ...DEFAULT_TTS_VOICES }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base
  for (const lang of LANGS) {
    const v = /** @type {Record<string, unknown>} */ (value)[lang]
    if (typeof v === 'string' && isAllowedVoice(v)) {
      // 必須屬於該語系列表
      if (VOICES_BY_LANG[lang].some((x) => x.id === v)) {
        base[lang] = v
      }
    }
  }
  return base
}

/**
 * @param {string} lang
 * @returns {string} BCP-47 for Edge TTS
 */
function langToEdgeLocale(lang) {
  if (lang === 'en') return 'en-US'
  if (lang === 'ja') return 'ja-JP'
  if (lang === 'ko') return 'ko-KR'
  return lang // zh-TW / zh-CN
}

/**
 * 列表給設定 UI
 * @returns {{ langs: string[], voicesByLang: typeof VOICES_BY_LANG, defaults: typeof DEFAULT_TTS_VOICES }}
 */
function listVoices() {
  return {
    langs: [...LANGS],
    voicesByLang: VOICES_BY_LANG,
    defaults: { ...DEFAULT_TTS_VOICES }
  }
}

module.exports = {
  VOICES_BY_LANG,
  DEFAULT_TTS_VOICES,
  VOICE_ALLOWLIST,
  LANGS,
  isAllowedVoice,
  sanitizeTtsVoices,
  langToEdgeLocale,
  listVoices
}
