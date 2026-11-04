import { EventEmitter } from 'node:events'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { rateLimit } from './rate-limit.mjs'
import { isDuplicateKeyError } from './db.mjs'

const namePattern = /^[\p{L}\p{M}][\p{L}\p{M}\p{N} .,'’-]{1,79}$/u
const ticketPattern = /^[A-Za-z0-9][A-Za-z0-9_\-/]{0,39}$/
const verificationStatuses = ['pending', 'verified', 'rejected']

// Reads the movie duration (seconds) from an MP4's moov/mvhd box; returns null when it cannot be determined (e.g. WebM).
function readMp4Duration(filePath) {
  let descriptor
  try {
    descriptor = openSync(filePath, 'r')
    const header = Buffer.alloc(16)
    const scan = (start, end, depth) => {
      let position = start
      while (position + 8 <= end) {
        readSync(descriptor, header, 0, 16, position)
        let boxSize = header.readUInt32BE(0)
        const type = header.toString('ascii', 4, 8)
        let headerSize = 8
        if (boxSize === 1) {
          boxSize = Number(header.readBigUInt64BE(8))
          headerSize = 16
        } else if (boxSize === 0) {
          boxSize = end - position
        }
        if (boxSize < headerSize) return null
        if (type === 'moov' && depth === 0) {
          const found = scan(position + headerSize, position + boxSize, 1)
          if (found) return found
        } else if (type === 'mvhd') {
          const body = Buffer.alloc(32)
          readSync(descriptor, body, 0, 32, position + headerSize)
          const timescale = body[0] === 1 ? body.readUInt32BE(20) : body.readUInt32BE(12)
          const duration = body[0] === 1 ? Number(body.readBigUInt64BE(24)) : body.readUInt32BE(16)
          return timescale > 0 ? duration / timescale : null
        }
        position += boxSize
      }
      return null
    }
    return scan(0, fstatSync(descriptor).size, 0)
  } catch {
    return null
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

export function registerQaRoutes({
  app, database, requireUser, requireAdmin, getCookie, getVotingCookieName, hashSessionToken,
  selectPoll, selectAdVideo, adVideosDirectory, inTransaction, getPoll, audit,
}) {
  const events = new EventEmitter()
  events.setMaxListeners(0)
  const notify = (pollId) => events.emit(pollId)

  const perMinute = Number(process.env.QA_RATE_LIMIT_PER_MINUTE || 3000)
  const audienceLimit = rateLimit({ windowMs: 60_000, max: perMinute })
  const submitLimit = rateLimit({ windowMs: 60_000, max: Math.max(60, Math.floor(perMinute / 5)) })

  const durationCache = new Map()
  function adDuration(video) {
    if (!durationCache.has(video.fileName)) {
      durationCache.set(video.fileName, readMp4Duration(path.join(adVideosDirectory, path.basename(video.fileName))))
    }
    return durationCache.get(video.fileName)
  }

  async function activeAd(poll) {
    if (!poll.videoEnabled) return null
    const video = await selectAdVideo('qa')
    if (!video) return null
    return {
      id: video.fileName,
      url: `/api/ad-videos/qa/file?v=${encodeURIComponent(video.updatedAt)}`,
      durationSeconds: adDuration(video),
    }
  }

  const selectSessionByToken = database.prepare(`
    SELECT id, expires_at AS expiresAt, consumed_at AS consumedAt, full_name AS fullName, ticket_number AS ticketNumber
    FROM poll_voting_sessions WHERE token_hash = ? AND poll_id = ?
  `)
  const selectSessionById = database.prepare(`
    SELECT id, consumed_at AS consumedAt, full_name AS fullName, ticket_number AS ticketNumber
    FROM poll_voting_sessions WHERE id = ?
  `)
  const selectPlayback = database.prepare(`
    SELECT id, ad_id AS adId, started_at AS startedAt, completed_at AS completedAt, status, max_position AS maxPosition
    FROM ad_playbacks WHERE voting_session_id = ?
  `)

  async function getSession(request, pollId) {
    const token = getCookie(request, getVotingCookieName(pollId))
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    const session = await selectSessionByToken.get(hashSessionToken(token), pollId)
    return session && Date.parse(session.expiresAt) > Date.now() ? session : null
  }

  async function describeSession(poll, sessionId) {
    const session = await selectSessionById.get(sessionId)
    const adRequired = Boolean(await activeAd(poll))
    const playback = await selectPlayback.get(sessionId)
    return {
      registered: Boolean(session?.ticketNumber),
      fullName: session?.fullName ?? null,
      ticketNumber: session?.ticketNumber ?? null,
      submitted: Boolean(session?.consumedAt),
      adRequired,
      adCompleted: !adRequired || playback?.status === 'completed',
    }
  }

  async function requireQaPoll(request, response, next) {
    const poll = await selectPoll.get(request.params.id)
    if (!poll) return response.status(404).json({ error: 'This Q&A could not be found.' })
    if (!poll.isQa) return response.status(400).json({ error: 'This action is only available for Q&A sessions.' })
    request.poll = poll
    next()
  }

  async function requireQaSession(request, response, next) {
    const session = await getSession(request, request.params.id)
    if (!session) return response.status(403).json({ error: 'Your session is missing or expired. Reload the page to continue.' })
    request.qaSession = session
    next()
  }

  app.post('/api/polls/:id/register', audienceLimit, submitLimit, requireQaPoll, requireQaSession, async (request, response) => {
    const { poll, qaSession } = request
    response.set('Cache-Control', 'no-store')
    if (qaSession.ticketNumber) return response.json({ registered: true, fullName: qaSession.fullName, ticketNumber: qaSession.ticketNumber })
    if (!poll.votingEnabled) return response.status(423).json({ error: 'This Q&A is not accepting participants right now.' })
    const fullName = typeof request.body?.fullName === 'string' ? request.body.fullName.trim().replace(/\s+/g, ' ') : ''
    const ticketNumber = typeof request.body?.ticketNumber === 'string' ? request.body.ticketNumber.trim() : ''
    if (!namePattern.test(fullName)) return response.status(400).json({ error: 'Enter your full name (2–80 letters; no symbols).' })
    if (!ticketPattern.test(ticketNumber)) return response.status(400).json({ error: 'Enter a valid ticket number (letters, numbers, dashes; up to 40 characters).' })
    try {
      await database.prepare('UPDATE poll_voting_sessions SET full_name = ?, ticket_number = ?, ticket_key = ?, registered_at = ? WHERE id = ? AND ticket_key IS NULL')
        .run(fullName, ticketNumber, ticketNumber.toUpperCase(), new Date().toISOString(), qaSession.id)
    } catch (error) {
      if (isDuplicateKeyError(error)) return response.status(409).json({ error: 'This ticket number has already been used for this Q&A.' })
      throw error
    }
    notify(poll.id)
    response.json({ registered: true, fullName, ticketNumber })
  })

  // Runs after the generic poll handler, which defers Q&A polls to this one via next().
  app.post('/api/polls/:id/votes', audienceLimit, submitLimit, requireQaPoll, requireQaSession, async (request, response) => {
    const { poll, qaSession } = request
    response.set('Cache-Control', 'no-store')
    if (!poll.votingEnabled) return response.status(423).json({ error: 'This Q&A is not accepting answers right now.' })
    if (!qaSession.ticketNumber) return response.status(403).json({ error: 'Enter your name and ticket number first.' })
    const optionId = request.body?.optionId
    if (typeof optionId !== 'string' || optionId.length > 80) return response.status(400).json({ error: 'Choose one answer.' })

    const outcome = await inTransaction(async () => {
      const option = await database.prepare('SELECT id FROM poll_options WHERE id = ? AND poll_id = ?').get(optionId, poll.id)
      if (!option) return 'invalid-option'
      const createdAt = new Date().toISOString()
      const consumed = await database.prepare('UPDATE poll_voting_sessions SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?')
        .run(createdAt, qaSession.id, createdAt)
      if (consumed.changes !== 1) return 'duplicate'
      const correctOptionId = (await database.prepare('SELECT correct_option_id AS id FROM polls WHERE id = ?').get(poll.id))?.id
      await database.prepare('INSERT INTO poll_voters (poll_id, voter_id, option_id, created_at, voting_session_id, first_name, ticket_number, is_correct) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(poll.id, qaSession.id, optionId, createdAt, qaSession.id, qaSession.fullName, qaSession.ticketNumber, Number(optionId === correctOptionId))
      await database.prepare('UPDATE poll_options SET votes = votes + 1 WHERE id = ?').run(optionId)
      return 'ok'
    })

    if (outcome === 'invalid-option') return response.status(400).json({ error: 'Choose one of the answers.' })
    notify(poll.id)
    if (outcome === 'duplicate') return response.status(409).json({ error: 'Your answer has already been submitted.', ...(await describeSession(poll, qaSession.id)) })
    response.status(201).json(await describeSession(poll, qaSession.id))
  })

  app.post('/api/polls/:id/ad/start', audienceLimit, requireQaPoll, requireQaSession, async (request, response) => {
    const { poll, qaSession } = request
    response.set('Cache-Control', 'no-store')
    if (!qaSession.consumedAt) return response.status(403).json({ error: 'Submit your answer first.' })
    const ad = await activeAd(poll)
    if (!ad) return response.json({ required: false, completed: true })
    const existing = await selectPlayback.get(qaSession.id)
    if (existing?.status === 'completed') return response.json({ required: true, completed: true })
    const now = new Date().toISOString()
    if (existing) {
      await database.prepare('UPDATE ad_playbacks SET ad_id = ?, started_at = ?, max_position = 0 WHERE id = ?').run(ad.id, now, existing.id)
    } else {
      await database.prepare('INSERT INTO ad_playbacks (id, poll_id, voting_session_id, ad_kind, ad_id, started_at, status, max_position) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
        .run(randomUUID(), poll.id, qaSession.id, 'qa', ad.id, now, 'started')
    }
    response.json({ required: true, completed: false, adId: ad.id, url: ad.url, durationSeconds: ad.durationSeconds })
  })

  // Playback position can never run ahead of wall-clock time since the ad started.
  app.post('/api/polls/:id/ad/progress', audienceLimit, requireQaPoll, requireQaSession, async (request, response) => {
    const playback = await selectPlayback.get(request.qaSession.id)
    const position = Number(request.body?.position)
    if (playback?.status === 'started' && Number.isFinite(position) && position >= 0) {
      const elapsed = (Date.now() - Date.parse(playback.startedAt)) / 1000
      const accepted = Math.min(position, elapsed + 1)
      if (accepted > playback.maxPosition) await database.prepare('UPDATE ad_playbacks SET max_position = ? WHERE id = ?').run(accepted, playback.id)
    }
    response.status(204).end()
  })

  app.post('/api/polls/:id/ad/complete', audienceLimit, requireQaPoll, requireQaSession, async (request, response) => {
    const { poll, qaSession } = request
    response.set('Cache-Control', 'no-store')
    const playback = await selectPlayback.get(qaSession.id)
    if (!playback) return response.status(403).json({ error: 'The advertisement has not been started.' })
    if (playback.status === 'completed') return response.json({ completed: true })
    const ad = await activeAd(poll)
    const clientDuration = Number(request.body?.clientDuration)
    const duration = ad?.durationSeconds ?? (Number.isFinite(clientDuration) ? Math.min(Math.max(clientDuration, 1), 3600) : 5)
    const elapsed = (Date.now() - Date.parse(playback.startedAt)) / 1000
    const finalPosition = Number(request.body?.position)
    const maxPosition = Math.max(playback.maxPosition, Number.isFinite(finalPosition) ? Math.min(finalPosition, elapsed + 1) : 0)
    if (elapsed < duration - 1.5 || maxPosition < duration - 2.5) {
      return response.status(409).json({ error: 'The advertisement has not finished playing. Please watch it to the end.', remainingSeconds: Math.max(0, Math.ceil(duration - elapsed)) })
    }
    await database.prepare("UPDATE ad_playbacks SET status = 'completed', completed_at = ?, max_position = ? WHERE id = ?")
      .run(new Date().toISOString(), maxPosition, playback.id)
    notify(poll.id)
    response.json({ completed: true })
  })

  app.get('/api/polls/:id/result', audienceLimit, requireQaPoll, requireQaSession, async (request, response) => {
    const { poll, qaSession } = request
    response.set('Cache-Control', 'no-store')
    if (!qaSession.consumedAt) return response.status(403).json({ error: 'Submit your answer first.', code: 'NOT_SUBMITTED' })
    if (!(await describeSession(poll, qaSession.id)).adCompleted) {
      return response.status(403).json({ error: 'Finish watching the advertisement to see your result.', code: 'AD_REQUIRED' })
    }
    const entry = await database.prepare(`
      SELECT v.is_correct AS isCorrect, o.label AS selectedAnswer
      FROM poll_voters v JOIN poll_options o ON o.id = v.option_id WHERE v.voting_session_id = ?
    `).get(qaSession.id)
    if (!entry) return response.status(404).json({ error: 'No answer was found for this session.' })
    const isWinner = Boolean(entry.isCorrect)
    const revealCorrect = Boolean((await database.prepare('SELECT reveal_correct AS revealCorrect FROM polls WHERE id = ?').get(poll.id))?.revealCorrect)
    const correctAnswer = isWinner || revealCorrect
      ? (await database.prepare('SELECT o.label FROM polls p JOIN poll_options o ON o.id = p.correct_option_id WHERE p.id = ?').get(poll.id))?.label ?? null
      : null
    response.json({ fullName: qaSession.fullName, ticketNumber: qaSession.ticketNumber, isWinner, selectedAnswer: entry.selectedAnswer, correctAnswer })
  })

  async function buildMonitor(pollId) {
    const poll = await getPoll(pollId, { admin: true })
    const adRequired = Boolean(await activeAd(await selectPoll.get(pollId)))
    const records = await database.prepare(`
      SELECT s.id AS sessionId, s.full_name AS fullName, s.ticket_number AS ticketNumber, s.registered_at AS registeredAt,
        v.created_at AS submittedAt, o.label AS selectedAnswer, v.is_correct AS isCorrect,
        v.verification_status AS verificationStatus, a.status AS adStatus
      FROM poll_voting_sessions s
      LEFT JOIN poll_voters v ON v.voting_session_id = s.id
      LEFT JOIN poll_options o ON o.id = v.option_id
      LEFT JOIN ad_playbacks a ON a.voting_session_id = s.id
      WHERE s.poll_id = ? AND s.ticket_key IS NOT NULL
    `).all(pollId)

    const ranks = new Map(records
      .filter((record) => record.submittedAt && record.isCorrect)
      .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt))
      .map((record, index) => [record.sessionId, index + 1]))

    const rows = records
      .map((record) => ({
        sessionId: record.sessionId,
        rank: ranks.get(record.sessionId) ?? null,
        fullName: record.fullName,
        ticketNumber: record.ticketNumber,
        question: poll.question || 'Image question',
        selectedAnswer: record.selectedAnswer,
        result: !record.submittedAt ? 'PENDING' : record.isCorrect ? 'WIN' : 'LOSE',
        submittedAt: record.submittedAt,
        registeredAt: record.registeredAt,
        adStatus: record.adStatus === 'completed' ? 'Completed' : !record.submittedAt ? 'Pending' : adRequired ? 'Pending' : 'Not required',
        verificationStatus: record.verificationStatus || 'pending',
      }))
      .sort((left, right) => (right.submittedAt || right.registeredAt || '').localeCompare(left.submittedAt || left.registeredAt || ''))

    const submissions = rows.filter((row) => row.result !== 'PENDING').length
    const winners = rows.filter((row) => row.result === 'WIN').length
    return {
      poll: {
        id: poll.id, question: poll.question, votingEnabled: poll.votingEnabled, revealCorrect: poll.revealCorrect,
        correctAnswer: poll.options.find((option) => option.id === poll.correctOptionId)?.label ?? null,
      },
      stats: {
        participants: rows.length,
        submissions,
        winners,
        nonWinners: submissions - winners,
        participationPercentage: rows.length ? Math.round(submissions / rows.length * 1000) / 10 : 0,
        adCompletions: rows.filter((row) => row.adStatus === 'Completed').length,
      },
      rows,
      generatedAt: new Date().toISOString(),
    }
  }

  app.get('/api/polls/:id/monitor', requireUser, requireQaPoll, async (request, response) => {
    response.set('Cache-Control', 'no-store').json(await buildMonitor(request.poll.id))
  })

  app.get('/api/polls/:id/monitor/stream', requireUser, requireQaPoll, (request, response) => {
    const pollId = request.poll.id
    response.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    response.flushHeaders()
    response.write('retry: 3000\n\n')
    let pending = null
    const send = () => {
      if (pending) return
      pending = setTimeout(() => { pending = null; response.write(`event: update\ndata: ${Date.now()}\n\n`) }, 250)
    }
    events.on(pollId, send)
    const keepAlive = setInterval(() => response.write(': keep-alive\n\n'), 25_000)
    request.on('close', () => {
      events.off(pollId, send)
      clearInterval(keepAlive)
      clearTimeout(pending)
    })
  })

  app.get('/api/polls/:id/monitor.csv', requireUser, requireQaPoll, async (request, response) => {
    const filter = ['winners', 'losers'].includes(request.query.filter) ? request.query.filter : 'all'
    const search = typeof request.query.q === 'string' ? request.query.q.trim().toLowerCase().slice(0, 80) : ''
    const rows = (await buildMonitor(request.poll.id)).rows
      .filter((row) => filter === 'all' || (filter === 'winners' ? row.result === 'WIN' : row.result === 'LOSE'))
      .filter((row) => !search || row.fullName.toLowerCase().includes(search) || row.ticketNumber.toLowerCase().includes(search))
    const lines = [['Rank', 'Participant Name', 'Ticket Number', 'Question', 'Selected Answer', 'Result', 'Submission Time', 'Ad Status', 'Verification']]
      .concat(rows.map((row) => [row.rank, row.fullName, row.ticketNumber, row.question, row.selectedAnswer, row.result, row.submittedAt, row.adStatus, row.verificationStatus]))
      .map((line) => line.map(csvCell).join(','))
    await audit(request, 'qa.export', 'poll', request.poll.id, { filter, rows: rows.length })
    response
      .set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="qa-${request.poll.id.slice(0, 8)}-${filter}.csv"`, 'Cache-Control': 'no-store' })
      .send(`\uFEFF${lines.join('\r\n')}\r\n`)
  })

  app.patch('/api/polls/:id/submissions/:sessionId/verification', requireAdmin, requireQaPoll, async (request, response) => {
    const status = request.body?.status
    if (!verificationStatuses.includes(status)) return response.status(400).json({ error: 'Use pending, verified, or rejected.' })
    const result = await database.prepare('UPDATE poll_voters SET verification_status = ?, verified_by = ?, verified_at = ? WHERE poll_id = ? AND voting_session_id = ? AND is_correct = 1')
      .run(status, request.user.id, new Date().toISOString(), request.poll.id, request.params.sessionId)
    if (result.changes !== 1) return response.status(404).json({ error: 'That winner could not be found.' })
    await audit(request, 'qa.verify-winner', 'poll', request.poll.id, { sessionId: request.params.sessionId, status })
    notify(request.poll.id)
    response.json({ status })
  })

  app.patch('/api/polls/:id', requireUser, requireQaPoll, async (request, response) => {
    const { poll } = request
    const body = request.body || {}
    const submissions = (await database.prepare('SELECT COUNT(*) AS count FROM poll_voters WHERE poll_id = ?').get(poll.id)).count
    const question = body.question === undefined ? undefined : typeof body.question === 'string' ? body.question.trim() : null
    if (question === null || (question !== undefined && (question.length > 160 || (!poll.questionImageUrl && question.length < 3)))) {
      return response.status(400).json({ error: 'Add a question of 3–160 characters.' })
    }
    if (body.revealCorrect !== undefined && typeof body.revealCorrect !== 'boolean') return response.status(400).json({ error: 'Reveal setting must be true or false.' })
    const joinTitle = body.joinTitle === undefined ? undefined : typeof body.joinTitle === 'string' ? body.joinTitle.trim() : null
    if (joinTitle === null || (joinTitle !== undefined && joinTitle.length > 80)) return response.status(400).json({ error: 'The join title must be 80 characters or fewer.' })
    const optionRows = await database.prepare('SELECT id, CASE WHEN image IS NULL THEN 0 ELSE 1 END AS hasImage FROM poll_options WHERE poll_id = ?').all(poll.id)
    const optionsById = new Map(optionRows.map((option) => [option.id, option]))
    const optionIds = new Set(optionsById.keys())
    const labels = Array.isArray(body.options) ? body.options.map((option) => ({ id: option?.id, label: typeof option?.label === 'string' ? option.label.trim() : '' })) : []
    if (body.options !== undefined && (!Array.isArray(body.options) || labels.some((option) => !optionIds.has(option.id) || (!option.label && !optionsById.get(option.id)?.hasImage) || option.label.length > 80))) {
      return response.status(400).json({ error: 'Answer options need text or an image and must be 80 characters or fewer.' })
    }
    if (body.correctOptionId !== undefined) {
      if (typeof body.correctOptionId !== 'string' || !optionIds.has(body.correctOptionId)) return response.status(400).json({ error: 'Choose one of the answers as correct.' })
      const current = (await database.prepare('SELECT correct_option_id AS id FROM polls WHERE id = ?').get(poll.id)).id
      if (submissions > 0 && body.correctOptionId !== current) return response.status(409).json({ error: 'The correct answer cannot change after participants have submitted answers.' })
    }
    await inTransaction(async () => {
      if (question !== undefined) await database.prepare('UPDATE polls SET question = ? WHERE id = ?').run(question, poll.id)
      if (joinTitle !== undefined) await database.prepare('UPDATE polls SET join_title = ? WHERE id = ?').run(joinTitle || null, poll.id)
      if (body.revealCorrect !== undefined) await database.prepare('UPDATE polls SET reveal_correct = ? WHERE id = ?').run(Number(body.revealCorrect), poll.id)
      if (body.correctOptionId !== undefined) await database.prepare('UPDATE polls SET correct_option_id = ? WHERE id = ?').run(body.correctOptionId, poll.id)
      for (const option of labels) await database.prepare('UPDATE poll_options SET label = ? WHERE id = ? AND poll_id = ?').run(option.label, option.id, poll.id)
    })
    await audit(request, 'qa.edit', 'poll', poll.id, { fields: Object.keys(body) })
    notify(poll.id)
    response.json(await getPoll(poll.id, { admin: true }))
  })

  app.delete('/api/polls/:id', requireUser, async (request, response) => {
    const poll = await selectPoll.get(request.params.id)
    if (!poll) return response.status(404).json({ error: 'This poll could not be found.' })
    await database.prepare('DELETE FROM polls WHERE id = ?').run(poll.id)
    await audit(request, poll.isQa ? 'qa.delete' : 'poll.delete', 'poll', poll.id, { question: poll.question })
    notify(poll.id)
    response.status(204).end()
  })

  app.get('/api/admin/audit-logs', requireAdmin, async (_request, response) => {
    response.set('Cache-Control', 'no-store').json({
      logs: await database.prepare('SELECT id, username, action, target_type AS targetType, target_id AS targetId, details, ip_address AS ipAddress, created_at AS createdAt FROM audit_logs ORDER BY created_at DESC LIMIT 500').all(),
    })
  })

  return { describeSession }
}
