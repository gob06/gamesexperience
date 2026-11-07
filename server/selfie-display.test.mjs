import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

test('OBS display works without login and exposes only approved photos for its active session', { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'roomvote-selfie-test-'))
  const filename = path.join(directory, 'test.sqlite')
  const listener = net.createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise((resolve) => listener.close(resolve))
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(port), DB_DRIVER: 'sqlite', SQLITE_PATH: filename, DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  let database
  server.stdout.on('data', (chunk) => { logs += chunk })
  server.stderr.on('data', (chunk) => { logs += chunk })
  t.after(async () => {
    database?.close()
    if (server.exitCode === null) {
      const exited = once(server, 'exit')
      server.kill()
      await exited
    }
    await rm(directory, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) assert.fail(`Test server exited: ${logs}`)
    try {
      if ((await fetch(`${base}/api/auth/status`)).ok) break
    } catch (error) {
      if (attempt === 99) throw new Error(`Test server did not start: ${logs}`, { cause: error })
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test-host', password: randomBytes(24).toString('hex') }),
  })
  assert.equal(setup.status, 201)
  const cookie = setup.headers.get('set-cookie').split(';')[0]
  async function createSession() {
    const response = await fetch(`${base}/api/selfie/sessions`, { method: 'POST', headers: { Cookie: cookie } })
    assert.equal(response.status, 201)
    const session = await response.json()
    assert.match(session.displayToken, /^[A-Za-z0-9_-]{43}$/)
    assert.notEqual(session.displayToken, session.joinToken)
    return session
  }
  const session = await createSession()
  const otherSession = await createSession()
  const normalStatus = await (await fetch(`${base}/api/selfie/join/${session.joinToken}/status`)).json()
  assert.equal(normalStatus.santaEnabled, false)
  const santaResponse = await fetch(`${base}/api/selfie/sessions`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ santaEnabled: true }),
  })
  assert.equal(santaResponse.status, 201)
  const santaSession = await santaResponse.json()
  assert.equal(santaSession.santaEnabled, true)
  const santaStatus = await (await fetch(`${base}/api/selfie/join/${santaSession.joinToken}/status`)).json()
  assert.equal(santaStatus.santaEnabled, true)
  const invalidMode = await fetch(`${base}/api/selfie/sessions`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ santaEnabled: 'true' }),
  })
  assert.equal(invalidMode.status, 400)
  database = new DatabaseSync(filename)
  const stored = database.prepare('SELECT display_token_hash FROM selfie_sessions WHERE id = ?').get(session.id)
  assert.equal(stored.display_token_hash.length, 64)
  assert.notEqual(stored.display_token_hash, session.displayToken)
  const image = Buffer.from('test-image')
  const insert = database.prepare('INSERT INTO selfie_submissions (id, session_id, image_mime_type, image, file_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  for (const [id, sessionId, status] of [['approved-photo', session.id, 'approved'], ['pending-photo', session.id, 'pending'], ['other-photo', otherSession.id, 'approved']]) {
    insert.run(id, sessionId, 'image/png', image, 'photo.png', status, new Date().toISOString())
  }
  const monitorUrl = `${base}/api/admin/selfie/sessions`
  const monitorPhoto = `${monitorUrl}/${session.id}/photos/pending-photo/image`
  const adminHeaders = { Cookie: cookie }
  const monitor = await fetch(monitorUrl, { headers: adminHeaders })
  assert.equal(monitor.status, 200)
  assert.equal(monitor.headers.get('cache-control'), 'no-store')
  const monitored = (await monitor.json()).sessions
  assert.equal(monitored.length, 3)
  assert.equal(monitored.find((item) => item.id === session.id).photos.length, 2)
  assert.ok(monitored.every((item) => !('joinToken' in item) && !('displayToken' in item)))
  assert.equal((await fetch(monitorPhoto, { headers: adminHeaders })).status, 200)
  assert.equal((await fetch(`${monitorUrl}/${otherSession.id}/photos/pending-photo/image`, { headers: adminHeaders })).status, 404)
  assert.equal((await fetch(monitorUrl)).status, 401)
  assert.equal((await fetch(monitorPhoto)).status, 401)
  database.prepare("UPDATE users SET role = 'host' WHERE username = ?").run('test-host')
  assert.equal((await fetch(monitorUrl, { headers: adminHeaders })).status, 403)
  assert.equal((await fetch(monitorPhoto, { headers: adminHeaders })).status, 403)
  database.prepare("UPDATE users SET role = 'admin' WHERE username = ?").run('test-host')
  const displayBase = `${base}/api/selfie/display/${session.id}/submissions`
  const headers = { 'X-Selfie-Display-Token': session.displayToken }
  const list = await fetch(displayBase, { headers })
  assert.equal(list.status, 200)
  assert.equal(list.headers.get('cache-control'), 'no-store')
  const result = await list.json()
  assert.deepEqual(result.submissions.map((photo) => photo.id), ['approved-photo'])
  assert.equal(result.paused, false)
  assert.equal(result.closed, false)
  const photoUrl = (id, token = session.displayToken) => `${displayBase}/${id}/image?token=${token}`
  const photo = await fetch(photoUrl('approved-photo'))
  assert.equal(photo.status, 200)
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), image)
  assert.equal((await fetch(photoUrl('pending-photo'))).status, 404)
  assert.equal((await fetch(photoUrl('other-photo'))).status, 404)
  assert.equal((await fetch(displayBase)).status, 403)
  assert.equal((await fetch(displayBase, { headers: { 'X-Selfie-Display-Token': session.joinToken } })).status, 404)
  assert.equal((await fetch(displayBase, { headers: { 'X-Selfie-Display-Token': otherSession.displayToken } })).status, 404)
  assert.equal((await fetch(`${base}/api/selfie/sessions/${session.id}/submissions`, { headers })).status, 401)
  assert.equal((await fetch(`${base}/api/selfie/sessions/${session.id}/submissions/pending-photo/approve`, { method: 'POST', headers })).status, 401)
  const ownerList = await fetch(`${base}/api/selfie/sessions/${session.id}/submissions`, { headers: { Cookie: cookie } })
  assert.equal((await ownerList.json()).submissions.length, 2)
  await fetch(`${base}/api/selfie/sessions/${session.id}/pause`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: true }),
  })
  assert.equal((await (await fetch(displayBase, { headers })).json()).paused, true)
  database.prepare('UPDATE selfie_sessions SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', session.id)
  assert.equal((await fetch(displayBase, { headers })).status, 410)
  assert.equal((await fetch(photoUrl('approved-photo'))).status, 410)
  const activeMonitor = (await (await fetch(monitorUrl, { headers: adminHeaders })).json()).sessions
  assert.ok(!activeMonitor.some((item) => item.id === session.id))
  assert.equal((await fetch(monitorPhoto, { headers: adminHeaders })).status, 404)
  const close = await fetch(`${base}/api/selfie/sessions/${otherSession.id}/close`, { method: 'POST', headers: { Cookie: cookie } })
  assert.equal(close.status, 204)
  assert.ok(!(await (await fetch(monitorUrl, { headers: adminHeaders })).json()).sessions.some((item) => item.id === otherSession.id))
  assert.equal((await fetch(`${base}/api/selfie/display/${otherSession.id}/submissions`, { headers: { 'X-Selfie-Display-Token': otherSession.displayToken } })).status, 404)
})
