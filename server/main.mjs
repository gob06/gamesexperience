import express from 'express'
import './async-handlers.mjs'
import multer from 'multer'
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase, readDatabaseConfig } from './db.mjs'
import { registerQaRoutes } from './qa.mjs'
import { registerRaffleRoutes } from './raffle.mjs'
import { registerScrambleRoutes } from './scramble.mjs'
import { rateLimit } from './rate-limit.mjs'
import { defaultTerms } from './defaultTerms.mjs'

const app = express()
const envPort = Number(process.env.PORT)
const nginxPort = Number(process.env.NGINX_PORT)
const port = Number.isInteger(envPort) && envPort > 0 && envPort !== nginxPort
  ? envPort
  : Number(process.env.DEFAULT_APP_PORT || 3000)
const themeImageMaxBytes = Number(process.env.THEME_IMAGE_MAX_BYTES || 50 * 1024 * 1024)
const themeFontMaxBytes = Number(process.env.THEME_FONT_MAX_BYTES || 20 * 1024 * 1024)
const adVideoMaxBytes = Number(process.env.AD_VIDEO_MAX_BYTES || 200 * 1024 * 1024)
if (!Number.isSafeInteger(adVideoMaxBytes) || adVideoMaxBytes < 1 || adVideoMaxBytes > 1024 * 1024 * 1024) {
  throw new Error('AD_VIDEO_MAX_BYTES must be between 1 byte and 1 GB.')
}
const votingSessionDurationSeconds = Number(process.env.VOTING_SESSION_DURATION_SECONDS || 7 * 24 * 60 * 60)
const rawTrustProxy = String(process.env.TRUST_PROXY_HOPS ?? '').trim()
const parsedTrustProxy = rawTrustProxy.toLowerCase() === 'true' ? 1 : Number(rawTrustProxy || 0)
const trustedProxyHops = Number.isSafeInteger(parsedTrustProxy) && parsedTrustProxy >= 0
  ? Math.min(parsedTrustProxy, 5)
  : 0
if (!Number.isSafeInteger(themeImageMaxBytes) || themeImageMaxBytes < 1 || themeImageMaxBytes > 200 * 1024 * 1024) {
  throw new Error('THEME_IMAGE_MAX_BYTES must be between 1 byte and 200 MB.')
}
if (!Number.isSafeInteger(themeFontMaxBytes) || themeFontMaxBytes < 1 || themeFontMaxBytes > 200 * 1024 * 1024) {
  throw new Error('THEME_FONT_MAX_BYTES must be between 1 byte and 200 MB.')
}
if (!Number.isSafeInteger(votingSessionDurationSeconds) || votingSessionDurationSeconds < 60 || votingSessionDurationSeconds > 90 * 24 * 60 * 60) {
  throw new Error('VOTING_SESSION_DURATION_SECONDS must be between 60 seconds and 90 days.')
}
app.set('trust proxy', trustedProxyHops)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rawDataDir = String(process.env.DATA_DIR || '').trim()
const dataDirectory = path.resolve(
  rawDataDir && !/^leave\s+unset\b/i.test(rawDataDir) ? rawDataDir : path.join(root, 'data'),
)
const legacyPollsFile = path.join(dataDirectory, 'polls.json')
const themeAssetsDirectory = path.join(dataDirectory, 'theme-assets')
const adVideosDirectory = path.join(dataDirectory, 'ad-videos')

mkdirSync(dataDirectory, { recursive: true })
mkdirSync(themeAssetsDirectory, { recursive: true })
mkdirSync(adVideosDirectory, { recursive: true })
const database = await createDatabase(readDatabaseConfig())
await database.initializeSchema()
const inTransaction = (action) => database.transaction(action)

// Derive a stable guest-only QR without storing raw tokens or issuing links on every refresh.
function selfieLiveJoinToken(joinTokenHash) {
  return createHash('sha256').update('selfie-live-join:').update(joinTokenHash).digest('base64url')
}

const gameRoomRetentionMs = 24 * 60 * 60 * 1000
await database.prepare('DELETE FROM game_rooms WHERE updated_at <= ?').run(new Date(Date.now() - gameRoomRetentionMs).toISOString())

app.use((_request, response, next) => {
  response.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' })
  next()
})
app.use(express.json({ limit: '32kb' }))

function audit(request, action, targetType, targetId, details = {}) {
  return database.prepare('INSERT INTO audit_logs (id, user_id, username, action, target_type, target_id, details, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), request.user?.id ?? null, request.user?.username ?? null, action, targetType, targetId, JSON.stringify(details), request.ip, new Date().toISOString())
}

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 10 },
  fileFilter: (_request, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) return callback(new Error('Use a JPEG, PNG, or WebP image.'))
    callback(null, true)
  },
})

const themeImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: themeImageMaxBytes, files: 1 },
})

const themeFontUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: themeFontMaxBytes, files: 1 },
})

app.get('/api/network-addresses', (_request, response) => {
  const addresses = Object.values(networkInterfaces())
    .flatMap((interfaces) => interfaces ?? [])
    .filter((network) => network.family === 'IPv4' && !network.internal)
    .map((network) => network.address)
    .filter((address) => /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(address))
    .sort((left, right) => Number(right.startsWith('192.168.')) - Number(left.startsWith('192.168.')))
  response.json({ addresses })
})

const selectPoll = database.prepare("SELECT id, question, join_title AS joinTitle, ticket_label AS ticketLabel, name_label AS nameLabel, created_at AS createdAt, is_qa AS isQa, voting_enabled AS votingEnabled, video_enabled AS videoEnabled, reveal_correct AS revealCorrect, correct_option_id AS correctOptionId, owner_user_id AS ownerUserId, CASE WHEN logo IS NULL THEN NULL ELSE CONCAT('/api/polls/', id, '/logo') END AS logoUrl, CASE WHEN question_image IS NULL THEN NULL ELSE CONCAT('/api/polls/', id, '/question-image') END AS questionImageUrl FROM polls WHERE id = ?")
const selectQaWinner = database.prepare('SELECT v.voter_id AS voterId, v.first_name AS firstName, v.ticket_number AS ticketNumber, o.label AS answer FROM poll_voters v JOIN poll_options o ON o.id = v.option_id WHERE v.poll_id = ? AND v.is_correct = 1 ORDER BY v.created_at, v.seq LIMIT 1')
const selectQaStats = database.prepare('SELECT (SELECT COUNT(*) FROM poll_voting_sessions WHERE poll_id = ? AND ticket_key IS NOT NULL) AS participants, (SELECT COUNT(*) FROM poll_voters WHERE poll_id = ? AND option_id IS NOT NULL) AS submissions, (SELECT COUNT(*) FROM poll_voters WHERE poll_id = ? AND is_correct = 1) AS winners')
const selectOptions = database.prepare("SELECT id, label, votes, hide_label AS hideLabel, CASE WHEN image IS NULL THEN NULL ELSE CONCAT('/api/poll-options/', id, '/image') END AS imageUrl FROM poll_options WHERE poll_id = ? ORDER BY `position`")

// The correct answer, winners, and statistics are only included for signed-in hosts (admin = true); audience requests never see them.
async function getPoll(id, { admin = false } = {}) {
  const { correctOptionId, revealCorrect, ownerUserId: _ownerUserId, ...poll } = (await selectPoll.get(id)) ?? {}
  if (!poll.id) return null
  const base = { ...poll, isQa: Boolean(poll.isQa), votingEnabled: Boolean(poll.votingEnabled), videoEnabled: Boolean(poll.videoEnabled), options: await selectOptions.all(id) }
  if (!admin || !base.isQa) return base
  const winner = await selectQaWinner.get(id)
  const stats = await selectQaStats.get(id, id, id)
  return {
    ...base,
    revealCorrect: Boolean(revealCorrect),
    correctOptionId,
    stats: { participants: stats.participants, submissions: stats.submissions, winners: stats.winners, nonWinners: stats.submissions - stats.winners },
    ...(winner ? { winnerName: winner.firstName, winnerTicketNumber: winner.ticketNumber, winnerAnswer: winner.answer } : {}),
  }
}

async function listPolls(user) {
  const polls = []
  for (const { id } of await database.prepare('SELECT id FROM polls WHERE owner_user_id = ? OR ? = 1 ORDER BY created_at DESC').all(user.id, Number(user.isSuperAdmin))) polls.push(await getPoll(id, { admin: true }))
  return polls
}

function hasValidImageSignature(mimeType, image) {
  const signature = image.subarray(0, 12)
  if (mimeType === 'image/jpeg') return signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff
  if (mimeType === 'image/png') return signature.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  return mimeType === 'image/webp' && signature.toString('ascii', 0, 4) === 'RIFF' && signature.toString('ascii', 8, 12) === 'WEBP'
}

function fontCssFormat(mimeType) {
  return {
    'font/woff2': 'woff2',
    'font/woff': 'woff',
    'font/ttf': 'truetype',
    'font/otf': 'opentype',
    'font/collection': 'collection',
    'application/vnd.ms-fontobject': 'embedded-opentype',
  }[mimeType] || ''
}

