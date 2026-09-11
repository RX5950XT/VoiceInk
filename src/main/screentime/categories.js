'use strict'

/**
 * 使用時長分類：固定幾類、依行程名／網域對上。
 * Tai 匯入的類別若已有同名就沿用，沒有就補進去。CategoryID 0 仍是未分類。
 */

const path = require('path')

const APP_CATS = Object.freeze([
  { name: '開發', color: '#7C5CFC' },
  { name: '瀏覽器', color: '#F5A524' },
  { name: '通訊', color: '#2BB673' },
  { name: '生產力', color: '#4F8EF7' },
  { name: '娛樂', color: '#E85D75' },
  { name: '遊戲', color: '#C084FC' },
  { name: '系統', color: '#94A3B8' }
])

const WEB_CATS = Object.freeze([
  { name: '開發', color: '#7C5CFC' },
  { name: '通訊', color: '#2BB673' },
  { name: '社交', color: '#38BDF8' },
  { name: '生產力', color: '#4F8EF7' },
  { name: '購物', color: '#FB923C' },
  { name: '資訊', color: '#64748B' },
  { name: '娛樂', color: '#E85D75' }
])

const APP_RULES = Object.freeze([
  { name: '瀏覽器', re: /^(chrome|msedge|firefox|brave|opera|vivaldi|arc|iexplore|comet|fellou)$/i },
  {
    name: '開發',
    re: /^(Code|Cursor|devenv|WindowsTerminal|wezterm-gui|wezterm|windowsterminal|claude|codex|idea64|pycharm64|webstorm64|goland64|rider64|sublime_text|notepad\+\+|GitHubDesktop|WinSCP|putty|Orca|Antigravity|antigravity_tools|zed|Trae|Windsurf|OpenCode|DevToys|mintty|pwsh|cmd|node|python|electron|ollama|ComfyUI|WindTerm|cc-switch|Chatbox|DeepChat|Perplexity|Copilot|ChatGPT|Qoder|qemu-system-x86_64|docker desktop|android-studio|VoiceInk|chimera-ui|token-anxiety-dashboard|codexbar|DiscordChatExporter|LunaTranslator|Super-Agent-Party)$/i
  },
  { name: '通訊', re: /^(Discord|Telegram|LINE|LineLauncher|Slack|Teams|ms-teams|Skype|Zoom|WhatsApp)$/i },
  {
    name: '娛樂',
    re: /^(Spotify|vlc|PotPlayerMini64|PotPlayer|mpv|Music\.UI|Video\.UI|iTunes|obs64|cyc-desktop|LineMediaPlayer|Audacity|shotcut|Clipchamp)$/i
  },
  {
    name: '遊戲',
    re: /^(steam|steamwebhelper|EpicGamesLauncher|RiotClientServices|LeagueClient|valorant-win64-shipping|HD-Player|HD-MultiInstanceManager|BlueArchive|P5R|minecraft|XboxPcApp|Overwolf|WeMod|GalaxyClient|upc|Game|Games|hl2|portal2|re7|ShadowOfMordor|MonsterHunterWilds|MiSideFull|DaysGone|HogwartsLegacy|DevilMayCry5|HoloCure|FluffyStore|player2|EdgeGameAssist|People Playground|PlagueIncEvolved|Erophone|FoxHime|ego|CuteHoney|SakuraSuccubus)$/i
  },
  {
    name: '生產力',
    re: /^(WINWORD|EXCEL|POWERPNT|ONENOTE|olk|Notion|Obsidian|Acrobat|OUTLOOK|Todo|OneDrive|GoogleDriveFS|TradingView|bambu-studio|FreeCAD|freecad|ImageGlass|Raindrop\.io|fdm|msrdc|rustdesk|desmos|Koodo Reader|Folo|Z-Library|Illustrator|Affinity|Thorium|Everything|WinRAR|pdf24-Toolbox|CUBMyATMap|MEGAsync|Fluent Reader|teraboxunite|TeraBox|FolderSize|google|TWSEATLAgent|ESUNATM_Service|ATMXHRService)$/i
  },
  {
    name: '系統',
    re: /^(explorer|SearchHost|ApplicationFrameHost|SystemSettings|CalculatorApp|Notepad|SnippingTool|PowerToys|TextInputHost|mmc|dllhost|rundll32|msiexec|WerFault|mspaint|cleanmgr|SecHealthUI|PickerHost|CredentialUIBroker|TrafficMonitor|OVRLibrarian|iCUE|HWMonitor|aida64|HWiNFO64|GPU-Z|MSIAfterburner|Core Temp|FPSMonitor|ThermalConsole|seelen-ui|urbanvpn-gui|zerotier_desktop_ui|RvRvpnGui|PhoneExperienceHost|WinStore\.App|Devices\.App|AsusIMEEntry|SystemPropertiesAdvanced|Cloudflare WARP)$/i
  }
])

