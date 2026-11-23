import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('announcing winners reveals the answer together with only announced winners', { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'roomvote-scramble-test-'))
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
  server.stdout.on('data', (chunk) => { logs += chunk })
  server.stderr.on('data', (chunk) => { logs += chunk })
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, 'exit')
      server.kill()
      await exited
    }
    await rm(directory, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${port}`
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) assert.fail(`Test server exited: ${logs}`)
    try {
      if ((await fetch(`${base}/api/auth/status`)).ok) { ready = true; break }
    } catch (error) {
      if (attempt === 99) throw new Error(`Test server did not start: ${logs}`, { cause: error })
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(ready, `Test server did not become ready: ${logs}`)
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'scramble-admin', password: randomBytes(24).toString('hex') }),
  })
  assert.equal(setup.status, 201)
  const cookie = setup.headers.get('set-cookie').split(';')[0]
  const post = (url, body, authenticated = true) => fetch(`${base}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body || {}),
  })
  const form = new FormData()
  form.append('title', 'Word game')
  form.append('answer', 'APPLE')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAX8AAAAASUVORK5CYII=', 'base64')
  form.append('displayLogo', new Blob([png], { type: 'image/png' }), 'display.png')
  const created = await fetch(`${base}/api/scrambles`, { method: 'POST', headers: { Cookie: cookie }, body: form })
  assert.equal(created.status, 201)
  const game = await created.json()
  const url = `/api/scrambles/${game.id}`
  assert.equal(game.logoUrl, null)
  assert.equal(game.displayLogoUrl, `${url}/display-logo?version=1`)
  const logo = await fetch(`${base}${game.displayLogoUrl}`)
  assert.equal(logo.status, 200)
  assert.equal(logo.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await logo.arrayBuffer()), png)
  const display = async () => {
    const response = await fetch(`${base}${url}/display`)
    assert.equal(response.status, 200)
    return response.json()
  }
  const register = async (name, ticket) => {
    const response = await post(`${url}/register`, { participantName: name, ticketNumber: ticket }, false)
    assert.equal(response.status, 201)
    return response.json()
  }
  const first = await register('First Guest', '001')
  const second = await register('Second Guest', '002')
  assert.equal((await post(`${url}/status`, { action: 'start' })).status, 200)
  for (const entry of [first, second]) assert.equal((await post(`${url}/answer`, { entryId: entry.id, answer: 'apple' }, false)).status, 200)
  assert.equal((await post(`${url}/reveal`)).status, 409)
  assert.equal((await post(`${url}/winners/announce-all`)).status, 409)
  assert.equal((await display()).game.revealedAnswer, null)
  assert.equal((await post(`${url}/status`, { action: 'close' })).status, 200)
  assert.equal((await post(`${url}/winners/randomize`, { count: 2 })).status, 200)
  assert.equal((await post(`${url}/winners/confirm`)).status, 200)
  const before = await display()
  assert.equal(before.game.displayLogoUrl, game.displayLogoUrl)
  assert.equal(before.game.revealedAnswer, null)
  assert.deepEqual(before.announcedWinners, [])
  assert.equal((await post(`${url}/winners/${first.id}/announce`, {}, false)).status, 401)
  assert.equal((await post(`${url}/winners/${first.id}/announce`)).status, 200)
  const one = await display()
  assert.equal(one.game.revealedAnswer, 'APPLE')
  assert.deepEqual(one.announcedWinners.map((winner) => winner.id), [first.id])
  assert.equal((await (await fetch(`${base}${url}`)).json()).revealedAnswer, 'APPLE')
  assert.equal((await post(`${url}/winners/announce-all`)).status, 200)
  const both = await display()
  assert.equal(both.game.revealedAnswer, 'APPLE')
  assert.deepEqual(new Set(both.announcedWinners.map((winner) => winner.id)), new Set([first.id, second.id]))
  assert.equal((await post(`${url}/status`, { action: 'complete' })).status, 200)
  assert.equal((await display()).game.revealedAnswer, 'APPLE')
  assert.equal((await post(`${url}/reset`)).status, 200)
  const reset = await display()
  assert.equal(reset.game.revealedAnswer, null)
  assert.deepEqual(reset.announcedWinners, [])

  const third = await register('Third Guest', '003')
  assert.equal((await post(`${url}/status`, { action: 'start' })).status, 200)
  assert.equal((await post(`${url}/answer`, { entryId: third.id, answer: 'apple' }, false)).status, 200)
  assert.equal((await post(`${url}/status`, { action: 'close' })).status, 200)
  assert.equal((await post(`${url}/winners/randomize`, { count: 1 })).status, 200)
  assert.equal((await post(`${url}/winners/confirm`)).status, 200)
  assert.equal((await post(`${url}/winners/announce-all`)).status, 200)
  const allFirst = await display()
  assert.equal(allFirst.game.revealedAnswer, 'APPLE')
  assert.deepEqual(allFirst.announcedWinners.map((winner) => winner.id), [third.id])
  const invalidForm = new FormData()
  invalidForm.append('title', 'Invalid logo')
  invalidForm.append('answer', 'APPLE')
  invalidForm.append('displayLogo', new Blob(['not an image'], { type: 'image/png' }), 'invalid.png')
  assert.equal((await fetch(`${base}/api/scrambles`, { method: 'POST', headers: { Cookie: cookie }, body: invalidForm })).status, 400)
  const noLogo = new FormData()
  noLogo.append('title', 'No logo')
  noLogo.append('answer', 'APPLE')
  const legacy = await fetch(`${base}/api/scrambles`, { method: 'POST', headers: { Cookie: cookie }, body: noLogo })
  assert.equal(legacy.status, 201)
  assert.equal((await legacy.json()).displayLogoUrl, null)
})
