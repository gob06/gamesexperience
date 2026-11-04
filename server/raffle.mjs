import { randomInt, randomUUID } from 'node:crypto'
import { rateLimit } from './rate-limit.mjs'
import { isDuplicateKeyError } from './db.mjs'

const participantNamePattern = /^[\p{L}\p{M}][\p{L}\p{M}\p{N} .,'’-]{1,79}$/u
const ticketNumberPattern = /^[\p{L}\p{N}][\p{L}\p{N} _\-/]{0,39}$/u
const duplicateTicketMessage = 'This ticket number has already been registered. Duplicate entries are not allowed.'
const registrationLimit = rateLimit({ windowMs: 60_000, max: Number(process.env.RAFFLE_REGISTRATION_LIMIT_PER_MINUTE || 60) })

const selectRaffle = database => database.prepare(`
  SELECT id, title, draw_status AS drawStatus, created_at AS createdAt,
    CASE WHEN logo IS NULL THEN NULL ELSE CONCAT('/api/raffles/', id, '/logo?version=2') END AS logoUrl
  FROM raffle_sessions
  WHERE id = ?
`)

function ticketKey(ticketNumber) {
  return ticketNumber.normalize('NFKC').replace(/\s+/g, '').toUpperCase()
}

export function registerRaffleRoutes({ app, database, requireUser, imageUpload, hasValidImageSignature, inTransaction, audit }) {
  const getRaffle = selectRaffle(database)

  app.get('/api/raffles', requireUser, async (_request, response) => {
    const raffles = await database.prepare(`
      SELECT raffle_sessions.id, raffle_sessions.title,
        raffle_sessions.draw_status AS drawStatus,
        raffle_sessions.created_at AS createdAt,
        CASE WHEN raffle_sessions.logo IS NULL THEN NULL ELSE CONCAT('/api/raffles/', raffle_sessions.id, '/logo?version=2') END AS logoUrl,
        (SELECT COUNT(*) FROM raffle_entries WHERE raffle_id = raffle_sessions.id) AS entryCount,
        (SELECT COUNT(*) FROM raffle_entries WHERE raffle_id = raffle_sessions.id AND won_at IS NOT NULL) AS winnerCount
      FROM raffle_sessions
      ORDER BY raffle_sessions.created_at DESC
    `).all()
    response.json(raffles)
  })

  app.post('/api/raffles', requireUser, imageUpload.single('logo'), async (request, response) => {
    const title = typeof request.body.title === 'string' ? request.body.title.trim() : ''
    if (title.length < 3 || title.length > 120) return response.status(400).json({ error: 'Raffle title must be between 3 and 120 characters.' })
    if (request.file && !hasValidImageSignature(request.file.mimetype, request.file.buffer)) {
      return response.status(400).json({ error: 'The QR logo is not a valid JPEG, PNG, or WebP image.' })
    }

    const raffle = { id: randomUUID(), title, createdAt: new Date().toISOString() }
    await database.prepare(`
      INSERT INTO raffle_sessions (id, title, logo_mime_type, logo, draw_status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'idle', ?, ?, ?)
    `).run(raffle.id, title, request.file?.mimetype || null, request.file?.buffer || null, request.user.id, raffle.createdAt, raffle.createdAt)
    await audit(request, 'raffle.create', 'raffle', raffle.id, { title })
    response.status(201).json(await getRaffle.get(raffle.id))
  })

  app.delete('/api/raffles/:id', requireUser, async (request, response) => {
    const raffle = await getRaffle.get(request.params.id)
    if (!raffle) return response.status(404).json({ error: 'This raffle could not be found.' })
    await database.prepare('DELETE FROM raffle_sessions WHERE id = ?').run(raffle.id)
    await audit(request, 'raffle.delete', 'raffle', raffle.id, { title: raffle.title })
    response.status(204).end()
  })

  app.get('/api/raffles/:id/logo', async (request, response) => {
    const logo = await database.prepare('SELECT logo_mime_type AS mimeType, logo FROM raffle_sessions WHERE id = ?').get(request.params.id)
    if (!logo?.logo) return response.status(404).end()
    response.type(logo.mimeType).set('Cache-Control', 'no-store').send(Buffer.from(logo.logo))
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
        SELECT id, participant_name AS participantName, ticket_number AS ticketNumber, won_at AS wonAt
        FROM raffle_entries WHERE raffle_id = ? AND won_at IS NOT NULL
        ORDER BY won_at DESC LIMIT 1
      `).get(raffle.id),
    ])
    const eligible = raffle.drawStatus === 'drawing'
      ? await database.prepare(`
        SELECT id, participant_name AS participantName, ticket_number AS ticketNumber
        FROM raffle_entries WHERE raffle_id = ? AND won_at IS NULL
        ORDER BY registered_at, id
      `).all(raffle.id)
      : []
    response.set('Cache-Control', 'no-store').json({ raffle, counts, latestWinner: latestWinner || null, eligible })
  })

  app.post('/api/raffles/:id/register', registrationLimit, async (request, response) => {
    const raffle = await getRaffle.get(request.params.id)
    if (!raffle) return response.status(404).json({ error: 'This raffle could not be found.' })
    if (raffle.drawStatus === 'drawing') return response.status(423).json({ error: 'Registration is closed while the raffle draw is in progress.' })

    const participantName = typeof request.body?.participantName === 'string' ? request.body.participantName.trim().replace(/\s+/g, ' ') : ''
    const ticketNumber = typeof request.body?.ticketNumber === 'string' ? request.body.ticketNumber.trim() : ''
    if (!participantNamePattern.test(participantName)) return response.status(400).json({ error: 'Enter a name between 2 and 80 characters.' })
    if (!ticketNumberPattern.test(ticketNumber)) return response.status(400).json({ error: 'Enter a ticket number using letters, numbers, spaces, dashes, slashes, or underscores.' })

    const entry = {
      id: randomUUID(),
      raffleId: raffle.id,
      participantName,
      ticketNumber,
      registeredAt: new Date().toISOString(),
    }

    try {
      const registered = await inTransaction(async () => {
        const currentRaffle = await getRaffle.get(raffle.id)
        if (!currentRaffle) return 'missing'
        if (currentRaffle.drawStatus === 'drawing') return 'drawing'
        await database.prepare(`
          INSERT INTO raffle_entries (id, raffle_id, participant_name, ticket_number, ticket_key, registered_at, won_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL)
        `).run(entry.id, entry.raffleId, entry.participantName, entry.ticketNumber, ticketKey(ticketNumber), entry.registeredAt)
        return 'registered'
      })
      if (registered === 'missing') return response.status(404).json({ error: 'This raffle could not be found.' })
      if (registered === 'drawing') return response.status(423).json({ error: 'Registration is closed while the raffle draw is in progress.' })
    } catch (error) {
      if (isDuplicateKeyError(error)) return response.status(409).json({ error: duplicateTicketMessage })
      throw error
    }

    response.status(201).json({ id: entry.id, participantName, ticketNumber, registeredAt: entry.registeredAt })
  })

  app.get('/api/raffles/:id/host', requireUser, async (request, response) => {
    const raffle = await getRaffle.get(request.params.id)
    if (!raffle) return response.status(404).json({ error: 'This raffle could not be found.' })
    const entries = await database.prepare(`
      SELECT id, participant_name AS participantName, ticket_number AS ticketNumber,
        registered_at AS registeredAt, won_at AS wonAt
      FROM raffle_entries WHERE raffle_id = ? ORDER BY registered_at, id
    `).all(raffle.id)
    const eligible = entries.filter((entry) => !entry.wonAt)
    const winners = entries.filter((entry) => entry.wonAt).sort((left, right) => right.wonAt.localeCompare(left.wonAt))
    response.json({ raffle, entries, eligible, winners })
  })

  app.post('/api/raffles/:id/draw/start', requireUser, async (request, response) => {
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
      await database.prepare('UPDATE raffle_sessions SET draw_status = ?, updated_at = ? WHERE id = ?').run('drawing', new Date().toISOString(), raffle.id)
      return { eligible }
    })

    if (result.error === 'missing') return response.status(404).json({ error: 'This raffle could not be found.' })
    if (result.error === 'already-drawing') return response.status(409).json({ error: 'A draw is already in progress.' })
    if (result.error === 'no-eligible') return response.status(409).json({ error: 'There are no eligible tickets left to draw.' })
    await audit(request, 'raffle.draw.start', 'raffle', request.params.id)
    response.json({ drawStatus: 'drawing', eligible: result.eligible })
  })

  app.post('/api/raffles/:id/draw/stop', requireUser, async (request, response) => {
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

      const winner = eligible[randomInt(eligible.length)]
      const marked = await database.prepare('UPDATE raffle_entries SET won_at = ? WHERE id = ? AND raffle_id = ? AND won_at IS NULL')
        .run(now, winner.id, raffle.id)
      if (marked.changes !== 1) return { error: 'race' }
      await database.prepare('UPDATE raffle_sessions SET draw_status = ?, updated_at = ? WHERE id = ?').run('idle', now, raffle.id)
      return { winner: { ...winner, wonAt: now } }
    })

    if (result.error === 'missing') return response.status(404).json({ error: 'This raffle could not be found.' })
    if (result.error === 'not-drawing') return response.status(409).json({ error: 'Start a draw before stopping it.' })
    if (result.error === 'no-eligible') return response.status(409).json({ error: 'There are no eligible tickets left to draw.' })
    if (result.error === 'race') return response.status(409).json({ error: 'The ticket was already selected. Start another draw.' })
    await audit(request, 'raffle.draw.winner', 'raffle', request.params.id, { ticketNumber: result.winner.ticketNumber })
    response.json({ drawStatus: 'idle', winner: result.winner })
  })
}