const APP_DESC_RULES = Object.freeze([
  { name: '遊戲', re: /bluestacks|fan game|video game|minecraft|xbox|hitman|arknights|persona|spider-man|shadow of mordor|monster hunter|holocure|people playground/i },
  { name: '開發', re: /visual studio code|intellij|pycharm|webstorm|ide\b|terminal emulator|source-code|ai assistant|docker desktop|node\.js|\bAIRI\b/i },
  { name: '瀏覽器', re: /microsoft edge|google chrome|mozilla firefox|modern browser/i },
  { name: '通訊', re: /microsoft teams|remote desktop/i },
  { name: '生產力', re: /microsoft outlook|microsoft word|microsoft excel|oneNote|to do|ebook|pdf|google drive|安控元件|世華|玉山|三竹/i },
  { name: '系統', re: /nvidia (app|overlay|broadcast|control panel)|calculator|snipping|powertoys|windows defender/i }
])

const WEB_RULES = Object.freeze([
  { name: '娛樂', re: /youtube|netflix|twitch|bilibili|spotify|bahamut|gamer\.com|missav|jable|xvideos|hanime|pornhub|playno1|myavlive|steampowered|steamgalgame|manhuagui|linovelib|cycani|mycomic/i },
  { name: '開發', re: /github|gitlab|stackoverflow|developer\.mozilla|learn\.microsoft|huggingface|civitai|stability\.ai|lobehub|1panel|developers\.cloudflare|console\.x\.ai|openai\.com|anthropic\.com|ollama\.com|openrouter\.ai|vercel\.|localhost|aistudio\.google|opencode\.ai|qwen\.ai|groq\.com|replicate\.com|lmarena\.ai/i },
  { name: '通訊', re: /discord|telegram|whatsapp|line\.me|slack|teams\.microsoft/i },
  { name: '社交', re: /facebook|instagram|twitter|x\.com|reddit|threads\.(net|com)|weibo|zhihu|linkedin|twimg\.com|dcard\.tw|tieba\.baidu|truthsocial/i },
  { name: '購物', re: /shopee|shp\.ee|carousell|bid\.yahoo|amazon|ebay|pchome|ruten|mi\.com|biggo|coolpc|digikey|play\.google|taobao|coupang/i },
  { name: '資訊', re: /reuters|bloomberg|forbes|ettoday|wikipedia|bbc\.|cnn\.|news\.|chinatimes|csdn\.net|^(www\.)?google\.com$/i },
  { name: '生產力', re: /docs\.google|drive\.google|notebooklm\.google|console\.cloud\.google|myaccount\.google|notion\.so|office|outlook|chatgpt|claude\.ai|grok\.com|gemini\.google|mail\.google|deepseek|perplexity|z-library|translate\.google|microsoftedge\.microsoft|chromewebstore|yahoo\.com|mega\.nz|apple\.com|etfdb|polymarket|104\.com\.tw/i }
])

const TEXT_APP = Object.freeze([
  { name: '遊戲', re: /video game|電子遊戲|role-playing|first-person|sandbox game|action-adventure|survival game|fan game|steam|game developed|game published|Category:.*video games/i },
  { name: '瀏覽器', re: /web browser|網頁瀏覽器/i },
  { name: '通訊', re: /instant messag|chat app|voip|video conferenc|messaging app/i },
  { name: '開發', re: /source-code editor|integrated development|ide\b|compiler|software development|programming language|code editor|terminal emulator/i },
  { name: '系統', re: /file manager|operating system|control panel|system utility|device driver/i },
  { name: '娛樂', re: /media player|streaming service|video sharing|music streaming|anime/i },
  { name: '生產力', re: /word processor|spreadsheet|office suite|note-taking|email client|\bpdf\b|e-book|remote desktop/i }
])

const TEXT_WEB = Object.freeze([
  { name: '社交', re: /social network|社交網|microblog/i },
  { name: '購物', re: /e-commerce|online shopping|online marketplace|購物|retailer/i },
  { name: '資訊', re: /news agency|newspaper|encyclopedia|search engine|新聞|wiki/i },
  { name: '開發', re: /software development|source code|git hosting|documentation/i },
  { name: '通訊', re: /instant messag|chat app|voip/i },
  { name: '娛樂', re: /video game|streaming service|video sharing|pornograph|adult video|anime/i },
  { name: '生產力', re: /office suite|email|productivity|artificial intelligence/i }
])

function normName(value) {
  return String(value || '').replace(/\.exe$/i, '')
}

/** @param {string} text @param {'app'|'web'} [kind] */
function categoryFromText(text, kind) {
  const blob = String(text || '')
  if (!blob) return '未分類'
  const rules = kind === 'web' ? TEXT_WEB : TEXT_APP
  for (const rule of rules) {
    if (rule.re.test(blob)) return rule.name
  }
  return '未分類'
}