function sanitizeAssetName(originalname, fallback = 'Custom font') {
  const base = path.basename(String(originalname || '').trim()).replace(/[\u0000-\u001f\u007f<>:"/\\|?*`$;]/g, ' ').replace(/\s+/g, ' ').trim()
  return (base || fallback).slice(0, 120)
}

function detectFontAsset(buffer, originalname = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null
  const tag = buffer.subarray(0, 4).toString('ascii')
  const lowerName = String(originalname || '').toLowerCase()

  if (tag === 'wOF2' && buffer.length >= 48) {
    return { mimeType: 'font/woff2', extension: '.woff2', format: 'woff2' }
  }
  if (tag === 'wOFF' && buffer.length >= 44) {
    return { mimeType: 'font/woff', extension: '.woff', format: 'woff' }
  }
  if (tag === 'OTTO') {
    const numTables = buffer.readUInt16BE(4)
    if (numTables >= 1 && numTables <= 1024 && buffer.length >= 12 + numTables * 16) {
      return { mimeType: 'font/otf', extension: '.otf', format: 'opentype' }
    }
    return null
  }
  if (buffer.subarray(0, 4).equals(Buffer.from([0x00, 0x01, 0x00, 0x00])) || tag === 'true' || tag === 'typ1') {
    const numTables = buffer.readUInt16BE(4)
    if (numTables >= 1 && numTables <= 1024 && buffer.length >= 12 + numTables * 16) {
      return { mimeType: 'font/ttf', extension: lowerName.endsWith('.sfnt') ? '.sfnt' : '.ttf', format: 'truetype' }
    }
    return null
  }
  if (tag === 'ttcf' && buffer.length >= 16) {
    const numFonts = buffer.readUInt32BE(8)
    if (numFonts >= 1 && numFonts <= 256 && buffer.length >= 12 + numFonts * 4) {
      return { mimeType: 'font/collection', extension: lowerName.endsWith('.otc') ? '.otc' : '.ttc', format: 'collection' }
    }
    return null
  }
  if (buffer.length >= 82 && buffer[34] === 0x4c && buffer[35] === 0x50) {
    const version = buffer.readUInt32LE(8)
    if ([0x00010000, 0x00020001, 0x00020002].includes(version)) {
      return { mimeType: 'application/vnd.ms-fontobject', extension: '.eot', format: 'embedded-opentype' }
    }
  }
  return null
}

const themeSkins = ['broadcast', 'classic']
const displayKeys = ['poll', 'qa', 'raffle', 'scramble', 'selfie', 'game']
const defaultThemeColors = { primary: '#f4cf51', secondary: '#ff657a', accent: '#68ceda', background: '#131317', text: '#f5f1ed' }
const defaultThemeBackground = { position: 'center', size: 'cover', repeat: 'no-repeat', opacity: 1, overlay: 0.35, borderRadius: 8, glow: 0.2 }

function createDefaultDisplayConfig() {
  return {
    customized: false,
    skin: 'inherit',
    colors: { ...defaultThemeColors },
    background: { ...defaultThemeBackground },
    box: null,
  }
}

const defaultTheme = {
  eventTitle: 'VOTE',
  skin: 'broadcast',
  assets: {
    logo: null,
    banner: null,
    background: null,
    guestRegistrationBackground: null,
    votingBackground: null,
    resultsBackground: null,
    qaDisplayBackground: null,
    raffleDisplayBackground: null,
    scrambleDisplayBackground: null,
    selfieSubmissionBackground: null,
    selfieDisplayBackground: null,
    gameDisplayBackground: null,
    adminBackground: null,
  },
  fonts: { bodyFont: null, headingFont: null },
  colors: { ...defaultThemeColors },
  background: { ...defaultThemeBackground },
  displays: Object.fromEntries(displayKeys.map((key) => [key, createDefaultDisplayConfig()])),
}

await database.prepare(`
  INSERT IGNORE INTO theme_settings (id, draft_json, published_json, updated_at)
  VALUES (1, ?, ?, ?)
`).run(JSON.stringify(defaultTheme), JSON.stringify(defaultTheme), new Date().toISOString())

const defaultGameTheme = {
  ...defaultTheme,
  eventTitle: 'Vanishing Tic-Tac-Toe',
}
await database.prepare(`
  INSERT IGNORE INTO game_theme_settings (id, draft_json, published_json, updated_at)
  VALUES (1, ?, ?, ?)
`).run(JSON.stringify(defaultGameTheme), JSON.stringify(defaultGameTheme), new Date().toISOString())

const selectThemeSettings = database.prepare('SELECT draft_json AS draft, published_json AS published, updated_by AS updatedBy, updated_at AS updatedAt, published_by AS publishedBy, published_at AS publishedAt FROM theme_settings WHERE id = 1')
const selectGameThemeSettings = database.prepare('SELECT draft_json AS draft, published_json AS published, updated_by AS updatedBy, updated_at AS updatedAt, published_by AS publishedBy, published_at AS publishedAt FROM game_theme_settings WHERE id = 1')
const selectThemeAsset = database.prepare("SELECT id, mime_type AS mimeType, size_bytes AS sizeBytes, width, height, COALESCE(asset_kind, 'image') AS assetKind, original_name AS originalName, uploaded_at AS uploadedAt FROM theme_assets WHERE id = ?")

function parseThemeJson(json) {
  try {
    const value = JSON.parse(json)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : defaultTheme
  } catch {
    return defaultTheme
  }
}

function normalizeDisplayOverride(raw) {
  const base = createDefaultDisplayConfig()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base
  const skin = ['inherit', ...themeSkins].includes(raw.skin) ? raw.skin : 'inherit'
  const rawBackground = raw.background && typeof raw.background === 'object' && !Array.isArray(raw.background) ? raw.background : {}
  const size = ['cover', 'contain', 'repeat'].includes(rawBackground.size) ? rawBackground.size : base.background.size
  return {
    customized: Boolean(raw.customized),
    skin,
    colors: { ...base.colors, ...(raw.colors && typeof raw.colors === 'object' && !Array.isArray(raw.colors) ? raw.colors : {}) },
    box: raw.box && typeof raw.box === 'object' && !Array.isArray(raw.box)
      && typeof raw.box.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.box.color)
      && typeof raw.box.opacity === 'number' && Number.isFinite(raw.box.opacity) && raw.box.opacity >= 0 && raw.box.opacity <= 1
      ? { color: raw.box.color.toLowerCase(), opacity: raw.box.opacity } : null,
    background: {
      ...base.background,
      ...rawBackground,
      size,
      repeat: size === 'repeat' ? 'repeat' : 'no-repeat',
    },
  }
}

function getThemeConfig(json) {
  const parsed = parseThemeJson(json)
  const parsedDisplays = parsed.displays && typeof parsed.displays === 'object' && !Array.isArray(parsed.displays) ? parsed.displays : {}
  return {
    ...defaultTheme,
    ...parsed,
    skin: themeSkins.includes(parsed.skin) ? parsed.skin : defaultTheme.skin,
    assets: { ...defaultTheme.assets, ...(parsed.assets || {}) },
    fonts: { ...defaultTheme.fonts, ...(parsed.fonts || {}) },
    colors: { ...defaultTheme.colors, ...(parsed.colors || {}) },
    background: { ...defaultTheme.background, ...(parsed.background || {}) },
    displays: Object.fromEntries(displayKeys.map((key) => [key, normalizeDisplayOverride(parsedDisplays[key])])),
  }
}

function validateAndNormalizeDisplays(displays) {
  if (displays === undefined) {
    return { ok: true, value: Object.fromEntries(displayKeys.map((key) => [key, createDefaultDisplayConfig()])) }
  }
  if (!displays || typeof displays !== 'object' || Array.isArray(displays)) {
    return { ok: false, error: 'Display customization settings are invalid.' }
  }
  const colorKeys = Object.keys(defaultThemeColors)
  const normalized = {}
  for (const key of displayKeys) {
    const entry = displays[key]
    if (entry === undefined) {
      normalized[key] = createDefaultDisplayConfig()
      continue
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: `Invalid display customization settings for ${key}.` }
    }
    if (entry.customized !== undefined && typeof entry.customized !== 'boolean') {
      return { ok: false, error: `Invalid display override toggle for ${key}.` }
    }
    const skin = entry.skin === undefined ? 'inherit' : entry.skin
    if (!['inherit', ...themeSkins].includes(skin)) {
      return { ok: false, error: `Invalid display theme skin for ${key}.` }
    }
    const box = entry.box
    if (box !== undefined && box !== null && (
      typeof box !== 'object' || Array.isArray(box)
      || typeof box.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(box.color)
      || typeof box.opacity !== 'number' || !Number.isFinite(box.opacity) || box.opacity < 0 || box.opacity > 1
    )) {
      return { ok: false, error: `Display box color or opacity for ${key} is invalid.` }
    }
    const colors = entry.colors
    if (!colors || typeof colors !== 'object' || Array.isArray(colors) || colorKeys.some((colorKey) => typeof colors[colorKey] !== 'string' || !/^#[0-9a-f]{6}$/i.test(colors[colorKey]))) {
      return { ok: false, error: `Display colors for ${key} must be valid six-digit hex colors.` }
    }
    const bg = entry.background
    if (
      !bg || typeof bg !== 'object' || Array.isArray(bg)
      || !['cover', 'contain', 'repeat'].includes(bg.size)
      || !['center', 'top', 'bottom', 'left', 'right'].includes(bg.position)
      || typeof bg.opacity !== 'number' || bg.opacity < 0 || bg.opacity > 1
      || typeof bg.overlay !== 'number' || bg.overlay < 0 || bg.overlay > 0.9
      || typeof bg.borderRadius !== 'number' || bg.borderRadius < 0 || bg.borderRadius > 32
      || typeof bg.glow !== 'number' || bg.glow < 0 || bg.glow > 1
    ) {
      return { ok: false, error: `Display layout settings for ${key} are invalid.` }
    }
    normalized[key] = {
      customized: Boolean(entry.customized),
      skin,
      box: box ? { color: box.color.toLowerCase(), opacity: box.opacity } : null,
      colors: Object.fromEntries(colorKeys.map((colorKey) => [colorKey, colors[colorKey].toLowerCase()])),
      background: {
        position: bg.position,
        size: bg.size,
        repeat: bg.size === 'repeat' ? 'repeat' : 'no-repeat',
        opacity: bg.opacity,
        overlay: bg.overlay,
        borderRadius: bg.borderRadius,
        glow: bg.glow,
      },
    }
  }
  return { ok: true, value: normalized }
}

function auditThemeChange(user, action, details = {}) {
  return database.prepare('INSERT INTO theme_audit_logs (id, administrator_id, administrator_name, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), user.id, user.username, action, JSON.stringify(details), new Date().toISOString())
}

function auditGameThemeChange(user, action, details = {}) {
  return database.prepare('INSERT INTO theme_audit_logs (id, administrator_id, administrator_name, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), user.id, user.username, `game-theme.${action}`, JSON.stringify(details), new Date().toISOString())
}

async function themeAssetsAreValid(assets, keys, userId = null, expectedKind = null) {
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) return false
  for (const key of keys) {
    const value = assets[key]
    if (value === null || value === undefined) continue
    if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) return false
    const asset = await selectThemeAsset.get(value)
    if (!asset) return false
    if (expectedKind && asset.assetKind !== expectedKind) return false
    if (userId && !(await database.prepare('SELECT asset_id FROM account_theme_assets WHERE user_id = ? AND asset_id = ?').get(userId, value))) return false
  }
  return true
}

function getImageDimensions(mimeType, image) {
  if (mimeType === 'image/png' && image.length >= 24) {
    return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) }
  }
  if (mimeType === 'image/webp' && image.length >= 30) {
    const chunk = image.toString('ascii', 12, 16)
    if (chunk === 'VP8X') return { width: 1 + image.readUIntLE(24, 3), height: 1 + image.readUIntLE(27, 3) }
    if (chunk === 'VP8 ' && image.length >= 30) return { width: image.readUInt16LE(26) & 0x3fff, height: image.readUInt16LE(28) & 0x3fff }
    if (chunk === 'VP8L' && image.length >= 25) {
      const bits = image.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
  }
  if (mimeType === 'image/jpeg') {
    let offset = 2
    while (offset + 4 < image.length) {
      if (image[offset] !== 0xff) { offset += 1; continue }
      const marker = image[offset + 1]
      const segmentLength = image.readUInt16BE(offset + 2)
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && offset + 9 < image.length) {
        return { height: image.readUInt16BE(offset + 5), width: image.readUInt16BE(offset + 7) }
      }
      if (segmentLength < 2) break
      offset += segmentLength + 2
    }
  }
  return null
}

async function accountTheme(userId) {
  let settings = await database.prepare('SELECT draft_json AS draft, published_json AS published, updated_at AS updatedAt, published_at AS publishedAt FROM account_theme_settings WHERE user_id = ?').get(userId)
  if (!settings) {
    const now = new Date().toISOString()
    await database.prepare('INSERT IGNORE INTO account_theme_settings (user_id, draft_json, published_json, updated_at) VALUES (?, ?, ?, ?)')
      .run(userId, JSON.stringify(defaultTheme), JSON.stringify(defaultTheme), now)
    settings = await database.prepare('SELECT draft_json AS draft, published_json AS published, updated_at AS updatedAt, published_at AS publishedAt FROM account_theme_settings WHERE user_id = ?').get(userId)
  }
  return settings
}

async function getPublicTheme(userId = null) {
  const settings = userId ? await accountTheme(userId) : await selectThemeSettings.get()
  const config = getThemeConfig(settings.published)
  const assetUrls = {}
  for (const [key, id] of Object.entries(config.assets)) {
    if (typeof id === 'string' && await selectThemeAsset.get(id)) assetUrls[key] = `/api/theme/assets/${encodeURIComponent(id)}`
  }
  const fontAssets = {}
  for (const [key, id] of Object.entries(config.fonts)) {
    if (typeof id !== 'string') continue
    const asset = await selectThemeAsset.get(id)
    if (asset && asset.assetKind === 'font') {
      fontAssets[key] = {
        id,
        url: `/api/theme/assets/${encodeURIComponent(id)}`,
        mimeType: asset.mimeType,
        format: fontCssFormat(asset.mimeType),
        name: asset.originalName || 'Custom font',
      }
    }
  }
  return { config, assetUrls, fontAssets }
}

async function getPublicGameTheme() {
  const settings = await selectGameThemeSettings.get()
  const config = getThemeConfig(settings.published)
  const assetUrls = {}
  for (const [key, id] of Object.entries(config.assets)) {
    if (typeof id === 'string' && await selectThemeAsset.get(id)) assetUrls[key] = `/api/game-theme/assets/${encodeURIComponent(id)}`
  }
  const fontAssets = {}
  for (const [key, id] of Object.entries(config.fonts)) {
    if (typeof id !== 'string') continue
    const asset = await selectThemeAsset.get(id)
    if (asset && asset.assetKind === 'font') {
      fontAssets[key] = {
        id,
        url: `/api/game-theme/assets/${encodeURIComponent(id)}`,
        mimeType: asset.mimeType,
        format: fontCssFormat(asset.mimeType),
        name: asset.originalName || 'Custom font',
      }
    }
  }
  return { config, assetUrls, fontAssets }
}

const sessionDurationSeconds = 60 * 60 * 24 * 7
const hashSessionToken = (token) => createHash('sha256').update(token).digest('hex')

for (const session of await database.prepare('SELECT id, join_token_hash AS joinTokenHash FROM selfie_sessions WHERE live_join_token_hash IS NULL').all()) {
  await database.prepare('UPDATE selfie_sessions SET live_join_token_hash = ? WHERE id = ?')
    .run(hashSessionToken(selfieLiveJoinToken(session.joinTokenHash)), session.id)
}

function publicUser(user) {
  return { id: user.id, username: user.username, role: user.role, isSuperAdmin: Boolean(user.isSuperAdmin) }
}

function getSessionToken(request) {
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('vote_session='))
  return cookie ? decodeURIComponent(cookie.slice('vote_session='.length)) : ''
}

function getCookie(request, name) {
  const prefix = `${name}=`
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))
  return cookie?.slice(prefix.length) || ''
}

function getVotingCookieName(pollId) {
  const pollKey = createHash('sha256').update(pollId).digest('hex').slice(0, 16)
  return `vote_ballot_${pollKey}`
}

function cookieSecurityFlags(request) {
  const forwardedHost = request.get('x-forwarded-host') || ''
  const isHttpsProxy = request.secure || request.get('x-forwarded-proto') === 'https' || forwardedHost.endsWith('.run.app')
  return isHttpsProxy ? '; SameSite=None; Secure' : '; SameSite=Lax'
}

function setVotingSessionCookie(request, response, pollId, token) {
  response.setHeader('Set-Cookie', `${getVotingCookieName(pollId)}=${token}; Path=/; HttpOnly; Max-Age=${votingSessionDurationSeconds}${cookieSecurityFlags(request)}`)
}

async function getCurrentUser(request) {
  const token = getSessionToken(request)
  if (!token) return null
  const tokenHash = hashSessionToken(token)
  const session = await database.prepare(`
    SELECT users.id, users.username, users.role, users.is_superadmin AS isSuperAdmin, sessions.expires_at AS expiresAt
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
  `).get(tokenHash)
  if (!session) return null
  if (Date.parse(session.expiresAt) <= Date.now()) {
    await database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
    return null
  }
  return publicUser(session)
}

async function setSessionCookie(request, response, userId) {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + sessionDurationSeconds * 1000).toISOString()
  await database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashSessionToken(token), userId, expiresAt)
  response.setHeader('Set-Cookie', `vote_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Max-Age=${sessionDurationSeconds}${cookieSecurityFlags(request)}`)
}

async function requireUser(request, response, next) {
  const user = await getCurrentUser(request)
  if (!user) return response.status(401).json({ error: 'Please log in to manage polls.' })
  request.user = user
  next()
}

async function requireAdmin(request, response, next) {
  const user = await getCurrentUser(request)
  if (!user) return response.status(401).json({ error: 'Please log in as an admin.' })
  if (user.role !== 'admin') return response.status(403).json({ error: 'Admin access is required.' })
  request.user = user
  next()
}

async function canManagePoll(id, user) {
  if (!user) return false
  const poll = await database.prepare('SELECT owner_user_id AS ownerId FROM polls WHERE id = ?').get(id)
  return Boolean(poll && (poll.ownerId === user.id || user.isSuperAdmin))
}

async function requirePollOwner(request, response, next) {
  if (!(await canManagePoll(request.params.id, request.user))) return response.status(404).json({ error: 'This poll could not be found.' })
  next()
}

function validateCredentials(username, password) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) return 'Use a username with 3–40 letters, numbers, dots, dashes, or underscores.'
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) return 'Use a password between 12 and 128 characters.'
  return ''
}

