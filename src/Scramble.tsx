import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import QRCode from 'qrcode'
import {
  ArrowLeft, ArrowUpRight, Check, CircleCheck, CircleX, Copy, Eye, ImagePlus, Lock, LogOut, Megaphone,
  MonitorPlay, Pause, Play, QrCode, RefreshCw, Search, Shuffle, Smartphone, Square, Ticket, Trash2, Trophy, Users, X,
} from 'lucide-react'
import { ThemeBrand, useTheme } from './theme'
import { AdVideoOverlay } from './AdVideo'
import { TermsNotice } from './terms'
import { SavedLogoPicker, logoToFile, saveLogo, type SavedLogo } from './logoLibrary'

type ScrambleStatus = 'draft' | 'active' | 'paused' | 'closed' | 'completed'

type ScrambleSummary = {
  id: string
  title: string
  status: ScrambleStatus
  createdAt: string
  logoUrl: string | null
  entryCount?: number
  winnerCount?: number
}

type PublicScramble = {
  id: string
  title: string
  status: ScrambleStatus
  logoUrl: string | null
  scrambled: string | null
  revealedAnswer: string | null
  registrationOpen: boolean
  submissionOpen: boolean
}

type HostScramble = {
  id: string
  title: string
  status: ScrambleStatus
  logoUrl: string | null
  answer: string
  scrambled: string
  answerRevealed: boolean
  createdAt: string
  updatedAt: string
}

type ScrambleEntry = {
  id: string
  participantName: string
  ticketNumber: string
  registeredAt: string
  answer: string | null
  isCorrect: boolean | null
  answeredAt: string | null
  selectedAt: string | null
  confirmedAt: string | null
  announcedAt: string | null
}

type ScrambleStats = {
  registrations: number
  answered: number
  correct: number
  incorrect: number
  notSubmitted: number
  eligible: number
  selected: number
  confirmed: number
  announced: number
}

type HostScrambleData = {
  game: HostScramble
  stats: ScrambleStats
  entries: ScrambleEntry[]
}

type ParticipantRecord = {
  id: string
  participantName: string
  ticketNumber: string
}

type ParticipantData = {
  game: PublicScramble
  me: { id: string; participantName: string; ticketNumber: string; answered: boolean; isCorrect: boolean | null }
}

type DisplayData = {
  game: PublicScramble
  counts: { registrations: number; answered: number }
  announcedWinners: { id: string; participantName: string; ticketNumber: string; announcedAt: string }[]
}

type ScrambleTab = 'qr' | 'game' | 'participants' | 'winners'

const statusLabels: Record<ScrambleStatus, string> = {
  draft: 'Not started',
  active: 'Game active',
  paused: 'Paused',
  closed: 'Closed',
  completed: 'Completed',
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'The word scramble request could not be completed.')
  return data as T
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  return requestJson<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function scrambleJoinUrl(gameId: string) {
  const url = new URL(`/scramble/join/${encodeURIComponent(gameId)}`, window.location.origin)
  if (!['localhost', '127.0.0.1'].includes(window.location.hostname)) return url.href
  try {
    const response = await fetch('/api/network-addresses')
    if (!response.ok) return url.href
    const result = await response.json() as { addresses: string[] }
    if (result.addresses.length) url.hostname = result.addresses[0]
  } catch { /* Keep the same-origin link if LAN discovery is unavailable. */ }
  return url.href
}

async function renderScrambleQr(canvas: HTMLCanvasElement, value: string, logoUrl: string | null, size: number) {
  await QRCode.toCanvas(canvas, value, {
    width: size,
    margin: 2,
    errorCorrectionLevel: 'H',
    color: { dark: '#15151a', light: '#ffffff' },
  })
  if (!logoUrl) return
  const logo = new Image()
  await new Promise<void>((resolve) => {
    logo.onload = () => resolve()
    logo.onerror = () => resolve()
    logo.src = logoUrl
  })
  if (!logo.naturalWidth) return
  const context = canvas.getContext('2d')
  if (!context) return
  const displayed = canvas.clientWidth || size
  const boxSize = Math.min(Math.round(200 * size / displayed), Math.round(size * 0.3))
  const padding = Math.max(2, Math.round(boxSize * .025))
  const fitSize = boxSize - padding * 2
  const scale = Math.min(fitSize / logo.naturalWidth, fitSize / logo.naturalHeight)
  const width = logo.naturalWidth * scale
  const height = logo.naturalHeight * scale
  context.fillStyle = '#ffffff'
  context.fillRect((size - boxSize) / 2, (size - boxSize) / 2, boxSize, boxSize)
  context.drawImage(logo, (size - width) / 2, (size - height) / 2, width, height)
}

function ScrambleQrCode({ value, logoUrl, size = 1024, label }: { value: string; logoUrl: string | null; size?: number; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !value) return
    let active = true
    let timer = 0
    const draw = () => { void renderScrambleQr(canvas, value, logoUrl, size) }
    draw()
    const onResize = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { if (active) draw() }, 150) }
    window.addEventListener('resize', onResize)
    return () => { active = false; window.clearTimeout(timer); window.removeEventListener('resize', onResize) }
  }, [value, logoUrl, size])
  return <canvas ref={canvasRef} aria-label={label} />
}

