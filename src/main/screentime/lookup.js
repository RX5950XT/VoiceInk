'use strict'

/**
 * 未分類的應用／網站用維基百科摘要對到固定類別。
 * 只填 CategoryID 仍是 0 的列；失敗就下次再試（快取 7 天）。
 */

const fs = require('fs')
const path = require('path')
const {
  categoryFromText, classifyApp, classifySite, seed, idByName, skipSite
} = require('./categories')

const UA = 'VoiceInk/1.19 (screentime classifier)'
const LIMIT = 40
const COOLDOWN_MS = 7 * 24 * 3600 * 1000

function skipApp(name) {
  const n = String(name || '')
  if (n.length < 2) return true
  if (/^(java|javaw|dllhost|rundll32|msiexec|werfault|textinputhost|pickerhost|credentialuibroker|crashreport|crashdatauploader)$/i.test(n)) {
    return true
  }
  if (/\.(tmp)$/i.test(n) || /_unins/i.test(n)) return true
  return false
}

async function wikiOnce(host, query, fetchFn) {
  const url = `https://${host}/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&gsrlimit=1&prop=extracts|categories&exintro=1&explaintext=1&cllimit=20&format=json&utf8=1`
  const res = await fetchFn(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000)
  })
  if (!res?.ok) return ''
  const body = await res.json()
  const pages = body?.query?.pages
  if (!pages || typeof pages !== 'object') return ''
  const page = Object.values(pages)[0]
  if (!page) return ''
  const cats = (page.categories || []).map((c) => c.title).join(' ')
  return `${page.title || ''} ${page.extract || ''} ${cats}`.trim()
}

function searchQuery(name, description) {
  const desc = String(description || '').trim()
  const n = String(name || '').trim()
  if (desc && desc.toLowerCase() !== n.toLowerCase()) return desc.slice(0, 80)
  return n.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').slice(0, 80)
}

async function wikiLookup(query, fetchFn) {
  const q = String(query || '').trim().slice(0, 80)
  if (q.length < 2) return { text: '', ok: false }
  const hosts = /[\u4e00-\u9fff]/.test(q)
    ? ['zh.wikipedia.org', 'en.wikipedia.org']
    : ['en.wikipedia.org', 'zh.wikipedia.org']
  let failed = 0
  for (const host of hosts) {
    try {
      const text = await wikiOnce(host, q, fetchFn)
      if (text) return { text, ok: true }
    } catch {
      failed += 1
    }
  }
  return { text: '', ok: failed < hosts.length }
}

function loadCache(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function saveCache(file, cache) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(cache))
  } catch { /* 快取寫不進去不該讓分類停掉 */ }
}

function cacheFresh(entry, now) {
  if (!entry || typeof entry !== 'object') return false
  return now - Number(entry.at || 0) < COOLDOWN_MS
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ fetchFn?: Function, cacheFile?: string, limit?: number }} [opts]
 */
async function lookupUnclassified(db, opts = {}) {
  if (!db) return { apps: 0, sites: 0 }
  seed(db)
  const fetchFn = opts.fetchFn || globalThis.fetch
  if (typeof fetchFn !== 'function') return { apps: 0, sites: 0 }
  const limit = Math.max(1, Math.min(Number(opts.limit) || LIMIT, 80))
  const cacheFile = typeof opts.cacheFile === 'string' ? opts.cacheFile : ''
  const cache = cacheFile ? loadCache(cacheFile) : {}
  const now = Date.now()
  let apps = 0
  let sites = 0

  const appRows = db.prepare(
    `SELECT ID, Name, File, Description FROM AppModels
     WHERE CategoryID IS NULL OR CategoryID = 0
     ORDER BY TotalTime DESC LIMIT ?`
  ).all(limit)
  const updApp = db.prepare('UPDATE AppModels SET CategoryID = ? WHERE ID = ?')
  for (const app of appRows) {
    let name = classifyApp(app.Name, app.File, app.Description)
    if (name === '未分類') {
      if (skipApp(app.Name)) continue
      const key = `app:${String(app.Name).toLowerCase()}`
      const hit = cache[key]
      if (cacheFresh(hit, now)) name = hit.cat || '未分類'
      else {
        const found = await wikiLookup(searchQuery(app.Name, app.Description), fetchFn)
        if (!found.ok) continue
        name = categoryFromText(found.text, 'app')
        cache[key] = { cat: name === '未分類' ? '' : name, at: now }
      }
    }
    const id = idByName(db, 'CategoryModels', name)
    if (id) {
      updApp.run(id, app.ID)
      apps += 1
    }
  }

  const siteRows = db.prepare(
    `SELECT ID, Domain, Title FROM WebSiteModels
     WHERE CategoryID IS NULL OR CategoryID = 0
     ORDER BY Duration DESC LIMIT ?`
  ).all(limit)
  const updSite = db.prepare('UPDATE WebSiteModels SET CategoryID = ? WHERE ID = ?')
  for (const site of siteRows) {
    let name = classifySite(site.Domain)
    if (name === '未分類') {
      const host = String(site.Domain || '')
      if (skipSite(host)) continue
      const key = `web:${host.toLowerCase()}`
      const hit = cache[key]
      if (cacheFresh(hit, now)) name = hit.cat || '未分類'
      else {
        const q = site.Title && !/^[\d.\s]+$/.test(site.Title)
          ? site.Title
          : host.replace(/^www\./, '')
        const found = await wikiLookup(searchQuery(q, ''), fetchFn)
        if (!found.ok) continue
        name = categoryFromText(found.text, 'web')
        cache[key] = { cat: name === '未分類' ? '' : name, at: now }
      }
    }
    const id = idByName(db, 'WebSiteCategoryModels', name)
    if (id) {
      updSite.run(id, site.ID)
      sites += 1
    }
  }

  if (cacheFile) saveCache(cacheFile, cache)
  return { apps, sites }
}

module.exports = { lookupUnclassified, wikiLookup, searchQuery }
