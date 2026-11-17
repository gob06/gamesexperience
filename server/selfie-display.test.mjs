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

test('selfie sessions end manually and retain private history and approved OBS playback across restarts', { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'roomvote-selfie-test-'))
  const filename = path.join(directory, 'test.sqlite')
  const listener = net.createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise((resolve) => listener.close(resolve))
  const startServer = () => spawn(process.execPath, ['server/index.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, PORT: String(port), DB_DRIVER: 'sqlite', SQLITE_PATH: filename, DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let server = startServer()
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
  async function waitForServer() {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) assert.fail(`Test server exited: ${logs}`)
      try {
        if ((await fetch(`${base}/api/auth/status`)).ok) return
      } catch (error) {
        if (attempt === 99) throw new Error(`Test server did not start: ${logs}`, { cause: error })
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.fail(`Test server did not become ready: ${logs}`)
  }
  await waitForServer()
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test-host', password: randomBytes(24).toString('hex') }),
  })
  assert.equal(setup.status, 201)
  const cookie = setup.headers.get('set-cookie').split(';')[0]
  const hostPassword = randomBytes(24).toString('hex')
  const hostResponse = await fetch(`${base}/api/admin/users`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'other-host', password: hostPassword, role: 'host' }),
  })
  assert.equal(hostResponse.status, 201)
  const hostLogin = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'other-host', password: hostPassword }),
  })
  assert.equal(hostLogin.status, 200)
  const hostCookie = hostLogin.headers.get('set-cookie').split(';')[0]
  const hostHeaders = { Cookie: hostCookie }
  async function createSession() {
    const response = await fetch(`${base}/api/selfie/sessions`, { method: 'POST', headers: { Cookie: cookie } })
    assert.equal(response.status, 201)
    const session = await response.json()
    assert.match(session.displayToken, /^[A-Za-z0-9_-]{43}$/)
    assert.notEqual(session.displayToken, session.joinToken)
    assert.equal('expiresAt' in session, false)
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
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAX8AAAAASUVORK5CYII=', 'base64')
  async function upload(token) {
    const form = new FormData()
    form.append('image', new Blob([png], { type: 'image/png' }), 'selfie.png')
    return fetch(`${base}/api/selfie/join/${token}`, { method: 'POST', body: form })
  }
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
  assert.equal(result.qrSession, null)
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
  const historyUrl = `${base}/api/selfie/sessions`
  assert.equal((await fetch(historyUrl)).status, 401)
  assert.equal((await fetch(`${historyUrl}/${session.id}/links`, { method: 'POST' })).status, 401)
  assert.deepEqual((await (await fetch(historyUrl, { headers: hostHeaders })).json()).sessions, [])
  for (const [suffix, method] of [['links', 'POST'], ['submissions', 'GET'], ['pause', 'POST'], ['close', 'POST'], ['submissions/pending-photo/approve', 'POST'], ['submissions/approved-photo/image', 'GET'], ['submissions/approved-photo', 'DELETE']]) {
    assert.equal((await fetch(`${historyUrl}/${session.id}/${suffix}`, { method, headers: hostHeaders })).status, 404, suffix)
  }
  const hostSessionResponse = await fetch(historyUrl, { method: 'POST', headers: hostHeaders })
  assert.equal(hostSessionResponse.status, 201)
  const hostSession = await hostSessionResponse.json()
  insert.run('host-photo', hostSession.id, 'image/png', png, 'photo.png', 'pending', new Date().toISOString())
  assert.equal((await fetch(`${historyUrl}/${hostSession.id}/submissions/host-photo/image`, { headers: adminHeaders })).status, 200, 'admin may view another host photo')
  assert.equal((await fetch(`${historyUrl}/${hostSession.id}/submissions/host-photo/approve`, { method: 'POST', headers: adminHeaders })).status, 204, 'admin may approve another host photo')
  const hostHistory = (await (await fetch(historyUrl, { headers: hostHeaders })).json()).sessions
  assert.deepEqual(hostHistory.map((item) => item.id), [hostSession.id])
  const adminHistory = (await (await fetch(historyUrl, { headers: adminHeaders })).json()).sessions
  assert.equal(adminHistory.length, 4)
  assert.equal(adminHistory[0].id, hostSession.id)
  assert.equal(adminHistory.find((item) => item.id === session.id).photoCount, 2)
  assert.equal(adminHistory.find((item) => item.id === session.id).approvedCount, 1)
  assert.ok(adminHistory.every((item) => !('joinToken' in item) && !('displayToken' in item)))
  const linksResponse = await fetch(`${historyUrl}/${session.id}/links`, { method: 'POST', headers: adminHeaders })
  assert.equal(linksResponse.status, 200)
  const links = await linksResponse.json()
  assert.notEqual(links.joinToken, session.joinToken)
  assert.notEqual(links.displayToken, session.displayToken)
  const storedLink = database.prepare('SELECT join_token_hash, display_token_hash FROM selfie_session_links WHERE session_id = ?').get(session.id)
  assert.equal(storedLink.join_token_hash.length, 64)
  assert.equal(storedLink.display_token_hash.length, 64)
  assert.notEqual(storedLink.display_token_hash, links.displayToken)
  assert.equal((await fetch(`${base}/api/selfie/join/${links.joinToken}/status`)).status, 200)
  assert.equal((await fetch(displayBase, { headers: { 'X-Selfie-Display-Token': links.displayToken } })).status, 200)
  assert.equal((await fetch(displayBase, { headers: { 'X-Selfie-Display-Token': links.joinToken } })).status, 404)
  assert.equal((await fetch(photoUrl('pending-photo', links.displayToken))).status, 404)
  assert.equal((await upload(links.joinToken)).status, 423)
  const banner = new FormData()
  banner.append('image', new Blob([png], { type: 'image/png' }), 'banner.png')
  assert.equal((await fetch(`${historyUrl}/${session.id}/banner`, { method: 'POST', headers: adminHeaders, body: banner })).status, 204)
  assert.equal((await fetch(`${base}/api/selfie/join/${links.joinToken}/banner`)).status, 200)
  await fetch(`${historyUrl}/${session.id}/pause`, {
    method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: false }),
  })
  database.prepare('UPDATE selfie_sessions SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', session.id)
  assert.equal((await fetch(displayBase, { headers })).status, 200)
  assert.equal((await fetch(photoUrl('approved-photo'))).status, 200)
  assert.equal((await fetch(`${base}/api/selfie/join/${session.joinToken}/status`)).status, 200)
  assert.equal((await upload(session.joinToken)).status, 201)
  assert.equal((await upload(links.joinToken)).status, 201)
  const newestSession = await createSession()
  assert.ok(database.prepare('SELECT id FROM selfie_sessions WHERE id = ?').get(session.id), 'creating another session must not delete old sessions')
  const close = await fetch(`${base}/api/selfie/sessions/${otherSession.id}/close`, { method: 'POST', headers: { Cookie: cookie } })
  assert.equal(close.status, 204)
  assert.ok((await (await fetch(monitorUrl, { headers: adminHeaders })).json()).sessions.some((item) => item.id === otherSession.id && item.closedAt))
  const endedDisplay = await fetch(`${base}/api/selfie/display/${otherSession.id}/submissions`, { headers: { 'X-Selfie-Display-Token': otherSession.displayToken } })
  assert.equal(endedDisplay.status, 200)
  const endedBody = await endedDisplay.json()
  assert.equal(endedBody.closed, true)
  assert.equal(endedBody.qrSession.id, newestSession.id)
  assert.equal(endedBody.qrSession.paused, false)
  assert.match(endedBody.qrSession.joinToken, /^[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(endedBody.submissions.map((item) => item.id), ['other-photo'])
  assert.equal((await upload(endedBody.qrSession.joinToken)).status, 201)
  assert.equal(database.prepare('SELECT count(*) AS count FROM selfie_submissions WHERE session_id = ?').get(newestSession.id).count, 1)
  assert.equal((await fetch(`${base}/api/selfie/display/${newestSession.id}/submissions`, { headers: { 'X-Selfie-Display-Token': endedBody.qrSession.joinToken } })).status, 404)
  assert.equal((await fetch(`${base}/api/selfie/display/${otherSession.id}/submissions/host-photo/image`, { headers: { 'X-Selfie-Display-Token': otherSession.displayToken } })).status, 404)
  assert.equal((await (await fetch(`${historyUrl}/${otherSession.id}/submissions`, { headers: adminHeaders })).json()).qrSession.joinToken, endedBody.qrSession.joinToken)
  await fetch(`${historyUrl}/${newestSession.id}/pause`, {
    method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: true }),
  })
  const pausedQr = (await (await fetch(`${base}/api/selfie/display/${otherSession.id}/submissions`, { headers: { 'X-Selfie-Display-Token': otherSession.displayToken } })).json()).qrSession
  assert.equal(pausedQr.id, newestSession.id)
  assert.equal(pausedQr.paused, true)
  assert.equal((await upload(pausedQr.joinToken)).status, 423)
  assert.equal((await upload(otherSession.joinToken)).status, 404)
  assert.equal((await fetch(`${historyUrl}/${hostSession.id}/close`, { method: 'POST', headers: adminHeaders })).status, 204, 'admin may end another host session')
  assert.equal((await fetch(`${historyUrl}/${hostSession.id}/submissions`, { headers: hostHeaders })).status, 200, 'owner can still view an ended session')
  const hostDisplay = await fetch(`${base}/api/selfie/display/${hostSession.id}/submissions`, { headers: { 'X-Selfie-Display-Token': hostSession.displayToken } })
  assert.equal((await hostDisplay.json()).qrSession, null, 'another host ongoing session must not be shown')
  assert.equal((await fetch(`${historyUrl}/${session.id}/close`, { method: 'POST', headers: adminHeaders })).status, 204)
  assert.equal((await upload(session.joinToken)).status, 404)
  assert.equal((await upload(links.joinToken)).status, 404)
  assert.equal((await fetch(`${base}/api/selfie/join/${links.joinToken}/status`)).status, 404)
  assert.equal((await fetch(`${base}/api/selfie/join/${links.joinToken}/banner`)).status, 404)
  assert.equal((await fetch(monitorPhoto, { headers: adminHeaders })).status, 200)
  assert.equal((await fetch(`${historyUrl}/${session.id}/submissions/pending-photo/approve`, { method: 'POST', headers: adminHeaders })).status, 204)
  const endedLinks = await (await fetch(`${historyUrl}/${session.id}/links`, { method: 'POST', headers: adminHeaders })).json()
  assert.ok(endedLinks.closedAt)
  for (const displayToken of [session.displayToken, links.displayToken, endedLinks.displayToken]) {
    const archive = await fetch(displayBase, { headers: { 'X-Selfie-Display-Token': displayToken } })
    assert.equal(archive.status, 200)
    const body = await archive.json()
    assert.equal(body.closed, true)
    assert.equal(body.paused, false)
    assert.equal(body.qrSession.id, newestSession.id)
    assert.deepEqual(body.submissions.map((item) => item.id).sort(), ['approved-photo', 'pending-photo'])
  }
  // Exercise startup backfill for a retained session created before the live-QR column existed.
  database.prepare('UPDATE selfie_sessions SET live_join_token_hash = NULL WHERE id = ?').run(newestSession.id)
  const exited = once(server, 'exit')
  server.kill()
  await exited
  server = startServer()
  server.stdout.on('data', (chunk) => { logs += chunk })
  server.stderr.on('data', (chunk) => { logs += chunk })
  await waitForServer()
  const restartedQr = (await (await fetch(displayBase, { headers })).json()).qrSession
  assert.equal(restartedQr.joinToken, endedBody.qrSession.joinToken)
  assert.equal((await fetch(`${base}/api/selfie/join/${restartedQr.joinToken}/status`)).status, 200)
  assert.ok(database.prepare('SELECT live_join_token_hash FROM selfie_sessions WHERE id = ?').get(newestSession.id).live_join_token_hash)
  assert.equal((await fetch(`${historyUrl}/${newestSession.id}/close`, { method: 'POST', headers: adminHeaders })).status, 204)
  const fallbackQr = (await (await fetch(displayBase, { headers })).json()).qrSession
  assert.equal(fallbackQr.id, santaSession.id)
  assert.equal((await fetch(`${base}/api/selfie/join/${fallbackQr.joinToken}/status`)).status, 200)
  assert.equal((await fetch(`${historyUrl}/${santaSession.id}/close`, { method: 'POST', headers: adminHeaders })).status, 204)
  assert.equal((await (await fetch(displayBase, { headers })).json()).qrSession, null)
  const replacement = await createSession()
  assert.equal((await (await fetch(displayBase, { headers })).json()).qrSession.id, replacement.id)
  assert.equal((await fetch(photoUrl('approved-photo', links.displayToken))).status, 200)
  assert.equal((await fetch(photoUrl('pending-photo', endedLinks.displayToken))).status, 200)
  assert.equal((await fetch(`${base}/api/selfie/join/${santaSession.joinToken}/status`)).status, 404)
  const afterRestart = (await (await fetch(historyUrl, { headers: adminHeaders })).json()).sessions
  assert.ok(afterRestart.some((item) => item.id === session.id && item.closedAt && item.photoCount === 4))
  assert.equal((await fetch(`${historyUrl}/${session.id}/submissions/approved-photo`, { method: 'DELETE', headers: adminHeaders })).status, 204)
  assert.equal((await fetch(photoUrl('approved-photo'))).status, 404)
  assert.equal((await fetch(`${historyUrl}/${session.id}`, { method: 'DELETE' })).status, 401)
  assert.equal((await fetch(`${historyUrl}/${session.id}`, { method: 'DELETE', headers: hostHeaders })).status, 404)
  assert.equal((await fetch(`${historyUrl}/${replacement.id}`, { method: 'DELETE', headers: adminHeaders })).status, 409)
  assert.ok(database.prepare('SELECT id FROM selfie_sessions WHERE id = ?').get(replacement.id))
  assert.equal((await fetch(`${historyUrl}/${session.id}`, { method: 'DELETE', headers: adminHeaders })).status, 204)
  assert.equal(database.prepare('SELECT count(*) AS count FROM selfie_submissions WHERE session_id = ?').get(session.id).count, 0)
  assert.equal(database.prepare('SELECT count(*) AS count FROM selfie_session_links WHERE session_id = ?').get(session.id).count, 0)
  assert.equal((await fetch(displayBase, { headers })).status, 404)
  assert.equal((await fetch(photoUrl('pending-photo', endedLinks.displayToken))).status, 404)
  assert.equal((await fetch(`${historyUrl}/${session.id}/submissions`, { headers: adminHeaders })).status, 404)
  assert.ok(!(await (await fetch(historyUrl, { headers: adminHeaders })).json()).sessions.some((item) => item.id === session.id))
  assert.equal((await fetch(`${historyUrl}/${session.id}`, { method: 'DELETE', headers: adminHeaders })).status, 404)
  assert.equal((await fetch(`${historyUrl}/${hostSession.id}`, { method: 'DELETE', headers: hostHeaders })).status, 204)
  assert.equal(database.prepare('SELECT count(*) AS count FROM selfie_submissions WHERE session_id = ?').get(hostSession.id).count, 0)
  assert.equal((await fetch(`${base}/api/selfie/join/${replacement.joinToken}/status`)).status, 200)
  for (let index = 0; index < 100; index++) {
    insert.run(`bulk-photo-${index}`, replacement.id, 'image/png', png, 'photo.png', 'pending', new Date().toISOString())
  }
  for (const expectedCount of [101, 102]) {
    const uploaded = await upload(replacement.joinToken)
    assert.equal(uploaded.status, 201, 'uploads must succeed beyond the former 100-photo cap')
    assert.equal((await uploaded.json()).status, 'pending')
    assert.equal(database.prepare('SELECT count(*) AS count FROM selfie_submissions WHERE session_id = ?').get(replacement.id).count, expectedCount)
  }
  const unlimitedList = await (await fetch(`${historyUrl}/${replacement.id}/submissions`, { headers: adminHeaders })).json()
  assert.equal(unlimitedList.submissions.length, 102)
  const unlimitedDisplay = await (await fetch(`${base}/api/selfie/display/${replacement.id}/submissions`, {
    headers: { 'X-Selfie-Display-Token': replacement.displayToken },
  })).json()
  assert.deepEqual(unlimitedDisplay.submissions, [], 'uploads beyond the old cap must still require approval')
  await fetch(`${historyUrl}/${replacement.id}/pause`, {
    method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: true }),
  })
  assert.equal((await upload(replacement.joinToken)).status, 423)
  assert.equal((await fetch(`${historyUrl}/${replacement.id}/close`, { method: 'POST', headers: adminHeaders })).status, 204)
  assert.equal((await upload(replacement.joinToken)).status, 404)
})
