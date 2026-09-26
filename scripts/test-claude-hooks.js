#!/usr/bin/env node
/**
 * Claude Code hooks：settings 只動我們自己的那幾筆、事件驗證、狀態歸約、重開接回。
 *
 * 家目錄指到暫存。這支**不可以**寫到使用者的 ~/.claude/settings.json。
 * 最後一節才用真的 `claude -p` 打暫存 settings，確認 Windows 上 hook 真的會被叫到
 * （`VOICEINK_LIVE_CLAUDE=1` 才跑）。
 */

'use strict'

const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn, execFileSync } = require('child_process')
const { tempDir } = require('./lib/test-temp')

const ROOT = path.join(__dirname, '..')
const claudeSettings = require(path.join(ROOT, 'src/main/ccswitch/claude-settings.js'))
const store = require(path.join(ROOT, 'src/main/terminal/store.js'))
const hooks = require(path.join(ROOT, 'src/main/terminal/claude-hooks.js'))

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

const tmpHome = tempDir('voiceink-claude-hooks-')
claudeSettings.configure({
  homeDir: tmpHome,
  backupDir: path.join(tmpHome, 'backup')
})

const realSettings = path.join(os.homedir(), '.claude', 'settings.json')
function realStamp() {
  try { return fs.statSync(realSettings).mtimeMs } catch { return null }
}
const realBefore = realStamp()

const SID = '3d5f2c1a-9b8e-4d7c-a6f5-112233445566'
const SID2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const CMD = '"C:/Users/a b/AppData/Roaming/voiceink/claude-hook/voiceink-claude-hook.exe" claude-hook'

function writeLive(obj) {
  const file = claudeSettings.settingsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof obj === 'string' ? obj : `${JSON.stringify(obj, null, 2)}\n`)
}

function readLive() {
  return JSON.parse(fs.readFileSync(claudeSettings.settingsPath(), 'utf8'))
}

function countOurs(settings) {
  let n = 0
  const groups = settings.hooks && typeof settings.hooks === 'object' ? Object.values(settings.hooks) : []
  for (const list of groups) {
    if (!Array.isArray(list)) continue
    for (const group of list) {
      for (const hook of (group && group.hooks) || []) {
        if (hook && String(hook.command).includes('voiceink-claude-hook.exe')) n += 1
      }
    }
  }
  return n
}

function settingsMerge() {
  console.log('\n[settings 合併]')
  ok('測試的 settings 在暫存家目錄', claudeSettings.settingsPath().startsWith(tmpHome))
  ok('不是使用者的 settings.json', path.normalize(claudeSettings.settingsPath()) !== path.normalize(realSettings))

  const orca = { type: 'command', command: 'C:/orca/hook.exe run', timeout: 30 }
  writeLive({
    env: { ANTHROPIC_MODEL: 'keep-me' },
    permissions: { allow: ['Bash'] },
    statusLine: { type: 'command', command: 'orca-status' },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [orca, { type: 'command', command: CMD }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'C:/orca/stop.exe' }] }]
    }
  })
  const first = claudeSettings.applyHooks(CMD)
  ok('第一次有寫入', first.ok === true && first.changed === true)
  const once = readLive()
  ok('別人的 env／permissions／statusLine 還在',
    once.env.ANTHROPIC_MODEL === 'keep-me' && once.permissions.allow[0] === 'Bash' && once.statusLine.command === 'orca-status')
  ok('Orca 的 Bash hook 還在，而且不再跟我們擠在同一群',
    once.hooks.PreToolUse.some((group) => group.matcher === 'Bash' && group.hooks.length === 1 && group.hooks[0].command === orca.command))
  ok('Orca 的 Stop hook 還在',
    once.hooks.Stop.some((group) => (group.hooks || []).some((hook) => hook.command === 'C:/orca/stop.exe')))
  ok('八個事件各一筆我們的 hook', countOurs(once) === claudeSettings.HOOK_SPECS.length)
  const pre = once.hooks.PreToolUse.find((group) => (group.hooks || []).some((hook) => String(hook.command).includes('voiceink-claude-hook.exe')))
  ok('PreToolUse 的 matcher 是那兩個會卡住的工具', Boolean(pre && pre.matcher === 'AskUserQuestion|ExitPlanMode'))
  const perm = once.hooks.PermissionRequest.find((group) => (group.hooks || []).some((hook) => String(hook.command).includes('voiceink-claude-hook.exe')))
  ok('PermissionRequest matcher 是 *', Boolean(perm && perm.matcher === '*'))
  ok('timeout 是 5', Boolean(pre && pre.hooks[0].timeout === 5 && pre.hooks[0].type === 'command'))

  const second = claudeSettings.applyHooks(CMD)
  const twice = readLive()
  ok('重跑不重複、也不再寫', second.ok === true && second.changed === false && JSON.stringify(once) === JSON.stringify(twice))
  ok('冪等之後仍然各一筆', countOurs(twice) === claudeSettings.HOOK_SPECS.length)

  const input = JSON.parse(JSON.stringify(once))
  const merged = claudeSettings.mergeHooks(input, CMD)
  ok('mergeHooks 不改輸入', JSON.stringify(input) === JSON.stringify(once))
  ok('merge 結果跟磁碟上一致', JSON.stringify(merged.hooks) === JSON.stringify(twice.hooks))

  writeLive('{ this is not json')
  const beforeBad = fs.readFileSync(claudeSettings.settingsPath())
  const bad = claudeSettings.applyHooks(CMD)
  const afterBad = fs.readFileSync(claudeSettings.settingsPath())
  ok('壞 JSON 不寫', bad.ok === false && bad.reason === 'SETTINGS_INVALID_JSON' && beforeBad.equals(afterBad))

  fs.unlinkSync(claudeSettings.settingsPath())
  const created = claudeSettings.applyHooks(CMD)
  ok('沒有 settings.json 時會新建只含我們的 hooks', created.ok === true && created.changed === true && countOurs(readLive()) === 8)

  const quoted = hooks.hookCommand('C:\\Users\\a b\\voiceink')
  ok('command 用斜線與引號', quoted === '"C:/Users/a b/voiceink/claude-hook/voiceink-claude-hook.exe" claude-hook')
  ok('路徑裡有引號就不組', hooks.hookCommand('C:\\a"b') === '')
}

