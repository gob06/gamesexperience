import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createDatabase } from './db.mjs'

test('accounts isolate activities, banks and themes while superadmin manages sessions', { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'account-isolation-'))
  const listener = net.createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise((resolve) => listener.close(resolve))
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(port), DB_DRIVER: 'sqlite', SQLITE_PATH: path.join(directory, 'test.sqlite'), DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  server.stdout.on('data', (data) => { logs += data })
  server.stderr.on('data', (data) => { logs += data })
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, 'exit')
      server.kill()
      await exited
    }
    await rm(directory, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) assert.fail(logs)
    try { if ((await fetch(`${base}/api/auth/status`)).ok) break } catch { /* Waiting for startup. */ }
    if (i === 99) assert.fail(`Server failed to start: ${logs}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const request = (url, cookie, options = {}) => fetch(`${base}${url}`, { ...options, headers: { ...(cookie ? { Cookie: cookie } : {}), ...options.headers } })
  const json = () => ({ 'Content-Type': 'application/json' })
  const password = randomBytes(24).toString('hex')
  const setup = await request('/api/auth/setup', '', { method: 'POST', headers: json(), body: JSON.stringify({ username: 'admin', password }) })
  assert.equal(setup.status, 201)
  const superCookie = setup.headers.get('set-cookie').split(';')[0]
  assert.equal((await setup.json()).user.isSuperAdmin, true)
  async function createUser(username, role) {
    const response = await request('/api/admin/users', superCookie, { method: 'POST', headers: json(), body: JSON.stringify({ username, role, password }) })
    assert.equal(response.status, 201)
    const login = await request('/api/auth/login', '', { method: 'POST', headers: json(), body: JSON.stringify({ username, password }) })
    assert.equal(login.status, 200)
    return login.headers.get('set-cookie').split(';')[0]
  }
  const adminCookie = await createUser('another-admin', 'admin')
  const hostCookie = await createUser('another-host', 'host')
  const raffleForm = new FormData()
  raffleForm.append('title', 'Host raffle')
  const raffle = await (await request('/api/raffles', hostCookie, { method: 'POST', body: raffleForm })).json()
  const scrambleForm = new FormData()
  scrambleForm.append('title', 'Host scramble')
  scrambleForm.append('answer', 'EXAMPLE')
  const scramble = await (await request('/api/scrambles', hostCookie, { method: 'POST', body: scrambleForm })).json()
  const pollForm = new FormData()
  pollForm.append('question', 'A question?')
  pollForm.append('options', JSON.stringify(['Yes', 'No']))
  const poll = await (await request('/api/polls', hostCookie, { method: 'POST', body: pollForm })).json()
  const qaForm = new FormData()
  qaForm.append('question', 'A quiz question?')
  qaForm.append('isQa', 'true')
  qaForm.append('options', JSON.stringify([{ label: 'Yes', imageIndex: null, isCorrect: true }, { label: 'No', imageIndex: null }]))
  const qa = await (await request('/api/polls', hostCookie, { method: 'POST', body: qaForm })).json()
  const selfie = await (await request('/api/selfie/sessions', hostCookie, { method: 'POST', headers: json(), body: '{}' })).json()
  assert.ok(raffle.id && scramble.id && poll.id && qa.id && selfie.id)
  for (const [url, id] of [['/api/raffles', raffle.id], ['/api/scrambles', scramble.id], ['/api/polls', poll.id]]) {
    assert.equal((await (await request(url, adminCookie)).json()).some((item) => item.id === id), false)
    assert.equal((await (await request(url, superCookie)).json()).some((item) => item.id === id), true)
  }
  for (const [url, method] of [
    [`/api/raffles/${raffle.id}/host`, 'GET'], [`/api/raffles/${raffle.id}/reset`, 'POST'], [`/api/raffles/${raffle.id}`, 'DELETE'],
    [`/api/raffles/${raffle.id}/draw/start`, 'POST'], [`/api/raffles/${raffle.id}/draw/stop`, 'POST'],
    [`/api/scrambles/${scramble.id}/host`, 'GET'], [`/api/scrambles/${scramble.id}/reset`, 'POST'], [`/api/scrambles/${scramble.id}`, 'DELETE'],
    [`/api/scrambles/${scramble.id}/word`, 'PUT'], [`/api/scrambles/${scramble.id}/status`, 'POST'],
    [`/api/scrambles/${scramble.id}/reveal`, 'POST'], [`/api/scrambles/${scramble.id}/winners/randomize`, 'POST'],
    [`/api/scrambles/${scramble.id}/winners/confirm`, 'POST'], [`/api/scrambles/${scramble.id}/winners/announce-all`, 'POST'],
    [`/api/scrambles/${scramble.id}/winners/entry/announce`, 'POST'],
    [`/api/polls/${poll.id}`, 'DELETE'], [`/api/polls/${poll.id}`, 'PATCH'], [`/api/polls/${poll.id}/settings`, 'PATCH'],
    [`/api/polls/${qa.id}/monitor`, 'GET'], [`/api/polls/${qa.id}/monitor/stream`, 'GET'],
    [`/api/polls/${qa.id}/monitor.csv`, 'GET'], [`/api/polls/${qa.id}/submissions/entry/verification`, 'PATCH'],
    [`/api/selfie/sessions/${selfie.id}/links`, 'POST'], [`/api/selfie/sessions/${selfie.id}/pause`, 'POST'],
    [`/api/selfie/sessions/${selfie.id}/submissions`, 'GET'], [`/api/selfie/sessions/${selfie.id}/close`, 'POST'],
  ]) {
    assert.equal((await request(url, adminCookie, { method })).status, 404, url)
  }
  for (const url of [`/api/raffles/${raffle.id}/host`, `/api/scrambles/${scramble.id}/host`, `/api/polls/${qa.id}/monitor`, `/api/selfie/sessions/${selfie.id}/submissions`]) {
    assert.equal((await request(url, superCookie)).status, 200, url)
  }
  assert.equal((await (await request('/api/selfie/sessions', adminCookie)).json()).sessions.length, 0)
  assert.equal((await (await request('/api/admin/selfie/sessions', adminCookie)).json()).sessions.length, 0)
  assert.ok((await (await request('/api/selfie/sessions', superCookie)).json()).sessions.some((item) => item.id === selfie.id))
  assert.equal((await request(`/api/raffles/${raffle.id}`, '')).status, 200)
  assert.equal((await request(`/api/scrambles/${scramble.id}`, '')).status, 200)
  assert.equal((await request(`/api/polls/${qa.id}`, '')).status, 200)
  assert.equal('correctOptionId' in await (await request(`/api/polls/${qa.id}`, adminCookie)).json(), false)
  assert.equal('correctOptionId' in await (await request(`/api/polls/${qa.id}`, hostCookie)).json(), true)
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAX8AAAAASUVORK5CYII=', 'base64')
  const imageForm = new FormData()
  imageForm.append('image', new Blob([image], { type: 'image/png' }), 'logo.png')
  const logo = await (await request('/api/logo-bank', hostCookie, { method: 'POST', body: imageForm })).json()
  assert.ok(logo.id)
  assert.equal((await (await request('/api/logo-bank', adminCookie)).json()).logos.length, 0)
  assert.equal((await request(`/api/logo-bank/${logo.id}/image`, superCookie)).status, 404)
  assert.equal((await request(`/api/logo-bank/${logo.id}`, adminCookie, { method: 'DELETE' })).status, 404)
  const secondImageForm = new FormData()
  secondImageForm.append('image', new Blob([image], { type: 'image/png' }), 'logo.png')
  const secondLogo = await (await request('/api/logo-bank', adminCookie, { method: 'POST', body: secondImageForm })).json()
  assert.notEqual(secondLogo.id, logo.id)
  const themeImageForm = new FormData()
  themeImageForm.append('image', new Blob([image], { type: 'image/png' }), 'theme.png')
  const themeUpload = await request('/api/admin/theme/assets', hostCookie, { method: 'POST', body: themeImageForm })
  assert.equal(themeUpload.status, 201)
  const themeImage = (await themeUpload.json()).asset
  assert.equal((await request(`/api/admin/theme/assets/${themeImage.id}`, superCookie)).status, 404)
  assert.equal((await request(`/api/admin/theme/assets/${themeImage.id}`, adminCookie, { method: 'DELETE' })).status, 404)
  assert.equal((await request(`/api/theme/assets/${themeImage.id}`, '')).status, 404)
  const theme = await (await request('/api/admin/theme', hostCookie)).json()
  theme.draft.eventTitle = 'Host appearance'
  theme.draft.assets.logo = themeImage.id
  assert.equal((await request('/api/admin/theme/draft', hostCookie, { method: 'PUT', headers: json(), body: JSON.stringify(theme.draft) })).status, 200)
  assert.equal((await request('/api/admin/theme/publish', hostCookie, { method: 'POST' })).status, 200)
  assert.equal((await (await request('/api/theme', hostCookie)).json()).config.eventTitle, 'Host appearance')
  assert.equal((await request(`/api/theme/assets/${themeImage.id}`, '')).status, 200)
  assert.notEqual((await (await request('/api/theme', superCookie)).json()).config.eventTitle, 'Host appearance')
  for (const [kind, id] of [['poll', poll.id], ['raffle', raffle.id], ['scramble', scramble.id], ['selfie-join', selfie.joinToken]]) {
    assert.equal((await (await request(`/api/theme?kind=${kind}&id=${id}`, '')).json()).config.eventTitle, 'Host appearance')
  }
  assert.equal((await request(`/api/theme?kind=selfie-display&id=${selfie.id}`, '')).status, 404)
  assert.equal((await (await request(`/api/theme?kind=selfie-display&id=${selfie.id}`, '', { headers: { 'X-Selfie-Display-Token': selfie.displayToken } })).json()).config.eventTitle, 'Host appearance')
})

test('legacy ownership migration is idempotent and preserves activity and image data', { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'account-migration-'))
  const filename = path.join(directory, 'test.sqlite')
  const database = await createDatabase({ driver: 'sqlite', filename })
  await database.initializeSchema()
  const insertUser = database.prepare('INSERT INTO users (id, username, password_hash, password_salt, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
  await insertUser.run('first', 'first-admin', Buffer.alloc(64), 'salt', 'admin', '2020-01-01')
  await insertUser.run('images', 'admin', Buffer.alloc(64), 'salt', 'admin', '2021-01-01')
  await insertUser.run('host', 'host', Buffer.alloc(64), 'salt', 'host', '2022-01-01')
  await database.prepare('INSERT INTO polls (id, question, created_at) VALUES (?, ?, ?)').run('legacy-poll', 'Old poll', '2020-01-01')
  await database.prepare('INSERT INTO logo_bank (id, name, content_hash, image_mime_type, image, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('legacy-image', 'Old image', 'hash', 'image/png', Buffer.from('old-image'), '2020-01-01')
  await database.prepare('INSERT INTO theme_assets (id, file_name, mime_type, size_bytes, width, height, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('old-theme-image', 'old.png', 'image/png', 1, 1, 1, 'images', '2020-01-01')
  const listener = net.createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise((resolve) => listener.close(resolve))
  let server
  t.after(async () => {
    if (server && server.exitCode === null) {
      const exited = once(server, 'exit')
      server.kill()
      await exited
    }
    database.close()
    await rm(directory, { recursive: true, force: true })
  })
  async function start() {
    server = spawn(process.execPath, ['server/index.js'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, PORT: String(port), DB_DRIVER: 'sqlite', SQLITE_PATH: filename, DATA_DIR: directory },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let logs = ''
    server.stderr.on('data', (data) => { logs += data })
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) assert.fail(logs)
      try { if ((await fetch(`http://127.0.0.1:${port}/api/auth/status`)).ok) return } catch { /* Waiting for startup. */ }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.fail(`Server failed to start: ${logs}`)
  }
  await start()
  assert.equal((await database.prepare('SELECT owner_user_id AS ownerId FROM polls WHERE id = ?').get('legacy-poll')).ownerId, 'first')
  assert.equal((await database.prepare('SELECT is_superadmin AS flag FROM users WHERE id = ?').get('first')).flag, 1)
  assert.equal((await database.prepare('SELECT owner_user_id AS ownerId FROM account_logo_bank WHERE id = ?').get('legacy-image')).ownerId, 'images')
  assert.ok(await database.prepare('SELECT asset_id FROM account_theme_assets WHERE user_id = ? AND asset_id = ?').get('images', 'old-theme-image'))
  assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM account_theme_settings').get()).count, 3)
  const exited = once(server, 'exit')
  server.kill()
  await exited
  await start()
  assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM account_logo_bank').get()).count, 1)
  assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM account_theme_settings').get()).count, 3)
})
