#!/usr/bin/env node

'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')

const ROOT = path.join(__dirname, '..')
const size = require(path.join(ROOT, 'src/main/explorer/size.js'))
const rawFs = require(path.join(ROOT, 'src/main/raw-fs.js'))

async function main() {
  const root = tempDir('vi-ex-size-errors-')
  const denied = path.join(root, 'denied')
  const vanished = path.join(root, 'vanished.bin')
  fs.mkdirSync(denied)
  fs.writeFileSync(path.join(root, 'kept.bin'), Buffer.alloc(10))
  fs.writeFileSync(path.join(denied, 'hidden.bin'), Buffer.alloc(20))
  fs.writeFileSync(vanished, Buffer.alloc(30))

  const promiseFs = rawFs.promises
  const originalReaddir = promiseFs.readdir
  const originalLstat = promiseFs.lstat
  const resolve = (value) => path.resolve(String(value))
  try {
    promiseFs.readdir = async (target, ...args) => {
      if (resolve(target) === resolve(denied)) {
        const error = new Error('denied')
        error.code = 'EACCES'
        throw error
      }
      return originalReaddir.call(promiseFs, target, ...args)
    }
    const unreadable = await size.folderSize(root, 'nested-read-error')
    assert.equal(unreadable.incomplete, true, '巢狀 readdir 失敗要標 incomplete')

    promiseFs.readdir = originalReaddir
    promiseFs.lstat = async (target, ...args) => {
      if (resolve(target) === resolve(vanished)) {
        const error = new Error('vanished')
        error.code = 'ENOENT'
        throw error
      }
      return originalLstat.call(promiseFs, target, ...args)
    }
    const missing = await size.folderSize(root, 'nested-stat-error')
    assert.equal(missing.incomplete, true, '子項 lstat 失敗要標 incomplete')
  } finally {
    promiseFs.readdir = originalReaddir
    promiseFs.lstat = originalLstat
    removeTree(root)
  }

  console.log('PASS nested folder-size errors are incomplete')
}

main().catch((error) => {
  console.error(`FAIL ${error.message}`)
  process.exitCode = 1
})
