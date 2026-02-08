/**
 * VoiceInk - OpenRouter API 封裝
 */

const API_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_MODEL = 'google/gemini-3-flash-preview'

/**
 * 語言代碼對應的提示詞
 */
const LANGUAGE_PROMPTS = {
  'zh-TW': '繁體中文（台灣）',
  'zh-CN': '簡體中文',
  'en': 'English',
  'ja': '日本語',
  'ko': '한국어',
  'auto': '自動偵測的語言'
}

/**
 * 轉錄音訊檔案
 * @param {string} apiKey - OpenRouter API Key
 * @param {string} audioBase64 - Base64 編碼的音訊
 * @param {string} format - 音訊格式 (mp3, wav, etc.)
 * @param {string} outputLanguage - 輸出語言代碼
 * @param {string} modelId - 模型 ID
 * @returns {Promise<string>} 轉錄結果
 */
export async function transcribeAudio(apiKey, audioBase64, format, outputLanguage = 'zh-TW', modelId = DEFAULT_MODEL) {
  const languageName = LANGUAGE_PROMPTS[outputLanguage] || '繁體中文（台灣）'
  const model = modelId || DEFAULT_MODEL
  
  const prompt = outputLanguage === 'auto'
    ? `請將這段音訊轉錄為逐字稿。
自動偵測語言並使用該語言輸出。
過濾贅詞（如「嗯」「啊」「就是」「那個」等語氣詞）。
預測並填補模糊聽不清楚的部分。
僅輸出逐字稿內容，不要任何額外說明、標題或格式。`
    : `請將這段音訊轉錄為${languageName}逐字稿。
自動偵測語音語言，若非${languageName}則翻譯為${languageName}。
過濾贅詞（如「嗯」「啊」「就是」「那個」等語氣詞）。
預測並填補模糊聽不清楚的部分。
僅輸出逐字稿內容，不要任何額外說明、標題或格式。`

  const response = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://voiceink.app',
      'X-Title': 'VoiceInk'
    },
    body: JSON.stringify({
      model: model,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: {
              data: audioBase64,
              format: format
            }
          },
          {
            type: 'text',
            text: prompt
          }
        ]
      }]
    })
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.error?.message || `API 錯誤: ${response.status}`)
  }

  const data = await response.json()
  return data.choices[0]?.message?.content || ''
}

/**
 * 即時轉錄音訊片段（用於字幕）
 * @param {string} apiKey - OpenRouter API Key
 * @param {string} audioBase64 - Base64 編碼的音訊片段
 * @param {string} format - 音訊格式
 * @param {string} targetLanguage - 目標語言代碼
 * @param {string} modelId - 模型 ID
 * @returns {Promise<string>} 字幕文字
 */
export async function transcribeLive(apiKey, audioBase64, format, targetLanguage = 'zh-TW', modelId = DEFAULT_MODEL) {
  const languageName = LANGUAGE_PROMPTS[targetLanguage] || '繁體中文（台灣）'
  const model = modelId || DEFAULT_MODEL
  
  const prompt = targetLanguage === 'auto'
    ? `即時轉錄此音訊片段。自動偵測語言並輸出。僅輸出字幕文字，保持簡潔，不要任何額外標點或說明。`
    : `即時轉錄此音訊片段為${languageName}字幕。自動偵測語言，若非${languageName}則翻譯。僅輸出字幕文字，保持簡潔，不要任何額外標點或說明。`

  const response = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://voiceink.app',
      'X-Title': 'VoiceInk'
    },
    body: JSON.stringify({
      model: model,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: {
              data: audioBase64,
              format: format
            }
          },
          {
            type: 'text',
            text: prompt
          }
        ]
      }]
    })
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.error?.message || `API 錯誤: ${response.status}`)
  }

  const data = await response.json()
  return data.choices[0]?.message?.content || ''
}

/**
 * 驗證 API Key
 * @param {string} apiKey - OpenRouter API Key
 * @returns {Promise<boolean>} 是否有效
 */
export async function validateApiKey(apiKey) {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    })
    return response.ok
  } catch {
    return false
  }
}