async function createUser(username, password, role) {
  const salt = randomBytes(16)
  const passwordHash = scryptSync(password, salt, 64)
  const firstUser = !(await database.prepare('SELECT id FROM users LIMIT 1').get())
  const user = { id: randomUUID(), username, role, isSuperAdmin: firstUser, createdAt: new Date().toISOString() }
  await database.prepare('INSERT INTO users (id, username, password_hash, password_salt, role, created_at, is_superadmin) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(user.id, username, passwordHash, salt.toString('hex'), role, user.createdAt, Number(firstUser))
  return publicUser(user)
}

async function migrateLegacyData() {
  if (!existsSync(legacyPollsFile)) return
  const owner = await database.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at, id LIMIT 1").get()
  const insertPoll = database.prepare('INSERT IGNORE INTO polls (id, question, created_at, owner_user_id) VALUES (?, ?, ?, ?)')
  const insertOption = database.prepare('INSERT IGNORE INTO poll_options (id, poll_id, label, `position`, votes) VALUES (?, ?, ?, ?, ?)')
  const insertVoter = database.prepare('INSERT IGNORE INTO poll_voters (poll_id, voter_id, option_id, created_at) VALUES (?, ?, NULL, ?)')

  await inTransaction(async () => {
    const legacyPolls = JSON.parse(readFileSync(legacyPollsFile, 'utf8'))
    for (const poll of legacyPolls) {
      await insertPoll.run(poll.id, poll.question, poll.createdAt || new Date().toISOString(), owner?.id ?? null)
      for (const [index, option] of poll.options.entries()) await insertOption.run(option.id, poll.id, option.label, index, option.votes || 0)
      for (const voterId of poll.voterIds || []) {
        await insertVoter.run(poll.id, voterId, poll.createdAt || new Date().toISOString())
      }
    }
  })
}

await migrateLegacyData()

async function migrateAccountOwnership() {
  await inTransaction(async () => {
    if (await database.prepare('SELECT id FROM account_migrations WHERE id = ?').get('account-isolation-v1')) return
    const firstAdmin = await database.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at, id LIMIT 1").get()
    if (!firstAdmin) return
    const legacyImages = await database.prepare('SELECT COUNT(*) AS count FROM logo_bank').get()
    const imageOwner = await database.prepare('SELECT id FROM users WHERE username = ?').get('admin')
    if (Number(legacyImages.count) && !imageOwner) throw new Error('Account isolation migration requires an existing user named admin for the legacy image bank.')
    await database.prepare('UPDATE users SET is_superadmin = 1 WHERE id = ?').run(firstAdmin.id)
    await database.prepare('UPDATE polls SET owner_user_id = ? WHERE owner_user_id IS NULL').run(firstAdmin.id)
    if (Number(legacyImages.count)) {
      await database.prepare('INSERT INTO account_logo_bank (id, owner_user_id, name, content_hash, image_mime_type, image, created_at) SELECT id, ?, name, content_hash, image_mime_type, image, created_at FROM logo_bank').run(imageOwner.id)
    }
    const settings = await selectThemeSettings.get()
    for (const user of await database.prepare('SELECT id FROM users').all()) {
      await database.prepare('INSERT INTO account_theme_settings (user_id, draft_json, published_json, updated_at, published_at) VALUES (?, ?, ?, ?, ?)')
        .run(user.id, settings.draft, settings.published, settings.updatedAt, settings.publishedAt)
      const assets = new Set([settings.draft, settings.published].flatMap((json) => Object.values(getThemeConfig(json).assets)).filter((id) => typeof id === 'string'))
      for (const id of assets) await database.prepare('INSERT IGNORE INTO account_theme_assets (user_id, asset_id) VALUES (?, ?)').run(user.id, id)
    }
    for (const asset of await database.prepare('SELECT id, uploaded_by AS userId FROM theme_assets').all()) {
      await database.prepare('INSERT IGNORE INTO account_theme_assets (user_id, asset_id) VALUES (?, ?)').run(asset.userId, asset.id)
    }
    await database.prepare('INSERT INTO account_migrations (id) VALUES (?)').run('account-isolation-v1')
  })
}

await migrateAccountOwnership()

async function migrateAdVideoOwnership() {
  await inTransaction(async () => {
    if (await database.prepare('SELECT id FROM account_migrations WHERE id = ?').get('account-ad-videos-v1')) return
    const owner = await database.prepare("SELECT id FROM users WHERE is_superadmin = 1 OR role = 'admin' ORDER BY is_superadmin DESC, created_at, id LIMIT 1").get()
    if (!owner) return
    for (const table of ['ad_videos', 'raffle_ad_videos', 'scramble_ad_videos']) {
      await database.prepare(`
        INSERT IGNORE INTO account_ad_videos (user_id, kind, file_name, original_name, mime_type, size, updated_at)
        SELECT ?, kind, file_name, original_name, mime_type, size, updated_at FROM ${table}
      `).run(owner.id)
    }
    await database.prepare('UPDATE game_rooms SET owner_user_id = ? WHERE owner_user_id IS NULL').run(owner.id)
    await database.prepare('INSERT INTO account_migrations (id) VALUES (?)').run('account-ad-videos-v1')
  })
}

await migrateAdVideoOwnership()

app.get('/api/auth/status', async (request, response) => {
  const userCount = (await database.prepare('SELECT count(*) AS count FROM users').get()).count
  response.json({ setupRequired: userCount === 0, user: await getCurrentUser(request) })
})

app.post('/api/auth/setup', async (request, response) => {
  const userCount = (await database.prepare('SELECT count(*) AS count FROM users').get()).count
  if (userCount !== 0) return response.status(409).json({ error: 'Initial setup has already been completed.' })
  const { username, password } = request.body || {}
  const validationError = validateCredentials(username, password)
  if (validationError) return response.status(400).json({ error: validationError })

  let user
  try {
    user = await inTransaction(async () => {
      if (await database.prepare('SELECT 1 FROM users LIMIT 1').get()) return null
      return createUser(username, password, 'admin')
    })
  } catch {
    return response.status(409).json({ error: 'Initial setup has already been completed.' })
  }
  if (!user) return response.status(409).json({ error: 'Initial setup has already been completed.' })
  await migrateAccountOwnership()
  await migrateAdVideoOwnership()
  await setSessionCookie(request, response, user.id)
  response.status(201).json({ user })
})

app.post('/api/auth/login', rateLimit({ windowMs: 60_000, max: 20, message: 'Too many login attempts. Try again in a minute.' }), async (request, response) => {
  const { username, password } = request.body || {}
  if (typeof username !== 'string' || typeof password !== 'string') {
    return response.status(400).json({ error: 'Enter your username and password.' })
  }
  const user = await database.prepare('SELECT id, username, role, is_superadmin AS isSuperAdmin, password_hash AS passwordHash, password_salt AS passwordSalt FROM users WHERE username = ?').get(username)
  if (!user) return response.status(401).json({ error: 'Incorrect username or password.' })
  const passwordHash = scryptSync(password, Buffer.from(user.passwordSalt, 'hex'), 64)
  if (!timingSafeEqual(passwordHash, user.passwordHash)) return response.status(401).json({ error: 'Incorrect username or password.' })
  await setSessionCookie(request, response, user.id)
  response.json({ user: publicUser(user) })
})

app.post('/api/auth/logout', async (request, response) => {
  const token = getSessionToken(request)
  if (token) await database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashSessionToken(token))
  response.setHeader('Set-Cookie', `vote_session=; Path=/; HttpOnly; Max-Age=0${cookieSecurityFlags(request)}`)
  response.status(204).end()
})

function validPlayerName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 24
}

function getGameRoom(id) {
  return database.prepare(`
    SELECT id, player_x_token_hash AS playerXTokenHash, player_o_token_hash AS playerOTokenHash,
      room_name AS roomName, player_x_name AS playerXName, player_o_name AS playerOName, status,
      board_json AS boardJson, history_x_json AS historyXJson, history_o_json AS historyOJson,
      next_player AS nextPlayer, winner, x_image_mime_type AS xImageMimeType,
      o_image_mime_type AS oImageMimeType, rematch_deadline AS rematchDeadline,
      rematch_x_vote AS rematchXVote, rematch_o_vote AS rematchOVote,
      revision, updated_at AS updatedAt
    FROM game_rooms WHERE id = ?
  `).get(id)
}

function gameRoomState(room, player) {
  return {
    id: room.id,
    roomName: room.roomName,
    status: room.status,
    board: JSON.parse(room.boardJson),
    nextPlayer: room.nextPlayer,
    winner: room.winner,
    rematchDeadline: room.rematchDeadline,
    rematchVotes: { X: room.rematchXVote, O: room.rematchOVote },
    revision: room.revision,
    playerXName: room.playerXName,
    playerOName: room.playerOName,
    xImageUrl: room.xImageMimeType ? `/api/games/${encodeURIComponent(room.id)}/pieces/X` : null,
    oImageUrl: room.oImageMimeType ? `/api/games/${encodeURIComponent(room.id)}/pieces/O` : null,
    youAre: player,
    isSpectator: player === null,
  }
}

function getGamePlayer(request, room) {
  const authorization = request.get('authorization') || ''
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
  const tokenHash = hashSessionToken(token)
  if (tokenHash === room.playerXTokenHash) return 'X'
  if (tokenHash === room.playerOTokenHash) return 'O'
  return null
}

function isGameRoomExpired(room) {
  return Date.parse(room.updatedAt) <= Date.now() - 24 * 60 * 60 * 1000
}

app.get('/api/admin/games', requireAdmin, async (_request, response) => {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  await database.prepare('DELETE FROM game_rooms WHERE updated_at <= ?').run(cutoff)
  const rooms = await database.prepare(`
    SELECT id, room_name AS roomName, status, player_x_name AS playerXName, player_o_name AS playerOName,
      updated_at AS updatedAt
    FROM game_rooms
    WHERE status IN ('waiting', 'playing')
    ORDER BY updated_at DESC
  `).all()
  response.json({ rooms, limit: 3 })
})

app.delete('/api/admin/games/:id', requireAdmin, async (request, response) => {
  const result = await database.prepare("DELETE FROM game_rooms WHERE id = ? AND status IN ('waiting', 'playing')").run(request.params.id)
  if (result.changes === 0) return response.status(404).json({ error: 'The active game room could not be found.' })
  response.status(204).end()
})

app.post('/api/games', requireAdmin, imageUpload.fields([{ name: 'xImage', maxCount: 1 }, { name: 'oImage', maxCount: 1 }]), async (request, response) => {
  const roomName = typeof request.body?.roomName === 'string' ? request.body.roomName.trim() : ''
  if (!roomName || roomName.length > 60) {
    return response.status(400).json({ error: 'Enter a game room name up to 60 characters.' })
  }
  const xImage = request.files?.xImage?.[0]
  const oImage = request.files?.oImage?.[0]
  const pieceStyle = request.body?.pieceStyle
  if (pieceStyle === 'photo' && (!xImage || !oImage)) {
    return response.status(400).json({ error: 'Upload a photo for both Player X and Player O.' })
  }
  if (pieceStyle === 'letters' && (xImage || oImage)) {
    return response.status(400).json({ error: 'Letter pieces cannot include uploaded photos.' })
  }
  if ([xImage, oImage].some((file) => file && !hasValidImageSignature(file.mimetype, file.buffer))) {
    return response.status(400).json({ error: 'Player images must be valid JPEG, PNG, or WebP images.' })
  }
  const activeRoomLimit = 3
  const id = randomUUID()
  const now = new Date().toISOString()
  const created = await inTransaction(async () => {
    await database.prepare('DELETE FROM game_rooms WHERE updated_at <= ?')
      .run(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    const activeCount = (await database.prepare("SELECT count(*) AS count FROM game_rooms WHERE status IN ('waiting', 'playing')").get()).count
    if (activeCount >= activeRoomLimit) return false
    await database.prepare(`
      INSERT INTO game_rooms
        (id, room_name, owner_user_id, player_x_token_hash, player_x_name, status, board_json, history_x_json, history_o_json,
          next_player, x_image_mime_type, x_image, o_image_mime_type, o_image, updated_at)
      VALUES (?, ?, ?, '', 'Waiting for Player X', 'waiting', ?, '[]', '[]', 'X', ?, ?, ?, ?, ?)
    `).run(
      id,
      roomName,
      request.user.id,
      JSON.stringify(Array(9).fill(null)),
      xImage?.mimetype || null,
      xImage?.buffer || null,
      oImage?.mimetype || null,
      oImage?.buffer || null,
      now,
    )
    return true
  })
  if (!created) return response.status(409).json({ error: `You can have up to ${activeRoomLimit} active game rooms at a time.` })
  response.status(201).json({ id })
})

app.get('/api/games/:id/pieces/:player', async (request, response) => {
  const player = request.params.player.toUpperCase()
  if (!['X', 'O'].includes(player)) return response.status(404).end()
  const column = player === 'X' ? 'x_image' : 'o_image'
  const mimeColumn = player === 'X' ? 'x_image_mime_type' : 'o_image_mime_type'
  const piece = await database.prepare(`SELECT ${column} AS image, ${mimeColumn} AS mimeType FROM game_rooms WHERE id = ?`).get(request.params.id)
  if (!piece?.image || !piece.mimeType) return response.status(404).end()
  response.type(piece.mimeType).set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'no-store').send(Buffer.from(piece.image))
})

app.post('/api/games/:id/join', async (request, response) => {
  const { name } = request.body || {}
  if (!validPlayerName(name)) return response.status(400).json({ error: 'Enter a player name up to 24 characters.' })
  const room = await getGameRoom(request.params.id)
  if (!room || isGameRoomExpired(room)) {
    if (room) await database.prepare('DELETE FROM game_rooms WHERE id = ?').run(room.id)
    return response.status(404).json({ error: 'This game room has expired or does not exist.' })
  }
  const token = randomBytes(32).toString('base64url')
  const player = await inTransaction(async () => {
    const current = await getGameRoom(room.id)
    if (!current || current.status !== 'waiting') return null
    const side = current.playerXTokenHash === '' ? 'X' : current.playerOTokenHash ? null : 'O'
    if (!side) return null
    const now = new Date().toISOString()
    if (side === 'X') {
      await database.prepare(`
        UPDATE game_rooms
        SET player_x_token_hash = ?, player_x_name = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND status = 'waiting' AND player_x_token_hash = ''
      `).run(hashSessionToken(token), name.trim(), now, room.id)
    } else {
      await database.prepare(`
        UPDATE game_rooms
        SET player_o_token_hash = ?, player_o_name = ?, status = 'playing', revision = revision + 1, updated_at = ?
        WHERE id = ? AND status = 'waiting' AND player_o_token_hash IS NULL
      `).run(hashSessionToken(token), name.trim(), now, room.id)
    }
    return side
  })
  if (!player) return response.status(409).json({ error: 'Both player slots are already filled.' })
  response.status(200).json({ token, game: gameRoomState(await getGameRoom(room.id), player) })
})

app.get('/api/games/:id', async (request, response) => {
  const room = await getGameRoom(request.params.id)
  if (!room || isGameRoomExpired(room)) {
    if (room) await database.prepare('DELETE FROM game_rooms WHERE id = ?').run(room.id)
    return response.status(404).json({ error: 'This game room has expired or does not exist.' })
  }
  const player = getGamePlayer(request, room)
  if (!player) {
    const user = await getCurrentUser(request)
    if (!user || user.role !== 'admin') return response.status(403).json({ error: 'A valid player session or admin account is required to view this game.' })
    return response.json(gameRoomState(room, null))
  }
  response.json(gameRoomState(room, player))
})

