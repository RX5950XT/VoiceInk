'use strict'

/**
 * 打包後 CUDA／Vulkan 的 llama addon 留在 asar 裡（開機才不會被 Defender 掃一整排 DLL）。
 * `.node` 不能從 asar dlopen，第一次開 GPU 拷到 `%APPDATA%/voiceink/native-modules/`，
 * 再用 module.registerHooks 讓 `import('@node-llama-cpp/win-x64-cuda')` 指到那裡。
 * 絕不能寫進安裝目錄的 app.asar.unpacked：Program Files 一般使用者沒有寫入權限。
 */

const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')

const GPU_PACKAGES = Object.freeze(['win-x64-cuda', 'win-x64-vulkan'])

let hooksRegistered = false
/** @type {Map<string, string>} */
const destByPackage = new Map()

/** @returns {boolean} */
function isPackaged() {
  try {
    return require('electron').app?.isPackaged === true
  } catch {
    return false
  }
}

/**
 * @returns {string}
 */
function addonRoot() {
  return path.join(require('electron').app.getPath('userData'), 'native-modules', '@node-llama-cpp')
}

/**
 * @param {string} src
 * @param {string} dest
 */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(from, to)
    else fs.copyFileSync(from, to)
  }
}

/**
 * @param {string} src
 * @param {string} dest
 * @returns {boolean}
 */
function destMatchesSource(src, dest) {
  try {
    const srcVer = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).version
    const destVer = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8')).version
    return srcVer === destVer && fs.existsSync(path.join(dest, 'bins'))
  } catch {
    return false
  }
}

/** 讓 ESM import('@node-llama-cpp/win-x64-cuda') 指到 userData 那份。 */
function ensureResolveHook() {
  if (hooksRegistered) return
  const { registerHooks } = require('module')
  if (typeof registerHooks !== 'function') {
    throw new Error('目前執行環境無法把 GPU 套件接到使用者資料夾')
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      for (const pkg of GPU_PACKAGES) {
        const name = `@node-llama-cpp/${pkg}`
        if (specifier !== name && !specifier.startsWith(`${name}/`)) continue
        const dest = destByPackage.get(pkg)
        if (!dest) break
        const rest = specifier === name ? 'dist/index.js' : specifier.slice(name.length + 1)
        return {
          url: pathToFileURL(path.join(dest, rest)).href,
          format: 'module',
          shortCircuit: true
        }
      }
      return nextResolve(specifier, context)
    }
  })
  hooksRegistered = true
}

/**
 * 打包版第一次開 GPU：把 asar 裡的 addon 拷到 userData，並讓後續 import 走那份。
 * 開發／e2e（未打包）什麼都不做，直接用 node_modules。
 * @param {'win-x64-cuda'|'win-x64-vulkan'} pkgName
 */
function ensureLlamaAddon(pkgName) {
  if (!isPackaged()) return
  if (!GPU_PACKAGES.includes(pkgName)) {
    throw new Error(`未知的 GPU 套件: ${pkgName}`)
  }
  const src = path.join(process.resourcesPath, 'app.asar', 'node_modules', '@node-llama-cpp', pkgName)
  if (!fs.existsSync(path.join(src, 'package.json'))) {
    throw new Error(`套件裡沒有 ${pkgName}`)
  }
  const dest = path.join(addonRoot(), pkgName)
  if (!destMatchesSource(src, dest)) {
    const tmp = `${dest}.tmp`
    fs.rmSync(tmp, { recursive: true, force: true })
    copyDir(src, tmp)
    fs.rmSync(dest, { recursive: true, force: true })
    fs.renameSync(tmp, dest)
  }
  destByPackage.set(pkgName, dest)
  ensureResolveHook()
}

module.exports = { ensureLlamaAddon, GPU_PACKAGES }
