/**
 * e2e：LinguaForge v5e 出貨解碼對齊驗收（INTEGRATION.md A–E）
 * 用法：npx electron scripts/e2e-linguaforge-decode.js
 *
 * A 醫囑 en→zh-TW 完整無簡體無灌水
 * B 短句 zh-TW→en 一句無重複尾巴
 * C 長口語→en 不得同句無限重複
 * D 正常句 stopReason 不得為 maxTokens（EOS 生效）
 * E 繁中無簡體專用字（s2twp 後）
 */
const path = require('path')
const { app } = require('electron')

app.setPath('userData', path.join(app.getPath('appData'), 'voiceink'))

/** 簡體專用字（opencc 前粗檢；與訓練 evaluate 同精神） */
const SIMPLIFIED_CHARS = /[国国体发后会学时对们来过还这说开 Spec门见关车东风长马书儿气]/

function hasLoop(text) {
  const t = String(text || '')
  // 同一 8+ 字子串出現 ≥3 次視為刷屏
  const m = t.match(/(.{8,}?)\1\1/)
  return !!m
}

async function main() {
  const models = require('../src/main/models')
  const localLlm = require('../src/main/local-llm')

  let failed = 0
  const pass = (name, d = '') => console.log(`PASS  ${name}${d ? ' — ' + d : ''}`)
  const fail = (name, e) => {
    failed++
    console.error(`FAIL  ${name}:`, e?.message || e)
  }

  // DECODE 表結構
  try {
    const dZh = localLlm.resolveLinguaforgeDecode('zh-TW')
    const dEn = localLlm.resolveLinguaforgeDecode('en')
    const dJa = localLlm.resolveLinguaforgeDecode('ja')
    if (dZh.repetitionPenalty != null) throw new Error('zhtw must not have repetition_penalty')
    if (dZh.noRepeatNgramSize !== 4 || !dZh.s2twp) throw new Error('zhtw decode')
    if (dEn.repetitionPenalty !== 1.1 || dEn.noRepeatNgramSize !== 4) throw new Error('en decode')
    if (dJa.repetitionPenalty !== 1.1) throw new Error('ja decode')
    if (JSON.stringify(dZh.eosTokenIds) !== JSON.stringify([248046, 248044])) {
      throw new Error(`eos ${dZh.eosTokenIds}`)
    }
    if (dZh.numBeams !== 4 || dZh.lengthPenalty !== 1.2) throw new Error('beams/lp')
    pass('DECODE table', 'zhtw=no-rep en/ja=1.1 ngram=4 eos dual beams=4 lp=1.2')
  } catch (e) {
    fail('DECODE table', e)
  }

  if (!models.isDownloaded('linguaforge08q4')) {
    console.error('linguaforge08 not downloaded — skip runtime checks')
    process.exit(failed ? 1 : 0)
  }

  const store = {
    data: { translator: 'local', localTranslateModel: 'linguaforge08q4', llmGpu: false },
    get(k, d) {
      return k in this.data ? this.data[k] : d
    }
  }
  localLlm.setStore(store)

  try {
    const w = await localLlm.warm()
    if (!w?.ok) throw new Error(JSON.stringify(w))
    pass('warm', JSON.stringify(localLlm.getLoadInfo()))
  } catch (e) {
    fail('warm', e)
    process.exit(1)
  }

  // A
  try {
    const src = 'The patient should take this medication twice a day.'
    const out = await localLlm.translate(store, src, 'zh-TW', { mode: 'file' })
    if (!out || out === src) throw new Error(`empty/echo: ${out}`)
    if (hasLoop(out)) throw new Error(`loop: ${out}`)
    if (out.length > 120) throw new Error(`too long (possible fill): ${out}`)
    // 簡體粗檢（s2twp 後應極少）
    if (/[国体发后会学时对们来过还这说开关车东风长马书儿气]/.test(out)) {
      throw new Error(`simplified leak: ${out}`)
    }
    if (!/藥|病|每天|兩次|日|服/.test(out)) throw new Error(`unrelated: ${out}`)
    pass('A en→zh-TW medical', out)
  } catch (e) {
    fail('A en→zh-TW medical', e)
  }

  // B
  try {
    const src = '週末的夜市人聲鼎沸。'
    const out = await localLlm.translate(store, src, 'en', { mode: 'file' })
    if (!out || out === src) throw new Error(`empty/echo: ${out}`)
    if (hasLoop(out)) throw new Error(`loop: ${out}`)
    // 不應整段重複尾巴
    const sentences = out.split(/(?<=[.!?])\s+/).filter(Boolean)
    if (sentences.length > 3) throw new Error(`too many sentences: ${out}`)
    if (!/night|market|weekend|bustl|crowd|lively/i.test(out)) {
      throw new Error(`unrelated: ${out}`)
    }
    pass('B zh-TW→en short', out)
  } catch (e) {
    fail('B zh-TW→en short', e)
  }

  // C 長口語
  try {
    const src =
      '欸你知道嗎昨天我去夜市逛了好久，本來只是想買個飲料結果看到好多攤，' +
      '然後朋友一直說要去吃臭豆腐，我說好啦好啦，結果排隊排超久，' +
      '後來吃完又去看那個射氣球的，完全沒中，超糗的，最後我們走回去的時候還下雨。'
    const out = await localLlm.translate(store, src, 'en', { mode: 'file' })
    if (!out) throw new Error('empty')
    if (hasLoop(out)) throw new Error(`loop: ${out.slice(0, 200)}…`)
    // 中→英正常可到 3–5× 字元；真正 runaway 是貼滿 maxTokens 或 n-gram 刷屏
    if (out.length > Math.max(src.length * 6, 800)) {
      throw new Error(`runaway len=${out.length}: ${out.slice(0, 200)}…`)
    }
    pass('C long oral →en', `${out.length} chars: ${out.slice(0, 160)}…`)
  } catch (e) {
    fail('C long oral →en', e)
  }

  // D：短句不應 maxTokens 填滿（靠 log stopReason；此處用長度代理）
  try {
    const src = 'Good morning.'
    const out = await localLlm.translate(store, src, 'zh-TW', { mode: 'file' })
    // maxTokens 對短句 ≥64；若貼滿會很長
    if (out.length > 80) throw new Error(`possible maxTokens fill: len=${out.length} ${out}`)
    if (hasLoop(out)) throw new Error(`loop: ${out}`)
    pass('D short not fill maxTokens', out)
  } catch (e) {
    fail('D short not fill maxTokens', e)
  }

  // E 再抽樣繁中
  try {
    const src = 'She opened the window and listened to the rain.'
    const out = await localLlm.translate(store, src, 'zh-TW', { mode: 'file' })
    if (/[国体发后会学时对们来过还这说开关车东风长马书儿气]/.test(out)) {
      throw new Error(`simplified: ${out}`)
    }
    pass('E zh-TW no simplified', out)
  } catch (e) {
    fail('E zh-TW no simplified', e)
  }

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
  // 跳過 unload 原生崩潰；直接 exit
  process.exit(failed === 0 ? 0 : 1)
}

app.whenReady().then(main).catch((e) => {
  console.error(e)
  process.exit(1)
})
