/**
 * VoiceInk - OpenRouter API 封裝
 */

const API_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "google/gemini-3-flash-preview";

/**
 * 語言代碼對應的提示詞
 */
const LANGUAGE_PROMPTS = {
  "zh-TW": "繁體中文（台灣）",
  "zh-CN": "簡體中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
  auto: "自動偵測的語言",
};

/**
 * 轉錄音訊檔案
 * @param {string} apiKey - OpenRouter API Key
 * @param {string} audioBase64 - Base64 編碼的音訊
 * @param {string} format - 音訊格式 (mp3, wav, etc.)
 * @param {string} outputLanguage - 輸出語言代碼
 * @param {string} modelId - 模型 ID
 * @returns {Promise<string>} 轉錄結果
 */
export async function transcribeAudio(
  apiKey,
  audioBase64,
  format,
  outputLanguage = "zh-TW",
  modelId = DEFAULT_MODEL,
) {
  const languageName = LANGUAGE_PROMPTS[outputLanguage] || "繁體中文（台灣）";
  const model = modelId || DEFAULT_MODEL;

  const prompt =
    outputLanguage === "auto"
      ? `請將這段音訊轉錄為逐字稿。
自動偵測語言並使用該語言輸出。
過濾贅詞（如「嗯」「啊」「就是」「那個」等語氣詞）。
預測並填補模糊聽不清楚的部分。
僅輸出逐字稿內容，不要任何額外說明、標題或格式。`
      : `請將這段音訊轉錄為${languageName}逐字稿。
自動偵測語音語言，若非${languageName}則翻譯為${languageName}。
過濾贅詞（如「嗯」「啊」「就是」「那個」等語氣詞）。
預測並填補模糊聽不清楚的部分。
僅輸出逐字稿內容，不要任何額外說明、標題或格式。`;

  const response = await fetch(API_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://voiceink.app",
      "X-Title": "VoiceInk",
    },
    body: JSON.stringify({
      model: model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: {
                data: audioBase64,
                format: format,
              },
            },
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `API 錯誤: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0]?.message?.content || "";
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
export async function transcribeLive(
  apiKey,
  audioBase64,
  format,
  targetLanguage = "zh-TW",
  modelId = DEFAULT_MODEL,
) {
  const languageName = LANGUAGE_PROMPTS[targetLanguage] || "繁體中文（台灣）";
  const model = modelId || DEFAULT_MODEL;

  const prompt =
    targetLanguage === "auto"
      ? `即時轉錄此音訊片段。自動偵測語言並輸出。僅輸出字幕文字，保持簡潔，不要任何額外標點或說明。`
      : `即時轉錄此音訊片段為${languageName}字幕。自動偵測語言，若非${languageName}則翻譯。僅輸出字幕文字，保持簡潔，不要任何額外標點或說明。`;

  const response = await fetch(API_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://voiceink.app",
      "X-Title": "VoiceInk",
    },
    body: JSON.stringify({
      model: model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: {
                data: audioBase64,
                format: format,
              },
            },
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `API 錯誤: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0]?.message?.content || "";
}

/**
 * 即時轉錄音訊片段（帶上下文）
 * @param {string} apiKey - OpenRouter API Key
 * @param {string} audioBase64 - Base64 編碼的音訊片段
 * @param {string} format - 音訊格式
 * @param {string} targetLanguage - 目標語言代碼
 * @param {string} modelId - 模型 ID
 * @param {string} previousText - 前一句轉錄結果（用於上下文連貫）
 * @returns {Promise<string>} 字幕文字
 */
export async function transcribeLiveWithContext(
  apiKey,
  audioBase64,
  format,
  targetLanguage = "zh-TW",
  modelId = DEFAULT_MODEL,
  previousText = "",
) {
  const languageName = LANGUAGE_PROMPTS[targetLanguage] || "繁體中文（台灣）";
  const model = modelId || DEFAULT_MODEL;

  // 構建包含上下文的 prompt
  let contextHint = "";
  if (previousText && previousText.trim()) {
    contextHint = `前一句話是：「${previousText}」\n這段音訊是接續前一句的內容。`;
  }

  const prompt =
    targetLanguage === "auto"
      ? `你是精確的語音轉錄系統。根據音訊內容生成字幕。
${contextHint}
【核心原則】只輸出你實際聽到的內容，不添加任何推測。

【音訊類型處理】
- 人聲說話 → 逐字轉錄說話內容
- 音樂（歌曲、背景音樂、旋律） → 只輸出「（音樂）」
- 效果音（掌聲、笑聲、爆炸聲等） → 輸出對應標註如「（掌聲）」「（笑聲）」
- 靜音/無法辨識的噪音 → 回覆空白（不輸出任何內容）

【嚴格禁止 - 違反視為失敗】
✗ 禁止編造、猜測、補充任何未實際聽到的內容
✗ 禁止輸出「謝謝觀看」「歡迎訂閱」「字幕由...提供」等常見片尾語除非真的聽到
✗ 禁止在音樂中猜測歌詞（除非清楚聽到歌詞則可轉錄）
✗ 禁止填充語氣詞或創造對話

【輸出格式】
- 只輸出純文字字幕或上述標註
- 不要任何說明、前綴、後綴
- 若與前一句重疊，只輸出新增部分`
      : `你是精確的語音轉錄系統。根據音訊內容生成${languageName}字幕。
${contextHint}
【核心原則】只輸出你實際聽到的內容，不添加任何推測。

【音訊類型處理】
- 人聲說話 → 逐字轉錄說話內容，若非${languageName}則翻譯
- 音樂（歌曲、背景音樂、旋律） → 只輸出「（音樂）」
- 效果音（掌聲、笑聲、爆炸聲等） → 輸出對應標註如「（掌聲）」「（笑聲）」
- 靜音/無法辨識的噪音 → 回覆空白（不輸出任何內容）

【嚴格禁止 - 違反視為失敗】
✗ 禁止編造、猜測、補充任何未實際聽到的內容
✗ 禁止輸出「謝謝觀看」「歡迎訂閱」「字幕由...提供」等常見片尾語除非真的聽到
✗ 禁止在音樂中猜測歌詞（除非清楚聽到歌詞則可轉錄）
✗ 禁止填充語氣詞或創造對話

【輸出格式】
- 只輸出純文字字幕或上述標註
- 不要任何說明、前綴、後綴
- 若與前一句重疊，只輸出新增部分`;

  const response = await fetch(API_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://voiceink.app",
      "X-Title": "VoiceInk",
    },
    body: JSON.stringify({
      model: model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: {
                data: audioBase64,
                format: format,
              },
            },
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `API 錯誤: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0]?.message?.content || "";
}

/**
 * 驗證 API Key
 * @param {string} apiKey - OpenRouter API Key
 * @returns {Promise<boolean>} 是否有效
 */
export async function validateApiKey(apiKey) {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}
