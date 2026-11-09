import { randomInt, randomUUID } from 'node:crypto'
import { rateLimit } from './rate-limit.mjs'
import { isDuplicateKeyError } from './db.mjs'

const participantNamePattern = /^[\p{L}\p{M}][\p{L}\p{M}\p{N} .,'’-]{1,79}$/u
const ticketNumberPattern = /^[\p{L}\p{N}][\p{L}\p{N} _\-/]{0,39}$/u
const answerPattern = /^[\p{L}\p{M}\p{N} .,'’&!?-]{1,120}$/u
const duplicateTicketMessage = 'This ticket number has already been registered. Duplicate entries are not allowed.'
const registrationLimit = rateLimit({ windowMs: 60_000, max: Number(process.env.SCRAMBLE_REGISTRATION_LIMIT_PER_MINUTE || 60) })
const answerLimit = rateLimit({ windowMs: 60_000, max: Number(process.env.SCRAMBLE_ANSWER_LIMIT_PER_MINUTE || 60) })

const gameStatuses = ['draft', 'active', 'paused', 'closed', 'completed']

function ticketKey(ticketNumber) {
  return ticketNumber.normalize('NFKC').replace(/\s+/g, '').toUpperCase()
}

// Case-insensitive, whitespace-normalized comparison key for answers.
export function answerKey(text) {
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase()
}

function letterKey(text) {
  return [...answerKey(text).replace(/\s+/g, '')].sort().join('')
}

function secureShuffle(items) {
  const shuffled = [...items]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1)
    ;[shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]]
  }
  return shuffled
}

// Scrambles each word of the answer while preserving spaces and letter frequency.
// The result differs from the original whenever the letters allow it.
export function scrambleAnswer(answer) {
  const normalized = answer.normalize('NFKC').trim().replace(/\s+/g, ' ')
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const scrambled = normalized
      .split(' ')
      .map((word) => secureShuffle([...word.toUpperCase()]).join(''))
      .join(' ')
    if (answerKey(scrambled) !== answerKey(normalized)) return scrambled
  }
  // Words such as "AAA" cannot differ from the original; return the letters as-is.
  return normalized.toUpperCase()
}

function isValidScramble(scrambled, answer) {
  return letterKey(scrambled) === letterKey(answer)
}

const selectGameSql = `
  SELECT id, title, status, answer, scrambled,
    answer_revealed_at AS answerRevealedAt,
    created_at AS createdAt, updated_at AS updatedAt,
    CASE WHEN logo IS NULL THEN NULL ELSE CONCAT('/api/scrambles/', id, '/logo?version=1') END AS logoUrl
  FROM scramble_games
  WHERE id = ?
`

function publicGame(game) {
  return {
    id: game.id,
    title: game.title,
    status: game.status,
    logoUrl: game.logoUrl,
    // The scrambled word stays private until the host starts the game.
    scrambled: game.status === 'draft' ? null : game.scrambled,
    revealedAnswer: game.answerRevealedAt ? game.answer : null,
    registrationOpen: game.status === 'draft' || game.status === 'active' || game.status === 'paused',
    submissionOpen: game.status === 'active',
  }
}

function hostGame(game) {
  return {
    id: game.id,
    title: game.title,
    status: game.status,
    logoUrl: game.logoUrl,
    answer: game.answer,
    scrambled: game.scrambled,
    answerRevealed: Boolean(game.answerRevealedAt),
    createdAt: game.createdAt,
    updatedAt: game.updatedAt,
  }
}

function participantState(entry) {
  return {
    id: entry.id,
    participantName: entry.participantName,
    ticketNumber: entry.ticketNumber,
    answered: Boolean(entry.answeredAt),
    isCorrect: entry.answeredAt ? Boolean(entry.isCorrect) : null,
  }
}