function eventChecks() {
  console.log('\n[事件驗證]')
  const good = hooks.parseEvent({
    v: 1,
    terminalId: 't_hook1',
    event: 'UserPromptSubmit',
    sessionId: SID,
    transcriptPath: `C:\\Users\\a\\.claude\\${SID}.jsonl`,
    source: 'startup'
  })
  ok('合法事件收得下', Boolean(good && good.event === 'UserPromptSubmit' && good.sessionId === SID))
  ok('終端機 id 不合法丟掉', hooks.parseEvent({ v: 1, terminalId: '../x', event: 'Stop', sessionId: SID }) === null)
  ok('session 不是 UUID 丟掉', hooks.parseEvent({ v: 1, terminalId: 't_hook1', event: 'Stop', sessionId: 'not-a-uuid' }) === null)
  ok('不認識的事件丟掉', hooks.parseEvent({ v: 1, terminalId: 't_hook1', event: 'PreCompact', sessionId: SID }) === null)
  ok('超長字串丟掉', hooks.parseEvent({
    v: 1, terminalId: 't_hook1', event: 'Stop', sessionId: SID, reason: 'r'.repeat(201)
  }) === null)
  ok('版本不對丟掉', hooks.parseEvent({ v: 2, terminalId: 't_hook1', event: 'Stop', sessionId: SID }) === null)
}

