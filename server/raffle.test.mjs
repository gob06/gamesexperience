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
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from './db.mjs'

test('existing raffle tables gain idempotent multi-winner columns without losing tickets', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'roomvote-raffle-migration-'))
  const filename = path.join(directory, 'test.sqlite')
  const legacy = new DatabaseSync(filename)
  legacy.exec(`
    CREATE TABLE raffle_sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, logo_mime_type TEXT, logo BLOB,
      draw_status TEXT NOT NULL DEFAULT 'idle', created_by TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE raffle_entries (
      id TEXT PRIMARY KEY, raffle_id TEXT NOT NULL, participant_name TEXT NOT NULL,
      ticket_number TEXT NOT NULL, ticket_key TEXT NOT NULL,
      registered_at TEXT NOT NULL, won_at TEXT
    );
    INSERT INTO raffle_sessions VALUES ('legacy', 'Legacy raffle', NULL, NULL, 'idle', 'host', '2026-01-01', '2026-01-01');
    INSERT INTO raffle_entries VALUES ('ticket', 'legacy', 'Legacy Guest', '001', '001', '2026-01-01', '2026-01-01');
  `)
  legacy.close()
  const database = await createDatabase({ driver: 'sqlite', filename })
  t.after(async () => {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  })
  await database.initializeSchema()
  await database.initializeSchema()
  const raffle = await database.prepare('SELECT draw_winner_count AS count FROM raffle_sessions WHERE id = ?').get('legacy')
  assert.equal(raffle.count, 1)
  const entry = await database.prepare('SELECT ticket_number AS ticket, won_at AS wonAt, draw_id AS drawId FROM raffle_entries WHERE id = ?').get('ticket')
  assert.equal(entry.ticket, '001')
  assert.equal(entry.wonAt, '2026-01-01')
  assert.equal(entry.drawId, null)
})

