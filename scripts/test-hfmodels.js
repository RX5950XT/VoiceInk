#!/usr/bin/env node
/**
 * VoiceInk — 「HF模型」分頁的純邏輯回歸（node 直跑，不需 electron、不下載任何東西）
 *
 * 三個模組各有一條最容易錯的：
 *   - gguf.js：詞表陣列動輒十幾萬筆，會把檔頭推到 1MB 之外 → Reader 要能自己續讀
 *   - catalog.js：分片與 mmproj 少抓一個檔，症狀是**下載完才跑不起來**
 *   - plan.js：顯存估太滿的代價是載入到一半 OOM，所以「塞不下」一定要縮得出來
 */

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const gguf = require(path.join(ROOT, 'src/main/hfmodels/gguf.js'))
const catalog = require(path.join(ROOT, 'src/main/hfmodels/catalog.js'))
const plan = require(path.join(ROOT, 'src/main/hfmodels/plan.js'))
const hardware = require(path.join(ROOT, 'src/main/hfmodels/hardware.js'))
const hub = require(path.join(ROOT, 'src/main/hfmodels/hub.js'))
const library = require(path.join(ROOT, 'src/main/hfmodels/library.js'))
const download = require(path.join(ROOT, 'src/main/hfmodels/download.js'))
const presets = require(path.join(ROOT, 'src/main/hfmodels/presets.js'))

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ===== 合成一顆 GGUF（只有檔頭，沒有張量）=====
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
const gstr = (s) => { const b = Buffer.from(String(s), 'utf8'); return Buffer.concat([u64(b.length), b]) }
const kvStr = (k, v) => Buffer.concat([gstr(k), u32(8), gstr(v)])
const kvU32 = (k, v) => Buffer.concat([gstr(k), u32(4), u32(v)])
const kvU64 = (k, v) => Buffer.concat([gstr(k), u32(10), u64(v)])
const kvArrStr = (k, items) => Buffer.concat([gstr(k), u32(9), u32(8), u64(items.length), ...items.map(gstr)])

/** 詞表放在後面：正好逼 Reader 走到 1MB 之外（真實模型就是這個佈局） */
const VOCAB = Array.from({ length: 120_000 }, (_, i) => `tok_${i}`)
const CHAT_TEMPLATE = '{% for m in messages %}'.repeat(4000) // > MAX_STRING，只該留前面一段

