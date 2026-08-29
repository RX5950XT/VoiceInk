#!/usr/bin/env node
/**
 * 探測：代跑 `agy.exe models` 續期為什麼在 App 裡會等滿 60 秒逾時。
 *
 * 三種情境各量一次：
 *   A 現況（execFile，windowsHide，繼承 stdin）
 *   B stdin 直接關掉（spawn，stdio ignore/pipe/pipe）
 *   C 假裝找不到憑證（把 HOME 系列環境變數指到暫存目錄）——這是「真的過期、CLI 想重新登入」
 *     的安全替身；如果 CLI 在這裡卡住不動，就證實了「沒有主控台／stdin 時會等互動輸入」。
 *
 *   node scripts/probe-agy-nudge.js
 */
'use strict'

const { execFile, spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const TIMEOUT_MS = 25000

function cliPath() {
  const local = process.env.LOCALAPPDATA || ''
  const target = path.join(local, 'agy', 'bin', 'agy.exe')
  return fs.existsSync(target) ? target : ''
}

/**
 * @param {string} label
 * @param {object} options
 * @param {'inherit'|'ignore'} stdin
 * @param {object} env
 */
function run(label, stdin, env) {
  const exe = cliPath()
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(exe, ['models'], {
      windowsHide: true,
      stdio: [stdin, 'pipe', 'pipe'],
      env
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ label, ms: Date.now() - started, result: 'TIMEOUT', out: out.slice(0, 120), err: err.slice(0, 200) })
    }, TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        label,
        ms: Date.now() - started,
        result: `exit ${code}`,
        out: out.slice(0, 120).replace(/\s+/g, ' '),
        err: err.slice(0, 200).replace(/\s+/g, ' ')
      })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ label, ms: Date.now() - started, result: 'ERROR ' + e.message })
    })
  })
}

/** 目前 credential.js 用的那一版 */
function runExecFile(label, env) {
  const exe = cliPath()
  const started = Date.now()
  return new Promise((resolve) => {
    execFile(exe, ['models'], { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024, env },
      (error, stdout, stderr) => {
        resolve({
          label,
          ms: Date.now() - started,
          result: error ? (error.killed ? 'TIMEOUT' : 'error ' + error.code) : 'ok',
          out: String(stdout).slice(0, 120).replace(/\s+/g, ' '),
          err: String(stderr).slice(0, 200).replace(/\s+/g, ' ')
        })
      })
  })
}

/** @param {string} label */
function runAllIgnored(label) {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(cliPath(), ['models'], { windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ label, ms: Date.now() - started, result: 'TIMEOUT' })
    }, TIMEOUT_MS)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ label, ms: Date.now() - started, result: `exit ${code}` })
    })
  })
}

async function main() {
  if (!cliPath()) {
    console.log('找不到 agy.exe，跳過')
    return
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-nocred-'))
  const blindEnv = {
    ...process.env,
    USERPROFILE: sandbox,
    HOME: sandbox,
    LOCALAPPDATA: path.join(sandbox, 'Local'),
    APPDATA: path.join(sandbox, 'Roaming')
  }

  const rows = []
  rows.push(await runExecFile('A execFile（現況，stdin 繼承）', process.env))
  rows.push(await run('B spawn，stdin=ignore', 'ignore', process.env))
  rows.push(await run('C 找不到憑證 + stdin=ignore', 'ignore', blindEnv))
  rows.push(await run('D 找不到憑證 + stdin 繼承', 'inherit', blindEnv))
  // execFile 的預設就是「stdin 是一條開著、永遠不會收到 EOF 的 pipe」，而且它不會幫你關。
  // 這一條若也逾時，就證實卡住的原因是 stdin 而不是 execFile 本身。
  rows.push(await run('E spawn，stdin=pipe（不寫也不關）', 'pipe', process.env))
  rows.push(await runAllIgnored('F spawn，三個都 ignore（打算採用的寫法）'))

  // G：走真正的 credential.acquire（不注入 runCli），確認整條路真的不再卡住。
  // 需要 electron 才載得動（credential → usage/antigravity → electron），用 node 跑會跳過。
  try {
    const credential = require(path.join(__dirname, '..', 'src/main/agy/credential.js'))
    const iso = (deltaMs) => new Date(Date.now() + deltaMs).toISOString()
    const expired = JSON.stringify({
      token: { access_token: 'dead-token', refresh_token: 'r', expiry: iso(-60 * 1000) }
    })
    const started = Date.now()
    let outcome = 'ok'
    try {
      await credential.acquire({
        readCredential: async () => expired,
        refresh: async () => '',
        loadCodeAssist: async () => ({ project: 'p', tier: 't' }),
        now: () => Date.now()
      })
    } catch (error) {
      outcome = error.code || error.message
    }
    rows.push({
      label: 'G credential.acquire（真的 runAgyCli，過期憑證 → 走阻塞續期）',
      ms: Date.now() - started,
      result: outcome,
      out: '期望：幾秒內就回，而不是等滿逾時'
    })
    credential.reset()
  } catch (error) {
    rows.push({ label: 'G（略過，需要 electron）', ms: 0, result: error.message.slice(0, 60) })
  }

  for (const r of rows) {
    console.log(`\n${r.label}`)
    console.log(`  ${r.result}  ${r.ms}ms`)
    if (r.out) console.log(`  stdout: ${r.out}`)
    if (r.err) console.log(`  stderr: ${r.err}`)
  }
  try { fs.rmSync(sandbox, { recursive: true, force: true }) } catch { /* best effort */ }
}

main()