app.post('/api/games/:id/moves', async (request, response) => {
  const room = await getGameRoom(request.params.id)
  if (!room || isGameRoomExpired(room)) {
    if (room) await database.prepare('DELETE FROM game_rooms WHERE id = ?').run(room.id)
    return response.status(404).json({ error: 'This game room has expired or does not exist.' })
  }
  const player = getGamePlayer(request, room)
  if (!player) return response.status(403).json({ error: 'This game session is invalid. Rejoin using the room link.' })
  const { cell } = request.body || {}
  if (!Number.isInteger(cell) || cell < 0 || cell > 8) return response.status(400).json({ error: 'Choose a square on the board.' })

  const result = await inTransaction(async () => {
    const current = await getGameRoom(room.id)
    if (!current || current.status !== 'playing') return { error: 'This game is not accepting moves.', status: 409 }
    if (current.nextPlayer !== player) return { error: 'Wait for your turn.', status: 409 }
    const board = JSON.parse(current.boardJson)
    if (board[cell] !== null) return { error: 'That square is already occupied.', status: 409 }
    const history = JSON.parse(player === 'X' ? current.historyXJson : current.historyOJson)
    board[cell] = player
    history.push(cell)
    const lines = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]]
    const winner = lines.some((line) => line.every((index) => board[index] === player)) ? player : null
    if (!winner && history.length > 3) board[history.shift()] = null
    const now = new Date().toISOString()
    await database.prepare(`
      UPDATE game_rooms SET board_json = ?, history_${player === 'X' ? 'x' : 'o'}_json = ?,
        next_player = ?, winner = ?, status = ?, rematch_deadline = ?, rematch_x_vote = NULL,
        rematch_o_vote = NULL, revision = revision + 1, updated_at = ? WHERE id = ?
    `).run(
      JSON.stringify(board),
      JSON.stringify(history),
      winner ? player : player === 'X' ? 'O' : 'X',
      winner,
      winner ? 'finished' : 'playing',
      winner ? new Date(Date.now() + 20_000).toISOString() : null,
      now,
      room.id,
    )
    return { game: gameRoomState(await getGameRoom(room.id), player) }
  })
  if (result.error) return response.status(result.status).json({ error: result.error })
  response.json(result.game)
})

app.post('/api/games/:id/rematch', async (request, response) => {
  const room = await getGameRoom(request.params.id)
  if (!room || isGameRoomExpired(room)) {
    if (room) await database.prepare('DELETE FROM game_rooms WHERE id = ?').run(room.id)
    return response.status(404).json({ error: 'This game room has expired or does not exist.' })
  }
  const player = getGamePlayer(request, room)
  if (!player) return response.status(403).json({ error: 'This game session is invalid. Rejoin using the room link.' })
  const { playAgain } = request.body || {}
  if (typeof playAgain !== 'boolean') return response.status(400).json({ error: 'Choose whether you want to play again.' })

  const result = await inTransaction(async () => {
    const current = await getGameRoom(room.id)
    if (!current || current.status !== 'finished') return { error: 'This game is not ready for a rematch.', status: 409 }
    if (!current.rematchDeadline || Date.parse(current.rematchDeadline) <= Date.now()) {
      return { error: 'The rematch time has expired.', status: 409 }
    }
    if (current.rematchXVote === 0 || current.rematchOVote === 0) {
      return { error: 'A player has declined the rematch.', status: 409 }
    }

    const voteColumn = player === 'X' ? 'rematch_x_vote' : 'rematch_o_vote'
    const currentVote = player === 'X' ? current.rematchXVote : current.rematchOVote
    if (currentVote !== null) {
      if (currentVote !== Number(playAgain)) return { error: 'Your rematch choice has already been submitted.', status: 409 }
      return { game: gameRoomState(current, player) }
    }

    await database.prepare(`UPDATE game_rooms SET ${voteColumn} = ?, revision = revision + 1, updated_at = ? WHERE id = ?`)
      .run(Number(playAgain), new Date().toISOString(), room.id)
    const updated = await getGameRoom(room.id)
    if (updated.rematchXVote === 1 && updated.rematchOVote === 1) {
      const now = new Date().toISOString()
      await database.prepare(`
        UPDATE game_rooms SET board_json = ?, history_x_json = '[]', history_o_json = '[]',
          next_player = 'X', winner = NULL, status = 'playing', rematch_deadline = NULL,
          rematch_x_vote = NULL, rematch_o_vote = NULL, revision = revision + 1,
          updated_at = ? WHERE id = ?
      `).run(JSON.stringify(Array(9).fill(null)), now, room.id)
      return { game: gameRoomState(await getGameRoom(room.id), player) }
    }
    return { game: gameRoomState(updated, player) }
  })

  if (result.error) return response.status(result.status).json({ error: result.error })
  response.json(result.game)
})

async function loadTerms() {
  const row = await database.prepare('SELECT content, version, updated_at AS updatedAt FROM terms_of_service WHERE id = 1').get()
  return row ? { content: row.content, version: Number(row.version), updatedAt: row.updatedAt } : { content: defaultTerms, version: 1, updatedAt: null }
}

app.get('/api/terms', async (_request, response) => {
  response.set('Cache-Control', 'no-store').json(await loadTerms())
})

app.put('/api/admin/terms', requireAdmin, async (request, response) => {
  const content = typeof request.body?.content === 'string' ? request.body.content.replace(/\r\n/g, '\n').trim() : ''
  if (!content) return response.status(400).json({ error: 'Enter the Terms of Service text.' })
  if (content.length > 60000) return response.status(400).json({ error: 'The Terms of Service must be 60,000 characters or fewer.' })
  const existing = await database.prepare('SELECT version FROM terms_of_service WHERE id = 1').get()
  const version = existing ? Number(existing.version) + 1 : 2
  const now = new Date().toISOString()
  if (existing) {
    await database.prepare('UPDATE terms_of_service SET content = ?, version = ?, updated_at = ?, updated_by = ? WHERE id = 1').run(content, version, now, request.user.id)
  } else {
    await database.prepare('INSERT INTO terms_of_service (id, content, version, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)').run(content, version, now, request.user.id)
  }
  response.json({ content, version, updatedAt: now })
})

app.get('/api/admin/users', requireAdmin, async (_request, response) => {
  const users = await database.prepare('SELECT id, username, role, is_superadmin AS isSuperAdmin, created_at AS createdAt FROM users ORDER BY created_at').all()
  response.json(users.map((user) => ({ ...user, isSuperAdmin: Boolean(user.isSuperAdmin) })))
})

app.post('/api/admin/users', requireAdmin, async (request, response) => {
  const { username, password, role } = request.body || {}
  const validationError = validateCredentials(username, password)
  if (validationError) return response.status(400).json({ error: validationError })
  if (!['admin', 'host'].includes(role)) return response.status(400).json({ error: 'Choose an admin or host role.' })

  try {
    const user = await createUser(username, password, role)
    response.status(201).json({ user })
  } catch {
    response.status(409).json({ error: 'That username is already in use.' })
  }
})

app.get('/api/theme', async (request, response) => {
  const { kind, id } = request.query
  let ownerId
  if (kind === 'login' && id === undefined) {
    const superadmin = await database.prepare('SELECT id FROM users WHERE is_superadmin = 1 ORDER BY created_at, id LIMIT 1').get()
    ownerId = superadmin?.id
  } else if (typeof kind === 'string' && typeof id === 'string') {
    let row
    if (kind === 'poll') row = await database.prepare('SELECT owner_user_id AS ownerId FROM polls WHERE id = ?').get(id)
    else if (kind === 'raffle') row = await database.prepare('SELECT created_by AS ownerId FROM raffle_sessions WHERE id = ?').get(id)
    else if (kind === 'scramble') row = await database.prepare('SELECT created_by AS ownerId FROM scramble_games WHERE id = ?').get(id)
    else if (kind === 'game') row = await database.prepare('SELECT owner_user_id AS ownerId FROM game_rooms WHERE id = ?').get(id)
    else if (kind === 'selfie-join' && /^[A-Za-z0-9_-]{43}$/.test(id)) {
      const session = await getSelfieSessionForJoin(id)
      if (session) row = await database.prepare('SELECT owner_user_id AS ownerId FROM selfie_sessions WHERE id = ?').get(session.id)
    } else if (kind === 'selfie-display') {
      const token = request.get('X-Selfie-Display-Token') || ''
      if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
        const hash = hashSessionToken(token)
        row = await database.prepare('SELECT owner_user_id AS ownerId FROM selfie_sessions WHERE id = ? AND (display_token_hash = ? OR id IN (SELECT session_id FROM selfie_session_links WHERE display_token_hash = ?))').get(id, hash, hash)
      }
      if (!row) {
        const user = await getCurrentUser(request)
        if (user) row = await database.prepare('SELECT owner_user_id AS ownerId FROM selfie_sessions WHERE id = ? AND (owner_user_id = ? OR ? = 1)').get(id, user.id, Number(user.isSuperAdmin))
      }
    } else return response.status(400).json({ error: 'Invalid theme context.' })
    if (!row?.ownerId) return response.status(404).json({ error: 'This activity could not be found.' })
    ownerId = row.ownerId
  } else if (kind !== undefined || id !== undefined) return response.status(400).json({ error: 'Invalid theme context.' })
  else ownerId = (await getCurrentUser(request))?.id
  response.set('Cache-Control', 'no-store').json(await getPublicTheme(ownerId))
})

app.get('/api/game-theme', async (_request, response) => response.json(await getPublicGameTheme()))

app.get('/api/game-theme/assets/:id', async (request, response) => {
  const theme = await getPublicGameTheme()
  if (![...Object.values(theme.config.assets), ...Object.values(theme.config.fonts)].includes(request.params.id)) return response.status(404).end()
  const asset = await selectThemeAsset.get(request.params.id)
  if (!asset) return response.status(404).end()
  const file = await database.prepare('SELECT file_name AS fileName FROM theme_assets WHERE id = ?').get(request.params.id)
  response.type(asset.mimeType).set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'public, max-age=3600, immutable').sendFile(path.join(themeAssetsDirectory, file.fileName))
})

app.get('/api/admin/game-theme', requireAdmin, async (request, response) => {
  const settings = await selectGameThemeSettings.get()
  const owned = await database.prepare("SELECT a.id, a.mime_type AS mimeType, a.size_bytes AS sizeBytes, a.width, a.height, COALESCE(a.asset_kind, 'image') AS assetKind, a.original_name AS originalName, a.uploaded_at AS uploadedAt FROM theme_assets a JOIN account_theme_assets aa ON aa.asset_id = a.id WHERE aa.user_id = ? ORDER BY a.uploaded_at DESC").all(request.user.id)
  const sharedIds = new Set([settings.draft, settings.published].flatMap((json) => {
    const c = getThemeConfig(json)
    return [...Object.values(c.assets), ...Object.values(c.fonts)]
  }).filter((id) => typeof id === 'string'))
  for (const id of sharedIds) {
    if (!owned.some((asset) => asset.id === id)) {
      const asset = await selectThemeAsset.get(id)
      if (asset) owned.push(asset)
    }
  }
  response.json({
    draft: getThemeConfig(settings.draft),
    published: getThemeConfig(settings.published),
    draftAssets: owned,
    maxUploadBytes: themeImageMaxBytes,
    maxFontUploadBytes: themeFontMaxBytes,
    updatedAt: settings.updatedAt,
    publishedAt: settings.publishedAt,
  })
})

app.put('/api/admin/game-theme/draft', requireAdmin, async (request, response) => {
  const config = request.body
  const assetKeys = Object.keys(defaultGameTheme.assets)
  const fontKeys = Object.keys(defaultGameTheme.fonts)
  const colorKeys = Object.keys(defaultGameTheme.colors)
  const background = config?.background
  if (!config || typeof config !== 'object' || Array.isArray(config) || typeof config.eventTitle !== 'string' || config.eventTitle.trim().length < 1 || config.eventTitle.trim().length > 80) {
    return response.status(400).json({ error: 'Enter a game title between 1 and 80 characters.' })
  }
  if (!config.assets || !(await themeAssetsAreValid(config.assets, assetKeys, null, 'image'))) {
    return response.status(400).json({ error: 'Choose valid uploaded images for the game theme.' })
  }
  if (config.fonts !== undefined && !(await themeAssetsAreValid(config.fonts, fontKeys, null, 'font'))) {
    return response.status(400).json({ error: 'Choose valid uploaded fonts for the game theme.' })
  }
  const currentGameTheme = await selectGameThemeSettings.get()
  const sharedIds = new Set([currentGameTheme.draft, currentGameTheme.published].flatMap((json) => {
    const c = getThemeConfig(json)
    return [...Object.values(c.assets), ...Object.values(c.fonts)]
  }))
  for (const id of [...Object.values(config.assets), ...Object.values(config.fonts || {})]) {
    if (id != null && !sharedIds.has(id) && !(await database.prepare('SELECT asset_id FROM account_theme_assets WHERE user_id = ? AND asset_id = ?').get(request.user.id, id))) {
      return response.status(400).json({ error: 'Choose valid uploaded assets for the game theme.' })
    }
  }
  if (!config.colors || colorKeys.some((key) => typeof config.colors[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(config.colors[key]))) {
    return response.status(400).json({ error: 'Game theme colors must be valid six-digit hex colors.' })
  }
  if (!background || !['cover', 'contain', 'repeat'].includes(background.size) || !['center', 'top', 'bottom', 'left', 'right'].includes(background.position) || typeof background.opacity !== 'number' || background.opacity < 0 || background.opacity > 1 || typeof background.overlay !== 'number' || background.overlay < 0 || background.overlay > 0.9 || typeof background.borderRadius !== 'number' || background.borderRadius < 0 || background.borderRadius > 32 || typeof background.glow !== 'number' || background.glow < 0 || background.glow > 1) {
    return response.status(400).json({ error: 'Game theme layout settings are invalid.' })
  }

  const displaysValidation = validateAndNormalizeDisplays(config.displays)
  if (!displaysValidation.ok) {
    return response.status(400).json({ error: displaysValidation.error })
  }

  const normalized = {
    eventTitle: config.eventTitle.trim(),
    assets: Object.fromEntries(assetKeys.map((key) => [key, config.assets[key] ?? null])),
    fonts: Object.fromEntries(fontKeys.map((key) => [key, config.fonts?.[key] ?? null])),
    colors: Object.fromEntries(colorKeys.map((key) => [key, config.colors[key].toLowerCase()])),
    background: {
      position: background.position,
      size: background.size,
      repeat: background.size === 'repeat' ? 'repeat' : 'no-repeat',
      opacity: background.opacity,
      overlay: background.overlay,
      borderRadius: background.borderRadius,
      glow: background.glow,
    },
    displays: displaysValidation.value,
  }
  const updatedAt = new Date().toISOString()
  await database.prepare('UPDATE game_theme_settings SET draft_json = ?, updated_by = ?, updated_at = ? WHERE id = 1')
    .run(JSON.stringify(normalized), request.user.id, updatedAt)
  await auditGameThemeChange(request.user, 'draft.save', { eventTitle: normalized.eventTitle })
  response.json({ draft: normalized, updatedAt })
})

app.post('/api/admin/game-theme/publish', requireAdmin, async (request, response) => {
  const settings = await selectGameThemeSettings.get()
  const publishedAt = new Date().toISOString()
  await database.prepare('UPDATE game_theme_settings SET published_json = draft_json, published_by = ?, published_at = ? WHERE id = 1')
    .run(request.user.id, publishedAt)
  await auditGameThemeChange(request.user, 'theme.publish', { eventTitle: getThemeConfig(settings.draft).eventTitle })
  response.json({ published: getThemeConfig(settings.draft), publishedAt })
})

app.post('/api/admin/game-theme/reset', requireAdmin, async (request, response) => {
  const now = new Date().toISOString()
  await database.prepare('UPDATE game_theme_settings SET draft_json = ?, published_json = ?, updated_by = ?, updated_at = ?, published_by = ?, published_at = ? WHERE id = 1')
    .run(JSON.stringify(defaultGameTheme), JSON.stringify(defaultGameTheme), request.user.id, now, request.user.id, now)
  await auditGameThemeChange(request.user, 'theme.reset')
  response.json({ theme: defaultGameTheme, resetAt: now })
})

app.get('/api/admin/game-theme/audit', requireAdmin, async (_request, response) => {
  const entries = await database.prepare("SELECT administrator_name AS administrator, action, details, created_at AS createdAt FROM theme_audit_logs WHERE action LIKE 'game-theme.%' ORDER BY created_at DESC LIMIT 100").all()
  response.json(entries.map((entry) => ({ ...entry, details: JSON.parse(entry.details) })))
})

app.get('/api/theme/assets/:id', async (request, response) => {
  const theme = await getPublicTheme()
  const accounts = await database.prepare('SELECT published_json AS published FROM account_theme_settings').all()
  const isPublishedInGlobal = [...Object.values(theme.config.assets), ...Object.values(theme.config.fonts)].includes(request.params.id)
  const isPublishedInAccount = accounts.some((settings) => {
    const published = getThemeConfig(settings.published)
    return [...Object.values(published.assets), ...Object.values(published.fonts)].includes(request.params.id)
  })
  if (!isPublishedInGlobal && !isPublishedInAccount) return response.status(404).end()
  const asset = await selectThemeAsset.get(request.params.id)
  if (!asset) return response.status(404).end()
  const file = await database.prepare('SELECT file_name AS fileName FROM theme_assets WHERE id = ?').get(request.params.id)
  response.type(asset.mimeType).set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'public, max-age=3600, immutable').sendFile(path.join(themeAssetsDirectory, file.fileName))
})