function ScrambledWord({ word, compact }: { word: string; compact?: boolean }) {
  return (
    <span className={`scramble-word ${compact ? 'is-compact' : ''}`} aria-label={`Scrambled word: ${word}`}>
      {[...word].map((letter, index) => letter === ' '
        ? <span key={index} className="scramble-word-space" aria-hidden="true" />
        : <span key={index} className="scramble-word-letter">{letter}</span>)}
    </span>
  )
}

function entryStorageKey(gameId: string) {
  return `scramble-entry-${gameId}`
}

function loadStoredEntry(gameId: string): ParticipantRecord | null {
  try {
    const raw = window.localStorage.getItem(entryStorageKey(gameId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as ParticipantRecord
    return parsed?.id ? parsed : null
  } catch {
    return null
  }
}

export function ScrambleJoinPage({ gameId }: { gameId: string }) {
  const { assetUrls } = useTheme()
  const [entry, setEntry] = useState<ParticipantRecord | null>(() => loadStoredEntry(gameId))
  const [game, setGame] = useState<PublicScramble | null>(null)
  const [me, setMe] = useState<ParticipantData['me'] | null>(null)
  const [participantName, setParticipantName] = useState('')
  const [ticketNumber, setTicketNumber] = useState('')
  const [answer, setAnswer] = useState('')
  const [result, setResult] = useState<'correct' | 'incorrect' | null>(null)
  const [showAd, setShowAd] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    async function refresh() {
      try {
        if (entry) {
          const data = await requestJson<ParticipantData>(`/api/scrambles/${encodeURIComponent(gameId)}/participant/${encodeURIComponent(entry.id)}`)
          if (!active) return
          setGame(data.game)
          setMe(data.me)
          if (data.me.answered && data.me.isCorrect !== null) setResult(data.me.isCorrect ? 'correct' : 'incorrect')
        } else {
          const data = await requestJson<PublicScramble>(`/api/scrambles/${encodeURIComponent(gameId)}`)
          if (!active) return
          setGame(data)
        }
        setError('')
      } catch (caught) {
        if (!active) return
        if (entry && caught instanceof Error && caught.message.includes('registration')) {
          window.localStorage.removeItem(entryStorageKey(gameId))
          setEntry(null)
          setMe(null)
        } else {
          setError(caught instanceof Error ? caught.message : 'Could not open this word scramble.')
        }
      } finally {
        if (active) setLoading(false)
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1500)
    return () => { active = false; window.clearInterval(timer) }
  }, [gameId, entry])

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!game?.registrationOpen) return
    setBusy(true)
    setError('')
    try {
      const created = await postJson<ParticipantRecord>(`/api/scrambles/${encodeURIComponent(gameId)}/register`, { participantName, ticketNumber })
      window.localStorage.setItem(entryStorageKey(gameId), JSON.stringify(created))
      setEntry(created)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not register.')
    } finally {
      setBusy(false)
    }
  }

  async function submitAnswer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!entry || !answer.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const outcome = await postJson<{ correct: boolean }>(`/api/scrambles/${encodeURIComponent(gameId)}/answer`, { entryId: entry.id, answer })
      setResult(outcome.correct ? 'correct' : 'incorrect')
      setMe((current) => current ? { ...current, answered: true, isCorrect: outcome.correct } : current)
      setShowAd(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not submit your answer.')
    } finally {
      setBusy(false)
    }
  }

  const gameEnded = game?.status === 'closed' || game?.status === 'completed'
  const answered = Boolean(me?.answered || result)

  return (
    <main className="raffle-audience-shell scramble-audience-shell">
      <section className="raffle-audience-panel">
        {loading ? <p className="raffle-muted">Loading word scramble…</p> : !game ? (
          <div className="raffle-notice raffle-error" role="alert">{error || 'This word scramble could not be found.'}</div>
        ) : (
          <>
            {(game.logoUrl || assetUrls.logo) && <img className="raffle-event-logo" src={game.logoUrl || assetUrls.logo} alt="Event logo" />}
            <h1 className="scramble-audience-title">{game.title}</h1>

            {!entry ? (
              game.registrationOpen ? (
                <form className="raffle-entry-form" onSubmit={(event) => void register(event)}>
                  <p className="scramble-instructions">Unscramble the word to enter the winner pool. Register once with your name and ticket number.</p>
                  <label htmlFor="scramble-participant-name">Your name</label>
                  <input id="scramble-participant-name" autoComplete="name" maxLength={80} value={participantName} onChange={(event) => setParticipantName(event.target.value)} placeholder="Enter your name" required />
                  <label htmlFor="scramble-ticket-number">Ticket number</label>
                  <input id="scramble-ticket-number" autoComplete="off" maxLength={40} value={ticketNumber} onChange={(event) => setTicketNumber(event.target.value)} placeholder="Enter your ticket number" required />
                  {error && <p className="raffle-notice raffle-error" role="alert">{error}</p>}
                  <button className="button button-primary raffle-submit" type="submit" disabled={busy}>{busy ? 'Registering…' : 'Register and continue'} <Ticket size={17} /></button>
                  <TermsNotice />
                </form>
              ) : (
                <div className="raffle-notice" role="status">Participation for this game has ended.</div>
              )
            ) : answered ? (
              showAd ? (
                <>
                  <p className="raffle-muted" role="status">Your answer has been recorded…</p>
                  <AdVideoOverlay kind="scramble" onDone={() => setShowAd(false)} />
                </>
              ) : (
                <div className={`scramble-result ${result === 'correct' ? 'is-correct' : 'is-incorrect'}`} role="status">
                  <p className="scramble-thanks">THANK YOU FOR PARTICIPATING!</p>
                  {result === 'correct' ? <CircleCheck size={42} /> : <CircleX size={42} />}
                  <strong>{result === 'correct' ? 'CORRECT!' : 'INCORRECT'}</strong>
                  <span>
                    {result === 'correct'
                      ? `You are in the eligible winner pool. Good luck, ${entry.participantName}!`
                      : 'That is not the right answer, so this entry is not eligible for the winner selection.'}
                  </span>
                  {game.revealedAnswer && <p className="scramble-revealed">The correct answer was <strong>{game.revealedAnswer}</strong></p>}
                </div>
              )
            ) : gameEnded ? (
              <div className="raffle-notice" role="status">Participation has ended. Answers can no longer be submitted.</div>
            ) : game.status === 'active' && game.scrambled ? (
              <form className="raffle-entry-form" onSubmit={(event) => void submitAnswer(event)}>
                <p className="scramble-instructions">Rearrange these letters into the correct word or phrase. You only get one try!</p>
                <ScrambledWord word={game.scrambled} />
                <label htmlFor="scramble-answer">Your answer</label>
                <input id="scramble-answer" autoComplete="off" maxLength={120} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Type your answer" required />
                {error && <p className="raffle-notice raffle-error" role="alert">{error}</p>}
                <button className="button button-primary raffle-submit" type="submit" disabled={busy || !answer.trim()}>{busy ? 'Submitting…' : 'Submit answer'} <ArrowUpRight size={17} /></button>
              </form>
            ) : game.status === 'paused' ? (
              <div className="raffle-notice" role="status"><Pause size={18} /> The game is paused. Hang tight — the host will resume shortly.</div>
            ) : (
              <div className="raffle-success" role="status"><Check size={26} /><strong>You are registered, {entry.participantName}.</strong><span>The scrambled word will appear here when the host starts the game.</span></div>
            )}
          </>
        )}
      </section>
    </main>
  )
}