/** @param {string} host */
function skipSite(host) {
  const h = String(host || '').toLowerCase()
  if (!h || h === 'http' || h === 'https') return true
  if (/^chrome-extension/.test(h)) return true
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(h)) return true
  return false
}

/** @param {string} name @param {string} [file] @param {string} [description] */
function classifyApp(name, file, description) {
  const process = normName(name)
  const base = path.basename(normName(file))
  const desc = String(description || '')
  if (/win64-shipping/i.test(process) || /win64-shipping/i.test(base)) return '遊戲'
  if (/\.(tmp)$/i.test(process) || /(?:^|[-_\s])(setup|installer|uninstall)(?:$|[-_\s])/i.test(process)) {
    return '系統'
  }
  for (const rule of APP_RULES) {
    if (rule.re.test(process) || (base && rule.re.test(base))) return rule.name
  }
  if (desc) {
    for (const rule of APP_DESC_RULES) {
      if (rule.re.test(desc)) return rule.name
    }
  }
  if (/^PowerToys\./i.test(process) || /^NVIDIA /i.test(process)) return '系統'
  if (/Cherry Studio/i.test(process) || /LM Studio/i.test(process)) return '開發'
  return '未分類'
}

/** @param {string} domain */
function classifySite(domain) {
  const host = String(domain || '').toLowerCase()
  if (!host) return '未分類'
  if (/^localhost(:\d+)?$/.test(host) || host === 'file') return '開發'
  if (skipSite(host)) return '未分類'
  for (const rule of WEB_RULES) {
    if (rule.re.test(host)) return rule.name
  }
  if (/\.(gov|edu)(\.[a-z]{2})?$/.test(host) || /\.gov\.tw$/.test(host)) return '資訊'
  return '未分類'
}

function ensureRow(db, table, name, color, extra) {
  const row = db.prepare(`SELECT ID FROM ${table} WHERE Name = ?`).get(name)
  if (row) return row.ID
  if (table === 'CategoryModels') {
    db.prepare(
      'INSERT INTO CategoryModels (Name, IconFile, Color, IsDirectoryMath, Directories) VALUES (?, ?, ?, 0, ?)'
    ).run(name, '', color, extra || '')
  } else {
    db.prepare(
      'INSERT INTO WebSiteCategoryModels (Name, IconFile, Color) VALUES (?, ?, ?)'
    ).run(name, '', color)
  }
  return db.prepare(`SELECT ID FROM ${table} WHERE Name = ?`).get(name).ID
}

/** @param {import('node:sqlite').DatabaseSync} db */
function seed(db) {
  if (!db) return
  for (const cat of APP_CATS) ensureRow(db, 'CategoryModels', cat.name, cat.color)
  for (const cat of WEB_CATS) ensureRow(db, 'WebSiteCategoryModels', cat.name, cat.color)
}

function idByName(db, table, name) {
  if (!name || name === '未分類') return 0
  const row = db.prepare(`SELECT ID FROM ${table} WHERE Name = ?`).get(name)
  return row ? row.ID : 0
}

/** @param {import('node:sqlite').DatabaseSync} db */
function resolveAppCategory(db, name, file, description) {
  return idByName(db, 'CategoryModels', classifyApp(name, file, description))
}

/** @param {import('node:sqlite').DatabaseSync} db */
function resolveSiteCategory(db, domain) {
  return idByName(db, 'WebSiteCategoryModels', classifySite(domain))
}

/**
 * 只填 CategoryID 仍是 0 的列，不覆蓋使用者或 Tai 已經分過的。
 * @param {import('node:sqlite').DatabaseSync} db
 */
function backfill(db) {
  seed(db)
  const apps = db.prepare(
    'SELECT ID, Name, File, Description FROM AppModels WHERE CategoryID IS NULL OR CategoryID = 0'
  ).all()
  const updApp = db.prepare('UPDATE AppModels SET CategoryID = ? WHERE ID = ?')
  for (const app of apps) {
    const id = resolveAppCategory(db, app.Name, app.File, app.Description)
    if (id) updApp.run(id, app.ID)
  }
  const sites = db.prepare(
    'SELECT ID, Domain FROM WebSiteModels WHERE CategoryID IS NULL OR CategoryID = 0'
  ).all()
  const updSite = db.prepare('UPDATE WebSiteModels SET CategoryID = ? WHERE ID = ?')
  for (const site of sites) {
    const id = resolveSiteCategory(db, site.Domain)
    if (id) updSite.run(id, site.ID)
  }
}

function lookupUnclassified(db, opts) {
  return require('./lookup').lookupUnclassified(db, opts)
}

module.exports = {
  APP_CATS,
  WEB_CATS,
  classifyApp,
  classifySite,
  categoryFromText,
  skipSite,
  seed,
  backfill,
  resolveAppCategory,
  resolveSiteCategory,
  idByName,
  lookupUnclassified
}
