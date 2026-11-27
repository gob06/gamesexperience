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
  const setupTheme = await request('/api/theme?kind=login', '')
  assert.equal(setupTheme.status, 200)
  assert.equal((await setupTheme.json()).config.eventTitle, (await (await request('/api/theme', '')).json()).config.eventTitle)
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
  qaForm.append('ticketLabel', 'Badge ID')
  qaForm.append('nameLabel', ' Participant name ')
  qaForm.append('options', JSON.stringify([{ label: 'Yes', imageIndex: null, isCorrect: true }, { label: 'No', imageIndex: null }]))
  const qa = await (await request('/api/polls', hostCookie, { method: 'POST', body: qaForm })).json()
  const selfie = await (await request('/api/selfie/sessions', hostCookie, { method: 'POST', headers: json(), body: '{}' })).json()
  assert.ok(raffle.id && scramble.id && poll.id && qa.id && selfie.id)
  assert.equal(qa.ticketLabel, 'Badge ID')
  assert.equal(qa.nameLabel, 'Participant name')
  assert.equal(raffle.nameLabel, null)
  assert.equal(scramble.nameLabel, null)
  assert.equal(poll.nameLabel, null)
  const invalidQa = new FormData()
  invalidQa.append('question', 'Invalid question?')
  invalidQa.append('isQa', 'true')
  invalidQa.append('nameLabel', 'x'.repeat(41))
  invalidQa.append('options', JSON.stringify([{ label: 'Yes', imageIndex: null, isCorrect: true }, { label: 'No', imageIndex: null }]))
  assert.equal((await request('/api/polls', hostCookie, { method: 'POST', body: invalidQa })).status, 400)
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
  const publicQa = await (await request(`/api/polls/${qa.id}`, '')).json()
  assert.equal(publicQa.ticketLabel, 'Badge ID')
  assert.equal(publicQa.nameLabel, 'Participant name')
  assert.equal((await request(`/api/polls/${qa.id}`, adminCookie, { method: 'PATCH', headers: json(), body: JSON.stringify({ nameLabel: 'Other name' }) })).status, 404)
  assert.equal((await request(`/api/polls/${qa.id}`, hostCookie, { method: 'PATCH', headers: json(), body: JSON.stringify({ nameLabel: 'x'.repeat(41) }) })).status, 400)
  assert.equal((await request(`/api/polls/${qa.id}`, hostCookie, { method: 'PATCH', headers: json(), body: JSON.stringify({ nameLabel: null }) })).status, 400)
  assert.equal((await request(`/api/polls/${qa.id}`, hostCookie, { method: 'PATCH', headers: json(), body: JSON.stringify({ nameLabel: ' Attendee name ' }) })).status, 200)
  assert.equal((await (await request(`/api/polls/${qa.id}`, '')).json()).nameLabel, 'Attendee name')
  assert.equal((await request(`/api/polls/${qa.id}`, hostCookie, { method: 'PATCH', headers: json(), body: JSON.stringify({ nameLabel: ' ' }) })).status, 200)
  assert.equal((await (await request(`/api/polls/${qa.id}`, '')).json()).nameLabel, null)
  assert.equal((await (await request(`/api/polls/${qa.id}/monitor`, hostCookie)).json()).poll.ticketLabel, 'Badge ID')
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
  const raffleBgForm = new FormData()
  raffleBgForm.append('image', new Blob([image], { type: 'image/png' }), 'raffle-bg.png')
  const raffleBgUpload = await request('/api/admin/theme/assets', hostCookie, { method: 'POST', body: raffleBgForm })
  assert.equal(raffleBgUpload.status, 201)
  const raffleBgImage = (await raffleBgUpload.json()).asset
  const scrambleBgForm = new FormData()
  scrambleBgForm.append('image', new Blob([image], { type: 'image/png' }), 'scramble-bg.png')
  const scrambleBgUpload = await request('/api/admin/theme/assets', hostCookie, { method: 'POST', body: scrambleBgForm })
  assert.equal(scrambleBgUpload.status, 201)
  const scrambleBgImage = (await scrambleBgUpload.json()).asset
  const uploadThemeImg = async (name) => {
    const form = new FormData()
    form.append('image', new Blob([image], { type: 'image/png' }), name)
    const up = await request('/api/admin/theme/assets', hostCookie, { method: 'POST', body: form })
    assert.equal(up.status, 201, name)
    return (await up.json()).asset
  }
  const guestRegBgImage = await uploadThemeImg('guest-reg.png')
  const qaBgImage = await uploadThemeImg('qa-bg.png')
  const selfieSubBgImage = await uploadThemeImg('selfie-sub.png')
  const selfieDisplayBgImage = await uploadThemeImg('selfie-display.png')
  const gameBgImage = await uploadThemeImg('game-bg.png')

  const theme = await (await request('/api/admin/theme', hostCookie)).json()
  theme.draft.eventTitle = 'Host appearance'
  theme.draft.assets.logo = themeImage.id
  theme.draft.assets.guestRegistrationBackground = guestRegBgImage.id
  theme.draft.assets.qaDisplayBackground = qaBgImage.id
  theme.draft.assets.raffleDisplayBackground = raffleBgImage.id
  theme.draft.assets.scrambleDisplayBackground = scrambleBgImage.id
  theme.draft.assets.selfieSubmissionBackground = selfieSubBgImage.id
  theme.draft.assets.selfieDisplayBackground = selfieDisplayBgImage.id
  theme.draft.assets.gameDisplayBackground = gameBgImage.id
  theme.draft.displays = {
    poll: { customized: true, skin: 'classic', colors: { ...theme.draft.colors, primary: '#123456' }, background: { ...theme.draft.background, borderRadius: 16 } },
    qa: { customized: true, skin: 'broadcast', colors: { ...theme.draft.colors, accent: '#654321' }, background: { ...theme.draft.background, overlay: 0.45 } },
    raffle: { customized: true, skin: 'inherit', colors: { ...theme.draft.colors, primary: '#abcdef' }, background: { ...theme.draft.background, borderRadius: 20 } },
    scramble: { customized: true, skin: 'classic', colors: { ...theme.draft.colors, secondary: '#fedcba' }, background: { ...theme.draft.background, glow: 0.8 } },
    selfie: { customized: true, skin: 'broadcast', colors: { ...theme.draft.colors, text: '#ffffff' }, background: { ...theme.draft.background, borderRadius: 14 } },
    game: { customized: true, skin: 'classic', colors: { ...theme.draft.colors, primary: '#00ffaa' }, background: { ...theme.draft.background, borderRadius: 12 } },
  }
  theme.draft.displays.raffle.box = { color: '#AABBCC', opacity: 0 }
  theme.draft.displays.scramble.box = { color: '#102030', opacity: 0.53 }
  theme.draft.displays.selfie.box = { color: '#506070', opacity: 1 }

  // Invalid per-display override payload is rejected with 400.
  assert.equal((await request('/api/admin/theme/draft', hostCookie, {
    method: 'PUT',
    headers: json(),
    body: JSON.stringify({ ...theme.draft, displays: { ...theme.draft.displays, qa: { ...theme.draft.displays.qa, colors: { ...theme.draft.displays.qa.colors, primary: 'not-a-color' } } } }),
  })).status, 400)
  for (const box of [
    { color: 'red', opacity: 0.5 }, { color: '#123456', opacity: -0.01 },
    { color: '#123456', opacity: 1.01 }, { color: '#123456', opacity: '0.5' }, [],
  ]) {
    assert.equal((await request('/api/admin/theme/draft', hostCookie, {
      method: 'PUT',
      headers: json(),
      body: JSON.stringify({ ...theme.draft, displays: { ...theme.draft.displays, raffle: { ...theme.draft.displays.raffle, box } } }),
    })).status, 400)
  }

  function makeFont(kind) {
    if (kind === 'woff2') { const b = Buffer.alloc(48); b.write('wOF2', 0, 'ascii'); return b }
    if (kind === 'woff') { const b = Buffer.alloc(44); b.write('wOFF', 0, 'ascii'); return b }
    if (kind === 'ttf') { const b = Buffer.alloc(28); b.set([0x00, 0x01, 0x00, 0x00, 0x00, 0x01], 0); return b }
    if (kind === 'otf') { const b = Buffer.alloc(28); b.write('OTTO', 0, 'ascii'); b.writeUInt16BE(1, 4); return b }
    if (kind === 'ttc') { const b = Buffer.alloc(20); b.write('ttcf', 0, 'ascii'); b.writeUInt32BE(0x00010000, 4); b.writeUInt32BE(1, 8); b.writeUInt32BE(16, 12); return b }
    const b = Buffer.alloc(82); b.writeUInt32LE(0x00020001, 8); b[34] = 0x4c; b[35] = 0x50; return b
  }

  const badFontForm = new FormData()
  badFontForm.append('font', new Blob([Buffer.from('<svg></svg>')], { type: 'image/svg+xml' }), 'bad.svg')
  assert.equal((await request('/api/admin/theme/fonts', hostCookie, { method: 'POST', body: badFontForm })).status, 400)

  const uploadedFonts = {}
  for (const [kind, fileName, expectedMime] of [
    ['woff2', 'BrandBody.woff2', 'font/woff2'],
    ['woff', 'LegacyBody.woff', 'font/woff'],
    ['ttf', 'EventSans.ttf', 'font/ttf'],
    ['otf', 'DisplaySerif.otf', 'font/otf'],
    ['ttc', 'FamilyPack.ttc', 'font/collection'],
    ['eot', 'OldIE.eot', 'application/vnd.ms-fontobject'],
  ]) {
    const fontForm = new FormData()
    fontForm.append('font', new Blob([makeFont(kind)]), fileName)
    const upload = await request('/api/admin/theme/fonts', hostCookie, { method: 'POST', body: fontForm })
    assert.equal(upload.status, 201, fileName)
    const { asset } = await upload.json()
    assert.equal(asset.mimeType, expectedMime)
    assert.equal(asset.assetKind, 'font')
    assert.equal(asset.originalName, fileName)
    uploadedFonts[kind] = asset
  }

  // Fonts stay private to the owning account until published and cannot be swapped into image slots.
  assert.equal((await request(`/api/admin/theme/assets/${uploadedFonts.woff2.id}`, adminCookie)).status, 404)
  assert.equal((await request(`/api/theme/assets/${uploadedFonts.woff2.id}`, '')).status, 404)
  assert.equal((await request('/api/admin/theme/draft', hostCookie, {
    method: 'PUT',
    headers: json(),
    body: JSON.stringify({ ...theme.draft, fonts: { bodyFont: themeImage.id, headingFont: null } }),
  })).status, 400)

  theme.draft.fonts = { bodyFont: uploadedFonts.woff2.id, headingFont: uploadedFonts.otf.id }
  assert.equal((await request('/api/admin/theme/draft', hostCookie, { method: 'PUT', headers: json(), body: JSON.stringify(theme.draft) })).status, 200)
  // Still private while only saved in draft:
  assert.equal((await request(`/api/theme/assets/${uploadedFonts.woff2.id}`, '')).status, 404)
  assert.equal((await (await request('/api/theme', hostCookie)).json()).config.fonts.bodyFont, null)
  assert.equal((await (await request('/api/theme', hostCookie)).json()).config.displays.qa.customized, false)
  assert.equal((await (await request('/api/theme', hostCookie)).json()).config.displays.raffle.box, null)

  assert.equal((await request('/api/admin/theme/publish', hostCookie, { method: 'POST' })).status, 200)
  const hostPublishedTheme = await (await request('/api/theme', hostCookie)).json()
  assert.equal(hostPublishedTheme.config.eventTitle, 'Host appearance')
  assert.equal(hostPublishedTheme.config.fonts.bodyFont, uploadedFonts.woff2.id)
  assert.equal(hostPublishedTheme.config.fonts.headingFont, uploadedFonts.otf.id)
  assert.equal(hostPublishedTheme.config.displays.poll.skin, 'classic')
  assert.equal(hostPublishedTheme.config.displays.poll.colors.primary, '#123456')
  assert.equal(hostPublishedTheme.config.displays.qa.colors.accent, '#654321')
  assert.equal(hostPublishedTheme.config.displays.game.colors.primary, '#00ffaa')
  assert.deepEqual(hostPublishedTheme.config.displays.raffle.box, { color: '#aabbcc', opacity: 0 })
  assert.deepEqual(hostPublishedTheme.config.displays.scramble.box, { color: '#102030', opacity: 0.53 })
  assert.deepEqual(hostPublishedTheme.config.displays.selfie.box, { color: '#506070', opacity: 1 })
  assert.equal(hostPublishedTheme.config.displays.poll.box, null)
  assert.equal(hostPublishedTheme.fontAssets.bodyFont.url, `/api/theme/assets/${uploadedFonts.woff2.id}`)
  assert.equal(hostPublishedTheme.fontAssets.bodyFont.format, 'woff2')
  assert.equal(hostPublishedTheme.fontAssets.headingFont.format, 'opentype')
  for (const bgAsset of [themeImage, guestRegBgImage, qaBgImage, raffleBgImage, scrambleBgImage, selfieSubBgImage, selfieDisplayBgImage, gameBgImage]) {
    assert.equal((await request(`/api/theme/assets/${bgAsset.id}`, '')).status, 200)
  }
  assert.equal((await request(`/api/theme/assets/${uploadedFonts.woff2.id}`, '')).status, 200)
  assert.equal((await request(`/api/theme/assets/${uploadedFonts.otf.id}`, '')).status, 200)
  assert.equal((await request(`/api/admin/theme/assets/${uploadedFonts.woff2.id}`, hostCookie, { method: 'DELETE' })).status, 409)
  assert.equal((await request(`/api/admin/theme/assets/${uploadedFonts.eot.id}`, hostCookie, { method: 'DELETE' })).status, 204)
  assert.notEqual((await (await request('/api/theme', superCookie)).json()).config.eventTitle, 'Host appearance')
  assert.equal((await (await request('/api/theme', superCookie)).json()).config.fonts.bodyFont, null)
  assert.equal((await (await request('/api/theme', adminCookie)).json()).config.fonts.bodyFont, null)
  assert.equal((await (await request('/api/theme', adminCookie)).json()).config.displays.raffle.box, null)
  const superImageForm = new FormData()
  superImageForm.append('image', new Blob([image], { type: 'image/png' }), 'login.png')
  const superUpload = await request('/api/admin/theme/assets', superCookie, { method: 'POST', body: superImageForm })
  assert.equal(superUpload.status, 201)
  const superImage = (await superUpload.json()).asset
  const superTheme = await (await request('/api/admin/theme', superCookie)).json()
  superTheme.draft.eventTitle = 'Login appearance'
  superTheme.draft.assets.logo = superImage.id
  assert.equal((await request('/api/admin/theme/draft', superCookie, { method: 'PUT', headers: json(), body: JSON.stringify(superTheme.draft) })).status, 200)
  assert.notEqual((await (await request('/api/theme?kind=login', '')).json()).config.eventTitle, 'Login appearance')
  assert.equal((await request(`/api/theme/assets/${superImage.id}`, '')).status, 404)
  assert.equal((await request('/api/admin/theme/publish', superCookie, { method: 'POST' })).status, 200)
  for (const cookie of ['', hostCookie]) {
    const loginTheme = await request('/api/theme?kind=login', cookie)
    assert.equal(loginTheme.headers.get('cache-control'), 'no-store')
    const loginAppearance = await loginTheme.json()
    assert.equal(loginAppearance.config.eventTitle, 'Login appearance')
    assert.equal(loginAppearance.assetUrls.logo, `/api/theme/assets/${superImage.id}`)
    assert.equal(loginAppearance.config.fonts.bodyFont, null)
  }
  assert.equal((await request(`/api/theme/assets/${superImage.id}`, '')).status, 200)
  assert.notEqual((await (await request('/api/theme', '')).json()).config.eventTitle, 'Login appearance')
  assert.equal((await (await request('/api/theme', hostCookie)).json()).config.eventTitle, 'Host appearance')
  assert.equal((await request('/api/theme?kind=login&id=unexpected', '')).status, 400)
  for (const [kind, id] of [['poll', poll.id], ['raffle', raffle.id], ['scramble', scramble.id], ['selfie-join', selfie.joinToken]]) {
    const resolvedTheme = await (await request(`/api/theme?kind=${kind}&id=${id}`, '')).json()
    assert.equal(resolvedTheme.config.eventTitle, 'Host appearance')
    assert.equal(resolvedTheme.assetUrls.guestRegistrationBackground, `/api/theme/assets/${guestRegBgImage.id}`)
    assert.equal(resolvedTheme.assetUrls.qaDisplayBackground, `/api/theme/assets/${qaBgImage.id}`)
    assert.equal(resolvedTheme.assetUrls.raffleDisplayBackground, `/api/theme/assets/${raffleBgImage.id}`)
    assert.equal(resolvedTheme.assetUrls.scrambleDisplayBackground, `/api/theme/assets/${scrambleBgImage.id}`)
    assert.equal(resolvedTheme.assetUrls.selfieSubmissionBackground, `/api/theme/assets/${selfieSubBgImage.id}`)
    assert.equal(resolvedTheme.assetUrls.selfieDisplayBackground, `/api/theme/assets/${selfieDisplayBgImage.id}`)
    assert.equal(resolvedTheme.assetUrls.gameDisplayBackground, `/api/theme/assets/${gameBgImage.id}`)
    assert.equal(resolvedTheme.config.displays.selfie.customized, true)
    assert.deepEqual(resolvedTheme.config.displays.raffle.box, { color: '#aabbcc', opacity: 0 })
    assert.deepEqual(resolvedTheme.config.displays.scramble.box, { color: '#102030', opacity: 0.53 })
    assert.deepEqual(resolvedTheme.config.displays.selfie.box, { color: '#506070', opacity: 1 })
    assert.equal(resolvedTheme.fontAssets.bodyFont.url, `/api/theme/assets/${uploadedFonts.woff2.id}`)
    assert.equal(resolvedTheme.fontAssets.headingFont.url, `/api/theme/assets/${uploadedFonts.otf.id}`)
  }
  assert.equal((await request(`/api/theme?kind=selfie-display&id=${selfie.id}`, '')).status, 404)
  const selfieDisplayTheme = await (await request(`/api/theme?kind=selfie-display&id=${selfie.id}`, '', { headers: { 'X-Selfie-Display-Token': selfie.displayToken } })).json()
  assert.equal(selfieDisplayTheme.config.eventTitle, 'Host appearance')
  assert.deepEqual(selfieDisplayTheme.config.displays.selfie.box, { color: '#506070', opacity: 1 })

  // Game room theme resolution via ?kind=game&id=<roomId> isolates to the room owner's account.
  const adminGame = await (await request('/api/games', adminCookie, { method: 'POST', headers: json(), body: JSON.stringify({ roomName: 'Admin Arena', playerName: 'Admin' }) })).json()
  assert.ok(adminGame.id)
  const adminGameBgForm = new FormData()
  adminGameBgForm.append('image', new Blob([image], { type: 'image/png' }), 'admin-game-bg.png')
  const adminGameBgAsset = (await (await request('/api/admin/theme/assets', adminCookie, { method: 'POST', body: adminGameBgForm })).json()).asset
  const adminThemeData = await (await request('/api/admin/theme', adminCookie)).json()
  adminThemeData.draft.eventTitle = 'Admin Game Theme'
  adminThemeData.draft.assets.gameDisplayBackground = adminGameBgAsset.id
  adminThemeData.draft.displays.game = { customized: true, skin: 'classic', colors: { ...adminThemeData.draft.colors, primary: '#ff3366' }, background: { ...adminThemeData.draft.background, borderRadius: 22 } }
  assert.equal((await request('/api/admin/theme/draft', adminCookie, { method: 'PUT', headers: json(), body: JSON.stringify(adminThemeData.draft) })).status, 200)
  assert.equal((await request('/api/admin/theme/publish', adminCookie, { method: 'POST' })).status, 200)
  const resolvedGameTheme = await (await request(`/api/theme?kind=game&id=${adminGame.id}`, '')).json()
  assert.equal(resolvedGameTheme.config.eventTitle, 'Admin Game Theme')
  assert.equal(resolvedGameTheme.assetUrls.gameDisplayBackground, `/api/theme/assets/${adminGameBgAsset.id}`)
  assert.equal(resolvedGameTheme.config.displays.game.colors.primary, '#ff3366')

  function makeMp4(tag) {
    const body = Buffer.from(tag, 'ascii')
    const buf = Buffer.alloc(16 + body.length)
    buf.writeUInt32BE(buf.length, 0)
    buf.write('ftypisom', 4, 'ascii')
    body.copy(buf, 16)
    return buf
  }
  const hostPollBytes = makeMp4('HOST_POLL_VIDEO')
  const hostQaBytes = makeMp4('HOST_QA_VIDEO')
  const hostRaffleBytes = makeMp4('HOST_RAFFLE_VIDEO')
  const hostScrambleBytes = makeMp4('HOST_SCRAMBLE_VIDEO')
  const hostSelfieBytes = makeMp4('HOST_SELFIE_VIDEO')
  const adminPollBytes = makeMp4('ADMIN_POLL_VIDEO')

  for (const [kind, bytes] of [
    ['poll', hostPollBytes],
    ['qa', hostQaBytes],
    ['raffle', hostRaffleBytes],
    ['scramble', hostScrambleBytes],
    ['selfie', hostSelfieBytes],
  ]) {
    const videoForm = new FormData()
    videoForm.append('video', new Blob([bytes], { type: 'video/mp4' }), `${kind}.mp4`)
    const upload = await request(`/api/admin/ad-videos/${kind}`, hostCookie, { method: 'PUT', body: videoForm })
    assert.equal(upload.status, 200, kind)
    const summary = await upload.json()
    assert.equal(summary.available, true)
    const preview = await request(summary.url, hostCookie)
    assert.equal(preview.status, 200)
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), bytes)
  }

  // Other accounts do not see host's uploaded videos in their video manager or previews.
  const adminVideos = await (await request('/api/admin/ad-videos', adminCookie)).json()
  assert.equal(adminVideos.poll.available, false)
  assert.equal(adminVideos.qa.available, false)
  assert.equal((await request('/api/admin/ad-videos/poll/file', adminCookie)).status, 404)
  assert.equal((await request('/api/admin/ad-videos/poll/file', superCookie)).status, 404)

  // Another admin creates their own poll, Q&A, and raffle, and uploads their own poll video only.
  const adminPollForm = new FormData()
  adminPollForm.append('question', 'Admin poll?')
  adminPollForm.append('options', JSON.stringify(['A', 'B']))
  const adminPoll = await (await request('/api/polls', adminCookie, { method: 'POST', body: adminPollForm })).json()
  const adminQaForm = new FormData()
  adminQaForm.append('question', 'Admin Q&A?')
  adminQaForm.append('isQa', 'true')
  adminQaForm.append('options', JSON.stringify([{ label: 'One', imageIndex: null, isCorrect: true }, { label: 'Two', imageIndex: null }]))
  const adminQa = await (await request('/api/polls', adminCookie, { method: 'POST', body: adminQaForm })).json()
  const adminRaffleForm = new FormData()
  adminRaffleForm.append('title', 'Admin raffle')
  const adminRaffle = await (await request('/api/raffles', adminCookie, { method: 'POST', body: adminRaffleForm })).json()

  const adminVideoForm = new FormData()
  adminVideoForm.append('video', new Blob([adminPollBytes], { type: 'video/mp4' }), 'admin-poll.mp4')
  assert.equal((await request('/api/admin/ad-videos/poll', adminCookie, { method: 'PUT', body: adminVideoForm })).status, 200)

  // Audience playback resolves strictly to the activity owner's account video.
  for (const [kind, id, expectedBytes] of [
    ['poll', poll.id, hostPollBytes],
    ['raffle', raffle.id, hostRaffleBytes],
    ['scramble', scramble.id, hostScrambleBytes],
    ['selfie', selfie.joinToken, hostSelfieBytes],
    ['poll', adminPoll.id, adminPollBytes],
    ['raffle', adminRaffle.id, adminPollBytes],
  ]) {
    const meta = await request(`/api/ad-videos/${kind}?id=${encodeURIComponent(id)}`, '')
    assert.equal(meta.status, 200, `${kind}:${id}`)
    const info = await meta.json()
    assert.equal(info.available, true, `${kind}:${id}`)
    const fileResponse = await request(info.url, '')
    assert.equal(fileResponse.status, 200, info.url)
    assert.deepEqual(Buffer.from(await fileResponse.arrayBuffer()), expectedBytes)
  }

  // Account without a video (or unauthenticated caller with no activity id) gets no ad video.
  assert.equal((await (await request(`/api/ad-videos/qa?id=${adminQa.id}`, '')).json()).available, false)
  assert.equal((await request(`/api/ad-videos/qa/file?id=${adminQa.id}`, '')).status, 404)
  assert.equal((await (await request('/api/ad-videos/poll', '')).json()).available, false)
  assert.equal((await request('/api/ad-videos/poll/file', '')).status, 404)
  assert.equal((await request('/api/ad-videos/poll?id=missing-poll', '')).status, 404)

  // Q&A ad enforcement uses the Q&A poll owner's account video.
  const hostQaSession = await request(`/api/polls/${qa.id}/session`, '', { method: 'POST' })
  assert.equal(hostQaSession.status, 200)
  const hostQaCookie = hostQaSession.headers.get('set-cookie').split(';')[0]
  assert.equal((await request(`/api/polls/${qa.id}/register`, hostQaCookie, { method: 'POST', headers: json(), body: JSON.stringify({ fullName: 'Ada Lovelace', ticketNumber: 'A1' }) })).status, 200)
  assert.equal((await request(`/api/polls/${qa.id}/votes`, hostQaCookie, { method: 'POST', headers: json(), body: JSON.stringify({ optionId: (await (await request(`/api/polls/${qa.id}`, '')).json()).options[0].id }) })).status, 201)
  const hostQaAdStart = await (await request(`/api/polls/${qa.id}/ad/start`, hostQaCookie, { method: 'POST', headers: json(), body: '{}' })).json()
  assert.equal(hostQaAdStart.required, true)
  const hostQaAdFile = await request(hostQaAdStart.url, '')
  assert.equal(hostQaAdFile.status, 200)
  assert.deepEqual(Buffer.from(await hostQaAdFile.arrayBuffer()), hostQaBytes)

  const adminQaSession = await request(`/api/polls/${adminQa.id}/session`, '', { method: 'POST' })
  assert.equal(adminQaSession.status, 200)
  const adminQaCookie = adminQaSession.headers.get('set-cookie').split(';')[0]
  assert.equal((await request(`/api/polls/${adminQa.id}/register`, adminQaCookie, { method: 'POST', headers: json(), body: JSON.stringify({ fullName: 'Grace Hopper', ticketNumber: 'B1' }) })).status, 200)
  const adminQaVote = await (await request(`/api/polls/${adminQa.id}/votes`, adminQaCookie, { method: 'POST', headers: json(), body: JSON.stringify({ optionId: (await (await request(`/api/polls/${adminQa.id}`, '')).json()).options[0].id }) })).json()
  assert.equal(adminQaVote.adRequired, false)
  const adminQaAdStart = await (await request(`/api/polls/${adminQa.id}/ad/start`, adminQaCookie, { method: 'POST', headers: json(), body: '{}' })).json()
  assert.equal(adminQaAdStart.required, false)

  // Deleting host's poll video removes only host's video and leaves admin's intact.
  assert.equal((await request('/api/admin/ad-videos/poll', hostCookie, { method: 'DELETE' })).status, 204)
  assert.equal((await (await request(`/api/ad-videos/poll?id=${poll.id}`, '')).json()).available, false)
  assert.equal((await (await request(`/api/ad-videos/poll?id=${adminPoll.id}`, '')).json()).available, true)
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
  await database.prepare('INSERT INTO ad_videos (kind, file_name, original_name, mime_type, size, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('poll', 'legacy-poll.mp4', 'legacy-poll.mp4', 'video/mp4', 128, '2020-01-01')
  await database.prepare('INSERT INTO raffle_ad_videos (kind, file_name, original_name, mime_type, size, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('raffle', 'legacy-raffle.mp4', 'legacy-raffle.mp4', 'video/mp4', 256, '2020-01-01')
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
  assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM account_ad_videos WHERE user_id = ?').get('first')).count, 2)
  assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM account_ad_videos WHERE user_id = ?').get('host')).count, 0)
  const exited = once(server, 'exit')
  server.kill()
  await exited
  await start()
  assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM account_logo_bank').get()).count, 1)
  assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM account_theme_settings').get()).count, 3)
  assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM account_ad_videos').get()).count, 2)
})
