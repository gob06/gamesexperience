import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import QRCode from 'qrcode'
import { ArrowLeft, ArrowUpRight, Check, Copy, ImagePlus, LogOut, MonitorPlay, Play, QrCode, Shuffle, Smartphone, Square, Ticket, Trash2, Trophy, X } from 'lucide-react'
import { ThemeBrand, useTheme } from './theme'
import { AdVideoOverlay } from './AdVideo'
import { TermsNotice } from './terms'
import { SavedLogoPicker, logoToFile, saveLogo, type SavedLogo } from './logoLibrary'

type Raffle = {
  id: string
  title: string
  logoUrl: string | null
  displayImage1Url?: string | null
  displayImage2Url?: string | null
  createdAt: string
  drawStatus: 'idle' | 'drawing'
  entryCount?: number
  winnerCount?: number
  registrationOpen?: boolean
}

type RaffleEntry = {
  id: string
  participantName: string
  ticketNumber: string
  registeredAt?: string
  wonAt?: string | null
}

type HostRaffleData = {
  raffle: Raffle
  entries: RaffleEntry[]
  eligible: RaffleEntry[]
  winners: RaffleEntry[]
}

type RaffleTab = 'qr' | 'draw' | 'winners'

function DisplayImagePicker({ label, file, onChange, onError }: { label: string; file: File | null; onChange: (file: File | null) => void; onError: (message: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState('')

  useEffect(() => {
    if (!file) { setPreview(''); return }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  function choose(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!selected) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(selected.type)) return onError(`Choose a JPEG, PNG, or WebP image for ${label.toLowerCase()}.`)
    if (selected.size > 5 * 1024 * 1024) return onError(`${label} must be 5 MB or smaller.`)
    onError('')
    onChange(selected)
  }

  return (
    <>
      <input ref={inputRef} className="raffle-file-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={choose} aria-label={`Upload ${label.toLowerCase()}`} />
      <div className="raffle-logo-row">
        <span className="raffle-logo-preview">{preview ? <img src={preview} alt={`${label} preview`} /> : <ImagePlus size={19} />}</span>
        <span className="raffle-logo-name">{file?.name || `${label} · optional`}</span>
        <button className="button button-secondary raffle-upload-button" type="button" onClick={() => inputRef.current?.click()}>{file ? 'Change' : 'Upload'}</button>
        {file && <button className="icon-button" type="button" onClick={() => onChange(null)} aria-label={`Remove ${label.toLowerCase()}`}><X size={15} /></button>}
      </div>
    </>
  )
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'The raffle request could not be completed.')
  return data as T
}

async function raffleJoinUrl(raffleId: string) {
  const url = new URL(`/raffle/join/${encodeURIComponent(raffleId)}`, window.location.origin)
  if (!['localhost', '127.0.0.1'].includes(window.location.hostname)) return url.href
  try {
    const response = await fetch('/api/network-addresses')
    if (!response.ok) return url.href
    const result = await response.json() as { addresses: string[] }
    if (result.addresses.length) url.hostname = result.addresses[0]
  } catch { /* Keep the same-origin link if LAN discovery is unavailable. */ }
  return url.href
}

async function renderRaffleQr(canvas: HTMLCanvasElement, value: string, logoUrl: string | null, size: number) {
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

function RaffleQrCode({ value, logoUrl, size = 1024, label }: { value: string; logoUrl: string | null; size?: number; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !value) return
    let active = true
    let timer = 0
    const draw = () => { void renderRaffleQr(canvas, value, logoUrl, size) }
    draw()
    const onResize = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { if (active) draw() }, 150) }
    window.addEventListener('resize', onResize)
    return () => { active = false; window.clearTimeout(timer); window.removeEventListener('resize', onResize) }
  }, [value, logoUrl, size])
    return <canvas ref={canvasRef} aria-label={label} />
}

type RaffleDisplayData = {
  raffle: Raffle
  counts: { entryCount: number; eligibleCount: number; winnerCount: number }
  latestWinner: RaffleEntry | null
  eligible: RaffleEntry[]
}