app.get('/api/admin/theme', requireUser, async (request, response) => {
  const settings = await accountTheme(request.user.id)
  const draft = getThemeConfig(settings.draft)
  response.json({
    draft,
    published: getThemeConfig(settings.published),
    draftAssets: await database.prepare("SELECT a.id, a.mime_type AS mimeType, a.size_bytes AS sizeBytes, a.width, a.height, COALESCE(a.asset_kind, 'image') AS assetKind, a.original_name AS originalName, a.uploaded_at AS uploadedAt FROM theme_assets a JOIN account_theme_assets aa ON aa.asset_id = a.id WHERE aa.user_id = ? ORDER BY a.uploaded_at DESC").all(request.user.id),
    maxUploadBytes: themeImageMaxBytes,
    maxFontUploadBytes: themeFontMaxBytes,
    updatedAt: settings.updatedAt,
    publishedAt: settings.publishedAt,
  })
})

const themeUploadTimes = new Map()
function limitThemeUploads(request, response, next) {
  const now = Date.now()
  const recent = (themeUploadTimes.get(request.user.id) || []).filter((time) => now - time < 10 * 60 * 1000)
  if (recent.length >= 40) return response.status(429).json({ error: 'Upload limit reached. Try again in a few minutes.' })
  recent.push(now)
  themeUploadTimes.set(request.user.id, recent)
  next()
}

app.post('/api/admin/theme/assets', requireUser, limitThemeUploads, themeImageUpload.single('image'), async (request, response) => {
  const { file } = request
  if (!file) return response.status(400).json({ error: 'Choose an image to upload.' })

  let mimeType = ''
  if (hasValidImageSignature('image/jpeg', file.buffer)) mimeType = 'image/jpeg'
  else if (hasValidImageSignature('image/png', file.buffer)) mimeType = 'image/png'
  else if (hasValidImageSignature('image/webp', file.buffer)) mimeType = 'image/webp'
  if (!mimeType) return response.status(400).json({ error: 'Upload a valid JPEG, PNG, or WebP image. SVG and other formats are not supported.' })

  const dimensions = getImageDimensions(mimeType, file.buffer)
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 12000 || dimensions.height > 12000 || dimensions.width * dimensions.height > 40000000) {
    return response.status(400).json({ error: 'Image dimensions must be valid and no larger than 12,000 pixels per side or 40 megapixels.' })
  }

  const id = randomUUID()
  const extension = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[mimeType]
  const fileName = `${id}${extension}`
  const originalName = sanitizeAssetName(file.originalname, 'Image')
  const uploadedAt = new Date().toISOString()
  try {
    writeFileSync(path.join(themeAssetsDirectory, fileName), file.buffer, { flag: 'wx' })
    await inTransaction(async () => {
      await database.prepare('INSERT INTO theme_assets (id, file_name, mime_type, size_bytes, width, height, asset_kind, original_name, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, fileName, mimeType, file.size, dimensions.width, dimensions.height, 'image', originalName, request.user.id, uploadedAt)
      await database.prepare('INSERT INTO account_theme_assets (user_id, asset_id) VALUES (?, ?)').run(request.user.id, id)
    })
  } catch (error) {
    const filePath = path.join(themeAssetsDirectory, fileName)
    if (existsSync(filePath)) unlinkSync(filePath)
    throw error
  }
  await auditThemeChange(request.user, 'asset.upload', { assetId: id, mimeType, sizeBytes: file.size, width: dimensions.width, height: dimensions.height })
  response.status(201).json({ asset: { id, mimeType, sizeBytes: file.size, width: dimensions.width, height: dimensions.height, assetKind: 'image', originalName, uploadedAt, url: `/api/admin/theme/assets/${encodeURIComponent(id)}` } })
})

app.post('/api/admin/theme/fonts', requireUser, limitThemeUploads, themeFontUpload.single('font'), async (request, response) => {
  const { file } = request
  if (!file) return response.status(400).json({ error: 'Choose a font file to import.' })

  const detected = detectFontAsset(file.buffer, file.originalname)
  if (!detected) {
    return response.status(400).json({ error: 'Upload a valid font file (TTF, OTF, WOFF, WOFF2, EOT, TTC, OTC, or SFNT).' })
  }

  const id = randomUUID()
  const fileName = `${id}${detected.extension}`
  const originalName = sanitizeAssetName(file.originalname, `Custom${detected.extension}`)
  const uploadedAt = new Date().toISOString()
  try {
    writeFileSync(path.join(themeAssetsDirectory, fileName), file.buffer, { flag: 'wx' })
    await inTransaction(async () => {
      await database.prepare('INSERT INTO theme_assets (id, file_name, mime_type, size_bytes, width, height, asset_kind, original_name, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, fileName, detected.mimeType, file.size, 0, 0, 'font', originalName, request.user.id, uploadedAt)
      await database.prepare('INSERT INTO account_theme_assets (user_id, asset_id) VALUES (?, ?)').run(request.user.id, id)
    })
  } catch (error) {
    const filePath = path.join(themeAssetsDirectory, fileName)
    if (existsSync(filePath)) unlinkSync(filePath)
    throw error
  }
  await auditThemeChange(request.user, 'font.upload', { assetId: id, mimeType: detected.mimeType, sizeBytes: file.size, name: originalName })
  response.status(201).json({ asset: { id, mimeType: detected.mimeType, sizeBytes: file.size, width: 0, height: 0, assetKind: 'font', originalName, uploadedAt, url: `/api/admin/theme/assets/${encodeURIComponent(id)}` } })
})

app.get('/api/admin/theme/assets/:id', requireUser, async (request, response) => {
  const owned = await database.prepare('SELECT asset_id FROM account_theme_assets WHERE user_id = ? AND asset_id = ?').get(request.user.id, request.params.id)
  const game = request.user.role === 'admin' ? await selectGameThemeSettings.get() : null
  const gameAssets = game ? [game.draft, game.published].flatMap((json) => {
    const c = getThemeConfig(json)
    return [...Object.values(c.assets), ...Object.values(c.fonts)]
  }) : []
  if (!owned && !gameAssets.includes(request.params.id)) return response.status(404).json({ error: 'Theme asset not found.' })
  const asset = await selectThemeAsset.get(request.params.id)
  if (!asset) return response.status(404).json({ error: 'Theme asset not found.' })
  const file = await database.prepare('SELECT file_name AS fileName FROM theme_assets WHERE id = ?').get(request.params.id)
  response.type(asset.mimeType).set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'no-store').sendFile(path.join(themeAssetsDirectory, file.fileName))
})