function reductionChecks() {
  console.log('\n[歸約]')
  let current = null
  let step = hooks.reduceAgent(current, { event: 'SessionStart', sessionId: SID, source: 'startup' })
  ok('第一個 SessionStart 採用，狀態 idle', step.adopt === true && step.next && step.next.state === 'idle' && step.changed === true)
  current = step.next

  step = hooks.reduceAgent(current, { event: 'SessionStart', sessionId: SID2, source: 'startup' })
  ok('巢狀 startup 不切換', step.adopt === false && step.next.sessionId === SID && step.changed === false)
  current = step.next

  step = hooks.reduceAgent(current, { event: 'UserPromptSubmit', sessionId: SID2 })
  ok('別的 session 的事件忽略', step.changed === false && step.next.state === 'idle')

  step = hooks.reduceAgent(current, { event: 'UserPromptSubmit', sessionId: SID })
  ok('UserPromptSubmit → working', step.changed === true && step.next.state === 'working')
  current = step.next

  step = hooks.reduceAgent(current, { event: 'PermissionRequest', sessionId: SID })
  ok('PermissionRequest → waiting', step.next.state === 'waiting')
  current = step.next

  step = hooks.reduceAgent(current, { event: 'PreToolUse', sessionId: SID, toolName: 'Bash' })
  ok('其他 PreToolUse 不改狀態', step.changed === false && step.next.state === 'waiting')
  step = hooks.reduceAgent({ sessionId: SID, state: 'working' }, { event: 'PreToolUse', sessionId: SID, toolName: 'ExitPlanMode' })
  ok('ExitPlanMode → waiting', step.changed === true && step.next.state === 'waiting')
  step = hooks.reduceAgent({ sessionId: SID, state: 'working' }, { event: 'PreToolUse', sessionId: SID, toolName: 'AskUserQuestion' })
  ok('AskUserQuestion → waiting', step.next.state === 'waiting')

  const typed = hooks.applyInput(current, '\r')
  ok('waiting 時按 Enter → working', typed.changed === true && typed.next.state === 'working')
  ok('waiting 時按數字選項 → working', hooks.applyInput(current, '1').next.state === 'working')
  ok('waiting 時焦點進出不算回答', hooks.applyInput(current, '\x1b[I').changed === false)
  ok('waiting 時滑鼠回報不算回答', hooks.applyInput(current, '\x1b[<0;10;5M').changed === false)
  ok('waiting 時 Esc → idle', hooks.applyInput(current, '\x1b').next.state === 'idle')
  ok('working 時一般打字不變', hooks.applyInput(typed.next, 'a').changed === false)
  ok('working 時 Esc 中斷 → idle', hooks.applyInput(typed.next, '\x1b').next.state === 'idle')
  ok('working 時 Ctrl+C 中斷 → idle', hooks.applyInput(typed.next, '\x03').next.state === 'idle')
  ok('idle 時 Esc 不變', hooks.applyInput({ sessionId: SID, state: 'idle' }, '\x1b').changed === false)

  step = hooks.reduceAgent(typed.next, { event: 'Notification', sessionId: SID, notificationType: 'permission_prompt' })
  ok('permission_prompt → waiting', step.next.state === 'waiting')
  step = hooks.reduceAgent(step.next, { event: 'Notification', sessionId: SID, notificationType: 'elicitation_dialog' })
  ok('elicitation_dialog 維持 waiting', step.changed === false && step.next.state === 'waiting')
  step = hooks.reduceAgent(step.next, { event: 'Notification', sessionId: SID, notificationType: 'idle_prompt' })
  ok('idle_prompt → idle', step.changed === true && step.next.state === 'idle')
  current = step.next

  step = hooks.reduceAgent(current, { event: 'SessionStart', sessionId: SID2, source: 'clear' })
  ok('clear 切換到新的 session', step.adopt === true && step.next.sessionId === SID2 && step.next.state === 'idle')
  step = hooks.reduceAgent(current, { event: 'SessionStart', sessionId: SID2, source: 'resume' })
  ok('resume 也切換', step.adopt === true && step.next.sessionId === SID2)

  step = hooks.reduceAgent({ sessionId: SID, state: 'working' }, { event: 'Stop', sessionId: SID })
  ok('Stop → idle 但還留著這段對話', Boolean(step.next && step.next.state === 'idle' && step.next.sessionId === SID))
  step = hooks.reduceAgent(step.next, { event: 'StopFailure', sessionId: SID })
  ok('StopFailure 也是 idle', step.next.state === 'idle' && step.changed === false)
  step = hooks.reduceAgent({ sessionId: SID, state: 'idle' }, { event: 'SessionEnd', sessionId: SID })
  ok('SessionEnd 清掉', step.next === null && step.changed === true)

  const tracked = { sessionId: SID, state: 'working' }
  const flipped = hooks.applyStatus(tracked, null, { state: 'idle', exitCode: 0 })
  ok('exitCode 從 null 變數字就清掉', flipped.changed === true && flipped.next === null && flipped.code === 0)
  const held = hooks.applyStatus(tracked, 0, { state: 'idle', exitCode: 0 })
  ok('離開碼沒變就不清', held.changed === false && held.next === tracked)
  const back = hooks.applyStatus(tracked, 0, { state: 'running', exitCode: null })
  ok('離開碼變回 null 不清（新指令開始）', back.changed === false && back.code === null)
  const died = hooks.applyStatus(tracked, null, { state: 'exited', exitCode: null })
  ok('exited 清掉', died.changed === true && died.next === null && died.forget === true)
  ok('沒在追蹤時離開碼變了也不必送', hooks.applyStatus(null, null, { state: 'idle', exitCode: 1 }).changed === false)
}

