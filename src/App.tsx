import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { BrowserMultiFormatReader } from '@zxing/browser'
import QRCode from 'qrcode'
import {
  ArrowLeft,
  ArrowUpRight,
  Camera,
  Check,
  ChevronRight,
  CircleHelp,
  Copy,
  ImagePlus,
  LogIn,
  LogOut,
  Maximize,
  MonitorPlay,
  Plus,
  QrCode,
  RotateCcw,
  ScanLine,
  Shield,
  UserPlus,
  Users,
  X,
} from 'lucide-react'

type PollOption = { id: string; label: string; votes: number }
type Poll = { id: string; question: string; options: PollOption[]; createdAt: string; logoUrl?: string | null }
type Selfie = { id: string; imageUrl: string; uploadedAt: string }
type AuthUser = { id: string; username: string; role: 'admin' | 'host' }

const pollPath = window.location.pathname.match(/^\/poll\/([^/]+)\/?$/)
const resultsPath = window.location.pathname.match(/^\/poll\/([^/]+)\/display\/?$/)
const selfieCamPath = window.location.pathname.match(/^\/poll\/([^/]+)\/selfie-cam\/?$/)

async function requestPolls(): Promise<Poll[]> {
  const response = await fetch('/api/polls')
  if (!response.ok) throw new Error('Could not load polls.')
  return response.json()
}

function getVoterId() {
  const storageKey = 'roomvote-voter-id'
  let voterId = localStorage.getItem(storageKey)
  if (!voterId) {
    if (typeof crypto.randomUUID === 'function') {
      voterId = crypto.randomUUID()
    } else {
      const bytes = new Uint8Array(16)
      crypto.getRandomValues(bytes)
      voterId = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    }
    localStorage.setItem(storageKey, voterId)
  }
  return voterId
}

function PollQrCode({ value, logoUrl, size, label }: { value: string; logoUrl?: string | null; size: number; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !value) return
    let active = true

    void QRCode.toCanvas(canvas, value, {
      width: size,
      margin: 2,
      errorCorrectionLevel: 'H',
      color: { dark: '#15151a', light: '#ffffff' },
    }).then(() => {
      if (!active || !logoUrl) return
      const logo = new Image()
      logo.onload = () => {
        if (!active) return
        const context = canvas.getContext('2d')
        if (!context) return
        const boxSize = Math.round(size * 0.22)
        const padding = Math.round(size * 0.025)
        const innerSize = boxSize - padding * 2
        const scale = Math.min(innerSize / logo.naturalWidth, innerSize / logo.naturalHeight)
        const width = logo.naturalWidth * scale
        const height = logo.naturalHeight * scale
        const left = (size - boxSize) / 2
        const top = (size - boxSize) / 2
        context.fillStyle = '#ffffff'
        context.fillRect(left, top, boxSize, boxSize)
        context.drawImage(logo, (size - width) / 2, (size - height) / 2, width, height)
      }
      logo.src = logoUrl
    })

    return () => { active = false }
  }, [value, logoUrl, size])

  return <canvas ref={canvasRef} aria-label={label} />
}

async function getPollShareUrl(pollId: string, destination: 'vote' | 'selfie' = 'vote') {
  const path = `/poll/${encodeURIComponent(pollId)}`
  const search = destination === 'selfie' ? '?open=selfie' : ''
  const fallbackUrl = new URL(`${path}${search}`, window.location.origin).href
  if (!['localhost', '127.0.0.1'].includes(window.location.hostname)) return fallbackUrl

  try {
    const response = await fetch('/api/network-addresses')
    if (!response.ok) return fallbackUrl
    const result: { addresses: string[] } = await response.json()
    if (!result.addresses.length) return fallbackUrl

    const phoneUrl = new URL(window.location.origin)
    phoneUrl.hostname = result.addresses[0]
    phoneUrl.pathname = path
    phoneUrl.search = search
    phoneUrl.hash = ''
    return phoneUrl.href
  } catch {
    return fallbackUrl
  }
}

