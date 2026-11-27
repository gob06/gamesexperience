import { randomInt, randomUUID } from 'node:crypto'
import { rateLimit } from './rate-limit.mjs'
import { isDuplicateKeyError } from './db.mjs'

const participantNamePattern = /^[\p{L}\p{M}][\p{L}\p{M}\p{N} .,'’-]{1,79}$/u
const ticketNumberPattern = /^[\p{L}\p{N}][\p{L}\p{N} _\-/]{0,39}$/u
const duplicateTicketMessage = 'This ticket number has already been registered. Duplicate entries are not allowed.'
const registrationLimit = rateLimit({ windowMs: 60_000, max: Number(process.env.RAFFLE_REGISTRATION_LIMIT_PER_MINUTE || 60) })

const selectRaffle = database => database.prepare(`
  SELECT id, title, ticket_label AS ticketLabel, draw_status AS drawStatus, draw_winner_count AS drawWinnerCount, reset_version AS resetVersion, created_at AS createdAt,
    CASE WHEN logo IS NULL THEN NULL ELSE CONCAT('/api/raffles/', id, '/logo?version=2') END AS logoUrl,
    CASE WHEN display_image_1 IS NULL THEN NULL ELSE CONCAT('/api/raffles/', id, '/display-image/1?version=1') END AS displayImage1Url,
    CASE WHEN display_image_2 IS NULL THEN NULL ELSE CONCAT('/api/raffles/', id, '/display-image/2?version=1') END AS displayImage2Url
  FROM raffle_sessions
  WHERE id = ?
`)

function ticketKey(ticketNumber) {
  return ticketNumber.normalize('NFKC').replace(/\s+/g, '').toUpperCase()
}

function latestDrawWinners(winners) {
  const latest = winners[0]
  if (!latest) return []
  return latest.drawId ? winners.filter((entry) => entry.drawId === latest.drawId) : [latest]
}

export function registerRaffleRoutes({ app, database, requireUser, imageUpload, hasValidImageSignature, inTransaction, audit }) {
  const getRaffle = selectRaffle(database)
  async function requireOwner(request, response, next) {
    const row = await database.prepare('SELECT created_by AS ownerId FROM raffle_sessions WHERE id = ?').get(request.params.id)
    if (!row || (row.ownerId !== request.user.id && !request.user.isSuperAdmin)) return response.status(404).json({ error: 'This raffle could not be found.' })
    next()
  }

  app.get('/api/raffles', requireUser, async (request, response) => {
    const raffles = await database.prepare(`
      SELECT raffle_sessions.id, raffle_sessions.title,
        raffle_sessions.ticket_label AS ticketLabel,
        raffle_sessions.draw_status AS drawStatus,
        raffle_sessions.draw_winner_count AS drawWinnerCount,
        raffle_sessions.reset_version AS resetVersion,
        raffle_sessions.created_at AS createdAt,
        CASE WHEN raffle_sessions.logo IS NULL THEN NULL ELSE CONCAT('/api/raffles/', raffle_sessions.id, '/logo?version=2') END AS logoUrl,
        (SELECT COUNT(*) FROM raffle_entries WHERE raffle_id = raffle_sessions.id) AS entryCount,
        (SELECT COUNT(*) FROM raffle_entries WHERE raffle_id = raffle_sessions.id AND won_at IS NOT NULL) AS winnerCount
      FROM raffle_sessions
      WHERE raffle_sessions.created_by = ? OR ? = 1
      ORDER BY raffle_sessions.created_at DESC
    `).all(request.user.id, Number(request.user.isSuperAdmin))
    response.json(raffles)
  })

  const createUpload = imageUpload.fields([{ name: 'logo', maxCount: 1 }, { name: 'displayImage1', maxCount: 1 }, { name: 'displayImage2', maxCount: 1 }])

  app.post('/api/raffles', requireUser, createUpload, async (request, response) => {
    const title = typeof request.body.title === 'string' ? request.body.title.trim() : ''
    if (title.length < 3 || title.length > 120) return response.status(400).json({ error: 'Raffle title must be between 3 and 120 characters.' })
    const ticketLabel = typeof request.body.ticketLabel === 'string' ? request.body.ticketLabel.trim() : ''
    if (ticketLabel.length > 40) return response.status(400).json({ error: 'Ticket number label must be 40 characters or fewer.' })
    const logo = request.files?.logo?.[0]
    const displayImage1 = request.files?.displayImage1?.[0]
    const displayImage2 = request.files?.displayImage2?.[0]
    for (const [file, label] of [[logo, 'QR logo'], [displayImage1, 'Display image 1'], [displayImage2, 'Display image 2']]) {
      if (file && !hasValidImageSignature(file.mimetype, file.buffer)) {
        return response.status(400).json({ error: `${label} is not a valid JPEG, PNG, or WebP image.` })
      }
    }

    const raffle = { id: randomUUID(), title, createdAt: new Date().toISOString() }
    await database.prepare(`
      INSERT INTO raffle_sessions (id, title, ticket_label, logo_mime_type, logo, display_image_1_mime_type, display_image_1, display_image_2_mime_type, display_image_2, draw_status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?)
    `).run(
      raffle.id, title, ticketLabel || null,
      logo?.mimetype || null, logo?.buffer || null,
      displayImage1?.mimetype || null, displayImage1?.buffer || null,
      displayImage2?.mimetype || null, displayImage2?.buffer || null,
      request.user.id, raffle.createdAt, raffle.createdAt,
    )
    await audit(request, 'raffle.create', 'raffle', raffle.id, { title, ...(ticketLabel ? { ticketLabel } : {}) })
    response.status(201).json(await getRaffle.get(raffle.id))
  })

  app.delete('/api/raffles/:id', requireUser, requireOwner, async (request, response) => {
    const raffle = await getRaffle.get(request.params.id)
    if (!raffle) return response.status(404).json({ error: 'This raffle could not be found.' })
    await database.prepare('DELETE FROM raffle_sessions WHERE id = ?').run(raffle.id)
    await audit(request, 'raffle.delete', 'raffle', raffle.id, { title: raffle.title })
    response.status(204).end()
  })

  app.post('/api/raffles/:id/reset', requireUser, requireOwner, async (request, response) => {
    const reset = await inTransaction(async () => {
      const raffle = await getRaffle.get(request.params.id)
      if (!raffle) return null
      const deleted = await database.prepare('DELETE FROM raffle_entries WHERE raffle_id = ?').run(raffle.id)
      await database.prepare('UPDATE raffle_sessions SET draw_status = ?, draw_winner_count = ?, reset_version = ?, updated_at = ? WHERE id = ?')
        .run('idle', 1, randomUUID(), new Date().toISOString(), raffle.id)
      return { raffle: await getRaffle.get(raffle.id), deleted: deleted.changes }
    })
    if (!reset) return response.status(404).json({ error: 'This raffle could not be found.' })
    await audit(request, 'raffle.reset', 'raffle', request.params.id, { title: reset.raffle.title, deleted: reset.deleted })
    response.json(reset)
  })

  app.get('/api/raffles/:id/logo', async (request, response) => {
    const logo = await database.prepare('SELECT logo_mime_type AS mimeType, logo FROM raffle_sessions WHERE id = ?').get(request.params.id)
    if (!logo?.logo) return response.status(404).end()
    response.type(logo.mimeType).set('Cache-Control', 'no-store').send(Buffer.from(logo.logo))
  })

  app.get('/api/raffles/:id/display-image/:slot', async (request, response) => {
    const slot = request.params.slot
    if (slot !== '1' && slot !== '2') return response.status(404).end()
    const image = await database.prepare(`SELECT display_image_${slot}_mime_type AS mimeType, display_image_${slot} AS image FROM raffle_sessions WHERE id = ?`).get(request.params.id)
    if (!image?.image) return response.status(404).end()
    response.type(image.mimeType).set('Cache-Control', 'no-store').send(Buffer.from(image.image))
  })

  app.get('/api/raffles/:id', async (request, response) => {
    const raffle = await getRaffle.get(request.params.id)
    if (!raffle) return response.status(404).json({ error: 'This raffle could not be found.' })
    response.json({ ...raffle, registrationOpen: raffle.drawStatus !== 'drawing' })
  })

  app.get('/api/raffles/:id/display', async (request, response) => {
    const raffle = await getRaffle.get(request.params.id)
    if (!raffle) return response.status(404).json({ error: 'This raffle could not be found.' })
    const [counts, latestWinner] = await Promise.all([
      database.prepare(`
        SELECT COUNT(*) AS entryCount,
          SUM(CASE WHEN won_at IS NULL THEN 1 ELSE 0 END) AS eligibleCount,
          SUM(CASE WHEN won_at IS NOT NULL THEN 1 ELSE 0 END) AS winnerCount
        FROM raffle_entries WHERE raffle_id = ?
      `).get(raffle.id),
      database.prepare(`
        SELECT id, participant_name AS participantName, ticket_number AS ticketNumber, won_at AS wonAt, draw_id AS drawId
        FROM raffle_entries WHERE raffle_id = ? AND won_at IS NOT NULL
        ORDER BY won_at DESC, id LIMIT 1
      `).get(raffle.id),
    ])
    const latestWinners = latestWinner?.drawId
      ? await database.prepare(`
        SELECT id, participant_name AS participantName, ticket_number AS ticketNumber, won_at AS wonAt, draw_id AS drawId
        FROM raffle_entries WHERE raffle_id = ? AND draw_id = ? AND won_at IS NOT NULL
        ORDER BY id
      `).all(raffle.id, latestWinner.drawId)
      : latestWinner ? [latestWinner] : []
    const eligible = raffle.drawStatus === 'drawing'
      ? await database.prepare(`
        SELECT id, participant_name AS participantName, ticket_number AS ticketNumber
        FROM raffle_entries WHERE raffle_id = ? AND won_at IS NULL
        ORDER BY registered_at, id
      `).all(raffle.id)
      : []
    response.set('Cache-Control', 'no-store').json({ raffle, counts, latestWinner: latestWinner || null, latestWinners, eligible })
  })

  app.post('/api/raffles/:id/register', registrationLimit, async (request, response) => {
    const raffle = await getRaffle.get(request.params.id)
    if (!raffle) return response.status(404).json({ error: 'This raffle could not be found.' })
    if (raffle.drawStatus === 'drawing') return response.status(423).json({ error: 'Registration is closed while the raffle draw is in progress.' })

    const fieldLabel = (raffle.ticketLabel || 'ticket number').toLowerCase()
    const participantName = typeof request.body?.participantName === 'string' ? request.body.participantName.trim().replace(/\s+/g, ' ') : ''
    const ticketNumber = typeof request.body?.ticketNumber === 'string' ? request.body.ticketNumber.trim() : ''
    if (!participantNamePattern.test(participantName)) return response.status(400).json({ error: 'Enter a name between 2 and 80 characters.' })
    if (!ticketNumberPattern.test(ticketNumber)) return response.status(400).json({ error: `Enter a ${fieldLabel} using letters, numbers, spaces, dashes, slashes, or underscores.` })

    const entry = {
      id: randomUUID(),
      raffleId: raffle.id,
      participantName,
      ticketNumber,
      registeredAt: new Date().toISOString(),
    }

    let registered
    try {
      registered = await inTransaction(async () => {
        const currentRaffle = await getRaffle.get(raffle.id)
        if (!currentRaffle) return 'missing'
        if (currentRaffle.drawStatus === 'drawing') return 'drawing'
        await database.prepare(`
          INSERT INTO raffle_entries (id, raffle_id, participant_name, ticket_number, ticket_key, registered_at, won_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL)
        `).run(entry.id, entry.raffleId, entry.participantName, entry.ticketNumber, ticketKey(ticketNumber), entry.registeredAt)
        return { resetVersion: currentRaffle.resetVersion }
      })
      if (registered === 'missing') return response.status(404).json({ error: 'This raffle could not be found.' })
      if (registered === 'drawing') return response.status(423).json({ error: 'Registration is closed while the raffle draw is in progress.' })
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return response.status(409).json({
          error: raffle.ticketLabel
            ? `This ${fieldLabel} has already been registered. Duplicate entries are not allowed.`
            : duplicateTicketMessage,
        })
      }
      throw error
    }

    response.status(201).json({ id: entry.id, participantName, ticketNumber, registeredAt: entry.registeredAt, resetVersion: registered.resetVersion })
  })

  app.get('/api/raffles/:id/host', requireUser, requireOwner, async (request, response) => {
    const raffle = await getRaffle.get(request.params.id)
    if (!raffle) return response.status(404).json({ error: 'This raffle could not be found.' })
    const entries = await database.prepare(`
      SELECT id, participant_name AS participantName, ticket_number AS ticketNumber,
        registered_at AS registeredAt, won_at AS wonAt, draw_id AS drawId
      FROM raffle_entries WHERE raffle_id = ? ORDER BY registered_at, id
    `).all(raffle.id)
    const eligible = entries.filter((entry) => !entry.wonAt)
    const winners = entries.filter((entry) => entry.wonAt).sort((left, right) => right.wonAt.localeCompare(left.wonAt))
    response.json({ raffle, entries, eligible, winners, latestWinners: latestDrawWinners(winners) })
  })

  app.post('/api/raffles/:id/draw/start', requireUser, requireOwner, async (request, response) => {
    const winnerCount = request.body?.winnerCount === undefined ? 1 : request.body.winnerCount
    if (!Number.isSafeInteger(winnerCount) || winnerCount < 1) {
      return response.status(400).json({ error: 'Number of winners must be a whole number of at least 1.' })
    }
    const result = await inTransaction(async () => {
      const raffle = await getRaffle.get(request.params.id)
      if (!raffle) return { error: 'missing' }
      if (raffle.drawStatus === 'drawing') return { error: 'already-drawing' }
      const eligible = await database.prepare(`
        SELECT id, participant_name AS participantName, ticket_number AS ticketNumber
        FROM raffle_entries WHERE raffle_id = ? AND won_at IS NULL
        ORDER BY registered_at, id
      `).all(raffle.id)
      if (!eligible.length) return { error: 'no-eligible' }
      if (winnerCount > eligible.length) return { error: 'too-many-winners' }
      await database.prepare('UPDATE raffle_sessions SET draw_status = ?, draw_winner_count = ?, updated_at = ? WHERE id = ?')
        .run('drawing', winnerCount, new Date().toISOString(), raffle.id)
      return { eligible }
    })

    if (result.error === 'missing') return response.status(404).json({ error: 'This raffle could not be found.' })
    if (result.error === 'already-drawing') return response.status(409).json({ error: 'A draw is already in progress.' })
    if (result.error === 'no-eligible') return response.status(409).json({ error: 'There are no eligible tickets left to draw.' })
    if (result.error === 'too-many-winners') return response.status(409).json({ error: 'Number of winners cannot exceed the eligible tickets.' })
    await audit(request, 'raffle.draw.start', 'raffle', request.params.id, { winnerCount })
    response.json({ drawStatus: 'drawing', drawWinnerCount: winnerCount, eligible: result.eligible })
  })

  app.post('/api/raffles/:id/draw/stop', requireUser, requireOwner, async (request, response) => {
    const now = new Date().toISOString()
    const result = await inTransaction(async () => {
      const raffle = await getRaffle.get(request.params.id)
      if (!raffle) return { error: 'missing' }
      if (raffle.drawStatus !== 'drawing') return { error: 'not-drawing' }
      const eligible = await database.prepare(`
        SELECT id, participant_name AS participantName, ticket_number AS ticketNumber
        FROM raffle_entries WHERE raffle_id = ? AND won_at IS NULL
      `).all(raffle.id)
      if (!eligible.length) {
        await database.prepare('UPDATE raffle_sessions SET draw_status = ?, updated_at = ? WHERE id = ?').run('idle', now, raffle.id)
        return { error: 'no-eligible' }
      }

      if (raffle.drawWinnerCount > eligible.length) return { error: 'too-many-winners' }
      const drawId = randomUUID()
      const winners = []
      for (let index = 0; index < raffle.drawWinnerCount; index++) {
        const selectedIndex = randomInt(eligible.length)
        const winner = eligible[selectedIndex]
        eligible[selectedIndex] = eligible[eligible.length - 1]
        eligible.pop()
        const marked = await database.prepare('UPDATE raffle_entries SET won_at = ?, draw_id = ? WHERE id = ? AND raffle_id = ? AND won_at IS NULL')
          .run(now, drawId, winner.id, raffle.id)
        if (marked.changes !== 1) throw new Error('A selected raffle ticket could not be marked as a winner.')
        winners.push({ ...winner, wonAt: now, drawId })
      }
      await database.prepare('UPDATE raffle_sessions SET draw_status = ?, updated_at = ? WHERE id = ?').run('idle', now, raffle.id)
      return { winners }
    })

    if (result.error === 'missing') return response.status(404).json({ error: 'This raffle could not be found.' })
    if (result.error === 'not-drawing') return response.status(409).json({ error: 'Start a draw before stopping it.' })
    if (result.error === 'no-eligible') return response.status(409).json({ error: 'There are no eligible tickets left to draw.' })
    if (result.error === 'too-many-winners') return response.status(409).json({ error: 'There are not enough eligible tickets for this draw.' })
    await audit(request, 'raffle.draw.winner', 'raffle', request.params.id, { winnerCount: result.winners.length, ticketNumbers: result.winners.map((entry) => entry.ticketNumber) })
    response.json({ drawStatus: 'idle', winner: result.winners[0], winners: result.winners })
  })
}