export function ScrambleDisplayPage({ gameId }: { gameId: string }) {
  const { assetUrls } = useTheme()
  const [data, setData] = useState<DisplayData | null>(null)
  const [shareUrl, setShareUrl] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    async function refresh() {
      try {
        const [result, url] = await Promise.all([
          requestJson<DisplayData>(`/api/scrambles/${encodeURIComponent(gameId)}/display`),
          scrambleJoinUrl(gameId),
        ])
        if (!active) return
        setData(result)
        setShareUrl(url)
        setError('')
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : 'Could not load the display.')
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 900)
    return () => { active = false; window.clearInterval(timer) }
  }, [gameId])

  useEffect(() => {
    function toggleFullscreen() {
      if (document.fullscreenElement) void document.exitFullscreen()
      else void document.documentElement.requestFullscreen().catch(() => undefined)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 'f' || event.repeat) return
      event.preventDefault()
      toggleFullscreen()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('dblclick', toggleFullscreen)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('dblclick', toggleFullscreen)
    }
  }, [])

  if (!data) return <main className="scramble-screen-shell"><div className="raffle-screen-message">{error || 'Connecting to word scramble…'}</div></main>

  const { game, announcedWinners } = data
  const eventLogoUrl = game.logoUrl || assetUrls.logo || null
  // The display only ever shows public states: intro QR, scrambled word, the official
  // reveal, announced winners, and the completion screen. Never the randomizer.
  const screen = game.status === 'completed' ? 'completed'
    : announcedWinners.length ? 'winners'
    : game.revealedAnswer ? 'reveal'
    : game.status === 'draft' ? 'intro'
    : 'word'

  return (
    <main className={`scramble-screen-shell is-${screen}`}>
      {screen === 'intro' && (
        <section className="scramble-screen-intro" aria-label="Word scramble registration QR code">
          <h1 className="scramble-screen-title">{game.title}</h1>
          <p className="scramble-screen-subtitle">WORD SCRAMBLE · Scan to register and play</p>
          <div className="scramble-screen-qr">{shareUrl ? <ScrambleQrCode value={shareUrl} logoUrl={eventLogoUrl} size={1024} label={`QR code to join ${game.title}`} /> : <span>Loading QR…</span>}</div>
          <p className="raffle-screen-scan"><Smartphone aria-hidden="true" />Register with your name and ticket number</p>
        </section>
      )}
      {screen === 'word' && (
        <section className="scramble-screen-stage" aria-live="polite">
          <h1 className="scramble-screen-title">{game.title}</h1>
          {game.status === 'paused' && <span className="scramble-screen-badge">GAME PAUSED</span>}
          {game.status === 'closed' && <span className="scramble-screen-badge">SUBMISSIONS CLOSED</span>}
          {game.scrambled && <ScrambledWord word={game.scrambled} />}
          <p className="scramble-screen-subtitle">
            {game.status === 'active' ? 'Unscramble the word on your phone — correct answers enter the winner pool!' : game.status === 'closed' ? 'Winners are being selected. Stay tuned!' : 'The game will resume in a moment.'}
          </p>
          {game.status === 'active' && shareUrl && (
            <div className="scramble-screen-corner-qr">
              <ScrambleQrCode value={shareUrl} logoUrl={eventLogoUrl} size={512} label={`QR code to join ${game.title}`} />
              <span>Scan to play</span>
            </div>
          )}
        </section>
      )}
      {screen === 'reveal' && (
        <section className="scramble-screen-stage" aria-live="polite">
          <h1 className="scramble-screen-title">{game.title}</h1>
          <p className="scramble-screen-subtitle">THE CORRECT ANSWER IS</p>
          <div className="scramble-screen-reveal"><ScrambledWord word={game.revealedAnswer || ''} /></div>
        </section>
      )}
      {screen === 'winners' && (
        <section className="scramble-screen-stage" aria-live="polite">
          <h1 className="scramble-screen-title">{game.title}</h1>
          <p className="scramble-screen-subtitle"><Trophy aria-hidden="true" /> WINNERS</p>
          <ul className="scramble-screen-winners">
            {announcedWinners.map((winner, index) => (
              <li key={winner.id} style={{ animationDelay: `${index * 0.15}s` }}>
                <strong>{winner.participantName}</strong>
                <span>TICKET {winner.ticketNumber}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {screen === 'completed' && (
        <section className="scramble-screen-stage" aria-live="polite">
          <h1 className="scramble-screen-title">{game.title}</h1>
          <p className="scramble-screen-subtitle">THANK YOU FOR PLAYING!</p>
          {announcedWinners.length > 0 && (
            <ul className="scramble-screen-winners is-compact">
              {announcedWinners.map((winner) => (
                <li key={winner.id}><strong>{winner.participantName}</strong><span>TICKET {winner.ticketNumber}</span></li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  )
}

export function ScrambleHostPage({ user, onLogout }: { user: { username: string }; onLogout: () => void }) {
  const { assetUrls } = useTheme()
  const [games, setGames] = useState<ScrambleSummary[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [data, setData] = useState<HostScrambleData | null>(null)
  const [tab, setTab] = useState<ScrambleTab>('qr')

  const [title, setTitle] = useState('')
  const [answerDraft, setAnswerDraft] = useState('')
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoPreview, setLogoPreview] = useState('')
  const logoInputRef = useRef<HTMLInputElement>(null)

  const [wordAnswer, setWordAnswer] = useState('')
  const [wordScrambled, setWordScrambled] = useState('')
  const [editingWord, setEditingWord] = useState(false)

  const [winnerCount, setWinnerCount] = useState(1)
  const [participantFilter, setParticipantFilter] = useState('')
  const [shareUrl, setShareUrl] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)

  const game = data?.game || null
  const stats = data?.stats || null
  const entries = useMemo(() => data?.entries || [], [data])
  const selectedWinners = useMemo(() => entries.filter((entry) => entry.selectedAt && !entry.confirmedAt), [entries])
  const confirmedWinners = useMemo(() => entries.filter((entry) => entry.confirmedAt), [entries])
  const filteredEntries = useMemo(() => {
    const query = participantFilter.trim().toLowerCase()
    if (!query) return entries
    return entries.filter((entry) => entry.participantName.toLowerCase().includes(query) || entry.ticketNumber.toLowerCase().includes(query))
  }, [entries, participantFilter])

  useEffect(() => {
    if (!logoPreview) return
    return () => URL.revokeObjectURL(logoPreview)
  }, [logoPreview])

  useEffect(() => {
    let active = true
    void requestJson<ScrambleSummary[]>('/api/scrambles')
      .then((list) => {
        if (!active) return
        setGames(list)
        if (list[0]) setSelectedId((current) => current || list[0].id)
      })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : 'Could not load word scrambles.') })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!selectedId) {
      setData(null)
      setShareUrl('')
      return
    }
    let active = true
    async function refresh() {
      try {
        const [hostData, url] = await Promise.all([
          requestJson<HostScrambleData>(`/api/scrambles/${encodeURIComponent(selectedId)}/host`),
          scrambleJoinUrl(selectedId),
        ])
        if (!active) return
        setData(hostData)
        setShareUrl(url)
        setError('')
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : 'Could not refresh the word scramble.')
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2500)
    return () => { active = false; window.clearInterval(timer) }
  }, [selectedId])

  useEffect(() => {
    if (!game || editingWord) return
    setWordAnswer(game.answer)
    setWordScrambled(game.scrambled)
  }, [game, editingWord])

  async function refreshList() {
    try {
      setGames(await requestJson<ScrambleSummary[]>('/api/scrambles'))
    } catch { /* The next poll keeps the list current. */ }
  }

  async function createGame(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setCreating(true)
    setError('')
    setNotice('')
    const body = new FormData()
    body.append('title', title.trim())
    body.append('answer', answerDraft.trim())
    if (logoFile) body.append('logo', logoFile)
    try {
      const created = await requestJson<HostScramble>('/api/scrambles', { method: 'POST', body })
      setGames((current) => [{ id: created.id, title: created.title, status: created.status, createdAt: created.createdAt, logoUrl: created.logoUrl, entryCount: 0, winnerCount: 0 }, ...current])
      setSelectedId(created.id)
      setTitle('')
      setAnswerDraft('')
      setLogoFile(null)
      setLogoPreview('')
      if (logoInputRef.current) logoInputRef.current.value = ''
      setTab('game')
      setNotice('Word scramble created. Preview the scrambled word, then start the game.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the word scramble.')
    } finally {
      setCreating(false)
    }
  }

  async function deleteGame(target: ScrambleSummary) {
    if (!window.confirm(`Delete "${target.title}"? All registrations, answers, and winner history will be removed.`)) return
    setError('')
    setNotice('')
    try {
      const response = await fetch(`/api/scrambles/${encodeURIComponent(target.id)}`, { method: 'DELETE' })
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error || 'Could not delete the word scramble.')
      const remaining = games.filter((item) => item.id !== target.id)
      setGames(remaining)
      setSelectedId((current) => current === target.id ? remaining[0]?.id || '' : current)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete the word scramble.')
    }
  }

  function selectLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    if (!file) return
    event.currentTarget.value = ''
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return setError('Choose a JPEG, PNG, or WebP logo.')
    if (file.size > 5 * 1024 * 1024) return setError('Logo must be 5 MB or smaller.')
    setError('')
    setLogoFile(file)
    setLogoPreview(URL.createObjectURL(file))
    void saveLogo(file)
  }

  async function useSavedLogo(logo: SavedLogo) {
    try {
      const file = await logoToFile(logo)
      setError('')
      setLogoFile(file)
      setLogoPreview(URL.createObjectURL(file))
    } catch {
      setError('Could not load that image from the image bank.')
    }
  }

  async function applyHostAction(run: () => Promise<unknown>, successNotice = '') {
    if (!game) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await run()
      const hostData = await requestJson<HostScrambleData>(`/api/scrambles/${encodeURIComponent(game.id)}/host`)
      setData(hostData)
      if (successNotice) setNotice(successNotice)
      void refreshList()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The action could not be completed.')
    } finally {
      setBusy(false)
    }
  }

  function statusAction(action: 'start' | 'pause' | 'resume' | 'close' | 'complete', confirmMessage?: string) {
    if (!game) return
    if (confirmMessage && !window.confirm(confirmMessage)) return
    void applyHostAction(() => postJson(`/api/scrambles/${encodeURIComponent(game.id)}/status`, { action }))
  }

  async function reshuffleWord() {
    if (!wordAnswer.trim()) return
    try {
      const preview = await postJson<{ scrambled: string }>('/api/scrambles/preview', { answer: wordAnswer.trim() })
      setWordScrambled(preview.scrambled)
      setEditingWord(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not generate a scramble preview.')
    }
  }

  function saveWord() {
    if (!game) return
    const afterStart = game.status !== 'draft'
    if (afterStart && !window.confirm('The game has already started. Replacing the word changes what counts as a correct answer for everyone. Continue?')) return
    void applyHostAction(
      () => requestJson(`/api/scrambles/${encodeURIComponent(game.id)}/word`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: wordAnswer.trim(), scrambled: wordScrambled.trim(), confirm: afterStart }),
      }),
      'Word updated.',
    ).then(() => setEditingWord(false))
  }

  const announceOne = (entry: ScrambleEntry) =>
    void applyHostAction(() => postJson(`/api/scrambles/${encodeURIComponent(game!.id)}/winners/${encodeURIComponent(entry.id)}/announce`), `${entry.participantName} announced on the display.`)

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setNotice('Join link copied.')
    } catch {
      setError('Could not copy the link. Open the audience page to copy it from the address bar.')
    }
  }

  async function downloadQr() {
    if (!game || !shareUrl) return
    const canvas = document.createElement('canvas')
    try {
      await renderScrambleQr(canvas, shareUrl, game.logoUrl || assetUrls.logo || null, 1024)
      const link = document.createElement('a')
      link.download = `scramble-${game.id}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } catch {
      setError('Could not generate the QR image.')
    }
  }

  const activeLogoUrl = game?.logoUrl || assetUrls.logo || null

  return (
    <main className="raffle-host-shell scramble-host-shell">
      <header className="topbar">
        <ThemeBrand />
        <div className="topbar-actions">
          <a className="button button-quiet" href="/" aria-label="Back to dashboard"><ArrowLeft size={16} /> Dashboard</a>
          <span className="signed-in-user">{user.username}</span>
          <button className="icon-button signout-button" onClick={onLogout} aria-label="Sign out" title="Sign out"><LogOut size={17} /></button>
        </div>
      </header>
      <div className="raffle-host-content">
        <header className="raffle-page-heading">
          <span className="raffle-kicker">AUDIENCE WORD GAME</span>
          <h1>QR Word Scramble</h1>
          <p>Audiences scan the QR code, register with name and ticket number, and unscramble the word. Winners are drawn securely from the correct answers.</p>
        </header>
        {error && <p className="raffle-notice raffle-error" role="alert">{error}</p>}
        {notice && <p className="raffle-notice raffle-success-note" role="status">{notice}</p>}
        <section className="raffle-host-grid">
          <aside className="raffle-sidebar">
            <form className="raffle-create-form" onSubmit={(event) => void createGame(event)}>
              <h2>Create a word scramble</h2>
              <label htmlFor="scramble-title">Event or game name</label>
              <input id="scramble-title" value={title} onChange={(event) => setTitle(event.target.value)} minLength={3} maxLength={120} placeholder="e.g. Lay Bare x PVL Game Night" required />
              <label htmlFor="scramble-answer-input">Correct word or phrase</label>
              <input id="scramble-answer-input" value={answerDraft} onChange={(event) => setAnswerDraft(event.target.value)} minLength={2} maxLength={120} placeholder="e.g. CHAMPIONS" autoComplete="off" required />
              <p className="raffle-help">The answer stays private on the server. A scrambled version is generated automatically and can be edited before the game starts.</p>
              <input ref={logoInputRef} className="raffle-file-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={selectLogo} aria-label="Upload QR logo" />
              <div className="raffle-logo-row">
                <span className="raffle-logo-preview">{logoPreview ? <img src={logoPreview} alt="Logo preview" /> : <ImagePlus size={19} />}</span>
                <span className="raffle-logo-name">{logoFile?.name || 'QR logo · optional'}</span>
                <button className="button button-secondary raffle-upload-button" type="button" onClick={() => logoInputRef.current?.click()}>{logoFile ? 'Change' : 'Upload'}</button>
                {logoFile && <button className="icon-button" type="button" onClick={() => { setLogoFile(null); setLogoPreview(''); if (logoInputRef.current) logoInputRef.current.value = '' }} aria-label="Remove logo"><X size={15} /></button>}
              </div>
              <SavedLogoPicker onSelect={(logo) => void useSavedLogo(logo)} />
              <button className="button button-primary raffle-submit" type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create word scramble'} <ArrowUpRight size={16} /></button>
            </form>
            <section className="raffle-session-list">
              <h2>Word scrambles</h2>
              {!games.length && <p className="raffle-muted">Your word scrambles will appear here.</p>}
              {games.map((item) => (
                <div key={item.id} className={`raffle-session-item ${selectedId === item.id ? 'is-selected' : ''}`}>
                  <button type="button" className="raffle-session-select" onClick={() => { setSelectedId(item.id); setTab('qr'); setEditingWord(false) }}>
                    <span>{item.title}</span><small>{statusLabels[item.status]} · {item.entryCount ?? 0} registered · {item.winnerCount ?? 0} winners</small>
                  </button>
                  <button className="icon-button raffle-session-delete" type="button" onClick={() => void deleteGame(item)} aria-label={`Delete ${item.title}`} title="Delete word scramble"><Trash2 size={16} /></button>
                </div>
              ))}
            </section>
          </aside>

          <section className="raffle-workspace">
            {!game || !stats ? (
              <div className="raffle-empty"><Shuffle size={34} /><strong>Select or create a word scramble</strong><span>The QR code, game controls, participants, and winner selection will appear here.</span></div>
            ) : (
              <>
                <div className="raffle-active-heading">
                  <div><span className="raffle-kicker">ACTIVE GAME · {statusLabels[game.status].toUpperCase()}</span><h2>{game.title}</h2></div>
                  <div className="raffle-heading-actions">
                    <a className="button button-secondary raffle-display-link" href={`/scramble/${game.id}/display`}><MonitorPlay size={16} /> Open display</a>
                    <div className="raffle-counts"><span><strong>{stats.registrations}</strong> registered</span><span><strong>{stats.correct}</strong> correct</span><span><strong>{stats.confirmed}</strong> winners</span></div>
                  </div>
                </div>
                <div className="raffle-tabs" role="tablist" aria-label="Word scramble views">
                  <button type="button" role="tab" aria-selected={tab === 'qr'} className={tab === 'qr' ? 'is-active' : ''} onClick={() => setTab('qr')}><QrCode size={16} /> QR code</button>
                  <button type="button" role="tab" aria-selected={tab === 'game'} className={tab === 'game' ? 'is-active' : ''} onClick={() => setTab('game')}><Play size={16} /> Game control</button>
                  <button type="button" role="tab" aria-selected={tab === 'participants'} className={tab === 'participants' ? 'is-active' : ''} onClick={() => setTab('participants')}><Users size={16} /> Participants</button>
                  <button type="button" role="tab" aria-selected={tab === 'winners'} className={tab === 'winners' ? 'is-active' : ''} onClick={() => setTab('winners')}><Trophy size={16} /> Winners</button>
                </div>

                {tab === 'qr' && (
                  <section className="raffle-qr-view" role="tabpanel">
                    <div className="raffle-qr-card">
                      <div className="raffle-qr-frame"><ScrambleQrCode value={shareUrl} logoUrl={activeLogoUrl} label={`QR code to join ${game.title}`} /></div>
                      <div className="raffle-qr-copy"><span className="raffle-kicker">SCAN TO PLAY</span><h3>{game.title}</h3><p>The same QR code stays valid for the whole event. Players register once with a name and ticket number, then answer once.</p><span className="raffle-url">{shareUrl}</span></div>
                    </div>
                    <div className="raffle-toolbar"><button className="button button-secondary" onClick={() => void copyLink()}><Copy size={16} /> Copy link</button><button className="button button-secondary" onClick={() => void downloadQr()}><QrCode size={16} /> Download QR</button><a className="button button-primary" href={`/scramble/join/${game.id}`} target="_blank" rel="noreferrer">Open audience page <ArrowUpRight size={16} /></a></div>
                  </section>
                )}

                {tab === 'game' && (
                  <section className="scramble-game-view" role="tabpanel">
                    <div className="scramble-controls">
                      {game.status === 'draft' && <button className="button button-primary" disabled={busy} onClick={() => statusAction('start')}><Play size={16} /> Start game</button>}
                      {game.status === 'active' && <button className="button button-secondary" disabled={busy} onClick={() => statusAction('pause')}><Pause size={16} /> Pause</button>}
                      {game.status === 'paused' && <button className="button button-primary" disabled={busy} onClick={() => statusAction('resume')}><Play size={16} /> Resume</button>}
                      {(game.status === 'active' || game.status === 'paused') && <button className="button button-secondary" disabled={busy} onClick={() => statusAction('close', 'Close the game? Participants will no longer be able to register or submit answers.')}><Square size={16} /> Close game</button>}
                      {game.status !== 'draft' && !game.answerRevealed && <button className="button button-secondary" disabled={busy} onClick={() => { if (window.confirm('Reveal the correct answer on the audience display?')) void applyHostAction(() => postJson(`/api/scrambles/${encodeURIComponent(game.id)}/reveal`), 'Answer revealed on the display.') }}><Eye size={16} /> Reveal answer</button>}
                      {game.status === 'closed' && <button className="button button-secondary" disabled={busy} onClick={() => statusAction('complete', 'End the event? The display will switch to the completion screen.')}><CircleCheck size={16} /> End event</button>}
                      <button className="button button-quiet scramble-reset" disabled={busy} onClick={() => { if (window.confirm('Reset the event? ALL registrations, answers, and winners will be permanently deleted and the game returns to Not started.')) void applyHostAction(() => postJson(`/api/scrambles/${encodeURIComponent(game.id)}/reset`), 'Event reset.') }}><RefreshCw size={16} /> Reset event</button>
                    </div>

                    <div className="scramble-stats" aria-label="Live statistics">
                      <div><strong>{stats.registrations}</strong><span>Registered</span></div>
                      <div><strong>{stats.answered}</strong><span>Answered</span></div>
                      <div><strong>{stats.correct}</strong><span>Correct</span></div>
                      <div><strong>{stats.incorrect}</strong><span>Incorrect</span></div>
                      <div><strong>{stats.notSubmitted}</strong><span>No answer</span></div>
                      <div><strong>{stats.confirmed}</strong><span>Winners</span></div>
                      <div><strong>{stats.announced}</strong><span>Announced</span></div>
                    </div>

                    <div className="scramble-word-card">
                      <div className="scramble-word-card-heading">
                        <h3><Lock size={15} /> Word &amp; answer (private)</h3>
                        {game.answerRevealed && <span className="scramble-badge">ANSWER REVEALED</span>}
                      </div>
                      <label htmlFor="scramble-word-answer">Correct answer</label>
                      <input id="scramble-word-answer" value={wordAnswer} maxLength={120} autoComplete="off" onChange={(event) => { setWordAnswer(event.target.value); setEditingWord(true) }} />
                      <label htmlFor="scramble-word-scrambled">Scrambled version shown to the audience</label>
                      <input id="scramble-word-scrambled" value={wordScrambled} maxLength={120} autoComplete="off" onChange={(event) => { setWordScrambled(event.target.value.toUpperCase()); setEditingWord(true) }} />
                      <div className="scramble-word-preview"><ScrambledWord word={wordScrambled || ' '} compact /></div>
                      <div className="scramble-word-actions">
                        <button className="button button-secondary" type="button" disabled={busy || !wordAnswer.trim()} onClick={() => void reshuffleWord()}><Shuffle size={15} /> Reshuffle</button>
                        <button className="button button-primary" type="button" disabled={busy || !editingWord || !wordAnswer.trim() || !wordScrambled.trim()} onClick={saveWord}><Check size={15} /> Save word</button>
                        {editingWord && <button className="button button-quiet" type="button" onClick={() => { setEditingWord(false); setWordAnswer(game.answer); setWordScrambled(game.scrambled) }}>Cancel</button>}
                      </div>
                      {game.status !== 'draft' && <p className="raffle-help">The word is locked while the game runs — saving a change requires confirmation.</p>}
                    </div>
                  </section>
                )}

                {tab === 'participants' && (
                  <section className="scramble-participants-view" role="tabpanel">
                    <div className="scramble-search">
                      <Search size={16} aria-hidden="true" />
                      <input value={participantFilter} onChange={(event) => setParticipantFilter(event.target.value)} placeholder="Search by name or ticket number" aria-label="Search participants" />
                    </div>
                    {!filteredEntries.length ? <p className="raffle-muted">{entries.length ? 'No participants match this search.' : 'Registered participants will appear here.'}</p> : (
                      <div className="scramble-table-wrap">
                        <table className="scramble-table">
                          <thead><tr><th>Name</th><th>Ticket</th><th>Registered</th><th>Answer</th><th>Status</th></tr></thead>
                          <tbody>
                            {filteredEntries.map((entry) => (
                              <tr key={entry.id}>
                                <td>{entry.participantName}</td>
                                <td>{entry.ticketNumber}</td>
                                <td>{new Date(entry.registeredAt).toLocaleTimeString()}</td>
                                <td>{entry.answeredAt ? entry.answer : <span className="raffle-muted">—</span>}</td>
                                <td>
                                  {!entry.answeredAt ? <span className="scramble-pill">No answer</span>
                                    : entry.isCorrect ? <span className="scramble-pill is-correct"><CircleCheck size={13} /> Correct · eligible</span>
                                    : <span className="scramble-pill is-incorrect"><CircleX size={13} /> Incorrect</span>}
                                  {entry.confirmedAt && <span className="scramble-pill is-winner"><Trophy size={13} /> Winner{entry.announcedAt ? ' · announced' : ''}</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </section>
                )}

                {tab === 'winners' && (
                  <section className="scramble-winners-view" role="tabpanel">
                    {game.status !== 'closed' && game.status !== 'completed' ? (
                      <p className="raffle-notice" role="status">Close the game to unlock winner selection. Winners are drawn with equal probability from every correct answer — submission order never matters.</p>
                    ) : (
                      <div className="scramble-randomize">
                        <p><strong>{stats.eligible + stats.selected}</strong> eligible participant{stats.eligible + stats.selected === 1 ? '' : 's'} with a correct answer{confirmedWinners.length ? ' (excluding confirmed winners)' : ''}.</p>
                        <div className="scramble-randomize-row">
                          <label htmlFor="scramble-winner-count">Number of winners</label>
                          <input id="scramble-winner-count" type="number" min={1} max={Math.max(1, stats.eligible + stats.selected)} value={winnerCount} onChange={(event) => setWinnerCount(Math.max(1, Number(event.target.value) || 1))} />
                          <button className="button button-primary" disabled={busy || game.status === 'completed'} onClick={() => { if (window.confirm(`Securely randomize ${winnerCount} winner${winnerCount === 1 ? '' : 's'} from ${stats.eligible + stats.selected} eligible participants?${selectedWinners.length ? ' The current unconfirmed selection will be replaced.' : ''}`)) void applyHostAction(() => postJson(`/api/scrambles/${encodeURIComponent(game.id)}/winners/randomize`, { count: winnerCount }), 'Winners selected. Review them below, then confirm.') }}><Shuffle size={16} /> Randomize winners</button>
                        </div>
                        <p className="raffle-help">Selection runs on the server with cryptographically secure randomness. It is never shown on the audience display.</p>
                      </div>
                    )}

                    {selectedWinners.length > 0 && (
                      <div className="scramble-winner-group">
                        <h3><Eye size={15} /> Private review — not yet visible anywhere</h3>
                        <ul className="scramble-winner-list">
                          {selectedWinners.map((entry) => <li key={entry.id}><strong>{entry.participantName}</strong><span>Ticket {entry.ticketNumber}</span></li>)}
                        </ul>
                        <button className="button button-primary" disabled={busy} onClick={() => { if (window.confirm(`Confirm ${selectedWinners.length} winner${selectedWinners.length === 1 ? '' : 's'}? Confirmed winners can then be announced on the display.`)) void applyHostAction(() => postJson(`/api/scrambles/${encodeURIComponent(game.id)}/winners/confirm`), 'Winners confirmed. Announce them when ready.') }}><CircleCheck size={16} /> Confirm winners</button>
                      </div>
                    )}

                    {confirmedWinners.length > 0 && (
                      <div className="scramble-winner-group">
                        <h3><Trophy size={15} /> Confirmed winners</h3>
                        <ul className="scramble-winner-list">
                          {confirmedWinners.map((entry) => (
                            <li key={entry.id}>
                              <strong>{entry.participantName}</strong><span>Ticket {entry.ticketNumber}</span>
                              {entry.announcedAt
                                ? <span className="scramble-pill is-winner"><Megaphone size={13} /> Announced</span>
                                : <button className="button button-secondary" disabled={busy} onClick={() => announceOne(entry)}><Megaphone size={14} /> Announce</button>}
                            </li>
                          ))}
                        </ul>
                        {confirmedWinners.some((entry) => !entry.announcedAt) && (
                          <button className="button button-primary" disabled={busy} onClick={() => { if (window.confirm('Announce all confirmed winners on the audience display?')) void applyHostAction(() => postJson(`/api/scrambles/${encodeURIComponent(game.id)}/winners/announce-all`), 'All winners announced.') }}><Megaphone size={16} /> Announce all winners</button>
                        )}
                      </div>
                    )}

                    {game.status === 'closed' && !selectedWinners.length && !confirmedWinners.length && (
                      <p className="raffle-muted">No winners selected yet. Choose how many winners to draw, then randomize.</p>
                    )}
                  </section>
                )}
              </>
            )}
          </section>
        </section>
      </div>
    </main>
  )
}
