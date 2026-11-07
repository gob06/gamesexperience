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
import { rateLimit } from './rate-limit.mjs'
import { defaultTerms } from './defaultTerms.mjs'

const app = express()
const port = Number(process.env.PORT || 4179)
const themeImageMaxBytes = Number(process.env.THEME_IMAGE_MAX_BYTES || 50 * 1024 * 1024)
const adVideoMaxBytes = Number(process.env.AD_VIDEO_MAX_BYTES || 200 * 1024 * 1024)
if (!Number.isSafeInteger(adVideoMaxBytes) || adVideoMaxBytes < 1 || adVideoMaxBytes > 1024 * 1024 * 1024) {
  throw new Error('AD_VIDEO_MAX_BYTES must be between 1 byte and 1 GB.')
}
const votingSessionDurationSeconds = Number(process.env.VOTING_SESSION_DURATION_SECONDS || 7 * 24 * 60 * 60)
const trustedProxyHops = Number(process.env.TRUST_PROXY_HOPS || 0)
if (!Number.isSafeInteger(themeImageMaxBytes) || themeImageMaxBytes < 1 || themeImageMaxBytes > 200 * 1024 * 1024) {
  throw new Error('THEME_IMAGE_MAX_BYTES must be between 1 byte and 200 MB.')
}
if (!Number.isSafeInteger(votingSessionDurationSeconds) || votingSessionDurationSeconds < 60 || votingSessionDurationSeconds > 90 * 24 * 60 * 60) {
  throw new Error('VOTING_SESSION_DURATION_SECONDS must be between 60 seconds and 90 days.')
}
if (!Number.isSafeInteger(trustedProxyHops) || trustedProxyHops < 0 || trustedProxyHops > 5) {
  throw new Error('TRUST_PROXY_HOPS must be between 0 and 5.')
}
app.set('trust proxy', trustedProxyHops)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(root, 'data'))
const legacyPollsFile = path.join(dataDirectory, 'polls.json')
const themeAssetsDirectory = path.join(dataDirectory, 'theme-assets')
const adVideosDirectory = path.join(dataDirectory, 'ad-videos')

mkdirSync(dataDirectory, { recursive: true })
mkdirSync(themeAssetsDirectory, { recursive: true })
mkdirSync(adVideosDirectory, { recursive: true })
const database = await createDatabase(readDatabaseConfig())
await database.initializeSchema()
const inTransaction = (action) => database.transaction(action)

const gameRoomRetentionMs = 24 * 60 * 60 * 1000
await database.prepare('DELETE FROM game_rooms WHERE updated_at <= ?').run(new Date(Date.now() - gameRoomRetentionMs).toISOString())
await database.prepare('DELETE FROM selfie_sessions WHERE expires_at <= ? OR closed_at IS NOT NULL').run(new Date().toISOString())
const selfieCleanupTimer = setInterval(() => {
  database.prepare('DELETE FROM selfie_sessions WHERE expires_at <= ? OR closed_at IS NOT NULL').run(new Date().toISOString())
    .catch((error) => console.error('Selfie session cleanup failed:', error))
}, 15 * 60 * 1000)
selfieCleanupTimer.unref()

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

app.get('/api/network-addresses', (_request, response) => {
  const addresses = Object.values(networkInterfaces())
    .flatMap((interfaces) => interfaces ?? [])
    .filter((network) => network.family === 'IPv4' && !network.internal)
    .map((network) => network.address)
    .filter((address) => /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(address))
    .sort((left, right) => Number(right.startsWith('192.168.')) - Number(left.startsWith('192.168.')))
  response.json({ addresses })
})

const selectPoll = database.prepare("SELECT id, question, join_title AS joinTitle, created_at AS createdAt, is_qa AS isQa, voting_enabled AS votingEnabled, video_enabled AS videoEnabled, reveal_correct AS revealCorrect, correct_option_id AS correctOptionId, CASE WHEN logo IS NULL THEN NULL ELSE CONCAT('/api/polls/', id, '/logo') END AS logoUrl, CASE WHEN question_image IS NULL THEN NULL ELSE CONCAT('/api/polls/', id, '/question-image') END AS questionImageUrl FROM polls WHERE id = ?")
const selectQaWinner = database.prepare('SELECT v.voter_id AS voterId, v.first_name AS firstName, v.ticket_number AS ticketNumber, o.label AS answer FROM poll_voters v JOIN poll_options o ON o.id = v.option_id WHERE v.poll_id = ? AND v.is_correct = 1 ORDER BY v.created_at, v.seq LIMIT 1')
const selectQaStats = database.prepare('SELECT (SELECT COUNT(*) FROM poll_voting_sessions WHERE poll_id = ? AND ticket_key IS NOT NULL) AS participants, (SELECT COUNT(*) FROM poll_voters WHERE poll_id = ? AND option_id IS NOT NULL) AS submissions, (SELECT COUNT(*) FROM poll_voters WHERE poll_id = ? AND is_correct = 1) AS winners')
const selectOptions = database.prepare("SELECT id, label, votes, hide_label AS hideLabel, CASE WHEN image IS NULL THEN NULL ELSE CONCAT('/api/poll-options/', id, '/image') END AS imageUrl FROM poll_options WHERE poll_id = ? ORDER BY `position`")