export function RaffleDisplayPage({ raffleId }: { raffleId: string }) {
  const { assetUrls } = useTheme()
  const [data, setData] = useState<RaffleDisplayData | null>(null)
  const [rollingEntry, setRollingEntry] = useState<RaffleEntry | null>(null)
  const [displayWinner, setDisplayWinner] = useState<RaffleEntry | null>(null)
  const [shareUrl, setShareUrl] = useState('')
  const [error, setError] = useState('')
  const eligibleRef = useRef<RaffleEntry[]>([])
  const drawStatusRef = useRef<'idle' | 'drawing' | null>(null)
  const winnerIdRef = useRef<string | null>(null)

  useEffect(() => {
    let active = true
    async function refresh() {
      try {
        const [result, url] = await Promise.all([
          requestJson<RaffleDisplayData>(`/api/raffles/${encodeURIComponent(raffleId)}/display`),
          raffleJoinUrl(raffleId),
        ])
        if (!active) return
        const priorStatus = drawStatusRef.current
        const nextWinnerId = result.latestWinner?.id ?? null
        if (result.raffle.drawStatus === 'drawing') setDisplayWinner(null)
        else if (priorStatus === 'drawing' && result.latestWinner && result.latestWinner.id !== winnerIdRef.current) setDisplayWinner(result.latestWinner)
        drawStatusRef.current = result.raffle.drawStatus
        winnerIdRef.current = nextWinnerId
        eligibleRef.current = result.eligible
        setData(result)
        setShareUrl(url)
        setError('')
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : 'Could not load the raffle display.')
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 650)
    return () => { active = false; window.clearInterval(timer) }
  }, [raffleId])

  const isDrawing = data?.raffle.drawStatus === 'drawing'
  const eventLogoUrl = data?.raffle.logoUrl || assetUrls.logo || null

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

  useEffect(() => {
    if (!isDrawing) {
      setRollingEntry(null)
      return
    }
    const showNextEntry = () => {
      const currentEntries = eligibleRef.current
      if (!currentEntries.length) return
      setRollingEntry(currentEntries[Math.floor(Math.random() * currentEntries.length)])
    }
    showNextEntry()
    const timer = window.setInterval(showNextEntry, 90)
    return () => window.clearInterval(timer)
  }, [isDrawing])

  const winner = !isDrawing ? displayWinner : null
  const showQrOnly = Boolean(data && !isDrawing && !winner)

  return (
    <main className={`raffle-screen-shell ${isDrawing ? 'is-drawing' : ''} ${winner ? 'has-winner' : ''}`}>
      {!data ? (
        <div className="raffle-screen-message">{error || 'Connecting to raffle…'}</div>
      ) : showQrOnly ? (
        <section className="raffle-screen-qr-only" aria-label="Raffle entry QR code">
            {shareUrl && data ? <RaffleQrCode value={shareUrl} logoUrl={eventLogoUrl} size={1024} label={`QR code to enter ${data.raffle.title}`} /> : <span>Loading QR…</span>}
            <p className="raffle-screen-scan"><Smartphone aria-hidden="true" />Scan the QR Code to register</p>
        </section>
      ) : (
        <section className={`raffle-screen-grid ${isDrawing ? 'is-drawing' : ''} ${winner ? 'has-winner' : ''}`}>
          <div className="raffle-screen-main" aria-live="polite">
            <header className="raffle-screen-event">
              {data.raffle.displayImage1Url && <img className="raffle-screen-side-image is-left" src={data.raffle.displayImage1Url} alt="" />}
              <h1>{data.raffle.title}</h1>
              {data.raffle.displayImage2Url && <img className="raffle-screen-side-image is-right" src={data.raffle.displayImage2Url} alt="" />}
            </header>
            <div className="raffle-screen-stage">
              {isDrawing ? (
                <div className="raffle-screen-draw">
                  <strong key={rollingEntry?.id || 'empty'} className="raffle-screen-name">{rollingEntry?.participantName || 'Waiting for eligible tickets…'}</strong>
                  {rollingEntry && <span className="raffle-screen-ticket">TICKET {rollingEntry.ticketNumber}</span>}
                </div>
              ) : winner && (
                <div className="raffle-screen-winner">
                  <strong>{winner.participantName}</strong>
                  <span className="raffle-screen-ticket">TICKET {winner.ticketNumber}</span>
                </div>
              )}
            </div>
          </div>
        </section>
      )}
    </main>
  )
}

