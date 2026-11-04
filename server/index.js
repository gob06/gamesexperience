import express from 'express'
import multer from 'multer'
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { rateLimit } from './rate-limit.mjs'

const app = express()
const port = Number(process.env.PORT || 4180)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(root, 'data'))
const databaseFile = path.join(dataDirectory, 'roomvote.sqlite')
const legacyPollsFile = path.join(dataDirectory, 'polls.json')
const selfiesDirectory = path.join(dataDirectory, 'selfies')
const legacySelfiesFile = path.join(dataDirectory, 'selfies.json')
const imageExtensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }

mkdirSync(dataDirectory, { recursive: true })
const database = new DatabaseSync(databaseFile)
database.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS polls (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    created_at TEXT NOT NULL,
    logo_mime_type TEXT,
    logo BLOB
  );
  CREATE TABLE IF NOT EXISTS poll_options (
    id TEXT PRIMARY KEY,
    poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    position INTEGER NOT NULL,
    votes INTEGER NOT NULL DEFAULT 0 CHECK (votes >= 0)
  );
  CREATE INDEX IF NOT EXISTS poll_options_poll_id ON poll_options(poll_id, position);
  CREATE TABLE IF NOT EXISTS poll_voters (
    poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    voter_id TEXT NOT NULL,
    option_id TEXT REFERENCES poll_options(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (poll_id, voter_id)
  );
  CREATE TABLE IF NOT EXISTS selfies (
    id TEXT PRIMARY KEY,
    poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    voter_id TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    image BLOB NOT NULL,
    uploaded_at TEXT NOT NULL,
    UNIQUE (poll_id, voter_id)
  );
  CREATE INDEX IF NOT EXISTS selfies_poll_uploaded ON selfies(poll_id, uploaded_at DESC);
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'host')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
`)
const pollColumns = new Set(database.prepare('PRAGMA table_info(polls)').all().map((column) => column.name))
if (!pollColumns.has('logo_mime_type')) database.exec('ALTER TABLE polls ADD COLUMN logo_mime_type TEXT')
if (!pollColumns.has('logo')) database.exec('ALTER TABLE polls ADD COLUMN logo BLOB')

app.use(express.json({ limit: '32kb' }))

const selfieUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    if (!Object.hasOwn(imageExtensions, file.mimetype)) return callback(new Error('Use a JPEG, PNG, or WebP photo.'))
    callback(null, true)
  },
})

const loginRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many sign-in attempts. Try again in 15 minutes.' })
const setupRateLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: 'Too many setup attempts. Try again later.' })

app.get('/api/network-addresses', (_request, response) => {
  const addresses = Object.values(networkInterfaces())
    .flatMap((interfaces) => interfaces ?? [])
    .filter((network) => network.family === 'IPv4' && !network.internal)
    .map((network) => network.address)
    .filter((address) => /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(address))
    .sort((left, right) => Number(right.startsWith('192.168.')) - Number(left.startsWith('192.168.')))
  response.json({ addresses })
})

const selectPoll = database.prepare("SELECT id, question, created_at AS createdAt, CASE WHEN logo IS NULL THEN NULL ELSE '/api/polls/' || id || '/logo' END AS logoUrl FROM polls WHERE id = ?")
const selectOptions = database.prepare('SELECT id, label, votes FROM poll_options WHERE poll_id = ? ORDER BY position')

function getPoll(id) {
  const poll = selectPoll.get(id)
  if (!poll) return null
  return { ...poll, options: selectOptions.all(id) }
}

function listPolls() {
  return database.prepare('SELECT id FROM polls ORDER BY created_at DESC').all().map(({ id }) => getPoll(id))
}

function inTransaction(action) {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = action()
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function hasValidImageSignature(mimeType, image) {
  const signature = image.subarray(0, 12)
  if (mimeType === 'image/jpeg') return signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff
  if (mimeType === 'image/png') return signature.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  return mimeType === 'image/webp' && signature.toString('ascii', 0, 4) === 'RIFF' && signature.toString('ascii', 8, 12) === 'WEBP'
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

function getCurrentUser(request) {
  const token = getSessionToken(request)
  if (!token) return null
  const tokenHash = hashSessionToken(token)
  const session = database.prepare(`
    SELECT users.id, users.username, users.role, sessions.expires_at AS expiresAt
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
  `).get(tokenHash)
  if (!session) return null
  if (Date.parse(session.expiresAt) <= Date.now()) {
    database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
    return null
  }
  return publicUser(session)
}

function verifySameOrigin(request, response) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true

  const fetchSite = request.get('sec-fetch-site')
  const origin = request.get('origin')
  const requestHost = (request.get('x-forwarded-host') || request.get('host'))?.toLowerCase()
  if (fetchSite === 'cross-site' || !origin || !requestHost) {
    response.status(403).json({ error: 'This request must come from the application origin.' })
    return false
  }

  try {
    const parsedOrigin = new URL(origin)
    if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.host.toLowerCase() !== requestHost) {
      response.status(403).json({ error: 'This request must come from the application origin.' })
      return false
    }
  } catch {
    response.status(403).json({ error: 'This request must come from the application origin.' })
    return false
  }

  return true
}

function requireSameOriginRequest(request, response, next) {
  if (verifySameOrigin(request, response)) next()
}

function setSessionCookie(request, response, userId) {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + sessionDurationSeconds * 1000).toISOString()
  database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashSessionToken(token), userId, expiresAt)
  const secure = request.secure ? '; Secure' : ''
  response.setHeader('Set-Cookie', `vote_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionDurationSeconds}${secure}`)
}

function requireUser(request, response, next) {
  if (!verifySameOrigin(request, response)) return
  const user = getCurrentUser(request)
  if (!user) return response.status(401).json({ error: 'Please log in to manage polls.' })
  request.user = user
  next()
}

function requireAdmin(request, response, next) {
  if (!verifySameOrigin(request, response)) return
  const user = getCurrentUser(request)
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

function createUser(username, password, role) {
  const salt = randomBytes(16)
  const passwordHash = scryptSync(password, salt, 64)
  const user = { id: randomUUID(), username, role, createdAt: new Date().toISOString() }
  database.prepare('INSERT INTO users (id, username, password_hash, password_salt, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.id, username, passwordHash, salt.toString('hex'), role, user.createdAt)
  return publicUser(user)
}

function migrateLegacyData() {
  const insertPoll = database.prepare('INSERT OR IGNORE INTO polls (id, question, created_at) VALUES (?, ?, ?)')
  const insertOption = database.prepare('INSERT OR IGNORE INTO poll_options (id, poll_id, label, position, votes) VALUES (?, ?, ?, ?, ?)')
  const insertVoter = database.prepare('INSERT OR IGNORE INTO poll_voters (poll_id, voter_id, option_id, created_at) VALUES (?, ?, NULL, ?)')
  const insertSelfie = database.prepare('INSERT OR IGNORE INTO selfies (id, poll_id, voter_id, mime_type, image, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)')

  const migrate = () => inTransaction(() => {
    if (existsSync(legacyPollsFile)) {
      const legacyPolls = JSON.parse(readFileSync(legacyPollsFile, 'utf8'))
      for (const poll of legacyPolls) {
        insertPoll.run(poll.id, poll.question, poll.createdAt || new Date().toISOString())
        poll.options.forEach((option, index) => insertOption.run(option.id, poll.id, option.label, index, option.votes || 0))
        for (const voterId of poll.voterIds || []) {
          insertVoter.run(poll.id, voterId, poll.createdAt || new Date().toISOString())
        }
      }
    }

    if (existsSync(legacySelfiesFile)) {
      const legacySelfies = JSON.parse(readFileSync(legacySelfiesFile, 'utf8'))
      for (const selfie of legacySelfies) {
        const filename = path.basename(selfie.fileName || '')
        const imagePath = path.join(selfiesDirectory, filename)
        if (!filename || !existsSync(imagePath)) continue
        insertSelfie.run(selfie.id, selfie.pollId, selfie.voterId, `image/${path.extname(filename).slice(1)}`, readFileSync(imagePath), selfie.uploadedAt)
      }
    }
  })

  migrate()
}

migrateLegacyData()

app.get('/api/auth/status', (request, response) => {
  const userCount = database.prepare('SELECT count(*) AS count FROM users').get().count
  response.json({ setupRequired: userCount === 0, user: getCurrentUser(request) })
})

app.post('/api/auth/setup', setupRateLimit, requireSameOriginRequest, (request, response) => {
  const userCount = database.prepare('SELECT count(*) AS count FROM users').get().count
  if (userCount !== 0) return response.status(409).json({ error: 'Initial setup has already been completed.' })
  const { username, password } = request.body || {}
  const validationError = validateCredentials(username, password)
  if (validationError) return response.status(400).json({ error: validationError })

  let user
  try {
    user = inTransaction(() => {
      if (database.prepare('SELECT 1 FROM users LIMIT 1').get()) return null
      return createUser(username, password, 'admin')
    })
  } catch {
    return response.status(409).json({ error: 'Initial setup has already been completed.' })
  }
  if (!user) return response.status(409).json({ error: 'Initial setup has already been completed.' })
  setSessionCookie(request, response, user.id)
  response.status(201).json({ user })
})

app.post('/api/auth/login', loginRateLimit, requireSameOriginRequest, (request, response) => {
  const { username, password } = request.body || {}
  if (typeof username !== 'string' || typeof password !== 'string') {
    return response.status(400).json({ error: 'Enter your username and password.' })
  }
  const user = database.prepare('SELECT id, username, role, password_hash AS passwordHash, password_salt AS passwordSalt FROM users WHERE username = ? COLLATE NOCASE').get(username)
  if (!user) return response.status(401).json({ error: 'Incorrect username or password.' })
  const passwordHash = scryptSync(password, Buffer.from(user.passwordSalt, 'hex'), 64)
  if (!timingSafeEqual(passwordHash, user.passwordHash)) return response.status(401).json({ error: 'Incorrect username or password.' })
  setSessionCookie(request, response, user.id)
  response.json({ user: publicUser(user) })
})

app.post('/api/auth/logout', requireSameOriginRequest, (request, response) => {
  const token = getSessionToken(request)
  if (token) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashSessionToken(token))
  response.setHeader('Set-Cookie', 'vote_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
  response.status(204).end()
})

app.get('/api/admin/users', requireAdmin, (_request, response) => {
  const users = database.prepare('SELECT id, username, role, created_at AS createdAt FROM users ORDER BY created_at').all()
  response.json(users)
})

app.post('/api/admin/users', requireAdmin, (request, response) => {
  const { username, password, role } = request.body || {}
  const validationError = validateCredentials(username, password)
  if (validationError) return response.status(400).json({ error: validationError })
  if (!['admin', 'host'].includes(role)) return response.status(400).json({ error: 'Choose an admin or host role.' })

  try {
    const user = createUser(username, password, role)
    response.status(201).json({ user })
  } catch {
    response.status(409).json({ error: 'That username is already in use.' })
  }
})

app.get('/api/polls', requireUser, (_request, response) => response.json(listPolls()))

app.get('/api/polls/:id', (request, response) => {
  const poll = getPoll(request.params.id)
  if (!poll) return response.status(404).json({ error: 'This poll could not be found.' })
  response.json(poll)
})

app.get('/api/polls/:id/logo', (request, response) => {
  const logo = database.prepare('SELECT logo_mime_type AS mimeType, logo FROM polls WHERE id = ?').get(request.params.id)
  if (!logo?.logo) return response.status(404).end()
  response.type(logo.mimeType).set('Cache-Control', 'private, max-age=300').send(Buffer.from(logo.logo))
})

app.get('/api/polls/:id/selfies', (request, response) => {
  if (!selectPoll.get(request.params.id)) return response.status(404).json({ error: 'This poll could not be found.' })
  const selfies = database.prepare('SELECT id, uploaded_at AS uploadedAt FROM selfies WHERE poll_id = ? ORDER BY uploaded_at DESC').all(request.params.id)
  response.json(selfies.map(({ id, uploadedAt }) => ({ id, uploadedAt, imageUrl: `/api/selfies/${id}` })))
})

app.post('/api/polls/:id/selfies', selfieUpload.single('selfie'), (request, response) => {
  if (!selectPoll.get(request.params.id)) return response.status(404).json({ error: 'This poll could not be found.' })
  const { file } = request
  const { voterId } = request.body || {}
  if (!file || typeof voterId !== 'string' || voterId.length < 8 || voterId.length > 80) {
    return response.status(400).json({ error: 'A photo and voter identity are required.' })
  }

  const signature = file.buffer.subarray(0, 12)
  const validImage = file.mimetype === 'image/jpeg'
    ? signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff
    : file.mimetype === 'image/png'
      ? signature.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : signature.toString('ascii', 0, 4) === 'RIFF' && signature.toString('ascii', 8, 12) === 'WEBP'
  if (!validImage) return response.status(400).json({ error: 'The uploaded file is not a valid JPEG, PNG, or WebP image.' })

  const selfie = {
    id: randomUUID(),
    pollId: request.params.id,
    voterId,
    mimeType: file.mimetype,
    image: file.buffer,
    uploadedAt: new Date().toISOString(),
  }
  database.prepare(`
    INSERT INTO selfies (id, poll_id, voter_id, mime_type, image, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (poll_id, voter_id) DO UPDATE SET
      id = excluded.id,
      mime_type = excluded.mime_type,
      image = excluded.image,
      uploaded_at = excluded.uploaded_at
  `).run(selfie.id, selfie.pollId, selfie.voterId, selfie.mimeType, selfie.image, selfie.uploadedAt)
  response.status(201).json({ id: selfie.id, uploadedAt: selfie.uploadedAt, imageUrl: `/api/selfies/${selfie.id}` })
})

app.delete('/api/polls/:id/selfies/:voterId', (request, response) => {
  database.prepare('DELETE FROM selfies WHERE poll_id = ? AND voter_id = ?').run(request.params.id, request.params.voterId)
  response.status(204).end()
})

app.get('/api/selfies/:id', (request, response) => {
  const selfie = database.prepare('SELECT mime_type AS mimeType, image FROM selfies WHERE id = ?').get(request.params.id)
  if (!selfie) return response.status(404).end()
  response.type(selfie.mimeType).set('Cache-Control', 'private, max-age=60').send(Buffer.from(selfie.image))
})

app.get('/api/polls/:id/voter/:voterId', (request, response) => {
  if (!selectPoll.get(request.params.id)) return response.status(404).json({ error: 'This poll could not be found.' })
  const voter = database.prepare('SELECT 1 FROM poll_voters WHERE poll_id = ? AND voter_id = ?').get(request.params.id, request.params.voterId)
  response.json({ voted: Boolean(voter) })
})

app.post('/api/polls', requireUser, selfieUpload.single('logo'), (request, response) => {
  const question = typeof request.body.question === 'string' ? request.body.question.trim() : ''
  let parsedOptions
  try {
    parsedOptions = typeof request.body.options === 'string' ? JSON.parse(request.body.options) : request.body.options
  } catch {
    return response.status(400).json({ error: 'Poll options are invalid.' })
  }
  const options = Array.isArray(parsedOptions)
    ? parsedOptions.map((option) => String(option).trim()).filter(Boolean).slice(0, 8)
    : []
  if (question.length < 3 || question.length > 160 || options.length < 2) {
    return response.status(400).json({ error: 'Add a question and at least two options.' })
  }
  if (request.file && !hasValidImageSignature(request.file.mimetype, request.file.buffer)) {
    return response.status(400).json({ error: 'The logo file is not a valid JPEG, PNG, or WebP image.' })
  }

  const poll = { id: randomUUID(), question, createdAt: new Date().toISOString() }
  const createPoll = () => inTransaction(() => {
    database.prepare('INSERT INTO polls (id, question, created_at, logo_mime_type, logo) VALUES (?, ?, ?, ?, ?)')
      .run(poll.id, question, poll.createdAt, request.file?.mimetype || null, request.file?.buffer || null)
    const insertOption = database.prepare('INSERT INTO poll_options (id, poll_id, label, position, votes) VALUES (?, ?, ?, ?, 0)')
    options.forEach((label, index) => insertOption.run(randomUUID(), poll.id, label, index))
  })
  createPoll()
  response.status(201).json(getPoll(poll.id))
})

app.post('/api/polls/:id/votes', (request, response) => {
  const { optionId, voterId } = request.body || {}
  if (typeof voterId !== 'string' || voterId.length < 8 || voterId.length > 80) {
    return response.status(400).json({ error: 'A voter identity is required.' })
  }
  if (!selectPoll.get(request.params.id)) return response.status(404).json({ error: 'This poll could not be found.' })

  const castVote = inTransaction(() => {
    if (database.prepare('SELECT 1 FROM poll_voters WHERE poll_id = ? AND voter_id = ?').get(request.params.id, voterId)) return 'duplicate'
    const option = database.prepare('SELECT id FROM poll_options WHERE id = ? AND poll_id = ?').get(optionId, request.params.id)
    if (!option) return 'invalid-option'
    database.prepare('INSERT INTO poll_voters (poll_id, voter_id, option_id, created_at) VALUES (?, ?, ?, ?)').run(request.params.id, voterId, optionId, new Date().toISOString())
    database.prepare('UPDATE poll_options SET votes = votes + 1 WHERE id = ?').run(optionId)
    return 'ok'
  })

  if (castVote === 'duplicate') return response.status(409).json({ error: 'A vote has already been recorded from this browser.' })
  if (castVote === 'invalid-option') return response.status(400).json({ error: 'Choose one of the poll options.' })
  response.json(getPoll(request.params.id))
})

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return response.status(413).json({ error: 'Photo must be 5 MB or smaller.' })
  }
  response.status(400).json({ error: error.message || 'The upload could not be processed.' })
})

const buildDirectory = path.join(root, 'dist')
if (existsSync(buildDirectory)) {
  app.use(express.static(buildDirectory))
  app.get('*', (_request, response) => response.sendFile(path.join(buildDirectory, 'index.html')))
}

app.listen(port, '0.0.0.0', () => {
  console.log(`VOTE API listening on http://localhost:${port}`)
})