// The correct answer, winners, and statistics are only included for signed-in hosts (admin = true); audience requests never see them.
async function getPoll(id, { admin = false } = {}) {
  const { correctOptionId, revealCorrect, ...poll } = (await selectPoll.get(id)) ?? {}
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

async function listPolls() {
  const polls = []
  for (const { id } of await database.prepare('SELECT id FROM polls ORDER BY created_at DESC').all()) polls.push(await getPoll(id, { admin: true }))
  return polls
}

function hasValidImageSignature(mimeType, image) {
  const signature = image.subarray(0, 12)
  if (mimeType === 'image/jpeg') return signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff
  if (mimeType === 'image/png') return signature.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  return mimeType === 'image/webp' && signature.toString('ascii', 0, 4) === 'RIFF' && signature.toString('ascii', 8, 12) === 'WEBP'
}

const themeSkins = ['broadcast', 'classic']

const defaultTheme = {
  eventTitle: 'VOTE',
  skin: 'broadcast',
  assets: { logo: null, banner: null, background: null, votingBackground: null, resultsBackground: null, adminBackground: null },
  colors: { primary: '#f4cf51', secondary: '#ff657a', accent: '#68ceda', background: '#131317', text: '#f5f1ed' },
  background: { position: 'center', size: 'cover', repeat: 'no-repeat', opacity: 1, overlay: 0.35, borderRadius: 8, glow: 0.2 },
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
const selectThemeAsset = database.prepare('SELECT id, mime_type AS mimeType, size_bytes AS sizeBytes, width, height, uploaded_at AS uploadedAt FROM theme_assets WHERE id = ?')
const selectThemeAssets = database.prepare('SELECT id, mime_type AS mimeType, size_bytes AS sizeBytes, width, height, uploaded_at AS uploadedAt FROM theme_assets ORDER BY uploaded_at DESC')

function parseThemeJson(json) {
  try {
    const value = JSON.parse(json)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : defaultTheme
  } catch {
    return defaultTheme
  }
}

function getThemeConfig(json) {
  const parsed = parseThemeJson(json)
  return {
    ...defaultTheme,
    ...parsed,
    skin: themeSkins.includes(parsed.skin) ? parsed.skin : defaultTheme.skin,
    assets: { ...defaultTheme.assets, ...(parsed.assets || {}) },
    colors: { ...defaultTheme.colors, ...(parsed.colors || {}) },
    background: { ...defaultTheme.background, ...(parsed.background || {}) },
  }
}

function auditThemeChange(user, action, details = {}) {
  return database.prepare('INSERT INTO theme_audit_logs (id, administrator_id, administrator_name, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), user.id, user.username, action, JSON.stringify(details), new Date().toISOString())
}

function auditGameThemeChange(user, action, details = {}) {
  return database.prepare('INSERT INTO theme_audit_logs (id, administrator_id, administrator_name, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), user.id, user.username, `game-theme.${action}`, JSON.stringify(details), new Date().toISOString())
}

async function getReferencedThemeAssetIds() {
  const settings = await selectThemeSettings.get()
  const gameSettings = await selectGameThemeSettings.get()
  return new Set(
    [settings, gameSettings]
      .flatMap((entry) => ['draft', 'published'].flatMap((key) => Object.values(getThemeConfig(entry[key]).assets)))
      .filter((id) => typeof id === 'string'),
  )
}

async function removeUnusedThemeAsset(id) {
  if ((await getReferencedThemeAssetIds()).has(id)) return false
  const asset = await database.prepare('SELECT file_name AS fileName FROM theme_assets WHERE id = ?').get(id)
  if (!asset) return false
  await database.prepare('DELETE FROM theme_assets WHERE id = ?').run(id)
  const filePath = path.join(themeAssetsDirectory, asset.fileName)
  if (existsSync(filePath)) unlinkSync(filePath)
  return true
}

async function themeAssetsAreValid(assets, keys) {
  if (!assets) return false
  for (const key of keys) {
    const value = assets[key]
    if (value === null) continue
    if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value) || !(await selectThemeAsset.get(value))) return false
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

async function getPublicTheme() {
  const settings = await selectThemeSettings.get()
  const config = getThemeConfig(settings.published)
  const assetUrls = {}
  for (const [key, id] of Object.entries(config.assets)) {
    if (typeof id === 'string' && await selectThemeAsset.get(id)) assetUrls[key] = `/api/theme/assets/${encodeURIComponent(id)}`
  }
  return { config, assetUrls }
}

async function getPublicGameTheme() {
  const settings = await selectGameThemeSettings.get()
  const config = getThemeConfig(settings.published)
  const assetUrls = {}
  for (const [key, id] of Object.entries(config.assets)) {
    if (typeof id === 'string' && await selectThemeAsset.get(id)) assetUrls[key] = `/api/game-theme/assets/${encodeURIComponent(id)}`
  }
  return { config, assetUrls }
}

const sessionDurationSeconds = 60 * 60 * 24 * 7
const hashSessionToken = (token) => createHash('sha256').update(token).digest('hex')

function publicUser(user) {
  return { id: user.id, username: user.username, role: user.role }
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

function setVotingSessionCookie(request, response, pollId, token) {
  const secure = request.secure ? '; Secure' : ''
  response.setHeader('Set-Cookie', `${getVotingCookieName(pollId)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${votingSessionDurationSeconds}${secure}`)
}

async function getCurrentUser(request) {
  const token = getSessionToken(request)
  if (!token) return null
  const tokenHash = hashSessionToken(token)
  const session = await database.prepare(`
    SELECT users.id, users.username, users.role, sessions.expires_at AS expiresAt
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
  const secure = request.secure ? '; Secure' : ''
  response.setHeader('Set-Cookie', `vote_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionDurationSeconds}${secure}`)
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

function validateCredentials(username, password) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) return 'Use a username with 3–40 letters, numbers, dots, dashes, or underscores.'
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) return 'Use a password between 12 and 128 characters.'
  return ''
}

async function createUser(username, password, role) {
  const salt = randomBytes(16)
  const passwordHash = scryptSync(password, salt, 64)
  const user = { id: randomUUID(), username, role, createdAt: new Date().toISOString() }
  await database.prepare('INSERT INTO users (id, username, password_hash, password_salt, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.id, username, passwordHash, salt.toString('hex'), role, user.createdAt)
  return publicUser(user)
}

async function migrateLegacyData() {
  if (!existsSync(legacyPollsFile)) return
  const insertPoll = database.prepare('INSERT IGNORE INTO polls (id, question, created_at) VALUES (?, ?, ?)')
  const insertOption = database.prepare('INSERT IGNORE INTO poll_options (id, poll_id, label, `position`, votes) VALUES (?, ?, ?, ?, ?)')
  const insertVoter = database.prepare('INSERT IGNORE INTO poll_voters (poll_id, voter_id, option_id, created_at) VALUES (?, ?, NULL, ?)')

  await inTransaction(async () => {
    const legacyPolls = JSON.parse(readFileSync(legacyPollsFile, 'utf8'))
    for (const poll of legacyPolls) {
      await insertPoll.run(poll.id, poll.question, poll.createdAt || new Date().toISOString())
      for (const [index, option] of poll.options.entries()) await insertOption.run(option.id, poll.id, option.label, index, option.votes || 0)
      for (const voterId of poll.voterIds || []) {
        await insertVoter.run(poll.id, voterId, poll.createdAt || new Date().toISOString())
      }
    }
  })
}

await migrateLegacyData()

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
  await setSessionCookie(request, response, user.id)
  response.status(201).json({ user })
})

app.post('/api/auth/login', rateLimit({ windowMs: 60_000, max: 20, message: 'Too many login attempts. Try again in a minute.' }), async (request, response) => {
  const { username, password } = request.body || {}
  if (typeof username !== 'string' || typeof password !== 'string') {
    return response.status(400).json({ error: 'Enter your username and password.' })
  }
  const user = await database.prepare('SELECT id, username, role, password_hash AS passwordHash, password_salt AS passwordSalt FROM users WHERE username = ?').get(username)
  if (!user) return response.status(401).json({ error: 'Incorrect username or password.' })
  const passwordHash = scryptSync(password, Buffer.from(user.passwordSalt, 'hex'), 64)
  if (!timingSafeEqual(passwordHash, user.passwordHash)) return response.status(401).json({ error: 'Incorrect username or password.' })
  await setSessionCookie(request, response, user.id)
  response.json({ user: publicUser(user) })
})

app.post('/api/auth/logout', async (request, response) => {
  const token = getSessionToken(request)
  if (token) await database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashSessionToken(token))
  response.setHeader('Set-Cookie', 'vote_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
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
        (id, room_name, player_x_token_hash, player_x_name, status, board_json, history_x_json, history_o_json,
          next_player, x_image_mime_type, x_image, o_image_mime_type, o_image, updated_at)
      VALUES (?, ?, '', 'Waiting for Player X', 'waiting', ?, '[]', '[]', 'X', ?, ?, ?, ?, ?)
    `).run(
      id,
      roomName,
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
  const users = await database.prepare('SELECT id, username, role, created_at AS createdAt FROM users ORDER BY created_at').all()
  response.json(users)
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

app.get('/api/theme', async (_request, response) => response.json(await getPublicTheme()))

app.get('/api/game-theme', async (_request, response) => response.json(await getPublicGameTheme()))

app.get('/api/game-theme/assets/:id', async (request, response) => {
  const theme = await getPublicGameTheme()
  if (!Object.values(theme.config.assets).includes(request.params.id)) return response.status(404).end()
  const asset = await selectThemeAsset.get(request.params.id)
  if (!asset) return response.status(404).end()
  const file = await database.prepare('SELECT file_name AS fileName FROM theme_assets WHERE id = ?').get(request.params.id)
  response.type(asset.mimeType).set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'public, max-age=3600, immutable').sendFile(path.join(themeAssetsDirectory, file.fileName))
})

app.get('/api/admin/game-theme', requireAdmin, async (_request, response) => {
  const settings = await selectGameThemeSettings.get()
  response.json({
    draft: getThemeConfig(settings.draft),
    published: getThemeConfig(settings.published),
    draftAssets: await selectThemeAssets.all(),
    maxUploadBytes: themeImageMaxBytes,
    updatedAt: settings.updatedAt,
    publishedAt: settings.publishedAt,
  })
})

app.put('/api/admin/game-theme/draft', requireAdmin, async (request, response) => {
  const config = request.body
  const assetKeys = Object.keys(defaultGameTheme.assets)
  const colorKeys = Object.keys(defaultGameTheme.colors)
  const background = config?.background
  if (!config || typeof config !== 'object' || Array.isArray(config) || typeof config.eventTitle !== 'string' || config.eventTitle.trim().length < 1 || config.eventTitle.trim().length > 80) {
    return response.status(400).json({ error: 'Enter a game title between 1 and 80 characters.' })
  }
  if (!config.assets || !(await themeAssetsAreValid(config.assets, assetKeys))) {
    return response.status(400).json({ error: 'Choose valid uploaded images for the game theme.' })
  }
  if (!config.colors || colorKeys.some((key) => typeof config.colors[key] !== 'string' || !/^#[0-9a-f]{6}$/i.test(config.colors[key]))) {
    return response.status(400).json({ error: 'Game theme colors must be valid six-digit hex colors.' })
  }
  if (!background || !['cover', 'contain', 'repeat'].includes(background.size) || !['center', 'top', 'bottom', 'left', 'right'].includes(background.position) || typeof background.opacity !== 'number' || background.opacity < 0 || background.opacity > 1 || typeof background.overlay !== 'number' || background.overlay < 0 || background.overlay > 0.9 || typeof background.borderRadius !== 'number' || background.borderRadius < 0 || background.borderRadius > 32 || typeof background.glow !== 'number' || background.glow < 0 || background.glow > 1) {
    return response.status(400).json({ error: 'Game theme layout settings are invalid.' })
  }

  const normalized = {
    eventTitle: config.eventTitle.trim(),
    assets: Object.fromEntries(assetKeys.map((key) => [key, config.assets[key]])),
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
  if (!Object.values(theme.config.assets).includes(request.params.id)) return response.status(404).end()
  const asset = await selectThemeAsset.get(request.params.id)
  if (!asset) return response.status(404).end()
  const file = await database.prepare('SELECT file_name AS fileName FROM theme_assets WHERE id = ?').get(request.params.id)
  response.type(asset.mimeType).set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'public, max-age=3600, immutable').sendFile(path.join(themeAssetsDirectory, file.fileName))
})

app.get('/api/admin/theme', requireAdmin, async (_request, response) => {
  const settings = await selectThemeSettings.get()
  const draft = getThemeConfig(settings.draft)
  response.json({
    draft,
    published: getThemeConfig(settings.published),
    draftAssets: await selectThemeAssets.all(),
    maxUploadBytes: themeImageMaxBytes,
    updatedAt: settings.updatedAt,
    publishedAt: settings.publishedAt,
  })
})

const themeUploadTimes = new Map()
function limitThemeUploads(request, response, next) {
  const now = Date.now()
  const recent = (themeUploadTimes.get(request.user.id) || []).filter((time) => now - time < 10 * 60 * 1000)
  if (recent.length >= 12) return response.status(429).json({ error: 'Upload limit reached. Try again in a few minutes.' })
  recent.push(now)
  themeUploadTimes.set(request.user.id, recent)
  next()
}

app.post('/api/admin/theme/assets', requireAdmin, limitThemeUploads, themeImageUpload.single('image'), async (request, response) => {
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
  const uploadedAt = new Date().toISOString()
  try {
    writeFileSync(path.join(themeAssetsDirectory, fileName), file.buffer, { flag: 'wx' })
    await database.prepare('INSERT INTO theme_assets (id, file_name, mime_type, size_bytes, width, height, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, fileName, mimeType, file.size, dimensions.width, dimensions.height, request.user.id, uploadedAt)
  } catch (error) {
    const filePath = path.join(themeAssetsDirectory, fileName)
    if (existsSync(filePath)) unlinkSync(filePath)
    throw error
  }
  await auditThemeChange(request.user, 'asset.upload', { assetId: id, mimeType, sizeBytes: file.size, width: dimensions.width, height: dimensions.height })
  response.status(201).json({ asset: { id, mimeType, sizeBytes: file.size, width: dimensions.width, height: dimensions.height, uploadedAt, url: `/api/admin/theme/assets/${encodeURIComponent(id)}` } })
})

app.get('/api/admin/theme/assets/:id', requireAdmin, async (request, response) => {
  const asset = await selectThemeAsset.get(request.params.id)
  if (!asset) return response.status(404).json({ error: 'Theme image not found.' })
  const file = await database.prepare('SELECT file_name AS fileName FROM theme_assets WHERE id = ?').get(request.params.id)
  response.type(asset.mimeType).set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'private, max-age=3600, immutable').sendFile(path.join(themeAssetsDirectory, file.fileName))
})

app.put('/api/admin/theme/draft', requireAdmin, async (request, response) => {
  const config = request.body
  const assetKeys = Object.keys(defaultTheme.assets)
  const colorKeys = Object.keys(defaultTheme.colors)
  const backgroundKeys = Object.keys(defaultTheme.background)
  if (!config || typeof config !== 'object' || Array.isArray(config) || typeof config.eventTitle !== 'string' || config.eventTitle.trim().length < 1 || config.eventTitle.trim().length > 80) {
    return response.status(400).json({ error: 'Enter an event title between 1 and 80 characters.' })
  }
  if (!config.assets || !(await themeAssetsAreValid(config.assets, assetKeys))) {
    return response.status(400).json({ error: 'Choose valid uploaded images for the theme.' })
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

  const normalized = {
    eventTitle: config.eventTitle.trim(),
    skin: config.skin,
    assets: Object.fromEntries(assetKeys.map((key) => [key, config.assets[key]])),
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
  }
  const updatedAt = new Date().toISOString()
  await database.prepare('UPDATE theme_settings SET draft_json = ?, updated_by = ?, updated_at = ? WHERE id = 1')
    .run(JSON.stringify(normalized), request.user.id, updatedAt)
  await auditThemeChange(request.user, 'draft.save', { eventTitle: normalized.eventTitle, theme: normalized.skin })
  response.json({ draft: normalized, updatedAt })
})

app.post('/api/admin/theme/publish', requireAdmin, async (_request, response) => {
  const settings = await selectThemeSettings.get()
  const publishedAt = new Date().toISOString()
  await database.prepare('UPDATE theme_settings SET published_json = draft_json, published_by = ?, published_at = ? WHERE id = 1')
    .run(_request.user.id, publishedAt)
  await auditThemeChange(_request.user, 'theme.publish', { eventTitle: getThemeConfig(settings.draft).eventTitle })
  response.json({ published: getThemeConfig(settings.draft), publishedAt })
})

app.post('/api/admin/theme/reset', requireAdmin, async (_request, response) => {
  const now = new Date().toISOString()
  await database.prepare('UPDATE theme_settings SET draft_json = ?, published_json = ?, updated_by = ?, updated_at = ?, published_by = ?, published_at = ? WHERE id = 1')
    .run(JSON.stringify(defaultTheme), JSON.stringify(defaultTheme), _request.user.id, now, _request.user.id, now)
  await auditThemeChange(_request.user, 'theme.reset')
  for (const asset of await selectThemeAssets.all()) await removeUnusedThemeAsset(asset.id)
  response.json({ theme: defaultTheme, resetAt: now })
})

app.delete('/api/admin/theme/assets/:id', requireAdmin, async (request, response) => {
  if ((await getReferencedThemeAssetIds()).has(request.params.id)) {
    return response.status(409).json({ error: 'Remove this image from both the draft and published themes before deleting it.' })
  }
  const deleted = await removeUnusedThemeAsset(request.params.id)
  if (!deleted) return response.status(404).json({ error: 'Theme image not found.' })
  await auditThemeChange(request.user, 'asset.delete', { assetId: request.params.id })
  response.status(204).end()
})

app.get('/api/admin/theme/audit', requireAdmin, async (_request, response) => {
  const entries = await database.prepare('SELECT administrator_name AS administrator, action, details, created_at AS createdAt FROM theme_audit_logs ORDER BY created_at DESC LIMIT 100').all()
  response.json(entries.map((entry) => ({ ...entry, details: JSON.parse(entry.details) })))
})

function getSelfieSessionForOwner(sessionId, userId) {
  return database.prepare(`
    SELECT id, expires_at AS expiresAt, closed_at AS closedAt, paused
    FROM selfie_sessions
    WHERE id = ? AND owner_user_id = ?
  `).get(sessionId, userId)
}

app.post('/api/selfie/sessions/:id/pause', requireUser, async (request, response) => {
  const session = await getSelfieSessionForOwner(request.params.id, request.user.id)
  if (!session || session.closedAt || Date.parse(session.expiresAt) <= Date.now()) {
    return response.status(404).json({ error: 'This selfie session is closed or has expired.' })
  }
  const paused = request.body?.paused === true ? 1 : 0
  await database.prepare('UPDATE selfie_sessions SET paused = ? WHERE id = ?').run(paused, session.id)
  response.json({ paused: Boolean(paused) })
})

app.get('/api/admin/selfie/sessions', requireAdmin, async (_request, response) => {
  const now = new Date().toISOString()
  const sessions = await database.prepare(`
    SELECT sess.id, u.username AS host, sess.created_at AS createdAt, sess.expires_at AS expiresAt,
      sess.paused, sess.santa_enabled AS santaEnabled
    FROM selfie_sessions sess JOIN users u ON u.id = sess.owner_user_id
    WHERE sess.closed_at IS NULL AND sess.expires_at > ? ORDER BY sess.created_at DESC
  `).all(now)
  const photos = await database.prepare(`
    SELECT sub.id, sub.session_id AS sessionId, sub.status, sub.created_at AS createdAt, sub.approved_at AS approvedAt
    FROM selfie_submissions sub JOIN selfie_sessions sess ON sess.id = sub.session_id
    WHERE sess.closed_at IS NULL AND sess.expires_at > ? ORDER BY sub.created_at DESC
  `).all(now)
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
    WHERE sub.id = ? AND sub.session_id = ? AND sess.closed_at IS NULL AND sess.expires_at > ?
  `).get(request.params.photoId, request.params.sessionId, new Date().toISOString())
  if (!photo) return response.status(404).json({ error: 'This active session photo could not be found.' })
  response.type(photo.mimeType).set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'no-store').send(Buffer.from(photo.image))
})

app.get('/api/selfie/join/:token/status', async (request, response) => {
  const token = request.params.token
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return response.status(404).end()
  const row = await database.prepare('SELECT paused, santa_enabled AS santaEnabled, expires_at AS expiresAt, closed_at AS closedAt FROM selfie_sessions WHERE join_token_hash = ?').get(hashSessionToken(token))
  if (!row || row.closedAt || Date.parse(row.expiresAt) <= Date.now()) return response.status(404).end()
  response.set('Cache-Control', 'no-store').json({ paused: Boolean(row.paused), santaEnabled: Boolean(row.santaEnabled) })
})

app.post('/api/selfie/sessions', requireUser, async (request, response) => {
  const santaEnabled = request.body?.santaEnabled ?? false
  if (typeof santaEnabled !== 'boolean') return response.status(400).json({ error: 'Santa effect must be enabled or disabled.' })
  const now = new Date()
  await database.prepare('DELETE FROM selfie_sessions WHERE expires_at <= ? OR closed_at IS NOT NULL').run(now.toISOString())
  const sessionId = randomUUID()
  const joinToken = randomBytes(32).toString('base64url')
  const displayToken = randomBytes(32).toString('base64url')
  const expiresAt = new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString()
  await database.prepare(`
    INSERT INTO selfie_sessions (id, join_token_hash, display_token_hash, owner_user_id, created_at, expires_at, santa_enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, hashSessionToken(joinToken), hashSessionToken(displayToken), request.user.id, now.toISOString(), expiresAt, Number(santaEnabled))
  response.status(201).json({ id: sessionId, joinToken, displayToken, expiresAt, santaEnabled })
})

app.post('/api/selfie/sessions/:id/banner', requireUser, imageUpload.single('image'), async (request, response) => {
  const session = await getSelfieSessionForOwner(request.params.id, request.user.id)
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
  const row = await database.prepare(`
    SELECT banner, banner_mime_type AS mimeType, expires_at AS expiresAt, closed_at AS closedAt
    FROM selfie_sessions WHERE join_token_hash = ?
  `).get(hashSessionToken(token))
  if (!row?.banner || row.closedAt || Date.parse(row.expiresAt) <= Date.now()) return response.status(404).end()
  response.type(row.mimeType).set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'no-store').send(Buffer.from(row.banner))
})

app.post('/api/selfie/join/:token', imageUpload.single('image'), async (request, response) => {
  const token = request.params.token
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return response.status(404).json({ error: 'This selfie session is invalid or has expired.' })
  const session = await database.prepare(`
    SELECT id, expires_at AS expiresAt, closed_at AS closedAt, paused
    FROM selfie_sessions
    WHERE join_token_hash = ?
  `).get(hashSessionToken(token))
  if (!session || session.closedAt || Date.parse(session.expiresAt) <= Date.now()) {
    return response.status(404).json({ error: 'This selfie session is closed or has expired.' })
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
      SELECT id, expires_at AS expiresAt, closed_at AS closedAt, paused FROM selfie_sessions WHERE id = ?
    `).get(session.id)
    if (!currentSession || currentSession.closedAt || Date.parse(currentSession.expiresAt) <= Date.now()) return 'closed'
    if (currentSession.paused) return 'paused'
    const submissionCount = (await database.prepare('SELECT count(*) AS count FROM selfie_submissions WHERE session_id = ?').get(session.id)).count
    if (submissionCount >= 100) return 'limit'
    await database.prepare(`
      INSERT INTO selfie_submissions (id, session_id, image_mime_type, image, file_name, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, session.id, file.mimetype, file.buffer, file.originalname.slice(0, 120), new Date().toISOString())
    return 'created'
  })
  if (submitted === 'closed') return response.status(404).json({ error: 'This selfie session is closed or has expired.' })
  if (submitted === 'paused') return response.status(423).json({ error: 'The host has paused photo uploads. Please try again shortly.' })
  if (submitted === 'limit') return response.status(429).json({ error: 'This selfie session has reached its submission limit.' })
  response.status(201).json({ id, status: 'pending' })
})

async function requireSelfieDisplay(request, response, next) {
  response.set('Cache-Control', 'no-store')
  const token = request.get('X-Selfie-Display-Token') || request.query.token
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return response.status(403).json({ error: 'This live-screen link is invalid. Copy a new OBS URL from the host screen.' })
  }
  const session = await database.prepare(`
    SELECT id, paused, expires_at AS expiresAt, closed_at AS closedAt
    FROM selfie_sessions WHERE id = ? AND display_token_hash = ?
  `).get(request.params.sessionId, hashSessionToken(token))
  if (!session) return response.status(404).json({ error: 'This live-screen link is invalid or the selfie session has ended.' })
  if (session.closedAt || Date.parse(session.expiresAt) <= Date.now()) {
    return response.status(410).json({ error: 'This selfie session has ended.', closed: true })
  }
  request.selfieDisplaySession = session
  next()
}

app.get('/api/selfie/display/:sessionId/submissions', requireSelfieDisplay, async (request, response) => {
  const session = request.selfieDisplaySession
  const submissions = await database.prepare(`
    SELECT id, status, created_at AS createdAt, approved_at AS approvedAt
    FROM selfie_submissions WHERE session_id = ? AND status = 'approved' ORDER BY created_at DESC
  `).all(session.id)
  response.json({ submissions, paused: Boolean(session.paused), expiresAt: session.expiresAt, closed: false })
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
  const session = await getSelfieSessionForOwner(request.params.id, request.user.id)
  if (!session) return response.status(404).json({ error: 'This selfie session could not be found.' })
  const submissions = await database.prepare(`
    SELECT id, file_name AS fileName, status, created_at AS createdAt, approved_at AS approvedAt
    FROM selfie_submissions WHERE session_id = ? ORDER BY created_at DESC
  `).all(session.id)
  response.json({ submissions, paused: Boolean(session.paused), expiresAt: session.expiresAt, closed: Boolean(session.closedAt) || Date.parse(session.expiresAt) <= Date.now() })
})

app.post('/api/selfie/sessions/:sessionId/submissions/:submissionId/approve', requireUser, async (request, response) => {
  const session = await getSelfieSessionForOwner(request.params.sessionId, request.user.id)
  if (!session || session.closedAt || Date.parse(session.expiresAt) <= Date.now()) {
    return response.status(404).json({ error: 'This selfie session is closed or has expired.' })
  }
  const result = await database.prepare(`
    UPDATE selfie_submissions SET status = 'approved', approved_at = ?
    WHERE id = ? AND session_id = ? AND status = 'pending'
  `).run(new Date().toISOString(), request.params.submissionId, session.id)
  if (result.changes === 0) return response.status(404).json({ error: 'This pending photo could not be found.' })
  response.status(204).end()
})

app.delete('/api/selfie/sessions/:sessionId/submissions/:submissionId', requireUser, async (request, response) => {
  const session = await getSelfieSessionForOwner(request.params.sessionId, request.user.id)
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
    WHERE sub.id = ? AND sub.session_id = ? AND sess.owner_user_id = ?
  `).get(request.params.submissionId, request.params.sessionId, request.user.id)
  if (!image) return response.status(404).end()
  response.type(image.mimeType).set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'no-store').send(Buffer.from(image.image))
})

app.post('/api/selfie/sessions/:id/close', requireUser, async (request, response) => {
  const session = await getSelfieSessionForOwner(request.params.id, request.user.id)
  if (!session) return response.status(404).json({ error: 'This selfie session could not be found.' })
  await database.prepare('DELETE FROM selfie_sessions WHERE id = ?').run(session.id)
  response.status(204).end()
})

app.get('/api/logo-bank', requireUser, async (_request, response) => {
  const rows = await database.prepare('SELECT id, name FROM logo_bank ORDER BY created_at DESC LIMIT 200').all()
  response.set('Cache-Control', 'no-store').json({ logos: rows })
})

app.post('/api/logo-bank', requireUser, imageUpload.single('image'), async (request, response) => {
  const { file } = request
  if (!file || !hasValidImageSignature(file.mimetype, file.buffer)) {
    return response.status(400).json({ error: 'Upload a valid JPEG, PNG, or WebP image.' })
  }
  const hash = createHash('sha256').update(file.buffer).digest('hex')
  const existing = await database.prepare('SELECT id, name FROM logo_bank WHERE content_hash = ?').get(hash)
  if (existing) return response.status(200).json(existing)
  const id = randomUUID()
  const name = String(request.body?.name || file.originalname || 'logo').slice(0, 120)
  await database.prepare('INSERT INTO logo_bank (id, name, content_hash, image_mime_type, image, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, hash, file.mimetype, file.buffer, new Date().toISOString())
  response.status(201).json({ id, name })
})

app.get('/api/logo-bank/:id/image', requireUser, async (request, response) => {
  const image = await database.prepare('SELECT image, image_mime_type AS mimeType FROM logo_bank WHERE id = ?').get(request.params.id)
  if (!image) return response.status(404).end()
  response.type(image.mimeType).set('X-Content-Type-Options', 'nosniff').set('Cache-Control', 'private, max-age=3600').send(Buffer.from(image.image))
})

app.delete('/api/logo-bank/:id', requireUser, async (request, response) => {
  await database.prepare('DELETE FROM logo_bank WHERE id = ?').run(request.params.id)
  response.status(204).end()
})

app.get('/api/polls', requireUser, async (_request, response) => response.json(await listPolls()))

app.get('/api/polls/:id', async (request, response) => {
  const poll = await getPoll(request.params.id, { admin: Boolean(await getCurrentUser(request)) })
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

  const poll = { id: randomUUID(), question, createdAt: new Date().toISOString() }
  const optionsWithIds = options.map((option) => ({ ...option, id: randomUUID() }))
  const correctOptionId = optionsWithIds.find((option) => option.isCorrect)?.id || null
  await inTransaction(async () => {
    await database.prepare('INSERT INTO polls (id, question, created_at,     logo_mime_type,     logo, is_qa, correct_option_id, question_image_mime_type, question_image, reveal_correct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
              .run(poll.id, question, poll.createdAt, logoFile?.mimetype || null, logoFile?.buffer || null, Number(isQa), correctOptionId, questionImageFile?.mimetype || null, questionImageFile?.buffer || null, Number(isQa && request.body.revealCorrect === 'true'))
    const insertOption = database.prepare('INSERT INTO poll_options (id, poll_id, label, `position`, votes, image_mime_type, image, hide_label) VALUES (?, ?, ?, ?, 0, ?, ?, ?)')
    for (const [index, option] of optionsWithIds.entries()) {
      const file = option.imageIndex === null ? null : optionFiles[option.imageIndex]
      await insertOption.run(option.id, poll.id, option.label, index, file?.mimetype || null, file?.buffer || null, Number(option.hideLabel === true))
    }
  })
  await audit(request, 'poll.create', 'poll', poll.id, { isQa })
  response.status(201).json(await getPoll(poll.id, { admin: true }))
})

app.patch('/api/polls/:id/settings', requireUser, async (request, response) => {
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

app.patch('/api/polls/:id', requireUser, async (request, response, next) => {
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
  app, database, requireUser, requireAdmin, getCookie, getVotingCookieName, hashSessionToken,
  selectPoll, selectAdVideo, adVideosDirectory, inTransaction, getPoll, audit,
})

registerRaffleRoutes({ app, database, requireUser, imageUpload, hasValidImageSignature, inTransaction, audit })

const adVideoKinds = ['poll', 'qa', 'game', 'selfie', 'raffle']
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

function removeAdVideoFile(fileName) {
  try { unlinkSync(path.join(adVideosDirectory, path.basename(fileName))) } catch { /* Already removed. */ }
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

function selectAdVideo(kind) {
  const table = kind === 'raffle' ? 'raffle_ad_videos' : 'ad_videos'
  return database.prepare(`SELECT kind, file_name AS fileName, original_name AS originalName, mime_type AS mimeType, size, updated_at AS updatedAt FROM ${table} WHERE kind = ?`).get(kind)
}

async function selectAudienceAdVideo(kind) {
  return (await selectAdVideo(kind)) || (kind === 'raffle' ? selectAdVideo('poll') : undefined)
}

function adVideoSummary(video) {
  return video
    ? { available: true, url: `/api/ad-videos/${video.kind}/file?v=${encodeURIComponent(video.updatedAt)}`, mimeType: video.mimeType, name: video.originalName, size: video.size, updatedAt: video.updatedAt }
    : { available: false }
}

app.get('/api/admin/ad-videos', requireAdmin, async (_request, response) => {
  response.json({ poll: adVideoSummary(await selectAdVideo('poll')), qa: adVideoSummary(await selectAdVideo('qa')), game: adVideoSummary(await selectAdVideo('game')), selfie: adVideoSummary(await selectAdVideo('selfie')), raffle: adVideoSummary(await selectAdVideo('raffle')), maxBytes: adVideoMaxBytes })
})

app.put('/api/admin/ad-videos/:kind', requireAdmin, requireAdVideoKind, adVideoUpload.single('video'), async (request, response) => {
  const file = request.file
  if (!file) return response.status(400).json({ error: 'Choose an MP4 or WebM video.' })
  if (!hasValidVideoSignature(file.mimetype, file.path)) {
    removeAdVideoFile(file.filename)
    return response.status(400).json({ error: 'That file is not a valid MP4 or WebM video.' })
  }
  const kind = request.params.kind
  const fileName = `${kind}-${randomUUID()}${adVideoTypes[file.mimetype]}`
  renameSync(file.path, path.join(adVideosDirectory, fileName))
  const previous = await selectAdVideo(kind)
  const table = kind === 'raffle' ? 'raffle_ad_videos' : 'ad_videos'
  await database.prepare(`
    INSERT INTO ${table} (kind, file_name, original_name, mime_type, size, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE file_name = VALUES(file_name), original_name = VALUES(original_name),
      mime_type = VALUES(mime_type), size = VALUES(size), updated_at = VALUES(updated_at)
  `).run(kind, fileName, path.basename(file.originalname).slice(0, 120), file.mimetype, file.size, new Date().toISOString())
  if (previous) removeAdVideoFile(previous.fileName)
  await audit(request, 'ad-video.upload', 'ad-video', kind, { size: file.size })
  response.json(adVideoSummary(await selectAdVideo(kind)))
})

app.delete('/api/admin/ad-videos/:kind', requireAdmin, requireAdVideoKind, async (request, response) => {
  const previous = await selectAdVideo(request.params.kind)
  if (!previous) return response.status(404).json({ error: 'No video has been uploaded for this slot.' })
  const table = request.params.kind === 'raffle' ? 'raffle_ad_videos' : 'ad_videos'
  await database.prepare(`DELETE FROM ${table} WHERE kind = ?`).run(request.params.kind)
  removeAdVideoFile(previous.fileName)
  await audit(request, 'ad-video.delete', 'ad-video', request.params.kind)
  response.status(204).end()
})

app.get('/api/ad-videos/:kind', requireAdVideoKind, async (request, response) => {
  response.set('Cache-Control', 'no-store').json(adVideoSummary(await selectAudienceAdVideo(request.params.kind)))
})

app.get('/api/ad-videos/:kind/file', requireAdVideoKind, async (request, response) => {
  const video = await selectAdVideo(request.params.kind)
  if (!video) return response.status(404).end()
  response.type(video.mimeType).set('X-Content-Type-Options', 'nosniff').sendFile(path.join(adVideosDirectory, path.basename(video.fileName)), (error) => {
    if (error && !response.headersSent) response.status(404).end()
  })
})

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    if (_request.path.startsWith('/admin/ad-videos/')) return response.status(413).json({ error: `Videos must be ${Math.ceil(adVideoMaxBytes / 1024 / 1024)} MB or smaller.` })
    const limit = _request.path.startsWith('/admin/theme/') ? `${Math.ceil(themeImageMaxBytes / 1024 / 1024)} MB` : '5 MB'
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
if (existsSync(buildDirectory)) {
  app.use(express.static(buildDirectory))
  app.get('*', (_request, response) => response.sendFile(path.join(buildDirectory, 'index.html')))
}

app.listen(port, '0.0.0.0', () => {
  console.log(`VOTE API listening on http://localhost:${port}`)
})