export function RaffleJoinPage({ raffleId }: { raffleId: string }) {
  const { assetUrls } = useTheme()
  const [raffle, setRaffle] = useState<Raffle | null>(null)
  const [participantName, setParticipantName] = useState('')
  const [ticketNumber, setTicketNumber] = useState('')
  const [registered, setRegistered] = useState(false)
  const [showAd, setShowAd] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    async function refresh() {
      try {
        const data = await requestJson<Raffle>(`/api/raffles/${encodeURIComponent(raffleId)}`)
        if (!active) return
        setRaffle(data)
        setError('')
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : 'Could not open this raffle.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1000)
    return () => { active = false; window.clearInterval(timer) }
  }, [raffleId])

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!raffle?.registrationOpen) return
    setBusy(true)
    setError('')
    try {
      await requestJson(`/api/raffles/${encodeURIComponent(raffleId)}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ participantName, ticketNumber }),
      })
      setRegistered(true)
      setShowAd(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not register this ticket.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="raffle-audience-shell">
      <section className="raffle-audience-panel">
        {loading ? <p className="raffle-muted">Loading raffle…</p> : !raffle ? (
          <div className="raffle-notice raffle-error" role="alert">{error || 'This raffle could not be found.'}</div>
        ) : (
          <>
            {(raffle.logoUrl || assetUrls.logo) && <img className="raffle-event-logo" src={raffle.logoUrl || assetUrls.logo} alt="Event logo" />}
            {registered ? (
              <div className="raffle-success" role="status"><Check size={26} /><strong>Your ticket is registered.</strong><span>Good luck, {participantName.trim()}!</span></div>
            ) : raffle.registrationOpen ? (
              <form className="raffle-entry-form" onSubmit={(event) => void register(event)}>
                <label htmlFor="raffle-participant-name">Ticket holder name</label>
                <input id="raffle-participant-name" autoComplete="name" maxLength={80} value={participantName} onChange={(event) => setParticipantName(event.target.value)} placeholder="Enter your name" required />
                <label htmlFor="raffle-ticket-number">Ticket number</label>
                <input id="raffle-ticket-number" autoComplete="off" maxLength={40} value={ticketNumber} onChange={(event) => setTicketNumber(event.target.value)} placeholder="Enter your ticket number" required />
                {error && <p className="raffle-notice raffle-error" role="alert">{error}</p>}
                <button className="button button-primary raffle-submit" type="submit" disabled={busy}>{busy ? 'Registering…' : 'Register ticket'} <Ticket size={17} /></button>
                <TermsNotice />
              </form>
            ) : (
              <div className="raffle-notice" role="status">Registration is closed while the host is drawing.</div>
            )}
          </>
        )}
      </section>
      {showAd && <AdVideoOverlay kind="raffle" onDone={() => setShowAd(false)} />}
    </main>
  )
}

export function RaffleHostPage({ user, onLogout }: { user: { username: string }; onLogout: () => void }) {
  const { assetUrls } = useTheme()
  const [raffles, setRaffles] = useState<Raffle[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [activeRaffle, setActiveRaffle] = useState<Raffle | null>(null)
  const [entries, setEntries] = useState<RaffleEntry[]>([])
  const [eligible, setEligible] = useState<RaffleEntry[]>([])
  const [winners, setWinners] = useState<RaffleEntry[]>([])
  const [rollingEntry, setRollingEntry] = useState<RaffleEntry | null>(null)
  const [winner, setWinner] = useState<RaffleEntry | null>(null)
  const [tab, setTab] = useState<RaffleTab>('qr')

  const [title, setTitle] = useState('')
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoPreview, setLogoPreview] = useState('')
  const [displayImage1, setDisplayImage1] = useState<File | null>(null)
  const [displayImage2, setDisplayImage2] = useState<File | null>(null)
  const [shareUrl, setShareUrl] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const logoInputRef = useRef<HTMLInputElement>(null)
  const isDrawing = activeRaffle?.drawStatus === 'drawing'
  const activeLogoUrl = activeRaffle?.logoUrl || assetUrls.logo || null

  useEffect(() => {
    if (!logoPreview) return
    return () => URL.revokeObjectURL(logoPreview)
  }, [logoPreview])

  useEffect(() => {
    let active = true
    void requestJson<Raffle[]>('/api/raffles')
      .then((data) => {
        if (!active) return
        setRaffles(data)
        if (data[0]) setSelectedId((current) => current || data[0].id)
      })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : 'Could not load raffles.') })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!selectedId) {
      setActiveRaffle(null)
      setEntries([])
      setEligible([])
      setWinners([])
      setShareUrl('')
      return
    }
    let active = true
    async function refresh() {
      try {
        const [data, url] = await Promise.all([
          requestJson<HostRaffleData>(`/api/raffles/${encodeURIComponent(selectedId)}/host`),
          raffleJoinUrl(selectedId),
        ])
        if (!active) return
        setActiveRaffle(data.raffle)
        setEntries(data.entries)
        setEligible(data.eligible)
        setWinners(data.winners)
        setShareUrl(url)
        if (data.raffle.drawStatus !== 'drawing') setRollingEntry(null)
        setError('')
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : 'Could not refresh raffle.')
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2500)
    return () => { active = false; window.clearInterval(timer) }
  }, [selectedId])

  useEffect(() => {
    if (!isDrawing || !eligible.length) return
    let index = 0
    setRollingEntry(eligible[0])
    const timer = window.setInterval(() => {
      index = (index + 1) % eligible.length
      setRollingEntry(eligible[index])
    }, 75)
    return () => window.clearInterval(timer)
  }, [isDrawing, eligible])

  async function createRaffle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    const data = new FormData()
    data.append('title', title.trim())
    if (logoFile) data.append('logo', logoFile)
    if (displayImage1) data.append('displayImage1', displayImage1)
    if (displayImage2) data.append('displayImage2', displayImage2)
    try {
      const created = await requestJson<Raffle>('/api/raffles', { method: 'POST', body: data })
      setRaffles((current) => [created, ...current])
      setSelectedId(created.id)
      setTitle('')
      setLogoFile(null)
      setLogoPreview('')
      setDisplayImage1(null)
      setDisplayImage2(null)
      if (logoInputRef.current) logoInputRef.current.value = ''
      setTab('qr')
      setNotice('Raffle QR is ready to share.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create raffle.')
    } finally {
      setBusy(false)
    }
  }

  async function deleteRaffle(raffle: Raffle) {
    if (!window.confirm(`Delete "${raffle.title}"? All registered tickets and winner history for this raffle will be removed.`)) return
    setError('')
    setNotice('')
    try {
      const response = await fetch(`/api/raffles/${encodeURIComponent(raffle.id)}`, { method: 'DELETE' })
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(result.error || 'Could not delete raffle.')
      }
      const remaining = raffles.filter((item) => item.id !== raffle.id)
      setRaffles(remaining)
      setSelectedId((current) => current === raffle.id ? remaining[0]?.id || '' : current)
      if (selectedId === raffle.id) setNotice('Raffle deleted.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete raffle.')
    }
  }

  function selectLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    if (!file) return
    event.currentTarget.value = ''
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Choose a JPEG, PNG, or WebP logo.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Logo must be 5 MB or smaller.')
      return
    }
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

  async function startDraw() {
    if (!activeRaffle) return
    setBusy(true)
    setError('')
    setWinner(null)
    try {
      const result = await requestJson<{ drawStatus: 'drawing'; eligible: RaffleEntry[] }>(`/api/raffles/${encodeURIComponent(activeRaffle.id)}/draw/start`, { method: 'POST' })
      setEligible(result.eligible)
      setActiveRaffle((current) => current ? { ...current, drawStatus: result.drawStatus } : current)
      setTab('draw')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not start the draw.')
    } finally {
      setBusy(false)
    }
  }

  async function stopDraw() {
    if (!activeRaffle) return
    setBusy(true)
    setError('')
    try {
      const result = await requestJson<{ drawStatus: 'idle'; winner: RaffleEntry }>(`/api/raffles/${encodeURIComponent(activeRaffle.id)}/draw/stop`, { method: 'POST' })
      setWinner(result.winner)
      setRollingEntry(null)
      setActiveRaffle((current) => current ? { ...current, drawStatus: 'idle' } : current)
      setWinners((current) => [result.winner, ...current.filter((entry) => entry.id !== result.winner.id)])
      setEligible((current) => current.filter((entry) => entry.id !== result.winner.id))
      setTab('draw')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not stop the draw.')
    } finally {
      setBusy(false)
    }
  }

  async function copyRaffleLink() {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setNotice('Raffle link copied.')
    } catch {
      setError('Could not copy the link. Open the audience page to copy it from the address bar.')
    }
  }

  async function downloadQr() {
    if (!activeRaffle || !shareUrl) return
    const canvas = document.createElement('canvas')
    try {
      await renderRaffleQr(canvas, shareUrl, activeLogoUrl, 1024)
      const link = document.createElement('a')
      link.download = `raffle-${activeRaffle.id}.png`
      link.href = canvas.toDataURL('image/png')
      link.click()
    } catch {
      setError('Could not generate the raffle QR image.')
    }
  }

  const displayedEntry = isDrawing ? rollingEntry : winner || winners[0] || null

  return (
    <main className="raffle-host-shell">
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
          <span className="raffle-kicker">EVENT DRAW</span>
          <h1>QR Raffle</h1>
          <p>Register ticket holders, draw a winner, and keep every winning ticket out of future draws.</p>
        </header>
        {error && <p className="raffle-notice raffle-error" role="alert">{error}</p>}
        {notice && <p className="raffle-notice raffle-success-note" role="status">{notice}</p>}
        <section className="raffle-host-grid">
          <aside className="raffle-sidebar">
            <form className="raffle-create-form" onSubmit={(event) => void createRaffle(event)}>
              <h2>Create a raffle</h2>
              <label htmlFor="raffle-title">Event or raffle name</label>
              <input id="raffle-title" value={title} onChange={(event) => setTitle(event.target.value)} minLength={3} maxLength={120} placeholder="e.g. Championship night" required />
              <input ref={logoInputRef} className="raffle-file-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={selectLogo} aria-label="Upload QR logo" />
              <div className="raffle-logo-row">
                <span className="raffle-logo-preview">{logoPreview ? <img src={logoPreview} alt="Logo preview" /> : <ImagePlus size={19} />}</span>
                <span className="raffle-logo-name">{logoFile?.name || 'QR logo · optional'}</span>
                <button className="button button-secondary raffle-upload-button" type="button" onClick={() => logoInputRef.current?.click()}>{logoFile ? 'Change' : 'Upload'}</button>
                {logoFile && <button className="icon-button" type="button" onClick={() => { setLogoFile(null); setLogoPreview(''); if (logoInputRef.current) logoInputRef.current.value = '' }} aria-label="Remove logo"><X size={15} /></button>}
              </div>
              <SavedLogoPicker onSelect={(logo) => void useSavedLogo(logo)} />
              <p className="raffle-help">Live randomizing screen images · shown left and right of the raffle name</p>
              <DisplayImagePicker label="Display image 1" file={displayImage1} onChange={setDisplayImage1} onError={setError} />
              <DisplayImagePicker label="Display image 2" file={displayImage2} onChange={setDisplayImage2} onError={setError} />
              <p className="raffle-help">JPEG, PNG, or WebP · 5 MB maximum</p>
              <button className="button button-primary raffle-submit" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create raffle'} <ArrowUpRight size={16} /></button>
            </form>
            <section className="raffle-session-list">
              <h2>Raffles</h2>
              {!raffles.length && <p className="raffle-muted">Your raffles will appear here.</p>}
              {raffles.map((raffle) => (
                <div key={raffle.id} className={`raffle-session-item ${selectedId === raffle.id ? 'is-selected' : ''}`}>
                  <button type="button" className="raffle-session-select" onClick={() => { setSelectedId(raffle.id); setWinner(null); setTab('qr') }}>
                    <span>{raffle.title}</span><small>{raffle.entryCount ?? 0} tickets · {raffle.winnerCount ?? 0} winners</small>
                  </button>
                  <button className="icon-button raffle-session-delete" type="button" onClick={() => void deleteRaffle(raffle)} aria-label={`Delete ${raffle.title}`} title="Delete raffle"><Trash2 size={16} /></button>
                </div>
              ))}
            </section>
          </aside>

          <section className="raffle-workspace">
            {!activeRaffle ? (
              <div className="raffle-empty"><QrCode size={34} /><strong>Select or create a raffle</strong><span>The QR, live draw, and winner history will appear here.</span></div>
            ) : (
              <>
                <div className="raffle-active-heading">
                  <div><span className="raffle-kicker">ACTIVE RAFFLE</span><h2>{activeRaffle.title}</h2></div>
                  <div className="raffle-heading-actions">
                    <a className="button button-secondary raffle-display-link" href={`/raffle/${activeRaffle.id}/display`}><MonitorPlay size={16} /> Open display</a>
                    <div className="raffle-counts"><span><strong>{entries.length}</strong> registered</span><span><strong>{winners.length}</strong> winners</span></div>
                  </div>
                </div>
                <div className="raffle-tabs" role="tablist" aria-label="Raffle views">
                  <button type="button" role="tab" aria-selected={tab === 'qr'} className={tab === 'qr' ? 'is-active' : ''} disabled={isDrawing} onClick={() => setTab('qr')}><QrCode size={16} /> QR code</button>
                  <button type="button" role="tab" aria-selected={tab === 'draw'} className={tab === 'draw' ? 'is-active' : ''} onClick={() => setTab('draw')}><Shuffle size={16} /> Live randomizer</button>
                  <button type="button" role="tab" aria-selected={tab === 'winners'} className={tab === 'winners' ? 'is-active' : ''} onClick={() => setTab('winners')}><Trophy size={16} /> Winners</button>
                </div>

                {tab === 'qr' && (
                  <section className="raffle-qr-view" role="tabpanel">
                    <div className="raffle-qr-card">
                      <div className="raffle-qr-frame"><RaffleQrCode value={shareUrl} logoUrl={activeLogoUrl} label={`QR code to register for ${activeRaffle.title}`} /></div>
                      <div className="raffle-qr-copy"><span className="raffle-kicker">SCAN TO ENTER</span><h3>{activeRaffle.title}</h3><p>Ticket holders scan the code, enter their name and ticket number, and register once.</p><span className="raffle-url">{shareUrl}</span></div>
                    </div>
                    <div className="raffle-toolbar"><button className="button button-secondary" onClick={() => void copyRaffleLink()}><Copy size={16} /> Copy link</button><button className="button button-secondary" onClick={() => void downloadQr()}><QrCode size={16} /> Download QR</button><a className="button button-primary" href={`/raffle/join/${activeRaffle.id}`} target="_blank" rel="noreferrer">Open audience page <ArrowUpRight size={16} /></a></div>
                  </section>
                )}

                {tab === 'draw' && (
                  <section className={`raffle-draw-view ${isDrawing ? 'is-drawing' : ''}`} role="tabpanel">
                    <div className="raffle-draw-stage">
                      <span className="raffle-draw-status">{isDrawing ? 'DRAW IN PROGRESS' : winner || winners[0] ? 'LATEST WINNER' : 'READY TO DRAW'}</span>
                      {displayedEntry ? <><strong>{displayedEntry.participantName}</strong><span className="raffle-ticket-result"><Ticket size={18} /> Ticket {displayedEntry.ticketNumber}</span></> : <p>{eligible.length ? 'Press DRAW to start the randomizer.' : 'Register tickets before drawing a winner.'}</p>}
                    </div>
                    <div className="raffle-draw-actions">
                      {!isDrawing ? <button className="button button-primary raffle-draw-button" onClick={() => void startDraw()} disabled={busy || eligible.length === 0}><Play size={18} /> DRAW</button> : <button className="button button-stop raffle-draw-button" onClick={() => void stopDraw()} disabled={busy}><Square size={17} fill="currentColor" /> STOP</button>}
                      <span>{eligible.length} eligible tickets · {winners.length} already won</span>
                    </div>
                    <p className="raffle-exclusion-note"><Check size={15} /> Each winning ticket is permanently excluded from future draws in this raffle.</p>
                  </section>
                )}

                {tab === 'winners' && (
                  <section className="raffle-winner-list" role="tabpanel">
                    <h3>Winner history</h3>
                    {!winners.length ? <p className="raffle-muted">No winner has been drawn yet.</p> : winners.map((entry, index) => (
                      <article className="raffle-winner-row" key={entry.id}><span className="raffle-winner-rank"><Trophy size={17} /> {winners.length - index}</span><strong>{entry.participantName}</strong><span>Ticket {entry.ticketNumber}</span><time>{entry.wonAt ? new Date(entry.wonAt).toLocaleString() : ''}</time></article>
                    ))}
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
