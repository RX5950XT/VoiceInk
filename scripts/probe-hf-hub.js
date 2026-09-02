#!/usr/bin/env node
/**
 * VoiceInk — Hugging Face Hub 的真流量實測（打真上游，不下載模型本體）
 *
 * `hub.js` 押在四個假設上，全部只能用真流量驗：
 *   [A] `GET /api/models?filter=gguf` 搜得到東西，欄位名對得上
 *   [B] `GET /api/models/<repo>/tree/main?recursive=1` 回得出檔案大小（LFS 要看 `lfs.size`）
 *   [C] `resolve/main/<file>` **支援 HTTP Range**（回 206 ＋ `content-range`）
 *   [D] 抓前 1MB 就足以解析出 `<arch>.block_count` 等等——也就是詞表排在它們後面
 *       （這條錯了，「還沒下載就先知道跑不跑得動」整個功能就不成立）
 *
 * 順便把 `catalog.groupVariants` 套在真實 repo 的檔案清單上，看分片與 mmproj 有沒有歸對。
 *
 * 用法：`node scripts/probe-hf-hub.js [repo-id]`
 */

'use strict'

const path = require('path')

const ROOT = path.join(__dirname, '..')
const hub = require(path.join(ROOT, 'src/main/hfmodels/hub.js'))
const gguf = require(path.join(ROOT, 'src/main/hfmodels/gguf.js'))
const catalog = require(path.join(ROOT, 'src/main/hfmodels/catalog.js'))

/** 一顆單檔、一顆分片、一顆多模態（mmproj）——三種佈局各一 */
const REPOS = process.argv[2] ? [process.argv[2]] : [
  'unsloth/Qwen3-4B-GGUF',
  'ggml-org/gemma-3-4b-it-GGUF'
]

let failed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MiB`

async function main() {
  console.log('\n[A] 搜尋')
  const found = await hub.searchModels({ query: 'qwen3', limit: 5 })
  ok('搜得到 GGUF repo', found.length > 0, `${found.length} 筆`)
  ok('欄位齊全', found.every((m) => m.id && m.downloads >= 0 && Array.isArray(m.tags)))
  for (const model of found.slice(0, 3)) {
    console.log(`    ${model.id}  ↓${model.downloads.toLocaleString()}  ♥${model.likes}`)
  }

  for (const repo of REPOS) {
    console.log(`\n[B] 檔案清單 — ${repo}`)
    let files = []
    try {
      files = await hub.listFiles(repo)
    } catch (error) {
      ok('列得出檔案', false, error.message)
      continue
    }
    const ggufs = files.filter((f) => /\.gguf$/i.test(f.name))
    ok('列得出檔案', files.length > 0, `${files.length} 個（GGUF ${ggufs.length} 個）`)
    ok('GGUF 有真實大小（LFS 的 size 不是指標檔那 135 bytes）',
      ggufs.every((f) => f.size > 1024 * 1024),
      ggufs.length ? mib(Math.min(...ggufs.map((f) => f.size))) + ' 起' : '')

    const variants = catalog.groupVariants(files, { repoName: repo.split('/')[1] })
    ok('歸得出變體', variants.length > 0, `${variants.length} 個`)
    for (const v of variants.slice(0, 6)) {
      console.log(`    ${v.id.padEnd(34)} ${String(v.quant || '—').padEnd(9)} ${mib(v.bytes).padStart(9)}`
        + ` ${v.shardCount > 1 ? `${v.shardCount} 片` : '單檔'}${v.multimodal ? ' +mmproj' : ''}`)
    }
    ok('分片都齊', variants.every((v) => catalog.isComplete(v)))

    const target = variants.find((v) => v.shardCount === 1)
    if (!target) {
      console.log('    SKIP 這個 repo 沒有單檔變體，跳過 Range 檢查')
      continue
    }

    console.log(`\n[C][D] Range 抓檔頭 — ${target.files[0].name}`)
    const started = Date.now()
    const peek = await hub.peekFile(repo, target.files[0].name)
    const elapsed = Date.now() - started
    ok('Range 拿得到前面一段', peek.buffer.length > 0 && peek.buffer.length <= hub.PEEK_BYTES,
      `${peek.buffer.length} bytes / ${elapsed}ms`)
    ok('回得出完整檔案大小（content-range）', peek.totalBytes > peek.buffer.length,
      mib(peek.totalBytes))
    ok('只抓了一小段（沒有整包拉下來）', peek.buffer.length < target.files[0].size)

    const info = gguf.readInfoFromBuffer(peek.buffer, peek.totalBytes)
    console.log(`    arch=${info.arch} layers=${info.blockCount} ctx=${info.contextTrain}`
      + ` embd=${info.embeddingLength} kv_heads=${info.headCountKv} truncated=${info.truncated}`)
    ok('前 1MB 就讀得到架構', !!info.arch)
    ok('前 1MB 就讀得到層數（plan.js 靠它算 GPU 層數）', info.blockCount > 0)
    ok('前 1MB 就讀得到訓練上下文', info.contextTrain > 0)
  }
}

main()
  .catch((error) => {
    failed += 1
    console.log(`\n  FAIL 拋錯 — ${error && error.message}`)
  })
  .then(() => {
    console.log(`\n${failed === 0 ? '全數 PASS' : `${failed} 項 FAIL`}`)
    process.exit(failed === 0 ? 0 : 1)
  })