async function resumeChecks() {
  console.log('\n[接回]')
  ok('合法 UUID 接回', store.startupCommand('claude', SID) === `claude --resume ${SID}`)
  ok('大寫 UUID 也接回', store.startupCommand('claude', SID.toUpperCase()) === `claude --resume ${SID.toUpperCase()}`)
  ok('不是 UUID 就照舊 claude', store.startupCommand('claude', 'not-a-uuid') === 'claude')
  ok('夾帶殼層字元不算 UUID', store.startupCommand('claude', `${SID};calc`) === 'claude')
  ok('別的 preset 不因 UUID 改寫', store.startupCommand('codex', SID) === store.PRESETS.codex.command)
  ok('未知 preset 退回純 shell', store.startupCommand('rm -rf', SID) === '')

  const transcript = `C:\\Users\\a\\.claude\\projects\\demo\\${SID}.jsonl`
  const kept = store.sanitizeAll([{
    id: 't_keep', shell: 'cmd', preset: 'claude', cwd: os.homedir(),
    claudeSessionId: SID, claudeTranscript: transcript
  }])
  ok('sanitize 留下合法的對話 id 與路徑', kept[0].claudeSessionId === SID && kept[0].claudeTranscript === transcript)
  const dropped = store.sanitizeAll([{
    id: 't_drop', shell: 'cmd', preset: 'claude', cwd: os.homedir(),
    claudeSessionId: 'not-a-uuid', claudeTranscript: transcript
  }])
  ok('不合法的對話 id 整組拿掉', dropped[0].claudeSessionId === undefined && dropped[0].claudeTranscript === undefined)
  const relative = store.sanitizeAll([{
    id: 't_rel', shell: 'cmd', preset: 'claude', cwd: os.homedir(),
    claudeSessionId: SID, claudeTranscript: `${SID}.jsonl`
  }])
  ok('相對路徑不留', relative[0].claudeTranscript === undefined)
  const dotdot = store.sanitizeAll([{
    id: 't_dot', shell: 'cmd', preset: 'claude', cwd: os.homedir(),
    claudeSessionId: SID, claudeTranscript: `C:\\Users\\..\\${SID}.jsonl`
  }])
  ok('路徑裡的 .. 不留', dotdot[0].claudeTranscript === undefined)

  const dir = tempDir('voiceink-claude-resume-')
  const liveFile = path.join(dir, `${SID}.jsonl`)
  const meta = {
    id: 't_resume', preset: 'claude', shell: 'pwsh', cwd: dir,
    claudeSessionId: SID, claudeTranscript: liveFile
  }
  const missing = await hooks.prepareResume(meta)
  ok('對話檔不在就把兩個欄位拿掉', missing.claudeSessionId === undefined && missing.claudeTranscript === undefined && missing.id === 't_resume')
  fs.writeFileSync(liveFile, '{}\n')
  const present = await hooks.prepareResume(meta)
  ok('對話檔在就原樣傳給宿主', present.claudeSessionId === SID && present.claudeTranscript === liveFile)
  const other = await hooks.prepareResume({ ...meta, preset: 'shell' })
  ok('不是 claude preset 不動這兩個欄位', other.claudeSessionId === SID)
}

function findClaude() {
  try {
    const out = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe'), ['claude'], {
      encoding: 'utf8', windowsHide: true
    })
    return out.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || ''
  } catch {
    return ''
  }
}

