/**
 * 驗證「送進模型的完整 prompt 字串」是否等同 transformers apply_chat_template
 * （Qwen3.5 chat_template.jinja 在 enable_thinking 未開時，assistant 起頭固定補
 *  `<think>\n\n</think>\n\n`，token id 248068,271,248069,271）。
 *
 * 印出：實際解析到的 chat wrapper、contextText 逐字元、尾端 token id。
 * 用法：node scripts/probe-prompt-path.js [gguf 路徑]
 */
const path = require('path')

const GGUF =
  process.argv[2] ||
  path.join(
    process.env.APPDATA || '',
    'voiceink/models/linguaforge08/gguf-v5e/linguaforge-v5e-0.8b-Q4_K_M.gguf'
  )

const SYSTEM = 'You are a professional translator.'
const USER = '翻譯成繁體中文：\nThe NVIDIA H200 has 141GB of HBM3e memory.'
/** transformers apply_chat_template(..., add_generation_prompt=True) 的輸出 */
const EXPECTED =
  `<|im_start|>system\n${SYSTEM}<|im_end|>\n` +
  `<|im_start|>user\n${USER}<|im_end|>\n` +
  '<|im_start|>assistant\n<think>\n\n</think>\n\n'

const HISTORY = [
  { type: 'system', text: SYSTEM },
  { type: 'user', text: USER },
  { type: 'model', response: [] }
]

/** @param {object} wrapper @param {object} tokenizer @param {string} label */
function report(label, wrapper, tokenizer) {
  const state = wrapper.generateContextState({ chatHistory: HISTORY })
  const text = state.contextText.toString()
  const ids = state.contextText.tokenize(tokenizer, 'trimLeadingSpace')
  console.log(`\n=== ${label} (wrapperName=${wrapper.wrapperName}) ===`)
  console.log('prompt:', JSON.stringify(text))
  console.log('tail ids:', ids.slice(-6).join(','))
  console.log('match apply_chat_template:', text === EXPECTED ? 'YES' : 'NO')
  if (text !== EXPECTED) {
    console.log('expected:', JSON.stringify(EXPECTED))
  }
  return text === EXPECTED
}

async function main() {
  const llamaMod = await import('node-llama-cpp')
  const { getLlama, LlamaChatSession, QwenChatWrapper, LlamaText } = llamaMod

  const llama = await getLlama({ gpu: false, progressLogs: false })
  const model = await llama.loadModel({ modelPath: GGUF })
  const context = await model.createContext({ contextSize: 2048 })

  // 1) 生產路徑現況：LlamaChatSession 不指定 chatWrapper → 自動解析
  const auto = new LlamaChatSession({ contextSequence: context.getSequence() })
  report('現況（自動解析）', auto.chatWrapper, model.tokenizer)

  // 2) 內建 QwenChatWrapper 各組合
  report('QwenChatWrapper()', new QwenChatWrapper(), model.tokenizer)
  report('QwenChatWrapper{variation:3.5}', new QwenChatWrapper({ variation: '3.5' }), model.tokenizer)
  report(
    'QwenChatWrapper{thoughts:discourage}',
    new QwenChatWrapper({ thoughts: 'discourage' }),
    model.tokenizer
  )
  report(
    'QwenChatWrapper{variation:3.5,thoughts:discourage}',
    new QwenChatWrapper({ variation: '3.5', thoughts: 'discourage' }),
    model.tokenizer
  )

  // 3) 手寫 subclass（INTEGRATION.md 建議寫法）
  class Qwen35ChatWrapper extends QwenChatWrapper {
    generateContextState(options) {
      const state = super.generateContextState(options)
      const last = options.chatHistory[options.chatHistory.length - 1]
      if (last?.type === 'model' && (last.response == null || last.response.length === 0))
        state.contextText = LlamaText([state.contextText, '<think>\n\n</think>\n\n'])
      return state
    }
  }
  report('Qwen35ChatWrapper(subclass)', new Qwen35ChatWrapper(), model.tokenizer)

  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