app.put('/api/admin/theme/draft', requireUser, async (request, response) => {
  const config = request.body
  const assetKeys = Object.keys(defaultTheme.assets)
  const fontKeys = Object.keys(defaultTheme.fonts)
  const colorKeys = Object.keys(defaultTheme.colors)
  if (!config || typeof config !== 'object' || Array.isArray(config) || typeof config.eventTitle !== 'string' || config.eventTitle.trim().length < 1 || config.eventTitle.trim().length > 80) {
    return response.status(400).json({ error: 'Enter an event title between 1 and 80 characters.' })
  }
  if (!config.assets || !(await themeAssetsAreValid(config.assets, assetKeys, request.user.id, 'image'))) {
    return response.status(400).json({ error: 'Choose valid uploaded images for the theme.' })
  }
  if (config.fonts !== undefined && !(await themeAssetsAreValid(config.fonts, fontKeys, request.user.id, 'font'))) {
    return response.status(400).json({ error: 'Choose valid uploaded fonts for the theme.' })
  }
  if (!config.colors || colorKeys.some((key) => typeof config.colors[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(config.colors[key]))) {
    return response.status(400).json({ error: 'Theme colors must be valid six-digit hex colors.' })
  }
  const background = config.background
  if (!themeSkins.includes(config.skin)) {
    return response.status(400).json({ error: 'Choose one of the available themes.' })
  }
  if (!background || !['cover', 'contain', 'repeat'].includes(background.size) || !['center', 'top', 'bottom', 'left', 'right'].includes(background.position) || typeof background.opacity !== 'number' || background.opacity < 0 || background.opacity > 1 || typeof background.overlay !== 'number' || background.overlay < 0 || background.overlay > 0.9 || typeof background.borderRadius !== 'number' || background.borderRadius < 0 || background.borderRadius > 32 || typeof background.glow !== 'number' || background.glow < 0 || background.glow > 1) {
    return response.status(400).json({ error: 'Theme layout settings are invalid.' })
  }

  const displaysValidation = validateAndNormalizeDisplays(config.displays)
  if (!displaysValidation.ok) {
    return response.status(400).json({ error: displaysValidation.error })
  }

  const normalized = {
    eventTitle: config.eventTitle.trim(),
    skin: config.skin,
    assets: Object.fromEntries(assetKeys.map((key) => [key, config.assets[key] ?? null])),
    fonts: Object.fromEntries(fontKeys.map((key) => [key, config.fonts?.[key] ?? null])),
    colors: Object.fromEntries(colorKeys.map((key) => [key, config.colors[key].toLowerCase()])),
    background: {
      position: background.position,
      size: background.size,
      repeat: background.size === 'repeat' ? 'repeat' : 'no-repeat',
      opacity: background.opacity,
      overlay: background.overlay,
      borderRadius: background.borderRadius,
      glow: background.glow,
    },
    displays: displaysValidation.value,
  }
  const updatedAt = new Date().toISOString()
  await accountTheme(request.user.id)
  await database.prepare('UPDATE account_theme_settings SET draft_json = ?, updated_at = ? WHERE user_id = ?')
    .run(JSON.stringify(normalized), updatedAt, request.user.id)
  await auditThemeChange(request.user, 'draft.save', { eventTitle: normalized.eventTitle, theme: normalized.skin })
  response.json({ draft: normalized, updatedAt })
})

app.post('/api/admin/theme/publish', requireUser, async (_request, response) => {
  const settings = await accountTheme(_request.user.id)
  const publishedAt = new Date().toISOString()
  await database.prepare('UPDATE account_theme_settings SET published_json = draft_json, published_at = ? WHERE user_id = ?')
    .run(publishedAt, _request.user.id)
  await auditThemeChange(_request.user, 'theme.publish', { eventTitle: getThemeConfig(settings.draft).eventTitle })
  response.json({ published: getThemeConfig(settings.draft), publishedAt })
})

app.post('/api/admin/theme/reset', requireUser, async (_request, response) => {
  const now = new Date().toISOString()
  await accountTheme(_request.user.id)
  await database.prepare('UPDATE account_theme_settings SET draft_json = ?, published_json = ?, updated_at = ?, published_at = ? WHERE user_id = ?')
    .run(JSON.stringify(defaultTheme), JSON.stringify(defaultTheme), now, now, _request.user.id)
  await auditThemeChange(_request.user, 'theme.reset')
  response.json({ theme: defaultTheme, resetAt: now })
})

app.delete('/api/admin/theme/assets/:id', requireUser, async (request, response) => {
  const settings = await accountTheme(request.user.id)
  if ([settings.draft, settings.published].some((json) => {
    const c = getThemeConfig(json)
    return [...Object.values(c.assets), ...Object.values(c.fonts)].includes(request.params.id)
  })) {
    return response.status(409).json({ error: 'Remove this asset from both the draft and published themes before deleting it.' })
  }
  const deleted = await database.prepare('DELETE FROM account_theme_assets WHERE user_id = ? AND asset_id = ?').run(request.user.id, request.params.id)
  if (!deleted.changes) return response.status(404).json({ error: 'Theme asset not found.' })
  await auditThemeChange(request.user, 'asset.delete', { assetId: request.params.id })
  response.status(204).end()
})

app.get('/api/admin/theme/audit', requireUser, async (request, response) => {
  const entries = await database.prepare('SELECT administrator_name AS administrator, action, details, created_at AS createdAt FROM theme_audit_logs WHERE administrator_id = ? ORDER BY created_at DESC LIMIT 100').all(request.user.id)
  response.json(entries.map((entry) => ({ ...entry, details: JSON.parse(entry.details) })))
})

function getSelfieSessionForOwner(sessionId, user) {
  return database.prepare(`
    SELECT id, owner_user_id AS ownerUserId, created_at AS createdAt, closed_at AS closedAt, paused, rotation_seconds AS rotationSeconds, santa_enabled AS santaEnabled
    FROM selfie_sessions
    WHERE id = ? AND (owner_user_id = ? OR ? = 1)
  `).get(sessionId, user.id, Number(user.isSuperAdmin))
}

function getSelfieSessionForJoin(token) {
  const hash = hashSessionToken(token)
  return database.prepare(`
    SELECT id, owner_user_id AS ownerUserId, closed_at AS closedAt, paused, santa_enabled AS santaEnabled
    FROM selfie_sessions WHERE join_token_hash = ? OR live_join_token_hash = ? OR id IN (
      SELECT session_id FROM selfie_session_links WHERE join_token_hash = ?
    )
  `).get(hash, hash, hash)
}

async function getSelfieDisplayQr(session) {
  const ongoing = await database.prepare(`
    SELECT id, join_token_hash AS joinTokenHash, paused FROM selfie_sessions
    WHERE owner_user_id = ? AND closed_at IS NULL AND (? IS NOT NULL OR id = ?)
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(session.ownerUserId, session.closedAt, session.id)
  return ongoing ? { id: ongoing.id, joinToken: selfieLiveJoinToken(ongoing.joinTokenHash), paused: Boolean(ongoing.paused) } : null
}

app.post('/api/selfie/sessions/:id/pause', requireUser, async (request, response) => {
  const session = await getSelfieSessionForOwner(request.params.id, request.user)
  if (!session) return response.status(404).json({ error: 'This selfie session could not be found.' })
  const paused = request.body?.paused === true ? 1 : 0
  await database.prepare('UPDATE selfie_sessions SET paused = ? WHERE id = ?').run(paused, session.id)
  response.json({ paused: Boolean(paused) })
})

app.post('/api/selfie/sessions/:id/rotation', requireUser, async (request, response) => {
  const session = await getSelfieSessionForOwner(request.params.id, request.user)
  if (!session) return response.status(404).json({ error: 'This selfie session could not be found.' })
  const seconds = request.body?.seconds
  if (!Number.isInteger(seconds) || seconds < 2 || seconds > 300) {
    return response.status(400).json({ error: 'Rotation duration must be a whole number between 2 and 300 seconds.' })
  }
  await database.prepare('UPDATE selfie_sessions SET rotation_seconds = ? WHERE id = ?').run(seconds, session.id)
  response.json({ rotationSeconds: seconds })
})

app.get('/api/selfie/sessions', requireUser, async (request, response) => {
  const sessions = await database.prepare(`
    SELECT sess.id, u.username AS host, sess.created_at AS createdAt, sess.closed_at AS closedAt,
      sess.paused, sess.santa_enabled AS santaEnabled,
      (SELECT COUNT(*) FROM selfie_submissions sub WHERE sub.session_id = sess.id) AS photoCount,
      (SELECT COUNT(*) FROM selfie_submissions sub WHERE sub.session_id = sess.id AND sub.status = 'approved') AS approvedCount
    FROM selfie_sessions sess JOIN users u ON u.id = sess.owner_user_id
    WHERE sess.owner_user_id = ? OR ? = 1
    ORDER BY sess.created_at DESC, sess.id DESC
  `).all(request.user.id, Number(request.user.isSuperAdmin))
  response.set('Cache-Control', 'no-store').json({
    sessions: sessions.map((session) => ({ ...session, paused: Boolean(session.paused), santaEnabled: Boolean(session.santaEnabled) })),
  })
})

app.post('/api/selfie/sessions/:id/links', requireUser, async (request, response) => {
  const session = await getSelfieSessionForOwner(request.params.id, request.user)
  if (!session) return response.status(404).json({ error: 'This selfie session could not be found.' })
  const joinToken = randomBytes(32).toString('base64url')
  const displayToken = randomBytes(32).toString('base64url')
  await database.prepare(`
    INSERT INTO selfie_session_links (session_id, join_token_hash, display_token_hash, created_at)
    VALUES (?, ?, ?, ?)
  `).run(session.id, hashSessionToken(joinToken), hashSessionToken(displayToken), new Date().toISOString())
  response.set('Cache-Control', 'no-store').json({
    id: session.id, createdAt: session.createdAt, closedAt: session.closedAt,
    paused: Boolean(session.paused), rotationSeconds: session.rotationSeconds, santaEnabled: Boolean(session.santaEnabled), joinToken, displayToken,
  })
})

app.get('/api/admin/selfie/sessions', requireAdmin, async (request, response) => {
  const sessions = await database.prepare(`
    SELECT sess.id, u.username AS host, sess.created_at AS createdAt, sess.closed_at AS closedAt,
      sess.paused, sess.santa_enabled AS santaEnabled
    FROM selfie_sessions sess JOIN users u ON u.id = sess.owner_user_id
    WHERE sess.owner_user_id = ? OR ? = 1
    ORDER BY sess.created_at DESC, sess.id DESC
  `).all(request.user.id, Number(request.user.isSuperAdmin))
  const photos = await database.prepare(`
    SELECT sub.id, sub.session_id AS sessionId, sub.status, sub.created_at AS createdAt, sub.approved_at AS approvedAt
    FROM selfie_submissions sub JOIN selfie_sessions sess ON sess.id = sub.session_id
    WHERE sess.owner_user_id = ? OR ? = 1 ORDER BY sub.created_at DESC
  `).all(request.user.id, Number(request.user.isSuperAdmin))
  response.set('Cache-Control', 'no-store').json({
    sessions: sessions.map((session) => ({
      ...session, paused: Boolean(session.paused), santaEnabled: Boolean(session.santaEnabled),
      photos: photos.filter((photo) => photo.sessionId === session.id),
    })),
  })
})

app.get('/api/admin/selfie/sessions/:sessionId/photos/:photoId/image', requireAdmin, async (request, response) => {
  const photo = await database.prepare(`
    SELECT sub.image, sub.image_mime_type AS mimeType
    FROM selfie_submissions sub JOIN selfie_sessions sess ON sess.id = sub.session_id
    WHERE sub.id = ? AND sub.session_id = ? AND (sess.owner_user_id = ? OR ? = 1)
  `).get(request.params.photoId, request.params.sessionId, request.user.id, Number(request.user.isSuperAdmin))
  if (!photo) return response.status(404).json({ error: 'This session photo could not be found.' })
  response.type(photo.mimeType).set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'no-store').send(Buffer.from(photo.image))
})

app.get('/api/selfie/join/:token/status', async (request, response) => {
  const token = request.params.token
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return response.status(404).end()
  const row = await getSelfieSessionForJoin(token)
  if (!row || row.closedAt) return response.status(404).end()
  response.set('Cache-Control', 'no-store').json({ paused: Boolean(row.paused), santaEnabled: Boolean(row.santaEnabled) })
})

app.post('/api/selfie/sessions', requireUser, async (request, response) => {
  const santaEnabled = request.body?.santaEnabled ?? false
  if (typeof santaEnabled !== 'boolean') return response.status(400).json({ error: 'Santa effect must be enabled or disabled.' })
  const now = new Date()
  const sessionId = randomUUID()
  const joinToken = randomBytes(32).toString('base64url')
  const displayToken = randomBytes(32).toString('base64url')
  // Keep the legacy NOT NULL expiry column populated; only closed_at controls uploads.
  await database.prepare(`
    INSERT INTO selfie_sessions (id, join_token_hash, display_token_hash, owner_user_id, created_at, expires_at, santa_enabled, live_join_token_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, hashSessionToken(joinToken), hashSessionToken(displayToken), request.user.id, now.toISOString(), now.toISOString(), Number(santaEnabled), hashSessionToken(selfieLiveJoinToken(hashSessionToken(joinToken))))
  response.set('Cache-Control', 'no-store').status(201).json({ id: sessionId, joinToken, displayToken, createdAt: now.toISOString(), closedAt: null, paused: false, rotationSeconds: 5, santaEnabled })
})

app.post('/api/selfie/sessions/:id/banner', requireUser, imageUpload.single('image'), async (request, response) => {
  const session = await getSelfieSessionForOwner(request.params.id, request.user)
  if (!session) return response.status(404).json({ error: 'This selfie session could not be found.' })
  const { file } = request
  if (!file || !hasValidImageSignature(file.mimetype, file.buffer)) {
    return response.status(400).json({ error: 'Upload a valid JPEG, PNG, or WebP image.' })
  }
  await database.prepare('UPDATE selfie_sessions SET banner_mime_type = ?, banner = ? WHERE id = ?').run(file.mimetype, file.buffer, session.id)
  response.status(204).end()
})

app.get('/api/selfie/join/:token/banner', async (request, response) => {
  const token = request.params.token
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return response.status(404).end()
  const session = await getSelfieSessionForJoin(token)
  if (!session || session.closedAt) return response.status(404).end()
  const row = await database.prepare('SELECT banner, banner_mime_type AS mimeType FROM selfie_sessions WHERE id = ?').get(session.id)
  if (!row?.banner) return response.status(404).end()
  response.type(row.mimeType).set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'no-store').send(Buffer.from(row.banner))
})

