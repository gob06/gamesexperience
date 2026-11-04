import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowUpRight, Check } from 'lucide-react'
import { ThemeBrand } from './theme'
import { TermsNotice } from './terms'
import { ThankYouScreen } from './AdVideo'

export type QaPoll = {
  id: string
  question: string
  questionImageUrl?: string | null
  options: Array<{ id: string; label: string; imageUrl?: string | null }>
  votingEnabled: boolean
}

type QaSession = { registered: boolean; fullName: string | null; ticketNumber: string | null; submitted: boolean; adRequired: boolean; adCompleted: boolean }
type QaResult = { fullName: string; ticketNumber: string; isWinner: boolean; selectedAnswer: string; correctAnswer: string | null }

async function postJson<T>(url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  const data = await response.json().catch(() => ({})) as T & { error?: string }
  return { ok: response.ok, status: response.status, data }
}

// Plays the Q&A advertisement with no controls. The server records start, progress and completion; the result stays locked until it confirms.
function QaAdPlayer({ pollId, onCompleted }: { pollId: string; onCompleted: () => void }) {
  const base = `/api/polls/${encodeURIComponent(pollId)}/ad`
  const videoRef = useRef<HTMLVideoElement>(null)
  const lastTime = useRef(0)
  const done = useRef(onCompleted)
  done.current = onCompleted
  const [url, setUrl] = useState('')
  const [needsTap, setNeedsTap] = useState(false)
  const [message, setMessage] = useState('Loading your advertisement…')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    setUrl('')
    postJson<{ completed: boolean; url?: string }>(`${base}/start`).then(({ ok, data }) => {
      if (!active) return
      if (!ok) { setMessage(data.error || 'The advertisement could not start.'); return }
      if (data.completed) done.current()
      else if (data.url) { setUrl(data.url); setMessage('') }
    }).catch(() => { if (active) setMessage('Connection lost. Retrying…') })
    return () => { active = false }
  }, [base, attempt])

  useEffect(() => {
    if (!url) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const timer = window.setInterval(() => {
      const video = videoRef.current
      if (video && !video.paused) void fetch(`${base}/progress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: video.currentTime }) }).catch(() => undefined)
    }, 5000)
    return () => { document.body.style.overflow = previousOverflow; window.clearInterval(timer) }
  }, [url, base])

  const play = useCallback(async () => {
    const video = videoRef.current
    if (!video) return
    try {
      await video.play()
      setNeedsTap(false)
    } catch {
      video.muted = true
      try { await video.play(); setNeedsTap(false) } catch { setNeedsTap(true) }
    }
  }, [])

  const complete = useCallback(async (remainingRetries = 6) => {
    const video = videoRef.current
    try {
      const { ok, status, data } = await postJson<{ completed: boolean; remainingSeconds?: number }>(`${base}/complete`, { position: video?.currentTime ?? 0, clientDuration: video?.duration })
      if (ok && data.completed) { done.current(); return }
      if (status === 409 && remainingRetries > 0) {
        window.setTimeout(() => void complete(remainingRetries - 1), Math.max(1, data.remainingSeconds ?? 1) * 1000 + 300)
        return
      }
      setMessage(data.error || 'Could not confirm the advertisement finished.')
    } catch {
      if (remainingRetries > 0) window.setTimeout(() => void complete(remainingRetries - 1), 2000)
      else setMessage('Connection lost while confirming the advertisement.')
    }
  }, [base])

  return (
    <div className="ad-video-overlay" role="dialog" aria-modal="true" aria-label="Sponsored video" onContextMenu={(event) => event.preventDefault()}>
      {url && (
        <video
          ref={videoRef}
          className="ad-video-player"
          src={url}
          autoPlay
          playsInline
          disablePictureInPicture
          disableRemotePlayback
          controlsList="nodownload noplaybackrate noremoteplayback"
          onLoadedData={() => void play()}
          onTimeUpdate={(event) => { if (!event.currentTarget.seeking) lastTime.current = event.currentTarget.currentTime }}
          onSeeking={(event) => { event.currentTarget.currentTime = lastTime.current }}
          onPause={(event) => { if (!event.currentTarget.ended) void play() }}
          onEnded={() => void complete()}
          onError={() => setMessage('The video could not be played.')}
        />
      )}
      {needsTap && <button className="button button-primary ad-tap-button" type="button" onClick={() => void play()}>Tap to play your video</button>}
      {message && (
        <div className="ad-message" role="status">
          <p>{message}</p>
          {url || /could not|lost|confirm/i.test(message) ? <button className="button button-secondary" type="button" onClick={() => { setMessage('Loading your advertisement…'); setAttempt((value) => value + 1) }}>Try again</button> : null}
        </div>
      )}
    </div>
  )
}

function Confetti() {
  const pieces = useMemo(() => Array.from({ length: 70 }, (_, index) => ({
    left: Math.random() * 100,
    delay: Math.random() * 2.5,
    duration: 3 + Math.random() * 3,
    color: ['#ffd166', '#ef476f', '#06d6a0', '#118ab2', '#f78c6b'][index % 5],
    size: 6 + Math.random() * 8,
  })), [])
  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((piece, index) => <i key={index} style={{ left: `${piece.left}%`, animationDelay: `${piece.delay}s`, animationDuration: `${piece.duration}s`, background: piece.color, width: piece.size, height: piece.size * 1.6 }} />)}
    </div>
  )
}

function ResultScreen({ pollId }: { pollId: string }) {
  const [result, setResult] = useState<QaResult | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    fetch(`/api/polls/${encodeURIComponent(pollId)}/result`).then(async (response) => {
      const data = await response.json().catch(() => ({}))
      if (!active) return
      if (response.ok) setResult(data)
      else setError(data.error || 'Could not load your result.')
    }).catch(() => { if (active) setError('Could not load your result.') })
    return () => { active = false }
  }, [pollId])

  if (error) return <div className="qa-screen"><p className="form-error" role="alert">{error}</p></div>
  if (!result) return <div className="qa-screen"><div className="skeleton-line" /></div>
  return result.isWinner ? (
    <div className="qa-screen qa-screen-win" role="status">
      <Confetti />
      <span className="qa-big-emoji" aria-hidden="true">🏆</span>
      <h1 className="qa-big-title">WINNER!</h1>
      <p className="qa-lead">Congratulations, {result.fullName}! You answered correctly.</p>
      <dl className="qa-facts">
        <div><dt>Name</dt><dd>{result.fullName}</dd></div>
        <div><dt>Ticket number</dt><dd>{result.ticketNumber}</dd></div>
        {result.correctAnswer && <div><dt>Correct answer</dt><dd>{result.correctAnswer}</dd></div>}
      </dl>
      <p className="qa-note">Show this screen to the event staff to claim your prize.</p>
    </div>
  ) : (
    <div className="qa-screen qa-screen-lose" role="status">
      <span className="qa-big-emoji" aria-hidden="true">😔</span>
      <h1 className="qa-big-title">BETTER LUCK NEXT TIME!</h1>
      <p className="qa-lead">Sorry, {result.fullName}, that was not the correct answer.</p>
      <dl className="qa-facts">
        <div><dt>Name</dt><dd>{result.fullName}</dd></div>
        <div><dt>Ticket number</dt><dd>{result.ticketNumber}</dd></div>
        <div><dt>Your answer</dt><dd>{result.selectedAnswer}</dd></div>
        {result.correctAnswer && <div><dt>Correct answer</dt><dd>{result.correctAnswer}</dd></div>}
      </dl>
    </div>
  )
}

export default function QaAudience({ pollId, initialPoll }: { pollId: string; initialPoll: QaPoll }) {
  const [poll, setPoll] = useState(initialPoll)
  const [session, setSession] = useState<QaSession | null>(null)
  const [fullName, setFullName] = useState('')
  const [ticketNumber, setTicketNumber] = useState('')
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const url = `/api/polls/${encodeURIComponent(pollId)}`

  useEffect(() => {
    let active = true
    postJson<{ qa?: QaSession }>(`${url}/session`).then(({ ok, data }) => {
      if (!active) return
      if (!ok || !data.qa) { setError(data.error || 'Could not start your session. Reload the page.'); return }
      setSession(data.qa)
      if (data.qa.fullName) setFullName(data.qa.fullName)
      if (data.qa.ticketNumber) setTicketNumber(data.qa.ticketNumber)
    }).catch(() => { if (active) setError('Could not reach the server. Check your connection.') })
    return () => { active = false }
  }, [url])

  useEffect(() => {
    if (!session || session.submitted) return
    const timer = window.setInterval(() => {
      fetch(url).then(async (response) => { if (response.ok) setPoll(await response.json()) }).catch(() => undefined)
    }, 5000)
    return () => window.clearInterval(timer)
  }, [url, session])

  async function register(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const { ok, data } = await postJson<{ fullName: string; ticketNumber: string }>(`${url}/register`, { fullName: fullName.trim(), ticketNumber: ticketNumber.trim() })
      if (!ok) { setError(data.error || 'Could not register.'); return }
      setSession((current) => current && { ...current, registered: true, fullName: data.fullName, ticketNumber: data.ticketNumber })
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function enter() {
    if (!selected || busy) return
    setBusy(true)
    setError('')
    try {
      const { ok, status, data } = await postJson<QaSession>(`${url}/votes`, { optionId: selected })
      if (ok || status === 409) setSession(data)
      else setError(data.error || 'Your answer could not be saved.')
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  let body
  if (!session) {
    body = <div className="qa-screen">{error ? <p className="form-error" role="alert">{error}</p> : <div className="skeleton-line" />}</div>
  } else if (session.submitted && !session.adCompleted) {
    body = <QaAdPlayer pollId={pollId} onCompleted={() => setSession((current) => current && { ...current, adCompleted: true })} />
  } else if (session.submitted) {
    body = <ThankYouScreen><ResultScreen pollId={pollId} /></ThankYouScreen>
  } else if (!session.registered) {
    body = (
      <form className="vote-card qa-register" onSubmit={(event) => void register(event)}>
        <div className="vote-card-kicker"><span className="live-indicator" /> LIVE Q&amp;A</div>
        <h1>Join the game</h1>
        <p className="vote-instruction">{poll.votingEnabled ? 'Enter your details to see the question.' : 'This Q&A is not open yet. Check back soon.'}</p>
        <label className="qa-name-label" htmlFor="qa-full-name">Full name<input id="qa-full-name" className="qa-name-input" type="text" autoComplete="name" maxLength={80} value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Your full name" required disabled={!poll.votingEnabled} /></label>
        <label className="qa-name-label" htmlFor="qa-ticket-number">Ticket number<input id="qa-ticket-number" className="qa-name-input" type="text" autoComplete="off" maxLength={40} value={ticketNumber} onChange={(event) => setTicketNumber(event.target.value)} placeholder="Your ticket number" required disabled={!poll.votingEnabled} /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button-primary submit-vote" type="submit" disabled={busy || !poll.votingEnabled || !fullName.trim() || !ticketNumber.trim()}>Continue <ArrowUpRight size={17} /></button>
                <TermsNotice />
              </form>
    )
  } else {
    body = (
      <section className="vote-card qa-question">
        <div className="vote-card-kicker"><span className="live-indicator" /> LIVE Q&amp;A <span className="kicker-divider">/</span> {session.fullName} · #{session.ticketNumber}</div>
        {poll.questionImageUrl && <img className="question-image" src={poll.questionImageUrl} alt={poll.question || 'Question'} />}
        {(poll.question || !poll.questionImageUrl) && <h1 className="qa-question-text">{poll.question}</h1>}
        <p className="vote-instruction">{poll.votingEnabled ? 'Choose one answer, then press ENTER. You cannot change it afterwards.' : 'Answers are currently closed. Check back soon.'}</p>
        <div className="vote-options">
          {poll.options.map((option, index) => (
            <button key={option.id} type="button" className={`vote-option qa-option ${selected === option.id ? 'is-selected' : ''}`} disabled={!poll.votingEnabled || busy} onClick={() => setSelected(option.id)} aria-pressed={selected === option.id}>
              <span className={`option-marker marker-${index % 4}`}>{String.fromCharCode(65 + index)}</span>
              {option.imageUrl && <img className="vote-option-image" src={option.imageUrl} alt="" />}
              <span className="vote-option-label">{option.label}</span>
              <span className="radio-mark" />
            </button>
          ))}
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button-primary submit-vote qa-enter" type="button" onClick={() => void enter()} disabled={!selected || busy || !poll.votingEnabled}>ENTER <Check size={18} /></button>
                <TermsNotice />
              </section>
    )
  }

  return (
    <div className="vote-shell">
      <header className="vote-topbar"><ThemeBrand /><span className="vote-top-label">LIVE Q&amp;A</span></header>
      <main className="vote-main">
        {body}
      </main>
    </div>
  )
}