function App() {
  const [polls, setPolls] = useState<Poll[]>([])
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState(['', ''])
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoPreviewUrl, setLogoPreviewUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sharePoll, setSharePoll] = useState<Poll | null>(null)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [authLoading, setAuthLoading] = useState(true)
  const [setupRequired, setSetupRequired] = useState(false)
  const [authUser, setAuthUser] = useState<AuthUser | null>(null)
  const [authError, setAuthError] = useState('')
  const logoInputRef = useRef<HTMLInputElement>(null)

  async function refreshPolls() {
    try {
      setPolls(await requestPolls())
      setError('')
    } catch {
      setError('The poll service is unavailable. Start the app with npm run dev.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    fetch('/api/auth/status')
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not check sign-in status.')
        return response.json()
      })
      .then((result: { setupRequired: boolean; user: AuthUser | null }) => {
        if (!active) return
        setSetupRequired(result.setupRequired)
        setAuthUser(result.user)
        setAuthLoading(false)
      })
      .catch((caught: unknown) => {
        if (!active) return
        setAuthError(caught instanceof Error ? caught.message : 'Could not connect to the sign-in service.')
        setAuthLoading(false)
      })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!authUser || window.location.pathname !== '/') return
    void refreshPolls()
    const timer = window.setInterval(() => void refreshPolls(), 5000)
    return () => window.clearInterval(timer)
  }, [authUser])

  useEffect(() => {
    if (!logoPreviewUrl) return
    return () => URL.revokeObjectURL(logoPreviewUrl)
  }, [logoPreviewUrl])

  function selectPollLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
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
    setLogoPreviewUrl(URL.createObjectURL(file))
  }

  function clearPollLogo() {
    setLogoFile(null)
    setLogoPreviewUrl('')
    if (logoInputRef.current) logoInputRef.current.value = ''
  }

  async function createPoll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const cleanOptions = options.map((option) => option.trim()).filter(Boolean)
    setError('')
    try {
      const formData = new FormData()
      formData.append('question', question.trim())
      formData.append('options', JSON.stringify(cleanOptions))
      if (logoFile) formData.append('logo', logoFile)
      const response = await fetch('/api/polls', {
        method: 'POST',
        body: formData,
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not create this poll.')
      setPolls((current) => [result, ...current])
      setQuestion('')
      setOptions(['', ''])
      clearPollLogo()
      setSharePoll(result)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create this poll.')
    }
  }

  function handleAuthenticated(user: AuthUser) {
    setAuthUser(user)
    setSetupRequired(false)
    setAuthError('')
    if (window.location.pathname === '/admin/users' && user.role !== 'admin') window.location.replace('/')
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    setAuthUser(null)
  }

  if (resultsPath) return <ResultsDisplay pollId={decodeURIComponent(resultsPath[1])} />
  if (selfieCamPath) return <SelfieCamPage pollId={decodeURIComponent(selfieCamPath[1])} />
  if (pollPath) return <VotePage pollId={decodeURIComponent(pollPath[1])} />
  if (authLoading) return <AuthLoading />
  if (setupRequired) return <LoginPage setupRequired onAuthenticated={handleAuthenticated} initialError={authError} />
  if (!authUser) return <LoginPage onAuthenticated={handleAuthenticated} initialError={authError} />
  if (window.location.pathname === '/admin/users') {
    return authUser.role === 'admin'
      ? <AdminUsersPage currentUser={authUser} onLogout={() => void logout()} />
      : <AccessDeniedPage onLogout={() => void logout()} />
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="VOTE home">
          <span>VOTE</span>
        </a>
        <div className="topbar-actions">
          <button className="button button-quiet scan-trigger" onClick={() => setScannerOpen(true)}>
            <ScanLine size={17} /> <span>Scan a poll</span>
          </button>
          {authUser.role === 'admin' && <a className="button button-quiet manage-users-link" href="/admin/users"><Users size={16} /> Manage users</a>}
          <span className="signed-in-user">{authUser.username}</span>
          <button className="icon-button signout-button" onClick={() => void logout()} aria-label="Sign out" title="Sign out"><LogOut size={17} /></button>
        </div>
      </header>

      <main className="dashboard">
        <section className="workspace-grid">
          <section className="create-panel" aria-labelledby="create-title">
            <div className="section-heading">
              <div><span className="step-number">01</span><h2 id="create-title">Start a poll</h2></div>
              <span className="heading-note">Takes about 20 seconds</span>
            </div>
            <form onSubmit={createPoll} className="poll-form">
              <label className="field-label" htmlFor="poll-question">Your question</label>
              <textarea
                id="poll-question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="What should we focus on next?"
                maxLength={160}
                rows={2}
                required
                minLength={3}
              />
              <div className="poll-logo-field">
                <input ref={logoInputRef} className="logo-file-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={selectPollLogo} aria-label="Choose a logo for this poll's QR code" />
                <div className="logo-preview-tile">{logoPreviewUrl ? <img src={logoPreviewUrl} alt="Selected QR logo preview" /> : <ImagePlus size={21} />}</div>
                <div className="logo-field-copy"><strong>{logoFile ? logoFile.name : 'Add a QR logo'}</strong><span>Optional · JPEG, PNG, or WebP · 5 MB max</span></div>
                <button className="button button-secondary logo-picker-button" type="button" onClick={() => logoInputRef.current?.click()}>{logoFile ? 'Change' : 'Upload'}</button>
                {logoFile && <button className="icon-button logo-remove-button" type="button" onClick={clearPollLogo} aria-label="Remove QR logo"><X size={16} /></button>}
              </div>
              <div className="field-row-label">
                <span className="field-label">Answer options</span>
                <span className="field-hint">2 minimum · 8 maximum</span>
              </div>
              <div className="option-list">
                {options.map((option, index) => (
                  <div className="option-input-row" key={index}>
                    <span className={`option-marker marker-${index % 4}`}>{String.fromCharCode(65 + index)}</span>
                    <input
                      aria-label={`Option ${index + 1}`}
                      value={option}
                      onChange={(event) => setOptions((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))}
                      placeholder={index === 0 ? 'First answer' : index === 1 ? 'Second answer' : `Option ${index + 1}`}
                      maxLength={80}
                    />
                    {options.length > 2 && (
                      <button className="icon-button remove-option" type="button" aria-label={`Remove option ${index + 1}`} onClick={() => setOptions((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={16} /></button>
                    )}
                  </div>
                ))}
              </div>
              {options.length < 8 && <button className="add-option" type="button" onClick={() => setOptions((current) => [...current, ''])}><Plus size={15} /> Add an option</button>}
              {error && <p className="form-error" role="alert">{error}</p>}
              <button className="button button-primary create-button" type="submit" disabled={loading}>
                Create poll <ArrowUpRight size={17} />
              </button>
            </form>
            <div className="privacy-note"><CircleHelp size={15} /><span>One vote per browser. Results update for everyone in the room.</span></div>
          </section>

          <section className="polls-panel" aria-labelledby="polls-title">
            <div className="section-heading polls-heading">
              <div><span className="step-number">02</span><h2 id="polls-title">Your polls</h2></div>
              <span className="poll-count">{polls.length.toString().padStart(2, '0')}</span>
            </div>
            {loading ? <div className="empty-state">Opening your polls…</div> : polls.length === 0 ? (
              <div className="empty-state empty-first">
                <div className="empty-icon"><QrCode size={21} /></div>
                <strong>Your next good question starts here.</strong>
                <span>Polls you create will appear in this list.</span>
              </div>
            ) : (
              <div className="poll-list">
                {polls.map((poll) => {
                  const totalVotes = poll.options.reduce((total, option) => total + option.votes, 0)
                  return (
                    <article className="poll-row" key={poll.id}>
                      <div className="poll-row-main">
                        <div className="poll-row-meta"><span className="live-indicator" />{totalVotes ? `${totalVotes} ${totalVotes === 1 ? 'vote' : 'votes'}` : 'READY TO SHARE'}<span className="meta-divider">·</span>{poll.options.length} options</div>
                        <h3>{poll.question}</h3>
                      </div>
                      <button className="icon-button poll-share" onClick={() => setSharePoll(poll)} aria-label={`Show QR code for ${poll.question}`} title="Show QR code"><QrCode size={18} /></button>
                      <a className="icon-button poll-display" href={`/poll/${poll.id}/display`} aria-label={`Display live results for ${poll.question}`} title="Display live results"><MonitorPlay size={18} /></a>
                      <a className="poll-open" href={`/poll/${poll.id}`} aria-label={`Open poll: ${poll.question}`}><ChevronRight size={18} /></a>
                    </article>
                  )
                })}
              </div>
            )}
            <div className="polls-footnote"><span className="footnote-bar" />Polls are saved on this server, not in your browser.</div>
          </section>
        </section>
        <footer className="page-footer"><span>VOTE <span className="footer-dot">/</span> SMALL ROOM, BIG VOICE</span><span>Made for the moments when everyone should weigh in.</span></footer>
      </main>

      {sharePoll && <ShareDialog poll={sharePoll} onClose={() => { setSharePoll(null); setCopied(false) }} copied={copied} setCopied={setCopied} />}
      {scannerOpen && <ScannerDialog onClose={() => setScannerOpen(false)} />}
    </div>
  )
}

function ShareDialog({ poll, onClose, copied, setCopied }: { poll: Poll; onClose: () => void; copied: boolean; setCopied: (value: boolean) => void }) {
  const [shareUrl, setShareUrl] = useState('')

  useEffect(() => {
    let active = true
    void getPollShareUrl(poll.id).then((url) => { if (active) setShareUrl(url) })
    return () => { active = false }
  }, [poll.id])

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="modal share-modal" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <button className="icon-button modal-close" onClick={onClose} aria-label="Close"><X size={19} /></button>
        <div className="modal-kicker"><span className="live-indicator" /> POLL IS READY</div>
        <h2 id="share-title">Cast your vote for the</h2>
        <p className="share-question">{poll.question}</p>
        <div className="qr-frame">{shareUrl ? <PollQrCode value={shareUrl} logoUrl={poll.logoUrl} size={240} label="QR code for this poll" /> : <span className="scan-caption">Preparing QR code…</span>}</div>
        <p className="scan-caption">Open your camera and point it here</p>
        <p className="share-help">Keep your phone on the same Wi-Fi network. The QR opens <span>{shareUrl ? new URL(shareUrl).host : 'the poll link'}</span>.</p>
        <button className="button button-secondary copy-button" onClick={() => void copyLink()} disabled={!shareUrl}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? 'Link copied' : 'Copy poll link'}</button>
        <a className="share-open-link" href={shareUrl}>Open voting page <ArrowUpRight size={14} /></a>
      </section>
    </div>
  )
}

function ScannerDialog({ onClose }: { onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [scanError, setScanError] = useState('')

  useEffect(() => {
    if (!videoRef.current) return
    const reader = new BrowserMultiFormatReader()
    let active = true
    let stopScanning: (() => void) | undefined
    void reader.decodeFromVideoDevice(undefined, videoRef.current, (result) => {
      if (!result || !active) return
      const scannedUrl = result.getText()
      try {
        const target = new URL(scannedUrl, window.location.origin)
        if (target.origin !== window.location.origin || !/^\/poll\/[\w-]+\/?$/.test(target.pathname)) {
          setScanError('That code does not look like a VOTE poll.')
          return
        }
        window.location.href = target.href
      } catch {
        setScanError('Could not read that poll link. Try again.')
      }
    }).then((controls) => {
      stopScanning = () => controls.stop()
      if (!active) stopScanning()
    }).catch(() => setScanError('Camera access is needed to scan. Check your browser permissions.'))
    return () => {
      active = false
      stopScanning?.()
    }
  }, [])

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="modal scanner-modal" role="dialog" aria-modal="true" aria-labelledby="scanner-title">
        <button className="icon-button modal-close" onClick={onClose} aria-label="Close scanner"><X size={19} /></button>
        <div className="modal-kicker"><ScanLine size={15} /> QUICK JOIN</div>
        <h2 id="scanner-title">Scan a poll.</h2>
        <p className="scanner-intro">Hold the QR code inside the frame to open its voting page.</p>
        <div className="camera-frame"><video ref={videoRef} muted playsInline /><span className="scan-corner corner-tl" /><span className="scan-corner corner-tr" /><span className="scan-corner corner-bl" /><span className="scan-corner corner-br" /></div>
        {scanError && <p className="form-error" role="alert">{scanError}</p>}
        <button className="button button-secondary scanner-cancel" onClick={onClose}><ArrowLeft size={16} /> Back to polls</button>
      </section>
    </div>
  )
}

function VotePage({ pollId }: { pollId: string }) {
  const selfieMode = new URLSearchParams(window.location.search).get('open') === 'selfie'
  const [poll, setPoll] = useState<Poll | null>(null)
  const [selected, setSelected] = useState('')
  const [voted, setVoted] = useState(false)
  const [selfieUrl, setSelfieUrl] = useState('')
  const [selfieFile, setSelfieFile] = useState<File | null>(null)
  const [selfieUploaded, setSelfieUploaded] = useState(false)
  const [uploadingSelfie, setUploadingSelfie] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [voterId] = useState(getVoterId)
  const selfieInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!selfieUrl) return
    return () => URL.revokeObjectURL(selfieUrl)
  }, [selfieUrl])

  useEffect(() => {
    let active = true
    async function load() {
      try {
        const response = await fetch(`/api/polls/${encodeURIComponent(pollId)}`)
        if (!response.ok) throw new Error('This poll may have been removed or the link may be incorrect.')
        const data: Poll = await response.json()
        if (active) setPoll(data)
        const voteResponse = await fetch(`/api/polls/${encodeURIComponent(pollId)}/voter/${encodeURIComponent(voterId)}`)
        if (voteResponse.ok && active) setVoted(Boolean((await voteResponse.json()).voted))
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : 'Could not open this poll.')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [pollId, voterId])

  useEffect(() => {
    if (!poll || voted) return
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/polls/${encodeURIComponent(pollId)}`)
        if (response.ok) setPoll(await response.json())
      } catch { /* Keep the last visible results while reconnecting. */ }
    }, 3000)
    return () => window.clearInterval(timer)
  }, [pollId, poll, voted])

  async function castVote() {
    if (!selected) return
    setError('')
    try {
      const response = await fetch(`/api/polls/${encodeURIComponent(pollId)}/votes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optionId: selected, voterId }),
      })
      const result = await response.json()
      if (response.status === 409) {
        setVoted(true)
        setError('')
        const latestResponse = await fetch(`/api/polls/${encodeURIComponent(pollId)}`)
        if (latestResponse.ok) setPoll(await latestResponse.json())
        return
      }
      if (!response.ok) throw new Error(result.error || 'Your vote could not be recorded.')
      setPoll(result)
      setVoted(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Your vote could not be recorded.')
    }
  }

  async function uploadSelfie(image: File) {
    setUploadingSelfie(true)
    setError('')
    const formData = new FormData()
    formData.append('selfie', image)
    formData.append('voterId', voterId)

    try {
      const response = await fetch(`/api/polls/${encodeURIComponent(pollId)}/selfies`, { method: 'POST', body: formData })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'The selfie could not be uploaded.')
      setSelfieUploaded(true)
    } catch (caught) {
      setSelfieUploaded(false)
      setError(caught instanceof Error ? caught.message : 'The selfie could not be uploaded.')
    } finally {
      setUploadingSelfie(false)
    }
  }

  function captureSelfie(event: ChangeEvent<HTMLInputElement>) {
    const image = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!image) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.type)) {
      setError('Choose a JPEG, PNG, or WebP photo.')
      return
    }
    if (image.size > 5 * 1024 * 1024) {
      setError('Photo must be 5 MB or smaller.')
      return
    }
    setSelfieFile(image)
    setSelfieUploaded(false)
    setSelfieUrl(URL.createObjectURL(image))
    void uploadSelfie(image)
  }

  async function removeSelfie() {
    const wasUploaded = selfieUploaded
    setSelfieUrl('')
    setSelfieFile(null)
    setSelfieUploaded(false)
    if (!wasUploaded) return

    try {
      const response = await fetch(`/api/polls/${encodeURIComponent(pollId)}/selfies/${encodeURIComponent(voterId)}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('The uploaded selfie could not be removed.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The uploaded selfie could not be removed.')
    }
  }

  const totalVotes = poll?.options.reduce((total, option) => total + option.votes, 0) ?? 0

  return (
    <div className="vote-shell">
      <header className="vote-topbar"><span className="brand" aria-label="VOTE">VOTE</span><span className="vote-top-label">{selfieMode ? 'SELFIE CAM' : 'A QUICK ROOM POLL'}</span></header>
      <main className="vote-main">
        {selfieMode && <a className="back-link" href={`/poll/${pollId}`}><ArrowLeft size={15} /> Back to poll</a>}
        {loading ? <div className="vote-card"><div className="skeleton-line" /><div className="skeleton-line short" /></div> : error && !poll ? (
          <div className="vote-card not-found"><div className="empty-icon"><CircleHelp size={21} /></div><h1>Poll not found.</h1><p>{error}</p><p>Check the QR code and try again.</p></div>
        ) : poll ? (
          <section className="vote-card">
            <div className="vote-card-kicker"><span className="live-indicator" /> {selfieMode ? 'SELFIE CAM' : 'LIVE POLL'} {!selfieMode && <><span className="kicker-divider">/</span> {totalVotes} {totalVotes === 1 ? 'VOTE' : 'VOTES'}</>}</div>
            <h1>{selfieMode ? 'Send a selfie.' : poll.question}</h1>
            {selfieMode && <p className="selfie-poll-question">For: {poll.question}</p>}
            <p className="vote-instruction">{selfieMode ? 'Take a selfie and send it to the big screen.' : voted ? 'You have already voted in this poll. You cannot vote again. Thank you!' : 'Choose one answer. You can only vote once.'}</p>
            {!selfieMode && <div className="vote-options">
              {poll.options.map((option, index) => {
                const percent = totalVotes ? Math.round(option.votes / totalVotes * 100) : 0
                return (
                  <button key={option.id} className={`vote-option ${selected === option.id ? 'is-selected' : ''} ${voted ? 'show-result' : ''}`} disabled={voted} onClick={() => setSelected(option.id)}>
                    {voted && <span className="result-fill" style={{ width: `${percent}%` }} />}
                    <span className={`option-marker marker-${index % 4}`}>{String.fromCharCode(65 + index)}</span>
                    <span className="vote-option-label">{option.label}</span>
                    {voted ? <span className="vote-percent">{percent}% <small>{option.votes}</small></span> : <span className="radio-mark" />}
                  </button>
                )
              })}
            </div>}
            {selfieMode && <div className="selfie-section">
              <input ref={selfieInputRef} className="selfie-input" type="file" accept="image/*" capture="user" onChange={captureSelfie} aria-label="Take a selfie" />
              {selfieUrl ? (
                <div className="selfie-preview">
                  <img src={selfieUrl} alt="Your captured selfie" />
                  <div className="selfie-preview-info"><strong>{uploadingSelfie ? 'Uploading selfie…' : selfieUploaded ? 'On the big screen' : 'Upload failed'}</strong><span>{selfieUploaded ? 'Visible on the selfie cam display' : 'Your preview stays on this phone'}</span></div>
                  {!selfieUploaded && !uploadingSelfie && selfieFile && <button className="selfie-action" type="button" onClick={() => void uploadSelfie(selfieFile)} aria-label="Retry selfie upload" title="Retry upload"><RotateCcw size={17} /></button>}
                  <button className="selfie-action" type="button" disabled={uploadingSelfie} onClick={() => selfieInputRef.current?.click()} aria-label="Retake selfie" title="Retake selfie"><Camera size={17} /></button>
                  <button className="selfie-action selfie-remove" type="button" disabled={uploadingSelfie} onClick={() => void removeSelfie()} aria-label="Remove selfie" title="Remove selfie"><X size={17} /></button>
                </div>
              ) : (
                <button className="selfie-capture" type="button" onClick={() => selfieInputRef.current?.click()}>
                  <span className="selfie-camera-icon"><Camera size={19} /></span>
                  <span className="selfie-capture-copy"><strong>Add a selfie</strong><small>Optional · appears on the big screen after upload</small></span>
                  <ArrowUpRight size={16} />
                </button>
              )}
            </div>}
            {error && <p className="form-error" role="alert">{error}</p>}
            {selfieMode ? <a className="button button-secondary submit-vote selfie-return-button" href={`/poll/${pollId}`}>Continue to poll voting <ArrowUpRight size={17} /></a> : !voted ? <button className="button button-primary submit-vote" onClick={() => void castVote()} disabled={!selected}>Cast my vote <ArrowUpRight size={17} /></button> : <div className="vote-confirmation" role="status"><Check size={16} /> Vote recorded · one vote per browser</div>}
            <div className="vote-card-foot"><span>VOTE <span className="footer-dot">/</span> EVERY VOICE COUNTS</span>{selfieMode && <span className="selfie-thanks">Thanks for joining in</span>}</div>
          </section>
        ) : null}
      </main>
    </div>
  )
}

function ResultsDisplay({ pollId }: { pollId: string }) {
  const [poll, setPoll] = useState<Poll | null>(null)
  const [error, setError] = useState('')
  const [shareUrl, setShareUrl] = useState('')

  useEffect(() => {
    let active = true
    async function refresh() {
      try {
        const response = await fetch(`/api/polls/${encodeURIComponent(pollId)}`)
        if (!response.ok) throw new Error('This poll could not be found.')
        const data: Poll = await response.json()
        if (active) {
          setPoll(data)
          setError('')
        }
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : 'Could not load live results.')
      }
    }

    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [pollId])

  useEffect(() => {
    let active = true
    void getPollShareUrl(pollId).then((url) => { if (active) setShareUrl(url) })
    return () => { active = false }
  }, [pollId])

  if (!poll) {
    return <main className="display-loading">{error || 'Loading live results…'}</main>
  }

  const totalVotes = poll.options.reduce((total, option) => total + option.votes, 0)
  const leadingVotes = Math.max(...poll.options.map((option) => option.votes), 0)
  const leader = poll.options.find((option) => option.votes === leadingVotes && leadingVotes > 0)

  return (
    <main className="display-shell">
      <header className="display-topbar">
        <a className="brand" href="/" aria-label="VOTE home"><span>VOTE</span></a>
        <div className="display-live"><span className="live-indicator" /> LIVE RESULTS <span className="display-live-divider">/</span> UPDATES EVERY 2 SEC</div>
        <a className="display-exit" href="/">Exit display <ArrowUpRight size={15} /></a>
      </header>
      <section className="display-heading">
        <div>
          <div className="display-kicker">AUDIENCE POLL <span>/</span> LIVE SCOREBOARD</div>
          <h1>{poll.question}</h1>
        </div>
        <div className="display-total"><strong>{totalVotes.toLocaleString()}</strong><span>VOTES CAST</span></div>
      </section>
      <section className="display-grid">
        <div className="display-results" aria-label="Live poll results">
          <div className="display-results-heading"><span>THE ROOM HAS SPOKEN</span><span>{poll.options.length} OPTIONS</span></div>
          {poll.options.map((option, index) => {
            const percent = totalVotes ? Math.round(option.votes / totalVotes * 100) : 0
            return (
              <article className={`display-result result-tone-${index % 4}`} key={option.id}>
                <div className="display-result-top">
                  <span className="display-result-index">{String(index + 1).padStart(2, '0')}</span>
                  <h2>{option.label}</h2>
                  <span className="display-result-percent">{percent}<small>%</small></span>
                </div>
                <div className="display-meter"><span style={{ width: `${percent}%` }} /></div>
                <div className="display-result-count">{option.votes.toLocaleString()} {option.votes === 1 ? 'VOTE' : 'VOTES'}</div>
              </article>
            )
          })}
          {leader && <div className="display-leader"><span className="leader-star">★</span><span>IN THE LEAD</span><strong>{leader.label}</strong></div>}
          {!totalVotes && <div className="display-waiting">Waiting for the first vote</div>}
        </div>
        <aside className="display-join">
          <div className="join-kicker"><QrCode size={15} /> JOIN THE VOTE</div>
          <h2>Your voice<br /><span>belongs here.</span></h2>
          <div className="display-qr">{shareUrl && poll ? <PollQrCode value={shareUrl} logoUrl={poll.logoUrl} size={220} label="Scan to vote in this poll" /> : <span>Loading QR…</span>}</div>
          <p>Point your phone camera at the code to cast your vote.</p>
          {shareUrl && <span className="display-address">{new URL(shareUrl).host}</span>}
        </aside>
      </section>
      <footer className="display-footer">
        <span>VOTE <i>/</i> EVERY VOICE COUNTS</span>
        <a href={`/poll/${poll.id}`}>Open voting page <ArrowUpRight size={14} /></a>
        <a href={`/poll/${poll.id}/selfie-cam`}>Selfie cam <Camera size={14} /></a>
        <button className="display-fullscreen" onClick={() => { if (!document.fullscreenElement) void document.documentElement.requestFullscreen(); else void document.exitFullscreen() }}><Maximize size={16} /> Full screen</button>
      </footer>
    </main>
  )
}

function SelfieCamPage({ pollId }: { pollId: string }) {
  const [poll, setPoll] = useState<Poll | null>(null)
  const [selfies, setSelfies] = useState<Selfie[]>([])
  const [shareUrl, setShareUrl] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    async function refresh() {
      try {
        const [pollResponse, selfieResponse] = await Promise.all([
          fetch(`/api/polls/${encodeURIComponent(pollId)}`),
          fetch(`/api/polls/${encodeURIComponent(pollId)}/selfies`),
        ])
        if (!pollResponse.ok || !selfieResponse.ok) throw new Error('This selfie cam could not be found.')
        const [pollData, selfieData]: [Poll, Selfie[]] = await Promise.all([pollResponse.json(), selfieResponse.json()])
        if (active) {
          setPoll(pollData)
          setSelfies(selfieData)
          setError('')
        }
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : 'Could not load the selfie cam.')
      }
    }

    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [pollId])

  useEffect(() => {
    let active = true
    void getPollShareUrl(pollId, 'selfie').then((url) => { if (active) setShareUrl(url) })
    return () => { active = false }
  }, [pollId])

  if (!poll) return <main className="selfie-cam-loading">{error || 'Connecting to selfie cam…'}</main>

  const latestSelfie = selfies[0]

  return (
    <main className="selfie-cam-shell">
      <header className="selfie-cam-topbar">
        <a className="brand" href="/" aria-label="VOTE home"><span>VOTE</span></a>
        <div className="selfie-cam-live"><span className="live-indicator" /> LIVE SELFIE CAM <span>/</span> {selfies.length} {selfies.length === 1 ? 'PHOTO' : 'PHOTOS'}</div>
        <a className="selfie-cam-back" href={`/poll/${poll.id}/display`}>Back to results <ArrowUpRight size={14} /></a>
      </header>
      <section className="selfie-cam-content">
        <div className="selfie-cam-main">
          <div className="selfie-cam-title"><span>VOTE <i>/</i> AUDIENCE CAMERA</span><h1>SELFIE CAM</h1><p>{poll.question}</p></div>
          <div className={`selfie-hero ${latestSelfie ? 'has-selfie' : ''}`}>
            {latestSelfie ? (
              <>
                <img className="selfie-backdrop" src={latestSelfie.imageUrl} alt="" aria-hidden="true" />
                <img className="selfie-photo" key={latestSelfie.id} src={latestSelfie.imageUrl} alt="Latest audience selfie" />
              </>
            ) : (
              <div className="selfie-empty"><Camera size={48} /><strong>You could be on the big screen.</strong><span>Scan the code and send the first selfie.</span></div>
            )}
            <span className="selfie-hero-tag"><span className="live-indicator" /> {latestSelfie ? 'JUST SENT' : 'WAITING FOR SELFIES'}</span>
          </div>
          <div className="selfie-recent">
            <div className="selfie-recent-heading"><span>FROM THE CROWD</span><span>{selfies.length} SHARED</span></div>
            {selfies.length ? (
              <div className="selfie-strip">
                {selfies.slice(0, 6).map((selfie, index) => (
                  <img className={index === 0 ? 'is-latest' : ''} key={selfie.id} src={selfie.imageUrl} alt={`Audience selfie ${index + 1}`} />
                ))}
              </div>
            ) : <div className="selfie-strip-empty">New selfies appear here as they arrive.</div>}
          </div>
        </div>
        <aside className="selfie-cam-join">
          <div className="selfie-cam-join-label"><QrCode size={17} /> GET IN THE PICTURE</div>
          <div className="selfie-cam-qr">{shareUrl && poll ? <PollQrCode value={shareUrl} logoUrl={poll.logoUrl} size={220} label="Scan to take a selfie" /> : <span>Loading QR…</span>}</div>
          <p>Open the poll on your phone, capture a selfie, and send it to the screen.</p>
          {shareUrl && <span className="selfie-cam-address">{new URL(shareUrl).host}</span>}
          <div className="selfie-cam-consent">Photos are shared on this screen for this poll.</div>
        </aside>
      </section>
      <footer className="selfie-cam-footer"><span>VOTE <i>/</i> LIVE FROM THE CROWD</span><a href={`/poll/${poll.id}/display`}>View poll results <ArrowUpRight size={14} /></a><button className="display-fullscreen" onClick={() => { if (!document.fullscreenElement) void document.documentElement.requestFullscreen(); else void document.exitFullscreen() }}><Maximize size={16} /> Full screen</button></footer>
    </main>
  )
}

function AuthLoading() {
  return <main className="auth-shell"><div className="auth-loading">Checking access…</div></main>
}

function LoginPage({ setupRequired = false, initialError = '', onAuthenticated }: { setupRequired?: boolean; initialError?: string; onAuthenticated: (user: AuthUser) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(initialError)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const response = await fetch(setupRequired ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Sign-in failed.')
      onAuthenticated(result.user)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sign-in failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-shell">
      <header className="auth-topbar"><a className="brand" href="/"><span>VOTE</span></a><span className="auth-top-label">POLL MANAGEMENT</span></header>
      <section className="auth-layout">
        <div className="auth-intro"><span className="auth-eyebrow">VOTE <i>/</i> HOST ACCESS</span><h1>{setupRequired ? 'Set up your admin account.' : 'Welcome back.'}</h1><p>{setupRequired ? 'Create the first admin account to manage polls and add other users.' : 'Sign in to create polls and manage your audience displays.'}</p></div>
        <form className="auth-form" onSubmit={submit}>
          <div className="auth-form-heading"><span className="auth-icon">{setupRequired ? <Shield size={19} /> : <LogIn size={19} />}</span><div><h2>{setupRequired ? 'Initial setup' : 'Sign in'}</h2><span>{setupRequired ? 'First account becomes admin' : 'Use your host account'}</span></div></div>
          <label className="auth-field-label" htmlFor="auth-username">Username</label>
          <input id="auth-username" autoComplete="username" minLength={3} maxLength={40} value={username} onChange={(event) => setUsername(event.target.value)} required />
          <label className="auth-field-label" htmlFor="auth-password">Password</label>
          <input id="auth-password" type="password" autoComplete={setupRequired ? 'new-password' : 'current-password'} minLength={setupRequired ? 12 : undefined} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} required />
          {setupRequired && <p className="auth-hint">Use at least 12 characters. You can add other accounts after signing in.</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="button button-primary auth-submit" type="submit" disabled={busy}>{setupRequired ? <UserPlus size={17} /> : <LogIn size={17} />}{busy ? 'Please wait…' : setupRequired ? 'Create admin account' : 'Sign in'}</button>
        </form>
      </section>
    </main>
  )
}

function AdminUsersPage({ currentUser, onLogout }: { currentUser: AuthUser; onLogout: () => void }) {
  const [users, setUsers] = useState<AuthUser[]>([])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<'admin' | 'host'>('host')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    fetch('/api/admin/users')
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Could not load users.')
        return result as (AuthUser & { createdAt: string })[]
      })
      .then((result) => { if (active) setUsers(result) })
      .catch((caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : 'Could not load users.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  async function addUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaving(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password, role }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not add user.')
      setUsers((current) => [...current, result.user])
      setUsername('')
      setPassword('')
      setRole('host')
      setNotice(`${result.user.username} has been added.`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add user.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="admin-shell">
      <header className="admin-topbar"><a className="brand" href="/"><span>VOTE</span></a><div className="admin-top-actions"><span>{currentUser.username} · ADMIN</span><button className="icon-button signout-button" onClick={onLogout} aria-label="Sign out" title="Sign out"><LogOut size={17} /></button></div></header>
      <div className="admin-content">
        <a className="admin-back" href="/">← Dashboard</a>
        <div className="admin-heading"><span className="auth-eyebrow">ACCOUNT CONTROL</span><h1>Manage users</h1><p>Add a host or another admin account.</p></div>
        <div className="admin-grid">
          <form className="admin-form" onSubmit={addUser}>
            <div className="admin-form-title"><UserPlus size={18} /><h2>Add a user</h2></div>
            <label className="auth-field-label" htmlFor="new-username">Username</label>
            <input id="new-username" autoComplete="off" minLength={3} maxLength={40} value={username} onChange={(event) => setUsername(event.target.value)} required />
            <label className="auth-field-label" htmlFor="new-password">Temporary password</label>
            <input id="new-password" type="password" autoComplete="new-password" minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} required />
            <p className="auth-hint">At least 12 characters. Share it with the user securely.</p>
            <label className="auth-field-label" htmlFor="new-role">Role</label>
            <select id="new-role" value={role} onChange={(event) => setRole(event.target.value as 'admin' | 'host')}><option value="host">Host · create and manage polls</option><option value="admin">Admin · manage users and polls</option></select>
            {error && <p className="form-error" role="alert">{error}</p>}
            {notice && <p className="auth-success" role="status">{notice}</p>}
            <button className="button button-primary auth-submit" type="submit" disabled={saving}><UserPlus size={17} />{saving ? 'Adding…' : 'Add user'}</button>
          </form>
          <section className="admin-user-list" aria-labelledby="users-title">
            <div className="admin-form-title"><Users size={18} /><h2 id="users-title">Accounts</h2><span>{users.length}</span></div>
            {loading ? <p className="auth-hint">Loading accounts…</p> : users.map((user) => <div className="admin-user-row" key={user.id}><span className="admin-user-avatar">{user.username.slice(0, 1).toUpperCase()}</span><span className="admin-user-name">{user.username}<small>{user.id === currentUser.id ? 'You' : 'VOTE account'}</small></span><span className={`role-tag role-${user.role}`}>{user.role}</span></div>)}
          </section>
        </div>
      </div>
    </main>
  )
}

function AccessDeniedPage({ onLogout }: { onLogout: () => void }) {
  return <main className="auth-shell"><section className="access-denied"><Shield size={30} /><h1>Admin access required.</h1><p>Your account can manage polls but cannot manage users.</p><a className="button button-secondary" href="/">Back to dashboard</a><button className="button button-quiet" onClick={onLogout}>Sign out</button></section></main>
}

export default App