app.post('/api/selfie/join/:token', imageUpload.single('image'), async (request, response) => {
  const token = request.params.token
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return response.status(404).json({ error: 'This selfie session link is invalid.' })
  const session = await getSelfieSessionForJoin(token)
  if (!session || session.closedAt) {
    return response.status(404).json({ error: 'This selfie session has ended.' })
  }
  if (session.paused) return response.status(423).json({ error: 'The host has paused photo uploads. Please try again shortly.' })
  const { file } = request
  if (!file) return response.status(400).json({ error: 'Choose or take a photo to submit.' })
  if (!hasValidImageSignature(file.mimetype, file.buffer)) {
    return response.status(400).json({ error: 'Upload a valid JPEG, PNG, or WebP photo.' })
  }
  const dimensions = getImageDimensions(file.mimetype, file.buffer)
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 12000 || dimensions.height > 12000 || dimensions.width * dimensions.height > 40000000) {
    return response.status(400).json({ error: 'Photo dimensions must be valid and no larger than 12,000 pixels per side or 40 megapixels.' })
  }
  const id = randomUUID()
  const submitted = await inTransaction(async () => {
    const currentSession = await database.prepare(`
      SELECT id, closed_at AS closedAt, paused FROM selfie_sessions WHERE id = ?
    `).get(session.id)
    if (!currentSession || currentSession.closedAt) return 'closed'
    if (currentSession.paused) return 'paused'
    await database.prepare(`
      INSERT INTO selfie_submissions (id, session_id, image_mime_type, image, file_name, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, session.id, file.mimetype, file.buffer, file.originalname.slice(0, 120), new Date().toISOString())
    return 'created'
  })
  if (submitted === 'closed') return response.status(404).json({ error: 'This selfie session has ended.' })
  if (submitted === 'paused') return response.status(423).json({ error: 'The host has paused photo uploads. Please try again shortly.' })
  response.status(201).json({ id, status: 'pending' })
})

async function requireSelfieDisplay(request, response, next) {
  response.set('Cache-Control', 'no-store')
  const token = request.get('X-Selfie-Display-Token') || request.query.token
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return response.status(403).json({ error: 'This live-screen link is invalid. Copy a new OBS URL from the host screen.' })
  }
  const session = await database.prepare(`
    SELECT id, owner_user_id AS ownerUserId, paused, closed_at AS closedAt, rotation_seconds AS rotationSeconds
    FROM selfie_sessions WHERE id = ? AND (display_token_hash = ? OR id IN (
      SELECT session_id FROM selfie_session_links WHERE display_token_hash = ?
    ))
  `).get(request.params.sessionId, hashSessionToken(token), hashSessionToken(token))
  if (!session) return response.status(404).json({ error: 'This live-screen link is invalid.' })
  request.selfieDisplaySession = session
  next()
}

app.get('/api/selfie/display/:sessionId/submissions', requireSelfieDisplay, async (request, response) => {
  const session = request.selfieDisplaySession
  const submissions = await database.prepare(`
    SELECT id, status, created_at AS createdAt, approved_at AS approvedAt
    FROM selfie_submissions WHERE session_id = ? AND status = 'approved' ORDER BY created_at DESC
  `).all(session.id)
  response.json({ submissions, paused: Boolean(session.paused), rotationSeconds: session.rotationSeconds, closed: Boolean(session.closedAt), qrSession: await getSelfieDisplayQr(session) })
})

app.get('/api/selfie/display/:sessionId/submissions/:submissionId/image', requireSelfieDisplay, async (request, response) => {
  const image = await database.prepare(`
    SELECT image, image_mime_type AS mimeType FROM selfie_submissions
    WHERE id = ? AND session_id = ? AND status = 'approved'
  `).get(request.params.submissionId, request.selfieDisplaySession.id)
  if (!image) return response.status(404).json({ error: 'This approved photo could not be found.' })
  response.type(image.mimeType).set('X-Content-Type-Options', 'nosniff').send(Buffer.from(image.image))
})

app.get('/api/selfie/sessions/:id/submissions', requireUser, async (request, response) => {
  const session = await getSelfieSessionForOwner(request.params.id, request.user)
  if (!session) return response.status(404).json({ error: 'This selfie session could not be found.' })
  const submissions = await database.prepare(`
    SELECT id, file_name AS fileName, status, created_at AS createdAt, approved_at AS approvedAt
    FROM selfie_submissions WHERE session_id = ? ORDER BY created_at DESC
  `).all(session.id)
  response.set('Cache-Control', 'no-store').json({ submissions, paused: Boolean(session.paused), rotationSeconds: session.rotationSeconds, closed: Boolean(session.closedAt), closedAt: session.closedAt, qrSession: await getSelfieDisplayQr(session) })
})

app.post('/api/selfie/sessions/:sessionId/submissions/delete-approved', requireUser, async (request, response) => {
  const session = await getSelfieSessionForOwner(request.params.sessionId, request.user)
  if (!session) return response.status(404).json({ error: 'This selfie session could not be found.' })
  const ids = request.body?.ids
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !id || id.length > 64)) {
    return response.status(400).json({ error: 'Select at least one valid approved photo.' })
  }
  const deleted = await inTransaction(async () => {
    const remove = database.prepare("DELETE FROM selfie_submissions WHERE id = ? AND session_id = ? AND status = 'approved'")
    let count = 0
    for (const id of new Set(ids)) count += (await remove.run(id, session.id)).changes
    return count
  })
  response.json({ deleted })
})

app.post('/api/selfie/sessions/:sessionId/submissions/:submissionId/approve', requireUser, async (request, response) => {
  const session = await getSelfieSessionForOwner(request.params.sessionId, request.user)
  if (!session) return response.status(404).json({ error: 'This selfie session could not be found.' })
  const result = await database.prepare(`
    UPDATE selfie_submissions SET status = 'approved', approved_at = ?
    WHERE id = ? AND session_id = ? AND status = 'pending'
  `).run(new Date().toISOString(), request.params.submissionId, session.id)
  if (result.changes === 0) return response.status(404).json({ error: 'This pending photo could not be found.' })
  response.status(204).end()
})

app.delete('/api/selfie/sessions/:sessionId/submissions/:submissionId', requireUser, async (request, response) => {
  const session = await getSelfieSessionForOwner(request.params.sessionId, request.user)
  if (!session) return response.status(404).json({ error: 'This selfie session could not be found.' })
  const result = await database.prepare('DELETE FROM selfie_submissions WHERE id = ? AND session_id = ?')
    .run(request.params.submissionId, session.id)
  if (result.changes === 0) return response.status(404).json({ error: 'This photo could not be found.' })
  response.status(204).end()
})

app.get('/api/selfie/sessions/:sessionId/submissions/:submissionId/image', requireUser, async (request, response) => {
  const image = await database.prepare(`
    SELECT sub.image, sub.image_mime_type AS mimeType
    FROM selfie_submissions sub
    JOIN selfie_sessions sess ON sess.id = sub.session_id
    WHERE sub.id = ? AND sub.session_id = ? AND (sess.owner_user_id = ? OR ? = 1)
  `).get(request.params.submissionId, request.params.sessionId, request.user.id, Number(request.user.isSuperAdmin))
  if (!image) return response.status(404).end()
  response.type(image.mimeType).set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'no-store').send(Buffer.from(image.image))
})

app.post('/api/selfie/sessions/:id/close', requireUser, async (request, response) => {
  const session = await getSelfieSessionForOwner(request.params.id, request.user)
  if (!session) return response.status(404).json({ error: 'This selfie session could not be found.' })
  await inTransaction(() => database.prepare('UPDATE selfie_sessions SET closed_at = ?, paused = 0 WHERE id = ? AND closed_at IS NULL').run(new Date().toISOString(), session.id))
  response.status(204).end()
})

app.delete('/api/selfie/sessions/:id', requireUser, async (request, response) => {
  const result = await inTransaction(async () => {
    const session = await getSelfieSessionForOwner(request.params.id, request.user)
    if (!session) return 'missing'
    if (!session.closedAt) return 'ongoing'
    await database.prepare('DELETE FROM selfie_sessions WHERE id = ? AND closed_at IS NOT NULL').run(session.id)
    return 'deleted'
  })
  if (result === 'missing') return response.status(404).json({ error: 'This selfie session could not be found.' })
  if (result === 'ongoing') return response.status(409).json({ error: 'End this selfie session before deleting it.' })
  response.status(204).end()
})

app.get('/api/logo-bank', requireUser, async (request, response) => {
  const rows = await database.prepare('SELECT id, name FROM account_logo_bank WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT 200').all(request.user.id)
  response.set('Cache-Control', 'no-store').json({ logos: rows })
})

app.post('/api/logo-bank', requireUser, imageUpload.single('image'), async (request, response) => {
  const { file } = request
  if (!file || !hasValidImageSignature(file.mimetype, file.buffer)) {
    return response.status(400).json({ error: 'Upload a valid JPEG, PNG, or WebP image.' })
  }
  const hash = createHash('sha256').update(file.buffer).digest('hex')
  const existing = await database.prepare('SELECT id, name FROM account_logo_bank WHERE owner_user_id = ? AND content_hash = ?').get(request.user.id, hash)
  if (existing) return response.status(200).json(existing)
  const id = randomUUID()
  const name = String(request.body?.name || file.originalname || 'logo').slice(0, 120)
  await database.prepare('INSERT INTO account_logo_bank (id, owner_user_id, name, content_hash, image_mime_type, image, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, request.user.id, name, hash, file.mimetype, file.buffer, new Date().toISOString())
  response.status(201).json({ id, name })
})

app.get('/api/logo-bank/:id/image', requireUser, async (request, response) => {
  const image = await database.prepare('SELECT image, image_mime_type AS mimeType FROM account_logo_bank WHERE id = ? AND owner_user_id = ?').get(request.params.id, request.user.id)
  if (!image) return response.status(404).end()
  response.type(image.mimeType).set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'no-store').send(Buffer.from(image.image))
})

app.delete('/api/logo-bank/:id', requireUser, async (request, response) => {
  const result = await database.prepare('DELETE FROM account_logo_bank WHERE id = ? AND owner_user_id = ?').run(request.params.id, request.user.id)
  if (!result.changes) return response.status(404).json({ error: 'Image not found.' })
  response.status(204).end()
})

app.get('/api/polls', requireUser, async (request, response) => response.json(await listPolls(request.user)))

app.get('/api/polls/:id', async (request, response) => {
  const poll = await getPoll(request.params.id, { admin: await canManagePoll(request.params.id, await getCurrentUser(request)) })
  if (!poll) return response.status(404).json({ error: 'This poll could not be found.' })
  response.set('Cache-Control', 'no-store').json(poll)
})

app.get('/api/polls/:id/question-image', async (request, response) => {
  const image = await database.prepare('SELECT question_image_mime_type AS mimeType, question_image AS image FROM polls WHERE id = ?').get(request.params.id)
  if (!image?.image) return response.status(404).end()
  response.type(image.mimeType).set('Cache-Control', 'private, max-age=300').send(Buffer.from(image.image))
})

app.get('/api/polls/:id/logo', async (request, response) => {
  const logo = await database.prepare('SELECT logo_mime_type AS mimeType, logo FROM polls WHERE id = ?').get(request.params.id)
  if (!logo?.logo) return response.status(404).end()
  response.type(logo.mimeType).set('Cache-Control', 'private, max-age=300').send(Buffer.from(logo.logo))
})

app.get('/api/poll-options/:id/image', async (request, response) => {
  const image = await database.prepare('SELECT image_mime_type AS mimeType, image FROM poll_options WHERE id = ?').get(request.params.id)
  if (!image?.image) return response.status(404).end()
  response.type(image.mimeType).set('Cache-Control', 'private, max-age=300').send(Buffer.from(image.image))
})

app.post('/api/polls/:id/session', rateLimit({ windowMs: 60_000, max: Number(process.env.QA_RATE_LIMIT_PER_MINUTE || 3000) }), async (request, response) => {
  const pollId = request.params.id
  const sessionPoll = await selectPoll.get(pollId)
  if (!sessionPoll) return response.status(404).json({ error: 'This poll could not be found.' })

  const now = new Date()
  const token = getCookie(request, getVotingCookieName(pollId))
  if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
    const existingSession = await database.prepare(`
      SELECT id, expires_at AS expiresAt, consumed_at AS consumedAt
      FROM poll_voting_sessions
      WHERE token_hash = ? AND poll_id = ?
    `).get(hashSessionToken(token), pollId)
    if (existingSession && Date.parse(existingSession.expiresAt) > now.getTime()) {
      response.set('Cache-Control', 'no-store')
      return response.json({
        authenticated: true,
        voted: Boolean(existingSession.consumedAt),
        expiresAt: existingSession.expiresAt,
        ...(sessionPoll.isQa ? { qa: await qa.describeSession(sessionPoll, existingSession.id) } : {}),
      })
    }
  }

  await database.prepare('DELETE FROM poll_voting_sessions WHERE expires_at <= ?').run(now.toISOString())
  const votingSessionId = randomUUID()
  const sessionToken = randomBytes(32).toString('base64url')
  const expiresAt = new Date(now.getTime() + votingSessionDurationSeconds * 1000).toISOString()
  await database.prepare('INSERT INTO poll_voting_sessions (id, poll_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
    .run(votingSessionId, pollId, hashSessionToken(sessionToken), expiresAt)
  setVotingSessionCookie(request, response, pollId, sessionToken)
  response.set('Cache-Control', 'no-store').json({ authenticated: true, voted: false, expiresAt, ...(sessionPoll.isQa ? { qa: await qa.describeSession(sessionPoll, votingSessionId) } : {}) })
})

app.post('/api/polls', requireUser, imageUpload.fields([{ name: 'logo', maxCount: 1 }, { name: 'optionImages', maxCount: 10 }, { name: 'questionImage', maxCount: 1 }]), async (request, response) => {
  const question = typeof request.body.question === 'string' ? request.body.question.trim() : ''
  const isQa = request.body.isQa === 'true'
  let parsedOptions
  try {
    parsedOptions = typeof request.body.options === 'string' ? JSON.parse(request.body.options) : request.body.options
  } catch {
    return response.status(400).json({ error: 'Poll options are invalid.' })
  }
  const options = Array.isArray(parsedOptions)
    ? parsedOptions.map((option) => {
      if (typeof option === 'string') return { label: option.trim(), imageIndex: null }
      if (!option || typeof option !== 'object' || Array.isArray(option)) return { label: '', imageIndex: null }
      return {
        label: typeof option.label === 'string' ? option.label.trim() : '',
        imageIndex: option.imageIndex === null ? null : Number.isInteger(option.imageIndex) ? option.imageIndex : -1,
        isCorrect: option.isCorrect === true,
        hideLabel: option.hideLabel === true,
      }
    }).filter((option) => option.label || option.imageIndex !== null).slice(0, 10)
    : []
  const optionFiles = request.files?.optionImages || []
  const logoFile = request.files?.logo?.[0]
  const questionImageFile = request.files?.questionImage?.[0]
  const imageIndexes = options.map((option) => option.imageIndex).filter((imageIndex) => imageIndex !== null)
  if (questionImageFile && !isQa) {
    return response.status(400).json({ error: 'Question images are only supported for Q&A.' })
  }
  if (question.length > 160 || (!questionImageFile && question.length < 3) || options.length < 2) {
    return response.status(400).json({ error: 'Add a question (or a question image) and at least two options.' })
  }
  if (questionImageFile && !hasValidImageSignature(questionImageFile.mimetype, questionImageFile.buffer)) {
    return response.status(400).json({ error: 'The question image is not a valid JPEG, PNG, or WebP image.' })
  }
  if ((isQa && options.filter((option) => option.isCorrect).length !== 1) || (!isQa && options.some((option) => option.isCorrect))) {
    return response.status(400).json({ error: isQa ? 'Choose exactly one correct answer for this Q&A.' : 'Correct answers are only supported for Q&A.' })
  }
  if (options.some((option) => option.label.length > 80)) {
    return response.status(400).json({ error: 'Answer options must be 80 characters or fewer.' })
  }
  if (imageIndexes.length !== optionFiles.length || new Set(imageIndexes).size !== imageIndexes.length || imageIndexes.some((imageIndex) => imageIndex < 0 || imageIndex >= optionFiles.length)) {
    return response.status(400).json({ error: 'Option images do not match their answer options.' })
  }
  if (logoFile && !hasValidImageSignature(logoFile.mimetype, logoFile.buffer)) {
    return response.status(400).json({ error: 'The logo file is not a valid JPEG, PNG, or WebP image.' })
  }
  if (optionFiles.some((file) => !hasValidImageSignature(file.mimetype, file.buffer))) {
    return response.status(400).json({ error: 'An option image is not a valid JPEG, PNG, or WebP image.' })
  }

  const ticketLabel = isQa && typeof request.body.ticketLabel === 'string' ? request.body.ticketLabel.trim() : ''
  if (ticketLabel.length > 40) {
    return response.status(400).json({ error: 'Ticket number label must be 40 characters or fewer.' })
  }
  const nameLabel = !isQa || request.body.nameLabel === undefined ? '' : typeof request.body.nameLabel === 'string' ? request.body.nameLabel.trim() : null
  if (nameLabel === null || nameLabel.length > 40) {
    return response.status(400).json({ error: 'Guest name label must be 40 characters or fewer.' })
  }
  const poll = { id: randomUUID(), question, createdAt: new Date().toISOString() }
  const optionsWithIds = options.map((option) => ({ ...option, id: randomUUID() }))
  const correctOptionId = optionsWithIds.find((option) => option.isCorrect)?.id || null
  await inTransaction(async () => {
    await database.prepare('INSERT INTO polls (id, question, ticket_label, name_label, created_at, logo_mime_type, logo, is_qa, correct_option_id, question_image_mime_type, question_image, reveal_correct, owner_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
              .run(poll.id, question, ticketLabel || null, nameLabel || null, poll.createdAt, logoFile?.mimetype || null, logoFile?.buffer || null, Number(isQa), correctOptionId, questionImageFile?.mimetype || null, questionImageFile?.buffer || null, Number(isQa && request.body.revealCorrect === 'true'), request.user.id)
    const insertOption = database.prepare('INSERT INTO poll_options (id, poll_id, label, `position`, votes, image_mime_type, image, hide_label) VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
    for (const [index, option] of optionsWithIds.entries()) {
      const file = option.imageIndex === null ? null : optionFiles[option.imageIndex]
      await insertOption.run(option.id, poll.id, option.label, index, file?.mimetype || null, file?.buffer || null, Number(option.hideLabel === true))
    }
  })
  await audit(request, 'poll.create', 'poll', poll.id, { isQa, ...(ticketLabel ? { ticketLabel } : {}), ...(nameLabel ? { nameLabel } : {}) })
  response.status(201).json(await getPoll(poll.id, { admin: true }))
})

app.patch('/api/polls/:id/settings', requireUser, requirePollOwner, async (request, response) => {
  const pollId = request.params.id
  if (!(await selectPoll.get(pollId))) return response.status(404).json({ error: 'This poll could not be found.' })
  const { votingEnabled, videoEnabled, revealCorrect } = request.body || {}
  if ([votingEnabled, videoEnabled, revealCorrect].some((value) => value !== undefined && typeof value !== 'boolean')) {
    return response.status(400).json({ error: 'Poll settings must be true or false.' })
  }
  if (votingEnabled !== undefined) await database.prepare('UPDATE polls SET voting_enabled = ? WHERE id = ?').run(Number(votingEnabled), pollId)
  if (videoEnabled !== undefined) await database.prepare('UPDATE polls SET video_enabled = ? WHERE id = ?').run(Number(videoEnabled), pollId)
  if (revealCorrect !== undefined) await database.prepare('UPDATE polls SET reveal_correct = ? WHERE id = ?').run(Number(revealCorrect), pollId)
  await audit(request, 'poll.settings', 'poll', pollId, { votingEnabled, videoEnabled, revealCorrect })
  response.json(await getPoll(pollId, { admin: true }))
})

app.patch('/api/polls/:id', requireUser, requirePollOwner, async (request, response, next) => {
  const poll = await selectPoll.get(request.params.id)
  if (!poll) return response.status(404).json({ error: 'This poll could not be found.' })
  if (poll.isQa) return next()
  const body = request.body || {}
  const question = typeof body.question === 'string' ? body.question.trim() : ''
  if (question.length < 3 || question.length > 160) return response.status(400).json({ error: 'Add a question of 3–160 characters.' })
  const joinTitle = typeof body.joinTitle === 'string' ? body.joinTitle.trim() : ''
  if (joinTitle.length > 80) return response.status(400).json({ error: 'The join title must be 80 characters or fewer.' })
  const optionRows = await database.prepare('SELECT id, CASE WHEN image IS NULL THEN 0 ELSE 1 END AS hasImage FROM poll_options WHERE poll_id = ?').all(poll.id)
  const optionsById = new Map(optionRows.map((option) => [option.id, option]))
  const optionIds = new Set(optionsById.keys())
  const labels = Array.isArray(body.options) ? body.options.map((option) => ({ id: option?.id, label: typeof option?.label === 'string' ? option.label.trim() : '' })) : []
  if (labels.length !== optionIds.size || labels.some((option) => !optionIds.has(option.id) || (!option.label && !optionsById.get(option.id)?.hasImage) || option.label.length > 80)) {
    return response.status(400).json({ error: 'Answer options need text or an image and must be 80 characters or fewer.' })
  }
  await inTransaction(async () => {
    await database.prepare('UPDATE polls SET question = ?, join_title = ? WHERE id = ?').run(question, joinTitle || null, poll.id)
    for (const option of labels) await database.prepare('UPDATE poll_options SET label = ? WHERE id = ? AND poll_id = ?').run(option.label, option.id, poll.id)
  })
  await audit(request, 'poll.edit', 'poll', poll.id, { fields: ['question', 'options', 'joinTitle'] })
  response.json(await getPoll(poll.id, { admin: true }))
})

app.post('/api/polls/:id/votes', async (request, response, next) => {
  const pollId = request.params.id
  const { optionId } = request.body || {}
  const poll = await selectPoll.get(pollId)
  if (!poll) return response.status(404).json({ error: 'This poll could not be found.' })
  if (poll.isQa) return next()
  if (!poll.votingEnabled) return response.status(423).json({ error: 'Voting is currently disabled for this poll.' })
  if (typeof optionId !== 'string' || optionId.length > 80) {
    return response.status(400).json({ error: 'Choose one of the poll options.' })
  }
  const token = getCookie(request, getVotingCookieName(pollId))
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return response.status(403).json({ error: 'Your voting session is missing or invalid. Reload the poll to continue.' })
  }

  const castVote = await inTransaction(async () => {
    const votingSession = await database.prepare(`
      SELECT id, expires_at AS expiresAt, consumed_at AS consumedAt
      FROM poll_voting_sessions
      WHERE token_hash = ? AND poll_id = ?
    `).get(hashSessionToken(token), pollId)
    if (!votingSession || Date.parse(votingSession.expiresAt) <= Date.now()) return 'invalid-session'
    if (votingSession.consumedAt) return 'duplicate'
    const option = await database.prepare('SELECT id FROM poll_options WHERE id = ? AND poll_id = ?').get(optionId, pollId)
    if (!option) return 'invalid-option'
    const createdAt = new Date().toISOString()
    const consumed = await database.prepare('UPDATE poll_voting_sessions SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?')
      .run(createdAt, votingSession.id, createdAt)
    if (consumed.changes !== 1) return 'duplicate'
    await database.prepare('INSERT INTO poll_voters (poll_id, voter_id, option_id, created_at, voting_session_id) VALUES (?, ?, ?, ?, ?)')
      .run(pollId, votingSession.id, optionId, createdAt, votingSession.id)
    await database.prepare('UPDATE poll_options SET votes = votes + 1 WHERE id = ?').run(optionId)
    return 'ok'
  })

  if (castVote === 'invalid-session') return response.status(403).json({ error: 'Your voting session is missing or expired. Reload the poll to continue.' })
  if (castVote === 'duplicate') return response.status(409).json({ error: 'A vote has already been recorded from this voting session.' })
  if (castVote === 'invalid-option') return response.status(400).json({ error: 'Choose one of the poll options.' })
  response.json(await getPoll(pollId))
})

const qa = registerQaRoutes({
  app, database, requireUser, requireAdmin, requirePollOwner, getCookie, getVotingCookieName, hashSessionToken,
  selectPoll, selectAdVideo, adVideosDirectory, inTransaction, getPoll, audit,
})

registerRaffleRoutes({ app, database, requireUser, imageUpload, hasValidImageSignature, inTransaction, audit })

registerScrambleRoutes({ app, database, requireUser, imageUpload, hasValidImageSignature, inTransaction, audit })

const adVideoKinds = ['poll', 'qa', 'game', 'selfie', 'raffle', 'scramble']
const adVideoTypes = { 'video/mp4': '.mp4', 'video/webm': '.webm' }

function requireAdVideoKind(request, response, next) {
  if (!adVideoKinds.includes(request.params.kind)) return response.status(404).json({ error: 'Unknown video slot.' })
  next()
}

function hasValidVideoSignature(mimeType, filePath) {
  const head = Buffer.alloc(12)
  const descriptor = openSync(filePath, 'r')
  try { readSync(descriptor, head, 0, 12, 0) } finally { closeSync(descriptor) }
  if (mimeType === 'video/mp4') return head.toString('ascii', 4, 8) === 'ftyp'
  return mimeType === 'video/webm' && head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
}

function adVideoPath(fileName) {
  const base = path.basename(String(fileName || ''))
  if (!base) return null
  const resolved = path.resolve(adVideosDirectory, base)
  if (!resolved.startsWith(`${adVideosDirectory}${path.sep}`)) return null
  return resolved
}

function removeAdVideoFile(fileName) {
  const target = adVideoPath(fileName)
  if (!target) return
  try { unlinkSync(target) } catch { /* Already removed. */ }
}

async function removeAdVideoFileIfUnused(fileName) {
  if (!fileName) return
  const ref = await database.prepare('SELECT COUNT(*) AS count FROM account_ad_videos WHERE file_name = ?').get(fileName)
  if (Number(ref?.count || 0) > 0) return
  removeAdVideoFile(fileName)
}

const adVideoUpload = multer({
  storage: multer.diskStorage({
    destination: adVideosDirectory,
    filename: (_request, _file, callback) => callback(null, `upload-${randomUUID()}.tmp`),
  }),
  limits: { fileSize: adVideoMaxBytes, files: 1 },
  fileFilter: (_request, file, callback) => {
    if (!adVideoTypes[file.mimetype]) return callback(new Error('Use an MP4 or WebM video.'))
    callback(null, true)
  },
})

function selectAdVideo(kind, userId) {
  if (!userId) return Promise.resolve(undefined)
  return database.prepare(`
    SELECT user_id AS userId, kind, file_name AS fileName, original_name AS originalName, mime_type AS mimeType, size, updated_at AS updatedAt
    FROM account_ad_videos WHERE user_id = ? AND kind = ?
  `).get(userId, kind)
}

async function selectAudienceAdVideo(kind, ownerId) {
  if (!ownerId) return undefined
  return (await selectAdVideo(kind, ownerId)) || (['raffle', 'scramble'].includes(kind) ? await selectAdVideo('poll', ownerId) : undefined)
}

function adVideoSummary(video, { preview = false, kind = video?.kind, activityId = '' } = {}) {
  if (!video) return { available: false }
  const slotKind = kind || video.kind
  const url = preview
    ? `/api/admin/ad-videos/${slotKind}/file?v=${encodeURIComponent(video.updatedAt)}`
    : `/api/ad-videos/${slotKind}/file?${new URLSearchParams({ ...(activityId ? { id: activityId } : {}), v: video.updatedAt })}`
  return { available: true, url, mimeType: video.mimeType, name: video.originalName, size: video.size, updatedAt: video.updatedAt }
}

async function resolveAdVideoOwner(kind, activityId, request) {
  if (activityId !== undefined) {
    if (typeof activityId !== 'string' || !activityId || activityId.length > 128) return { found: false, ownerId: null }
    let row
    if (kind === 'poll' || kind === 'qa') {
      row = await database.prepare('SELECT owner_user_id AS ownerId FROM polls WHERE id = ?').get(activityId)
    } else if (kind === 'raffle') {
      row = await database.prepare('SELECT created_by AS ownerId FROM raffle_sessions WHERE id = ?').get(activityId)
    } else if (kind === 'scramble') {
      row = await database.prepare('SELECT created_by AS ownerId FROM scramble_games WHERE id = ?').get(activityId)
    } else if (kind === 'selfie') {
      if (!/^[A-Za-z0-9_-]{43}$/.test(activityId)) return { found: false, ownerId: null }
      const session = await getSelfieSessionForJoin(activityId)
      if (session) row = { ownerId: session.ownerUserId }
    } else if (kind === 'game') {
      row = await database.prepare('SELECT owner_user_id AS ownerId FROM game_rooms WHERE id = ?').get(activityId)
    }
    if (!row) return { found: false, ownerId: null }
    return { found: true, ownerId: row.ownerId || null }
  }
  const user = await getCurrentUser(request)
  return { found: true, ownerId: user?.id || null }
}

app.get('/api/admin/ad-videos', requireUser, async (request, response) => {
  const userId = request.user.id
  response.set('Cache-Control', 'no-store').json({
    poll: adVideoSummary(await selectAdVideo('poll', userId), { preview: true }),
    qa: adVideoSummary(await selectAdVideo('qa', userId), { preview: true }),
    game: adVideoSummary(await selectAdVideo('game', userId), { preview: true }),
    selfie: adVideoSummary(await selectAdVideo('selfie', userId), { preview: true }),
    raffle: adVideoSummary(await selectAdVideo('raffle', userId), { preview: true }),
    scramble: adVideoSummary(await selectAdVideo('scramble', userId), { preview: true }),
    maxBytes: adVideoMaxBytes,
  })
})

app.get('/api/admin/ad-videos/:kind/file', requireUser, requireAdVideoKind, async (request, response) => {
  const video = await selectAdVideo(request.params.kind, request.user.id)
  const target = video ? adVideoPath(video.fileName) : null
  if (!video || !target) return response.status(404).end()
  response.type(video.mimeType).set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'no-store').sendFile(target, (error) => {
    if (error && !response.headersSent) response.status(404).end()
  })
})

app.put('/api/admin/ad-videos/:kind', requireUser, requireAdVideoKind, adVideoUpload.single('video'), async (request, response) => {
  const file = request.file
  if (!file) return response.status(400).json({ error: 'Choose an MP4 or WebM video.' })
  if (!hasValidVideoSignature(file.mimetype, file.path)) {
    removeAdVideoFile(file.filename)
    return response.status(400).json({ error: 'That file is not a valid MP4 or WebM video.' })
  }
  const kind = request.params.kind
  const userId = request.user.id
  const fileName = `${kind}-${randomUUID()}${adVideoTypes[file.mimetype]}`
  const destination = adVideoPath(fileName)
  if (!destination) {
    removeAdVideoFile(file.filename)
    return response.status(500).json({ error: 'Could not store this video.' })
  }
  renameSync(file.path, destination)
  const originalName = path.basename(file.originalname).slice(0, 120)
  const updatedAt = new Date().toISOString()
  const previous = await inTransaction(async () => {
    const existing = await selectAdVideo(kind, userId)
    if (existing) {
      await database.prepare(`
        UPDATE account_ad_videos
        SET file_name = ?, original_name = ?, mime_type = ?, size = ?, updated_at = ?
        WHERE user_id = ? AND kind = ?
      `).run(fileName, originalName, file.mimetype, file.size, updatedAt, userId, kind)
    } else {
      await database.prepare(`
        INSERT INTO account_ad_videos (user_id, kind, file_name, original_name, mime_type, size, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(userId, kind, fileName, originalName, file.mimetype, file.size, updatedAt)
    }
    return existing
  })
  if (previous) await removeAdVideoFileIfUnused(previous.fileName)
  await audit(request, 'ad-video.upload', 'ad-video', kind, { size: file.size })
  response.json(adVideoSummary(await selectAdVideo(kind, userId), { preview: true }))
})