function buildGguf() {
  const kvs = [
    kvStr('general.architecture', 'qwen3'),
    kvStr('general.name', 'Test Qwen3 4B'),
    kvStr('general.size_label', '4B'),
    kvU32('general.file_type', 15),
    kvU64('general.parameter_count', 4_020_000_000),
    kvU32('qwen3.context_length', 262_144),
    kvU32('qwen3.block_count', 36),
    kvU32('qwen3.embedding_length', 2560),
    kvU32('qwen3.attention.head_count', 32),
    kvU32('qwen3.attention.head_count_kv', 8),
    kvStr('tokenizer.chat_template', CHAT_TEMPLATE),
    kvArrStr('tokenizer.ggml.tokens', VOCAB),
    kvU32('split.no', 0),
    kvU32('split.count', 1)
  ]
  return Buffer.concat([
    u32(0x46554747), u32(3), u64(0), u64(kvs.length), ...kvs,
    Buffer.alloc(4096) // 假裝後面還有張量資料
  ])
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-hfmodels-'))
try {
  console.log('\n[A] GGUF 檔頭解析')
  {
    const buf = buildGguf()
    const file = path.join(tmp, 'test-Q4_K_M.gguf')
    fs.writeFileSync(file, buf)
    ok('合成的檔頭真的超過單次讀取量（否則這段測不到續讀）', buf.length > (1 << 20), `${buf.length} bytes`)

    const info = gguf.readInfo(file)
    ok('version', info.version === 3)
    ok('架構', info.arch === 'qwen3')
    ok('名稱', info.name === 'Test Qwen3 4B')
    ok('訓練上下文', info.contextTrain === 262_144)
    ok('層數', info.blockCount === 36)
    ok('embedding', info.embeddingLength === 2560)
    ok('GQA head_count_kv', info.headCountKv === 8)
    ok('參數量（uint64 轉 Number）', info.parameterCount === 4_020_000_000)
    ok('詞表大小取陣列長度、不存內容', info.vocabSize === 120_000)
    ok('有 chat template', info.hasChatTemplate === true)
    ok('檔案大小', info.fileBytes === buf.length)
    ok('完整檔案不算截斷', info.truncated === false)

    const header = gguf.readHeader(file)
    ok('陣列只留型別與長度', header.kv['tokenizer.ggml.tokens'].length === 120_000
      && header.kv['tokenizer.ggml.tokens'].arrayType === 8)
    ok('長字串只留前面一段', header.kv['tokenizer.chat_template'].length === 2048,
      String(header.kv['tokenizer.chat_template'].length))

    // 只抓前 1MB（模擬 HTTP Range）：詞表讀不完，但 <arch>.* 那幾格都在它前面
    const partial = gguf.readInfoFromBuffer(buf.subarray(0, 1 << 20), buf.length)
    ok('前段解析：標成截斷', partial.truncated === true)
    ok('前段解析：層數照樣拿得到', partial.blockCount === 36)
    ok('前段解析：訓練上下文照樣拿得到', partial.contextTrain === 262_144)
    ok('前段解析：完整檔案大小由外面帶進來', partial.fileBytes === buf.length)

    const broken = path.join(tmp, 'not-a-model.gguf')
    fs.writeFileSync(broken, Buffer.from('NOPE' + 'x'.repeat(64)))
    let threw = ''
    try { gguf.readInfo(broken) } catch (error) { threw = error.message }
    ok('magic 不符要拋錯', /magic/.test(threw), threw)
  }

  console.log('\n[B] 量化／分片／mmproj 判讀')
  {
    ok('檔名量化', catalog.parseQuant('Qwen3.5-4B-Q4_K_M.gguf') === 'Q4_K_M')
    ok('IQ 系列', catalog.parseQuant('model-IQ2_XXS.gguf') === 'IQ2_XXS')
    ok('小寫 f16', catalog.parseQuant('ggml-model-f16.gguf') === 'F16')
    ok('資料夾名也算', catalog.parseQuant('Q8_0/model-00001-of-00002.gguf') === 'Q8_0')
    ok('模型名裡的 Q 不誤判', catalog.parseQuant('Qwen3-8B.gguf') === '')
    ok('取最後一個（名字裡有干擾）', catalog.parseQuant('Q4-tuned-model-Q6_K.gguf') === 'Q6_K')

    ok('分片解析', JSON.stringify(catalog.parseShard('big-00002-of-00009.gguf'))
      === JSON.stringify({ base: 'big', index: 2, total: 9 }))
    ok('非分片回 null', catalog.parseShard('big.gguf') === null)
    ok('mmproj 認得出', catalog.isMmproj('mmproj-F16.gguf') === true)
    ok('模型檔不會被當成 mmproj', catalog.isMmproj('model-Q4_K_M.gguf') === false)
    ok('safeId 去掉路徑字元', catalog.safeId('owner/repo name:v2') === 'owner-repo-name-v2')
  }

  console.log('\n[C] 變體分組')
  {
    const variants = catalog.groupVariants([
      { name: 'README.md', size: 100 },
      { name: 'Model-Q4_K_M.gguf', size: 4_000 },
      { name: 'Model-Q8_0-00001-of-00002.gguf', size: 5_000 },
      { name: 'Model-Q8_0-00002-of-00002.gguf', size: 5_000 },
      { name: 'mmproj-F16.gguf', size: 500 }
    ], { repoName: 'Model' })

    ok('非 gguf 不進來', variants.length === 2, JSON.stringify(variants.map((v) => v.id)))
    const q4 = variants.find((v) => v.quant === 'Q4_K_M')
    const q8 = variants.find((v) => v.quant === 'Q8_0')
    ok('Q4 單檔', q4 && q4.files.length === 1 && q4.shardCount === 1)
    ok('Q8 兩片歸同一組', q8 && q8.files.length === 2 && q8.shardCount === 2)
    ok('id 帶 repo 名與量化', q8 && q8.id === 'Model-Q8_0', q8 && q8.id)
    ok('mmproj 掛給每個變體、不自成一列', !!(q4 && q4.mmproj) && !!(q8 && q8.mmproj))
    ok('多模態旗標', q4 && q4.multimodal === true)
    ok('大小含 mmproj', q4 && q4.bytes === 4_500, q4 && String(q4.bytes))
    ok('依大小排序', variants[0].bytes <= variants[1].bytes)

    const folders = catalog.groupVariants([
      { name: 'Q4_K_M/model-00001-of-00002.gguf', size: 10 },
      { name: 'Q4_K_M/model-00002-of-00002.gguf', size: 10 },
      { name: 'Q6_K/model.gguf', size: 30 }
    ], { repoName: 'Repo' })
    ok('量化寫在資料夾名的擺法', folders.length === 2
      && folders.every((v) => ['Q4_K_M', 'Q6_K'].includes(v.quant)),
    JSON.stringify(folders.map((v) => v.quant)))

    ok('分片齊全', catalog.isComplete(q8) === true)
    ok('缺一片就不算齊', catalog.isComplete({ files: [q8.files[0]], shardCount: 2 }) === false)
  }

  console.log('\n[D] 執行參數決策')
  {
    const info = { contextTrain: 262_144, blockCount: 36, embeddingLength: 2560, headCount: 32, headCountKv: 8 }
    const GiB = 1024 * 1024 * 1024

    const cpu = plan.planRun({ modelBytes: 2 * GiB, info, device: null })
    ok('沒有 GPU：層數 0', cpu.gpuLayers === 0)
    ok('沒有 GPU：不填 device（只給 99 層會安靜跑 CPU）', cpu.device === '')
    ok('沒有 GPU：講出來', cpu.warnings.some((w) => w.includes('CPU')))

    const big = plan.planRun({
      modelBytes: 2 * GiB,
      info,
      device: { id: 'Vulkan0', totalMiB: 16_000, freeMiB: 15_000 }
    })
    ok('顯存夠：整顆上 GPU', big.fullOffload === true && big.gpuLayers === 36)
    ok('顯存夠：上下文用預設而不是訓練上限', big.ctxSize === plan.DEFAULT_CTX, String(big.ctxSize))
    ok('顯存夠：沒有警告', big.warnings.length === 0, JSON.stringify(big.warnings))
    ok('device 有帶', big.device === 'Vulkan0')

    const tight = plan.planRun({
      modelBytes: 2 * GiB,
      info,
      device: { id: 'Vulkan0', totalMiB: 4_096, freeMiB: 2_800 }
    })
    ok('顯存緊：先縮上下文', tight.ctxSize < plan.DEFAULT_CTX && tight.ctxSize >= plan.MIN_CTX,
      String(tight.ctxSize))

    const tiny = plan.planRun({
      modelBytes: 6 * GiB,
      info,
      device: { id: 'Vulkan0', totalMiB: 4_096, freeMiB: 3_000 }
    })
    ok('真的塞不下：只放部分層', tiny.gpuLayers > 0 && tiny.gpuLayers < 36, String(tiny.gpuLayers))
    ok('真的塞不下：講出需要多少／有多少', tiny.warnings.some((w) => w.includes('顯存不足')))
    ok('估計值有回給上層', tiny.modelMiB === 6 * 1024 && tiny.kvMiB > 0 && tiny.budgetMiB === 2700)

    const forced = plan.planRun({
      modelBytes: 2 * GiB,
      info,
      device: { id: 'Vulkan0', totalMiB: 16_000, freeMiB: 15_000 },
      requested: { ctxSize: 300_000, gpuLayers: 10 }
    })
    ok('使用者覆寫照用', forced.ctxSize === 300_000 && forced.gpuLayers === 10)
    ok('超過訓練長度要提醒', forced.warnings.some((w) => w.includes('訓練長度')))

    ok('GQA 的 KV 比 MHA 小', plan.kvCacheMiB(info, 8192)
      < plan.kvCacheMiB({ ...info, headCountKv: 32 }, 8192))
    ok('讀不到層數時不當機', plan.planRun({ modelBytes: GiB, info: {}, device: null }).gpuLayers === 0)

    const preset = plan.toPresetArgs(big)
    ok('preset 參數', preset['ctx-size'] === String(big.ctxSize)
      && preset['gpu-layers'] === '36' && preset.device === 'Vulkan0')
  }

  console.log('\n[D2] KV 快取一定要用 GGUF 寫的 key_length（曾經低估 2 倍）')
  {
    // 實測：Qwen3.5 系列的 `attention.key_length` = 256，但 embd/head_count 只有 128～160。
    // 拿推導值算 KV 會低估 1.6～2 倍 → gpu-layers 給太多 → 載入時 OOM，
    // 而使用者只會看到「載入失敗」。
    const withExplicit = {
      blockCount: 24, embeddingLength: 1024, headCount: 8, headCountKv: 2,
      keyLength: 256, valueLength: 256
    }
    const derivedOnly = { ...withExplicit, keyLength: null, valueLength: null }
    ok('明寫的 key_length 贏過 embd/head_count 的推導值',
      plan.kvCacheMiB(withExplicit, 8192) === 384, String(plan.kvCacheMiB(withExplicit, 8192)))
    ok('沒有明寫時才退回推導（不可以回 0——回 0 等於說 KV 不佔空間）',
      plan.kvCacheMiB(derivedOnly, 8192) === 192, String(plan.kvCacheMiB(derivedOnly, 8192)))
    ok('兩者真的不一樣（這就是那個 bug）',
      plan.kvCacheMiB(withExplicit, 8192) === plan.kvCacheMiB(derivedOnly, 8192) * 2)
    ok('量化檔位真的比較省',
      plan.kvCacheMiB(withExplicit, 8192, 'q8_0', 'q4_0') < plan.kvCacheMiB(withExplicit, 8192) / 2)
    ok('資訊不足時老實回 0（而不是掰一個數字）', plan.kvCacheMiB({}, 8192) === 0)
  }

  console.log('\n[D3] 進階調參')
  {
    const info2 = {
      contextTrain: 262_144, blockCount: 36, embeddingLength: 2560,
      headCount: 32, headCountKv: 8, keyLength: 128, valueLength: 128
    }
    const GiB2 = 1024 * 1024 * 1024
    const roomy = { id: 'Vulkan0', totalMiB: 24_000, freeMiB: 23_000 }

    const p = plan.planRun({ modelBytes: 2 * GiB2, info: info2, device: roomy, cpu: { cores: 16 } })
    ok('顯存夠就不動 KV（f16 品質優先）', p.cacheTypeK === 'f16' && p.cacheTypeV === 'f16')
    ok('f16 檔位不強寫 flash-attn（不支援 FA 的後端會直接載不起來）', p.flashAttn === false)
    ok('執行緒用實體核估計', p.threads === 8, String(p.threads))
    ok('預設開免草稿模型的投機解碼', p.specType === 'ngram-mod')
    ok('可行性等級', p.feasibility === 'gpu' && !!p.feasibilityLabel)

    const squeeze = plan.planRun({
      modelBytes: 4 * GiB2,
      info: info2,
      device: { id: 'Vulkan0', totalMiB: 8_192, freeMiB: 5_600 },
      cpu: { cores: 16 }
    })
    ok('顯存緊：先降 KV 檔位而不是先砍層', squeeze.cacheTypeK !== 'f16')
    ok('V 一旦量化就必須一起開 flash attention',
      squeeze.cacheTypeV === 'f16' || squeeze.flashAttn === true)
    ok('有講為什麼', squeeze.reasons.length > 0, JSON.stringify(squeeze.reasons))

    // MoE：塞不下時搬專家、不砍層（注意力留在 GPU 上才不會整個掉一個檔次）
    const moe = plan.planRun({
      modelBytes: 18 * GiB2,
      info: { ...info2, isMoe: true, expertCount: 128, expertUsedCount: 8, expertFfnLength: 768 },
      device: { id: 'Vulkan0', totalMiB: 16_000, freeMiB: 15_000 },
      cpu: { cores: 16 }
    })
    ok('MoE 塞不下：層數不砍', moe.gpuLayers === 36, String(moe.gpuLayers))
    ok('MoE 塞不下：改把專家放 CPU', moe.nCpuMoe > 0 && moe.nCpuMoe <= 36, String(moe.nCpuMoe))
    ok('MoE 的 preset 有 n-cpu-moe', plan.toPresetArgs(moe)['n-cpu-moe'] === String(moe.nCpuMoe))

    const multi = plan.planRun({
      modelBytes: 2 * GiB2,
      info: info2,
      cpu: { cores: 16 },
      devices: [
        { id: 'CUDA0', totalMiB: 16_000, freeMiB: 15_000 },
        { id: 'CUDA1', totalMiB: 12_000, freeMiB: 5_000 }
      ]
    })
    ok('多卡給 tensor-split', /^0\.\d+,0\.\d+$/.test(multi.tensorSplit), multi.tensorSplit)
    ok('單卡不給 tensor-split（給了會關掉 llama.cpp 自己的 fit）', p.tensorSplit === '')

    // fit 的結果要蓋掉估算（它是實際載一次量出來的）
    const fitted = plan.toPresetArgs(p, {
      fit: {
        ctxSize: 16_384,
        gpuLayers: 'all',
        tensorSplit: '0.6,0.4',
        overrideTensor: 'blk\\.(1[0-9])\\.ffn_.*=CPU'
      }
    })
    ok('有 fit 就用 fit 的 ctx', fitted['ctx-size'] === '16384')
    ok('有 fit 就用 fit 的層數（`-ngl -1` 已轉成 all）', fitted['gpu-layers'] === 'all')
    ok('override-tensor 原樣帶（MoE 的那串 regex 手寫不出來）',
      fitted['override-tensor'] === 'blk\\.(1[0-9])\\.ffn_.*=CPU')

    const raw = plan.parseRawArgs('  ubatch-size = 160\n# 註解\n--n-cpu-moe = 48\nbad line\nBAD_KEY = 1\n')
    ok('原始參數：一行一個 key = value', raw.args['ubatch-size'] === '160')
    ok('原始參數：前面的 -- 會剝掉', raw.args['n-cpu-moe'] === '48')
    ok('原始參數：註解略過、壞行回報', raw.rejected.length === 2, JSON.stringify(raw.rejected))
    ok('原始參數可以蓋掉自動決定的值（這就是「比 LM Studio 自由」）',
      plan.toPresetArgs(p, { rawArgs: 'ctx-size = 999' })['ctx-size'] === '999')

    const off = plan.planRun({
      modelBytes: 2 * GiB2,
      info: info2,
      device: roomy,
      cpu: { cores: 16 },
      requested: { specType: '', cacheTypeK: 'q8_0', cacheTypeV: 'q8_0', threads: 4 }
    })
    ok('使用者關掉投機解碼就真的不送', !plan.toPresetArgs(off)['spec-type'])
    ok('使用者指定的 KV 檔位照用', off.cacheTypeK === 'q8_0' && off.flashAttn === true)
    ok('使用者指定的執行緒照用', off.threads === 4)
  }

  // 本機真的有 GGUF 就順手讀一顆（合成的檔頭證明不了真實檔案的佈局）
  console.log('\n[E] 本機真實 GGUF（有才跑）')
  {
    const root = path.join(process.env.APPDATA || os.homedir(), 'voiceink', 'models')
    const candidates = [
      path.join(root, 'linguaforge08q4', 'gguf-v5e', 'linguaforge-v5e-0.8b-Q4_K_M.gguf'),
      path.join(root, 'qwen35translate', 'Qwen3.5-0.8B-Q4_K_M.gguf'),
      path.join(root, 'qwen354b', 'Qwen3.5-4B-Q4_K_M.gguf')
    ]
    const real = candidates.find((p) => fs.existsSync(p))
    if (!real) {
      console.log('  SKIP 本機沒有可用的 GGUF')
    } else {
      const info = gguf.readInfo(real)
      ok(`真檔可解析（${path.basename(real)}）`, !!info.arch && info.blockCount > 0,
        JSON.stringify({ arch: info.arch, layers: info.blockCount, ctx: info.contextTrain }))
      ok('真檔的量化從檔名判得出', catalog.parseQuant(path.basename(real)) !== '')
      const run = plan.planRun({
        modelBytes: info.fileBytes,
        info,
        device: { id: 'Vulkan0', totalMiB: 16_000, freeMiB: 15_000 }
      })
      ok('真檔能算出參數', run.ctxSize > 0 && run.gpuLayers > 0,
        JSON.stringify({ ctx: run.ctxSize, ngl: run.gpuLayers, kvMiB: run.kvMiB }))
    }
  }
  console.log('\n[F] 後端裝置清單')
  {
    const sample = [
      'load_backend: loaded RPC backend',
      'Available devices:',
      '  Vulkan0: NVIDIA GeForce RTX 5060 Ti (16265 MiB, 15350 MiB free)',
      '  Vulkan1: AMD Radeon Graphics (8192 MiB, 8000 MiB free)',
      '  CPU: AMD Ryzen 7 9800X3D'
    ].join('\n')
    const devices = hardware.parseDevices(sample)
    ok('只收得出有編號的後端裝置（CPU 不是選項）', devices.length === 2,
      JSON.stringify(devices.map((d) => d.id)))
    ok('顯存解析', devices[0].totalMiB === 16_265 && devices[0].freeMiB === 15_350)
    ok('裝置名不含顯存那一段', devices[0].name === 'NVIDIA GeForce RTX 5060 Ti', devices[0].name)
    ok('挑 free 最大的那顆', hardware.pickDevice(devices).id === 'Vulkan0')

    const noFree = hardware.parseDevices('  Vulkan0: Intel Arc A770 (8192 MiB)')
    ok('只報總量沒報剩餘時，當成全部可用（當成 0 會規劃出「什麼都放不下」）',
      noFree.length === 1 && noFree[0].totalMiB === 8192 && noFree[0].freeMiB === 8192)
    ok('沒有裝置回 null', hardware.pickDevice([]) === null)
    ok('空輸入不當機', hardware.parseDevices('').length === 0)
  }

  console.log('\n[G] Hub 輸入驗證（不打網路）')
  {
    ok('正常 repo id', hub.isRepoId('unsloth/Qwen3-4B-GGUF') === true)
    ok('少了 owner', hub.isRepoId('Qwen3-4B-GGUF') === false)
    ok('多一層路徑', hub.isRepoId('a/b/c') === false)
    ok('夾網址', hub.isRepoId('https://evil.example/x') === false)
    ok('非字串', hub.isRepoId(null) === false)

    ok('正常檔名', hub.isRepoPath('Q4_K_M/model-00001-of-00002.gguf') === true)
    ok('目錄跳脫', hub.isRepoPath('../../etc/passwd') === false)
    ok('絕對路徑', hub.isRepoPath('/etc/passwd') === false)
    ok('反斜線', hub.isRepoPath('a\\b.gguf') === false)

    ok('下載網址在 main 組出來',
      hub.fileUrl('unsloth/Qwen3-4B-GGUF', 'Qwen3-4B-Q4_K_M.gguf')
      === 'https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf')
    let threw = ''
    try { hub.fileUrl('unsloth/Qwen3-4B-GGUF', '../secret') } catch (error) { threw = error.code }
    ok('壞路徑組不出網址', threw === 'INVALID_PATH', threw)
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ===== 需要非同步的段落 =====

/**
 * 假的 fetch：照 `chunks` 逐塊吐，可指定狀態碼與 content-length
 * @param {{ status?: number, body: string, contentLength?: number, onCall?: (init: any) => void }} spec
 */
function fakeFetch(spec) {
  return async (url, init) => {
    if (spec.onCall) spec.onCall(init)
    const buf = Buffer.from(spec.body)
    return {
      ok: (spec.status || 200) < 400,
      status: spec.status || 200,
      headers: { get: (name) => (name === 'content-length' ? String(buf.length) : null) },
      body: (async function* () {
        for (let i = 0; i < buf.length; i += 4) yield buf.subarray(i, i + 4)
      })()
    }
  }
}

async function asyncSections() {
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceink-hfmodels-b-'))
  try {
    console.log('\n[H] 本機模型庫')
    {
      const root = path.join(tmp2, 'hf-models')
      library.setRoot(root)
      ok('合法 id', library.isValidId('Qwen3-4B-GGUF-Q4_K_M') === true)
      ok('路徑跳脫擋掉', library.isValidId('../evil') === false)
      ok('空字串擋掉', library.isValidId('') === false)
      let threw = ''
      try { library.dirFor('../evil') } catch (error) { threw = error.message }
      ok('dirFor 對壞 id 拋錯（那個值會被接成路徑）', /格式/.test(threw), threw)

      const modelDir = path.join(root, 'Demo-Q4_K_M')
      fs.mkdirSync(modelDir, { recursive: true })
      fs.writeFileSync(path.join(modelDir, 'demo-Q4_K_M.gguf'), Buffer.alloc(2048))
      fs.writeFileSync(path.join(modelDir, 'mmproj-F16.gguf'), Buffer.alloc(1024))
      fs.writeFileSync(path.join(modelDir, 'half.gguf.part'), Buffer.alloc(999))
      fs.mkdirSync(path.join(root, 'Empty-Folder'), { recursive: true })

      const models = library.list()
      ok('掃得到模型', models.length === 1 && models[0].id === 'Demo-Q4_K_M',
        JSON.stringify(models.map((m) => m.id)))
      ok('沒有 gguf 的資料夾不算模型', !models.some((m) => m.id === 'Empty-Folder'))
      ok('下載到一半的 .part 不算數', models[0].bytes === 3072, String(models[0].bytes))
      ok('認得出 mmproj', models[0].multimodal === true && models[0].mmproj === 'mmproj-F16.gguf')

      library.writeMeta('Demo-Q4_K_M', { repoId: 'owner/repo', quant: 'Q4_K_M' })
      ok('meta 存得住讀得回', library.readMeta('Demo-Q4_K_M').repoId === 'owner/repo')
      ok('meta 檔不會被當成模型', library.list().length === 1)
      ok('沒有 meta 不算錯', JSON.stringify(library.readMeta('Empty-Folder')) === '{}')

      ok('has()', library.has('Demo-Q4_K_M') === true && library.has('Nope') === false)

      const src = path.join(tmp2, 'user-model.gguf')
      fs.writeFileSync(src, Buffer.alloc(512))
      const imported = library.importFile(src)
      ok('匯入本機檔案', library.has(imported.id) === true, imported.id)
      ok('匯入是複製不是搬移', fs.existsSync(src) === true)

      ok('刪得掉', library.remove('Demo-Q4_K_M') === true && library.has('Demo-Q4_K_M') === false)
      ok('刪不存在的回 false', library.remove('Never-Existed') === false)
    }

    console.log('\n[I] 下載（假上游）')
    {
      const dir = path.join(tmp2, 'dl')
      const body = 'ABCDEFGHIJKLMNOP'

      const seen = []
      const fresh = await download.downloadFile({
        url: 'https://huggingface.co/x/y/resolve/main/a.gguf',
        dest: path.join(dir, 'a.gguf'),
        expectedBytes: body.length,
        fetchImpl: fakeFetch({ body }),
        onProgress: (info) => seen.push(info.received)
      })
      ok('下載得到完整檔案', fresh.bytes === body.length
        && fs.readFileSync(path.join(dir, 'a.gguf'), 'utf8') === body)
      ok('收尾把 .part 換成正式檔名', !fs.existsSync(path.join(dir, 'a.gguf.part')))
      ok('有回報進度', seen.length > 0 && seen[seen.length - 1] === body.length)

      // 續傳：已經有前 8 個位元組
      const partDest = path.join(dir, 'b.gguf')
      fs.writeFileSync(`${partDest}.part`, body.slice(0, 8))
      let sentRange = ''
      const resumed = await download.downloadFile({
        url: 'https://huggingface.co/x/y/resolve/main/b.gguf',
        dest: partDest,
        expectedBytes: body.length,
        fetchImpl: fakeFetch({
          status: 206,
          body: body.slice(8),
          onCall: (init) => { sentRange = init?.headers?.range || '' }
        })
      })
      ok('續傳有送 Range', sentRange === 'bytes=8-', sentRange)
      ok('續傳標記', resumed.resumed === true)
      ok('接回來的內容是完整的', fs.readFileSync(partDest, 'utf8') === body)

      // 上游不支援 Range：回 200 整包 → 要從頭來，不能把整包接在舊的後面
      const ignoreDest = path.join(dir, 'c.gguf')
      fs.writeFileSync(`${ignoreDest}.part`, body.slice(0, 8))
      await download.downloadFile({
        url: 'https://huggingface.co/x/y/resolve/main/c.gguf',
        dest: ignoreDest,
        expectedBytes: body.length,
        fetchImpl: fakeFetch({ status: 200, body })
      })
      ok('上游忽略 Range 時重新來過（不會接成兩倍長）',
        fs.readFileSync(ignoreDest, 'utf8') === body,
        String(fs.statSync(ignoreDest).size))

      // 大小對不上：要拋錯，而且 .part 要留著給下次續傳
      let sizeError = ''
      const shortDest = path.join(dir, 'd.gguf')
      try {
        await download.downloadFile({
          url: 'https://huggingface.co/x/y/resolve/main/d.gguf',
          dest: shortDest,
          expectedBytes: 999,
          fetchImpl: fakeFetch({ body })
        })
      } catch (error) { sizeError = error.message }
      ok('大小對不上要拋錯（截斷的 gguf 只會在載入時才爆）', /沒有完成/.test(sizeError), sizeError)
      ok('失敗時 .part 留著給下次續傳', fs.existsSync(`${shortDest}.part`) === true)
      ok('失敗時不會產生正式檔名', fs.existsSync(shortDest) === false)

      // 取消
      const controller = new AbortController()
      controller.abort()
      let cancelError = ''
      try {
        await download.downloadFile({
          url: 'https://huggingface.co/x/y/resolve/main/e.gguf',
          dest: path.join(dir, 'e.gguf'),
          signal: controller.signal,
          fetchImpl: fakeFetch({ body })
        })
      } catch (error) { cancelError = error.message }
      ok('已取消就不要開始', /取消/.test(cancelError), cancelError)

      // 非 https 一律不打
      let schemeError = ''
      try {
        await download.downloadFile({ url: 'http://evil.example/x.gguf', dest: path.join(dir, 'f.gguf') })
      } catch (error) { schemeError = error.message }
      ok('只走 https', /網址/.test(schemeError), schemeError)

      // 多檔（分片＋mmproj）
      const variantDir = path.join(dir, 'variant')
      const progress = []
      await download.downloadVariant({
        dir: variantDir,
        files: [
          { url: 'https://huggingface.co/x/y/resolve/main/p1.gguf', name: 'p1.gguf', size: body.length },
          { url: 'https://huggingface.co/x/y/resolve/main/mmproj.gguf', name: 'mmproj.gguf', size: body.length }
        ],
        fetchImpl: fakeFetch({ body }),
        onProgress: (info) => progress.push(info)
      })
      ok('多檔都下載完', fs.readdirSync(variantDir).sort().join(',') === 'mmproj.gguf,p1.gguf')
      ok('進度是整個變體的累計', progress.length > 0
        && progress[progress.length - 1].total === body.length * 2
        && progress[progress.length - 1].received === body.length * 2,
      JSON.stringify(progress[progress.length - 1]))
    }

    console.log('\n[J] presets.ini')
    {
      const text = presets.render(
        [
          { id: 'Demo-Q4_K_M', args: { 'ctx-size': 8192, 'gpu-layers': 36 } },
          { id: 'bad id!', args: { 'ctx-size': 1024 } },
          { id: 'Has-Bad-Key', args: { 'ctx-size': 2048, 'DROP TABLE': 'x' } }
        ],
        { device: 'Vulkan0' }
      )
      ok('有 version 標頭', text.startsWith('version = 1'))
      ok('[*] 放全域設定', text.includes('[*]\ndevice = Vulkan0'))
      ok('長選項名（實測 router 吃得到）', text.includes('[Demo-Q4_K_M]\nctx-size = 8192\ngpu-layers = 36'))
      ok('壞 id 整段不寫', !text.includes('bad id'))
      ok('壞 key 只跳過那一行', text.includes('[Has-Bad-Key]\nctx-size = 2048') && !text.includes('DROP'))

      const injected = presets.render([{ id: 'X', args: { device: 'Vulkan0\n[*]\nctx-size = 1' } }])
      ok('值裡的換行清掉（否則會多長出一個區段）',
        !/\n\[\*\]/.test(injected.replace('version = 1\n', '')), injected)

      // `override-tensor` 的值是 llama.cpp 自己產的 regex，一定含中括號。
      // 把它當成注入字元清掉不會報錯，只會默默把 MoE 的層搬錯地方。
      const otRegex = 'blk\\.(1[0-9])\\.ffn_.*=CPU'
      const withOt = presets.render([{ id: 'Y', args: { 'override-tensor': otRegex } }])
      ok('override-tensor 的中括號要留著（清掉會把 MoE 的規則默默改掉）',
        withOt.includes(`override-tensor = ${otRegex}`), withOt)

      const file = path.join(tmp2, 'presets.ini')
      presets.write(file, [{ id: 'Demo', args: { 'ctx-size': 4096 } }])
      ok('寫得出檔案', fs.readFileSync(file, 'utf8').includes('ctx-size = 4096'))
      ok('沒有留下 .tmp', !fs.existsSync(`${file}.tmp`))
    }
  } finally {
    fs.rmSync(tmp2, { recursive: true, force: true })
  }
}

asyncSections()
  .catch((error) => {
    failed++
    console.log(`  FAIL 非同步測試拋錯 — ${error && error.stack}`)
  })
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed === 0 ? 0 : 1)
  })