function runClaude(bin, args, env, timeoutMs) {
  return new Promise((resolve) => {
    // stdin 要關掉。留著 pipe 的話 claude -p 會空等「是不是還有從管道進來的提示」三秒。
    const child = spawn(bin, args, { env, windowsHide: true, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch { /* 已經結束 */ }
      resolve({ code: -1, stdout, stderr, timedOut: true })
    }, timeoutMs)
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr, error }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

function eventFiles(dir) {
  let names = []
  try { names = fs.readdirSync(dir) } catch { return [] }
  return names.filter((name) => name.endsWith('.json')).sort()
}

async function liveHook() {
  console.log('\n[真的叫起 Claude]')
  const probe = path.join(ROOT, 'resources', 'probe', 'voiceink-probe.exe')
  if (!fs.existsSync(probe)) {
    ok('有 build 出來的 voiceink-probe.exe', false, probe)
    return
  }
  if (!fs.readFileSync(probe).includes(Buffer.from('claude-hook'))) {
    ok('probe exe 含 claude-hook 子指令', false, '先 npm run build:probe')
    return
  }
  const bin = findClaude()
  if (!bin) {
    ok('PATH 上找得到 claude', false)
    return
  }
  const dir = tempDir('voiceink-claude-live-')
  const exe = path.join(dir, 'voiceink-claude-hook.exe')
  fs.writeFileSync(exe, fs.readFileSync(probe))
  const events = path.join(dir, 'events')
  const settings = path.join(dir, 'settings.json')
  const command = `"${exe.replace(/\\/g, '/')}" claude-hook`
  const specced = claudeSettings.mergeHooks({}, command)
  fs.writeFileSync(settings, `${JSON.stringify(specced, null, 2)}\n`)

  let help = ''
  try {
    help = execFileSync(bin, ['--help'], { encoding: 'utf8', windowsHide: true, timeout: 20000, shell: true })
  } catch (error) {
    help = `${error.stdout || ''}${error.stderr || ''}`
  }
  const extra = []
  if (help.includes('--dangerously-skip-permissions')) extra.push('--dangerously-skip-permissions')
  else if (help.includes('bypassPermissions')) extra.push('--permission-mode', 'bypassPermissions')

  const baseEnv = { ...process.env }
  delete baseEnv.CLAUDE_JOB_DIR
  const env = { ...baseEnv, VOICEINK_TERMINAL_ID: 't_hooklive01' }
  const args = ['-p', 'reply with exactly: ok', '--settings', settings, ...extra]
  console.log(`  claude ${bin}`)
  const ran = await runClaude(bin, args, env, 180000)
  console.log(`  exit ${ran.code}${ran.timedOut ? ' timeout' : ''}`)
  if (ran.stdout) console.log(`  stdout: ${ran.stdout.trim().slice(0, 500)}`)
  if (ran.stderr) console.log(`  stderr: ${ran.stderr.trim().slice(0, 500)}`)

  const files = eventFiles(events)
  const records = files.map((name) => JSON.parse(fs.readFileSync(path.join(events, name), 'utf8')))
  console.log('  events:')
  for (const rec of records) console.log(`  ${JSON.stringify(rec)}`)
  const names = records.map((rec) => rec.event)
  ok('有 SessionStart', names.includes('SessionStart'))
  ok('有 UserPromptSubmit', names.includes('UserPromptSubmit'))
  ok('有 Stop', names.includes('Stop'))
  ok('終端機 id 與版本對', records.length > 0 && records.every((rec) => rec.v === 1 && rec.terminalId === 't_hooklive01' && typeof rec.sessionId === 'string' && rec.sessionId.includes('-')))
  const out = ran.stdout || ''
  ok('Claude 的輸出沒有被 hook 的 JSON 汙染',
    out.trim().length > 0 && !out.includes('hook_event_name') && !out.includes('voiceink-claude-hook') && !out.includes('"terminalId"') && !out.includes('SessionStart'))

  const before = new Set(eventFiles(events))
  const quiet = { ...baseEnv }
  delete quiet.VOICEINK_TERMINAL_ID
  const second = await runClaude(bin, args, quiet, 180000)
  const after = eventFiles(events).filter((name) => !before.has(name))
  console.log(`  沒有 id 的那次 exit ${second.code}，新檔 ${after.length}`)
  ok('沒有 VOICEINK_TERMINAL_ID 就不寫事件', after.length === 0)
}

async function main() {
  settingsMerge()
  eventChecks()
  reductionChecks()
  await resumeChecks()
  ok('單元測試沒有改到真的 settings.json', realStamp() === realBefore)
  // 真的叫 claude 會花額度、在 ~/.claude/projects 留對話，只在明講時跑
  if (process.env.VOICEINK_LIVE_CLAUDE === '1') await liveHook()
  else console.log('\n[真的叫起 Claude] 略過（設 VOICEINK_LIVE_CLAUDE=1 才跑）')
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