test('raffle draws persist the requested number of distinct winners and expose the latest batch', { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'roomvote-raffle-test-'))
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
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'raffle-admin', password: randomBytes(24).toString('hex') }),
  })
  assert.equal(setup.status, 201)
  const cookie = setup.headers.get('set-cookie').split(';')[0]
  async function post(url, body, authenticated = true) {
    return fetch(`${base}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
  const form = new FormData()
  form.append('title', 'Multi-winner raffle')
  const created = await fetch(`${base}/api/raffles`, { method: 'POST', headers: { Cookie: cookie }, body: form })
  assert.equal(created.status, 201)
  const raffle = await created.json()
  assert.equal(raffle.drawWinnerCount, 1)
  const url = `/api/raffles/${raffle.id}`
  const display = async () => {
    const response = await fetch(`${base}${url}/display`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    return response.json()
  }
  const host = async () => (await fetch(`${base}${url}/host`, { headers: { Cookie: cookie } })).json()
  assert.deepEqual((await display()).latestWinners, [])
  for (let index = 1; index <= 6; index++) {
    assert.equal((await post(`${url}/register`, { participantName: `Guest ${index}`, ticketNumber: `T-${index}` }, false)).status, 201)
  }
  assert.equal((await post(`${url}/draw/start`, { winnerCount: 2 }, false)).status, 401)
  assert.equal((await post(`${url}/draw/stop`, undefined, false)).status, 401)
  assert.equal((await post(`${url}/draw/stop`)).status, 409)
  for (const winnerCount of [0, -1, 1.5, '2', null, true, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await post(`${url}/draw/start`, { winnerCount })).status, 400)
  }
  assert.equal((await post(`${url}/draw/start`, { winnerCount: 7 })).status, 409)
  assert.equal((await host()).raffle.drawStatus, 'idle')
  const start = await post(`${url}/draw/start`, { winnerCount: 3 })
  assert.equal(start.status, 200)
  assert.equal((await start.json()).drawWinnerCount, 3)
  assert.equal((await host()).raffle.drawWinnerCount, 3)
  assert.equal((await display()).eligible.length, 6)
  assert.equal((await post(`${url}/draw/start`, { winnerCount: 1 })).status, 409)
  assert.equal((await post(`${url}/register`, { participantName: 'Late Guest', ticketNumber: 'late' }, false)).status, 423)
  // STOP must use the persisted count, not a count supplied by another host.
  const stop = await post(`${url}/draw/stop`, { winnerCount: 1 })
  assert.equal(stop.status, 200)
  const firstDraw = await stop.json()
  assert.equal(firstDraw.winners.length, 3)
  assert.equal(new Set(firstDraw.winners.map((entry) => entry.id)).size, 3)
  assert.equal(new Set(firstDraw.winners.map((entry) => entry.drawId)).size, 1)
  assert.equal(firstDraw.winner.id, firstDraw.winners[0].id)
  const ids = (entries) => entries.map((entry) => entry.id).sort()
  assert.deepEqual(ids((await display()).latestWinners), ids(firstDraw.winners))
  assert.deepEqual(ids((await display()).latestWinners), ids(firstDraw.winners))
  assert.deepEqual(ids((await host()).latestWinners), ids(firstDraw.winners))
  assert.equal((await display()).counts.winnerCount, 3)
  assert.equal((await post(`${url}/draw/stop`)).status, 409)
  assert.equal((await post(`${url}/draw/start`, { winnerCount: 4 })).status, 409)
  // Existing clients that omit the count still draw one winner.
  assert.equal((await post(`${url}/draw/start`)).status, 200)
  assert.equal((await host()).raffle.drawWinnerCount, 1)
  const secondDraw = await (await post(`${url}/draw/stop`)).json()
  assert.equal(secondDraw.winners.length, 1)
  assert.ok(!ids(firstDraw.winners).includes(secondDraw.winners[0].id))
  assert.deepEqual(ids((await display()).latestWinners), ids(secondDraw.winners))
  // Hosts and admins can both select all remaining eligible tickets.
  database = new DatabaseSync(filename)
  database.prepare("UPDATE users SET role = 'host' WHERE username = ?").run('raffle-admin')
  assert.equal((await post(`${url}/draw/start`, { winnerCount: 2 })).status, 200)
  const finalDraw = await (await post(`${url}/draw/stop`)).json()
  assert.equal(finalDraw.winners.length, 2)
  assert.equal(new Set([...firstDraw.winners, ...secondDraw.winners, ...finalDraw.winners].map((entry) => entry.id)).size, 6)
  assert.equal((await host()).eligible.length, 0)
  assert.equal((await host()).winners.length, 6)
  assert.deepEqual(ids((await display()).latestWinners), ids(finalDraw.winners))
  assert.equal((await post(`${url}/draw/start`)).status, 409)
  // Historic single-winner rows with no draw ID remain visible.
  database.prepare('UPDATE raffle_entries SET won_at = NULL, draw_id = NULL WHERE raffle_id = ?').run(raffle.id)
  database.prepare('UPDATE raffle_entries SET won_at = ? WHERE id = ?').run(new Date().toISOString(), firstDraw.winner.id)
  assert.deepEqual(ids((await display()).latestWinners), [firstDraw.winner.id])
  assert.deepEqual(ids((await host()).latestWinners), [firstDraw.winner.id])
  // A failure midway through a batch must roll back every winner in that batch.
  assert.equal((await post(`${url}/draw/start`, { winnerCount: 2 })).status, 200)
  database.exec(`
    CREATE TRIGGER reject_second_winner BEFORE UPDATE OF won_at ON raffle_entries
    WHEN NEW.draw_id IS NOT NULL AND (SELECT COUNT(*) FROM raffle_entries WHERE draw_id = NEW.draw_id) > 0
    BEGIN SELECT RAISE(ABORT, 'Simulated winner update failure'); END;
  `)
  const failedBatch = await post(`${url}/draw/stop`)
  assert.equal(failedBatch.status, 400)
  assert.match((await failedBatch.json()).error, /Simulated winner update failure/)
  assert.equal((await host()).winners.length, 1)
  assert.equal((await host()).raffle.drawStatus, 'drawing')
  database.exec('DROP TRIGGER reject_second_winner')
  const retry = await post(`${url}/draw/stop`)
  assert.equal(retry.status, 200)
  assert.equal((await retry.json()).winners.length, 2)
})