app.delete('/api/admin/ad-videos/:kind', requireUser, requireAdVideoKind, async (request, response) => {
  const kind = request.params.kind
  const userId = request.user.id
  const previous = await selectAdVideo(kind, userId)
  if (!previous) return response.status(404).json({ error: 'No video has been uploaded for this slot.' })
  await database.prepare('DELETE FROM account_ad_videos WHERE user_id = ? AND kind = ?').run(userId, kind)
  await removeAdVideoFileIfUnused(previous.fileName)
  await audit(request, 'ad-video.delete', 'ad-video', kind)
  response.status(204).end()
})

app.get('/api/ad-videos/:kind', requireAdVideoKind, async (request, response) => {
  const kind = request.params.kind
  const activityId = typeof request.query.id === 'string' ? request.query.id : request.query.id === undefined ? undefined : ''
  const resolved = await resolveAdVideoOwner(kind, activityId, request)
  if (!resolved.found) return response.status(404).json({ error: 'This activity could not be found.' })
  const video = await selectAudienceAdVideo(kind, resolved.ownerId)
  response.set('Cache-Control', 'no-store').json(adVideoSummary(video, { kind, activityId: typeof activityId === 'string' ? activityId : '' }))
})

app.get('/api/ad-videos/:kind/file', requireAdVideoKind, async (request, response) => {
  const kind = request.params.kind
  const activityId = typeof request.query.id === 'string' ? request.query.id : request.query.id === undefined ? undefined : ''
  const resolved = await resolveAdVideoOwner(kind, activityId, request)
  if (!resolved.found || !resolved.ownerId) return response.status(404).end()
  const video = await selectAudienceAdVideo(kind, resolved.ownerId)
  const target = video ? adVideoPath(video.fileName) : null
  if (!video || !target) return response.status(404).end()
  response.type(video.mimeType).set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'no-store').sendFile(target, (error) => {
    if (error && !response.headersSent) response.status(404).end()
  })
})

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    if (_request.path.includes('/admin/ad-videos/')) return response.status(413).json({ error: `Videos must be ${Math.ceil(adVideoMaxBytes / 1024 / 1024)} MB or smaller.` })
    if (_request.path.endsWith('/admin/theme/fonts')) return response.status(413).json({ error: `Fonts must be ${Math.ceil(themeFontMaxBytes / 1024 / 1024)} MB or smaller.` })
    const limit = _request.path.includes('/admin/theme/') ? `${Math.ceil(themeImageMaxBytes / 1024 / 1024)} MB` : '5 MB'
    return response.status(413).json({ error: `Images must be ${limit} or smaller.` })
  }
  if (error?.sqlState || error?.errno || error?.code === 'ER_LOCK_WAIT_TIMEOUT') {
    console.error('Database error:', error)
    return response.status(500).json({ error: 'The server could not complete the request.' })
  }
  response.status(400).json({ error: error.message || 'The upload could not be processed.' })
})

app.use('/api', (_request, response) => response.status(404).json({ error: 'API endpoint not found.' }))

const buildDirectory = path.join(root, 'dist')
if (process.env.NODE_ENV !== 'development' && existsSync(buildDirectory)) {
  app.use(express.static(buildDirectory))
  app.get('*', (_request, response) => response.sendFile(path.join(buildDirectory, 'index.html')))
} else {
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({
    root,
    server: { middlewareMode: true, hmr: false, allowedHosts: true },
    appType: 'spa',
  })
  app.use(vite.middlewares)
}

app.listen(port, '0.0.0.0', () => {
  console.log(`VOTE API listening on http://localhost:${port}`)
})