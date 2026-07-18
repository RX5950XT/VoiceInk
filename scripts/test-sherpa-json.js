/**
 * 驗證 sherpa JSON 控制字元修復（不需 electron / 模型）
 */
const path = require('path')

// 直接讀 local-asr 會拉 models/electron；改成內嵌同源實作對照，
// 並用 Function 從檔案抽出函式本體測一次。
const fs = require('fs')
const src = fs.readFileSync(path.join(__dirname, '../src/main/local-asr.js'), 'utf8')

function extractFn(name) {
  const re = new RegExp(`function ${name}\\([^{]*\\)\\s*\\{[\\s\\S]*?\\n\\}`)
  // 較穩：找 function name 到下一個 \nfunction 或 \n/** 
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error('missing ' + name)
  let i = src.indexOf('{', start)
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) {
        // eslint-disable-next-line no-new-func
        return new Function(`${src.slice(start, i + 1)}; return ${name};`)()
      }
    }
  }
  throw new Error('unclosed ' + name)
}

const repairJsonControlChars = extractFn('repairJsonControlChars')
// parseSherpaJson 閉包依賴 repairJsonControlChars — 綁在同一 scope
const parseSherpaJson = (() => {
  const start = src.indexOf('function parseSherpaJson(')
  if (start < 0) throw new Error('missing parseSherpaJson')
  let i = src.indexOf('{', start)
  let depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) {
        // eslint-disable-next-line no-new-func
        return new Function(
          'repairJsonControlChars',
          `${src.slice(start, i + 1)}; return parseSherpaJson;`
        )(repairJsonControlChars)
      }
    }
  }
  throw new Error('unclosed parseSherpaJson')
})()

let fail = 0
function check(name, cond, detail = '') {
  if (cond) console.log('PASS', name, detail)
  else {
    fail++
    console.error('FAIL', name, detail)
  }
}

// 1) 正常 JSON
check('normal', parseSherpaJson('{"text":"你好"}').text === '你好')

// 2) 字串內 raw tab / newline（正是 Bad control character 的來源）
const bad = '{"text":"hello\tworld\nnext","timestamps":[]}'
let threw = false
try {
  JSON.parse(bad)
} catch {
  threw = true
}
check('raw control throws on JSON.parse', threw)
const fixed = parseSherpaJson(bad)
check('repaired text', fixed.text === 'hello\tworld\nnext', JSON.stringify(fixed.text))

// 3) 含 null 控制字元
const withNull = '{"text":"a\u0000b"}'
check('null char', parseSherpaJson(withNull).text === 'a\u0000b')

// 4) 空
check('empty', parseSherpaJson('').text === '')
check('nullish', parseSherpaJson(null).text === '')

// 5) 完全壞掉仍不 throw
check('garbage no throw', parseSherpaJson('not-json{{{').text === '')

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