export function registerScrambleRoutes({ app, database, requireUser, imageUpload, hasValidImageSignature, inTransaction, audit }) {
  const getGame = async (id) => database.prepare(selectGameSql).get(id)
  const getEntry = async (gameId, entryId) => database.prepare(`
    SELECT id, game_id AS gameId, participant_name AS participantName, ticket_number AS ticketNumber,
      answer, is_correct AS isCorrect, answered_at AS answeredAt
    FROM scramble_entries WHERE game_id = ? AND id = ?
  `).get(gameId, entryId)

  async function getStats(gameId) {
    const stats = await database.prepare(`
      SELECT COUNT(*) AS registrations,
        SUM(CASE WHEN answered_at IS NOT NULL THEN 1 ELSE 0 END) AS answered,
        SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct,
        SUM(CASE WHEN answered_at IS NOT NULL AND is_correct = 0 THEN 1 ELSE 0 END) AS incorrect,
        SUM(CASE WHEN is_correct = 1 AND confirmed_at IS NULL AND selected_at IS NULL THEN 1 ELSE 0 END) AS eligible,
        SUM(CASE WHEN selected_at IS NOT NULL AND confirmed_at IS NULL THEN 1 ELSE 0 END) AS selected,
        SUM(CASE WHEN confirmed_at IS NOT NULL THEN 1 ELSE 0 END) AS confirmed,
        SUM(CASE WHEN announced_at IS NOT NULL THEN 1 ELSE 0 END) AS announced
      FROM scramble_entries WHERE game_id = ?
    `).get(gameId)
    return {
      registrations: Number(stats.registrations || 0),
      answered: Number(stats.answered || 0),
      correct: Number(stats.correct || 0),
      incorrect: Number(stats.incorrect || 0),
      notSubmitted: Number(stats.registrations || 0) - Number(stats.answered || 0),
      eligible: Number(stats.eligible || 0),
      selected: Number(stats.selected || 0),
      confirmed: Number(stats.confirmed || 0),
      announced: Number(stats.announced || 0),
    }
  }

  app.get('/api/scrambles', requireUser, async (_request, response) => {
    const games = await database.prepare(`
      SELECT scramble_games.id, scramble_games.title, scramble_games.status,
        scramble_games.created_at AS createdAt,
        CASE WHEN scramble_games.logo IS NULL THEN NULL ELSE CONCAT('/api/scrambles/', scramble_games.id, '/logo?version=1') END AS logoUrl,
        (SELECT COUNT(*) FROM scramble_entries WHERE game_id = scramble_games.id) AS entryCount,
        (SELECT COUNT(*) FROM scramble_entries WHERE game_id = scramble_games.id AND confirmed_at IS NOT NULL) AS winnerCount
      FROM scramble_games
      ORDER BY scramble_games.created_at DESC
    `).all()
    response.json(games)
  })

  app.post('/api/scrambles', requireUser, imageUpload.single('logo'), async (request, response) => {
    const title = typeof request.body.title === 'string' ? request.body.title.trim() : ''
    const answerInput = typeof request.body.answer === 'string' ? request.body.answer.normalize('NFKC').trim().replace(/\s+/g, ' ') : ''
    const scrambledInput = typeof request.body.scrambled === 'string' ? request.body.scrambled.normalize('NFKC').trim().replace(/\s+/g, ' ') : ''
    if (title.length < 3 || title.length > 120) return response.status(400).json({ error: 'Game title must be between 3 and 120 characters.' })
    if (answerInput.length < 2 || answerInput.length > 120 || !answerPattern.test(answerInput)) return response.status(400).json({ error: 'Enter an answer word or phrase between 2 and 120 letters, numbers, and basic punctuation.' })
    const scrambled = scrambledInput ? scrambledInput.toUpperCase() : scrambleAnswer(answerInput)
    if (!isValidScramble(scrambled, answerInput)) return response.status(400).json({ error: 'The scrambled version must use exactly the same letters as the answer.' })
    const logo = request.file
    if (logo && !hasValidImageSignature(logo.mimetype, logo.buffer)) return response.status(400).json({ error: 'QR logo is not a valid JPEG, PNG, or WebP image.' })

    const now = new Date().toISOString()
    const id = randomUUID()
    await database.prepare(`
      INSERT INTO scramble_games (id, title, answer, scrambled, status, answer_revealed_at, logo_mime_type, logo, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'draft', NULL, ?, ?, ?, ?, ?)
    `).run(id, title, answerInput, scrambled, logo?.mimetype || null, logo?.buffer || null, request.user.id, now, now)
    await audit(request, 'scramble.create', 'scramble', id, { title })
    response.status(201).json(hostGame(await getGame(id)))
  })

  app.delete('/api/scrambles/:id', requireUser, async (request, response) => {
    const game = await getGame(request.params.id)
    if (!game) return response.status(404).json({ error: 'This word scramble could not be found.' })
    await database.prepare('DELETE FROM scramble_games WHERE id = ?').run(game.id)
    await audit(request, 'scramble.delete', 'scramble', game.id, { title: game.title })
    response.status(204).end()
  })

  app.get('/api/scrambles/:id/logo', async (request, response) => {
    const logo = await database.prepare('SELECT logo_mime_type AS mimeType, logo FROM scramble_games WHERE id = ?').get(request.params.id)
    if (!logo?.logo) return response.status(404).end()
    response.type(logo.mimeType).set('Cache-Control', 'no-store').send(Buffer.from(logo.logo))
  })

  app.put('/api/scrambles/:id/word', requireUser, async (request, response) => {
    const game = await getGame(request.params.id)
    if (!game) return response.status(404).json({ error: 'This word scramble could not be found.' })
    // The answer locks once the game starts; changing it afterwards requires explicit confirmation.
    if (game.status !== 'draft' && request.body?.confirm !== true) {
      return response.status(409).json({ error: 'The game has already started. Confirm the change to replace the active word.' })
    }
    const answerInput = typeof request.body?.answer === 'string' ? request.body.answer.normalize('NFKC').trim().replace(/\s+/g, ' ') : ''
    const scrambledInput = typeof request.body?.scrambled === 'string' ? request.body.scrambled.normalize('NFKC').trim().replace(/\s+/g, ' ') : ''
    if (answerInput.length < 2 || answerInput.length > 120 || !answerPattern.test(answerInput)) return response.status(400).json({ error: 'Enter an answer word or phrase between 2 and 120 letters, numbers, and basic punctuation.' })
    const scrambled = scrambledInput ? scrambledInput.toUpperCase() : scrambleAnswer(answerInput)
    if (!isValidScramble(scrambled, answerInput)) return response.status(400).json({ error: 'The scrambled version must use exactly the same letters as the answer.' })
    await database.prepare('UPDATE scramble_games SET answer = ?, scrambled = ?, updated_at = ? WHERE id = ?')
      .run(answerInput, scrambled, new Date().toISOString(), game.id)
    await audit(request, 'scramble.word.update', 'scramble', game.id, { afterStart: game.status !== 'draft' })
    response.json(hostGame(await getGame(game.id)))
  })

  // Preview endpoint so the host can reshuffle without persisting anything.
  app.post('/api/scrambles/preview', requireUser, async (request, response) => {
    const answerInput = typeof request.body?.answer === 'string' ? request.body.answer.normalize('NFKC').trim().replace(/\s+/g, ' ') : ''
    if (answerInput.length < 2 || answerInput.length > 120 || !answerPattern.test(answerInput)) return response.status(400).json({ error: 'Enter an answer word or phrase between 2 and 120 letters, numbers, and basic punctuation.' })
    response.json({ scrambled: scrambleAnswer(answerInput) })
  })

  const statusActions = {
    start: { from: ['draft', 'paused'], to: 'active' },
    pause: { from: ['active'], to: 'paused' },
    resume: { from: ['paused'], to: 'active' },
    close: { from: ['active', 'paused'], to: 'closed' },
    complete: { from: ['closed'], to: 'completed' },
  }

  app.post('/api/scrambles/:id/status', requireUser, async (request, response) => {
    const action = statusActions[request.body?.action]
    if (!action) return response.status(400).json({ error: 'Choose a valid game action.' })
    const result = await inTransaction(async () => {
      const game = await getGame(request.params.id)
      if (!game) return { error: 'missing' }
      if (!action.from.includes(game.status)) return { error: 'invalid', status: game.status }
      await database.prepare('UPDATE scramble_games SET status = ?, updated_at = ? WHERE id = ?')
        .run(action.to, new Date().toISOString(), game.id)
      return { ok: true }
    })
    if (result.error === 'missing') return response.status(404).json({ error: 'This word scramble could not be found.' })
    if (result.error === 'invalid') return response.status(409).json({ error: `This action is not available while the game is ${result.status}.` })
    await audit(request, 'scramble.status', 'scramble', request.params.id, { action: request.body.action })
    response.json(hostGame(await getGame(request.params.id)))
  })

  app.post('/api/scrambles/:id/reveal', requireUser, async (request, response) => {
    const game = await getGame(request.params.id)
    if (!game) return response.status(404).json({ error: 'This word scramble could not be found.' })
    if (game.status === 'draft') return response.status(409).json({ error: 'Start the game before revealing the answer.' })
    if (!game.answerRevealedAt) {
      await database.prepare('UPDATE scramble_games SET answer_revealed_at = ?, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), new Date().toISOString(), game.id)
      await audit(request, 'scramble.reveal', 'scramble', game.id)
    }
    response.json(hostGame(await getGame(game.id)))
  })

  app.post('/api/scrambles/:id/reset', requireUser, async (request, response) => {
    const game = await getGame(request.params.id)
    if (!game) return response.status(404).json({ error: 'This word scramble could not be found.' })
    await inTransaction(async () => {
      await database.prepare('DELETE FROM scramble_entries WHERE game_id = ?').run(game.id)
      await database.prepare('UPDATE scramble_games SET status = ?, answer_revealed_at = NULL, updated_at = ? WHERE id = ?')
        .run('draft', new Date().toISOString(), game.id)
    })
    await audit(request, 'scramble.reset', 'scramble', game.id, { title: game.title })
    response.json(hostGame(await getGame(game.id)))
  })

  // Public game state. The correct answer is only included after the official reveal.
  app.get('/api/scrambles/:id', async (request, response) => {
    const game = await getGame(request.params.id)
    if (!game) return response.status(404).json({ error: 'This word scramble could not be found.' })
    response.set('Cache-Control', 'no-store').json(publicGame(game))
  })

  app.get('/api/scrambles/:id/participant/:entryId', async (request, response) => {
    const game = await getGame(request.params.id)
    if (!game) return response.status(404).json({ error: 'This word scramble could not be found.' })
    const entry = await getEntry(game.id, request.params.entryId)
    if (!entry) return response.status(404).json({ error: 'This registration could not be found.' })
    response.set('Cache-Control', 'no-store').json({ game: publicGame(game), me: participantState(entry) })
  })

  app.post('/api/scrambles/:id/register', registrationLimit, async (request, response) => {
    const game = await getGame(request.params.id)
    if (!game) return response.status(404).json({ error: 'This word scramble could not be found.' })
    if (game.status === 'closed' || game.status === 'completed') return response.status(423).json({ error: 'Participation for this game has ended.' })

    const participantName = typeof request.body?.participantName === 'string' ? request.body.participantName.trim().replace(/\s+/g, ' ') : ''
    const ticketNumber = typeof request.body?.ticketNumber === 'string' ? request.body.ticketNumber.trim() : ''
    if (!participantNamePattern.test(participantName)) return response.status(400).json({ error: 'Enter a name between 2 and 80 characters.' })
    if (!ticketNumberPattern.test(ticketNumber)) return response.status(400).json({ error: 'Enter a ticket number using letters, numbers, spaces, dashes, slashes, or underscores.' })

    const entry = { id: randomUUID(), registeredAt: new Date().toISOString() }
    try {
      const registered = await inTransaction(async () => {
        const currentGame = await getGame(game.id)
        if (!currentGame) return 'missing'
        if (currentGame.status === 'closed' || currentGame.status === 'completed') return 'ended'
        await database.prepare(`
          INSERT INTO scramble_entries (id, game_id, participant_name, ticket_number, ticket_key, registered_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(entry.id, game.id, participantName, ticketNumber, ticketKey(ticketNumber), entry.registeredAt)
        return 'registered'
      })
      if (registered === 'missing') return response.status(404).json({ error: 'This word scramble could not be found.' })
      if (registered === 'ended') return response.status(423).json({ error: 'Participation for this game has ended.' })
    } catch (error) {
      if (isDuplicateKeyError(error)) return response.status(409).json({ error: duplicateTicketMessage })
      throw error
    }
    response.status(201).json({ id: entry.id, participantName, ticketNumber, registeredAt: entry.registeredAt })
  })

  app.post('/api/scrambles/:id/answer', answerLimit, async (request, response) => {
    const entryId = typeof request.body?.entryId === 'string' ? request.body.entryId : ''
    const submitted = typeof request.body?.answer === 'string' ? request.body.answer : ''
    if (!entryId) return response.status(400).json({ error: 'Register before submitting an answer.' })
    const normalized = answerKey(submitted)
    if (!normalized || normalized.length > 120) return response.status(400).json({ error: 'Enter your answer before submitting.' })

    const now = new Date().toISOString()
    const result = await inTransaction(async () => {
      const game = await getGame(request.params.id)
      if (!game) return { error: 'missing' }
      if (game.status !== 'active') return { error: game.status === 'paused' ? 'paused' : 'closed' }
      const entry = await getEntry(game.id, entryId)
      if (!entry) return { error: 'no-entry' }
      // The answered_at guard in the UPDATE enforces one submission per participant.
      const isCorrect = normalized === answerKey(game.answer) ? 1 : 0
      const updated = await database.prepare(`
        UPDATE scramble_entries SET answer = ?, is_correct = ?, answered_at = ?
        WHERE id = ? AND game_id = ? AND answered_at IS NULL
      `).run(submitted.normalize('NFKC').trim().replace(/\s+/g, ' ').slice(0, 120), isCorrect, now, entry.id, game.id)
      if (updated.changes !== 1) return { error: 'duplicate' }
      return { correct: isCorrect === 1 }
    })

    if (result.error === 'missing') return response.status(404).json({ error: 'This word scramble could not be found.' })
    if (result.error === 'paused') return response.status(423).json({ error: 'The game is paused. Wait for the host to resume.' })
    if (result.error === 'closed') return response.status(423).json({ error: 'Answer submissions for this game have ended.' })
    if (result.error === 'no-entry') return response.status(404).json({ error: 'This registration could not be found.' })
    if (result.error === 'duplicate') return response.status(409).json({ error: 'Your answer has already been recorded. Only one submission is allowed.' })
    response.json({ correct: result.correct })
  })

  app.get('/api/scrambles/:id/host', requireUser, async (request, response) => {
    const game = await getGame(request.params.id)
    if (!game) return response.status(404).json({ error: 'This word scramble could not be found.' })
    const [stats, entries] = await Promise.all([
      getStats(game.id),
      database.prepare(`
        SELECT id, participant_name AS participantName, ticket_number AS ticketNumber,
          registered_at AS registeredAt, answer, is_correct AS isCorrect, answered_at AS answeredAt,
          selected_at AS selectedAt, confirmed_at AS confirmedAt, announced_at AS announcedAt
        FROM scramble_entries WHERE game_id = ? ORDER BY registered_at, id
      `).all(game.id),
    ])
    response.json({
      game: hostGame(game),
      stats,
      entries: entries.map((entry) => ({ ...entry, isCorrect: entry.answeredAt ? Boolean(entry.isCorrect) : null })),
    })
  })

  app.post('/api/scrambles/:id/winners/randomize', requireUser, async (request, response) => {
    const count = Number(request.body?.count)
    if (!Number.isInteger(count) || count < 1) return response.status(400).json({ error: 'Choose at least one winner.' })
    const now = new Date().toISOString()
    const result = await inTransaction(async () => {
      const game = await getGame(request.params.id)
      if (!game) return { error: 'missing' }
      if (game.status !== 'closed') return { error: 'not-closed' }
      // Discard any previous selection that was never confirmed.
      await database.prepare('UPDATE scramble_entries SET selected_at = NULL WHERE game_id = ? AND confirmed_at IS NULL').run(game.id)
      const eligible = await database.prepare(`
        SELECT id FROM scramble_entries
        WHERE game_id = ? AND is_correct = 1 AND confirmed_at IS NULL
        ORDER BY registered_at, id
      `).all(game.id)
      if (!eligible.length) return { error: 'no-eligible' }
      if (count > eligible.length) return { error: 'too-many', eligible: eligible.length }
      // Cryptographically secure selection with equal probability for every eligible entry.
      const winners = secureShuffle(eligible).slice(0, count)
      for (const winner of winners) {
        await database.prepare('UPDATE scramble_entries SET selected_at = ? WHERE id = ?').run(now, winner.id)
      }
      return { ok: true }
    })
    if (result.error === 'missing') return response.status(404).json({ error: 'This word scramble could not be found.' })
    if (result.error === 'not-closed') return response.status(409).json({ error: 'Close the game before randomizing winners.' })
    if (result.error === 'no-eligible') return response.status(409).json({ error: 'There are no eligible participants with a correct answer.' })
    if (result.error === 'too-many') return response.status(409).json({ error: `Only ${result.eligible} eligible participant${result.eligible === 1 ? ' is' : 's are'} available.` })
    await audit(request, 'scramble.winners.randomize', 'scramble', request.params.id, { count })
    response.json({ ok: true })
  })

  app.post('/api/scrambles/:id/winners/confirm', requireUser, async (request, response) => {
    const now = new Date().toISOString()
    const result = await inTransaction(async () => {
      const game = await getGame(request.params.id)
      if (!game) return { error: 'missing' }
      const confirmed = await database.prepare(`
        UPDATE scramble_entries SET confirmed_at = ?
        WHERE game_id = ? AND selected_at IS NOT NULL AND confirmed_at IS NULL
      `).run(now, game.id)
      if (!confirmed.changes) return { error: 'none' }
      return { count: confirmed.changes }
    })
    if (result.error === 'missing') return response.status(404).json({ error: 'This word scramble could not be found.' })
    if (result.error === 'none') return response.status(409).json({ error: 'Randomize winners before confirming them.' })
    await audit(request, 'scramble.winners.confirm', 'scramble', request.params.id, { count: result.count })
    response.json({ ok: true })
  })

  app.post('/api/scrambles/:id/winners/:entryId/announce', requireUser, async (request, response) => {
    const now = new Date().toISOString()
    const announced = await database.prepare(`
      UPDATE scramble_entries SET announced_at = ?
      WHERE game_id = ? AND id = ? AND confirmed_at IS NOT NULL AND announced_at IS NULL
    `).run(now, request.params.id, request.params.entryId)
    if (!announced.changes) return response.status(409).json({ error: 'Only confirmed, unannounced winners can be announced.' })
    await audit(request, 'scramble.winners.announce', 'scramble', request.params.id, { entryId: request.params.entryId })
    response.json({ ok: true })
  })

  app.post('/api/scrambles/:id/winners/announce-all', requireUser, async (request, response) => {
    const now = new Date().toISOString()
    const announced = await database.prepare(`
      UPDATE scramble_entries SET announced_at = ?
      WHERE game_id = ? AND confirmed_at IS NOT NULL AND announced_at IS NULL
    `).run(now, request.params.id)
    if (!announced.changes) return response.status(409).json({ error: 'There are no confirmed winners waiting to be announced.' })
    await audit(request, 'scramble.winners.announce-all', 'scramble', request.params.id, { count: announced.changes })
    response.json({ ok: true })
  })

  // Public display endpoint for the big screen / OBS Browser Source.
  // It never exposes the correct answer before the reveal, the eligible pool,
  // or any part of the randomization process - only announced winners.
  app.get('/api/scrambles/:id/display', async (request, response) => {
    const game = await getGame(request.params.id)
    if (!game) return response.status(404).json({ error: 'This word scramble could not be found.' })
    const [counts, announcedWinners] = await Promise.all([
      database.prepare(`
        SELECT COUNT(*) AS registrations,
          SUM(CASE WHEN answered_at IS NOT NULL THEN 1 ELSE 0 END) AS answered
        FROM scramble_entries WHERE game_id = ?
      `).get(game.id),
      database.prepare(`
        SELECT id, participant_name AS participantName, ticket_number AS ticketNumber, announced_at AS announcedAt
        FROM scramble_entries WHERE game_id = ? AND announced_at IS NOT NULL
        ORDER BY announced_at, id
      `).all(game.id),
    ])
    response.set('Cache-Control', 'no-store').json({
      game: publicGame(game),
      counts: { registrations: Number(counts.registrations || 0), answered: Number(counts.answered || 0) },
      announcedWinners,
    })
  })
}
