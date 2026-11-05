import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { Film, LogOut, Trash2, Upload } from 'lucide-react'
import { ThemeBrand } from './theme'

export type AdVideoKind = 'poll' | 'qa' | 'game' | 'selfie' | 'raffle'
type AdVideoInfo = { available: boolean; url?: string; name?: string; size?: number; updatedAt?: string }
const thankYouKey = `games-experience:thank-you:${window.location.pathname}`

export function hasAudienceThankYouCompleted() {
  try { return window.localStorage.getItem(thankYouKey) === 'done' } catch { return false }
}

function markAudienceThankYouCompleted() {
  try { window.localStorage.setItem(thankYouKey, 'done') } catch { /* Continue with the in-memory screen if storage is unavailable. */ }
  window.dispatchEvent(new Event('audience-thank-you-complete'))
}

export function ThankYouScreen({ children }: { children?: ReactNode }) {
  const [showCloseHint, setShowCloseHint] = useState(false)

  useEffect(() => {
    const currentUrl = window.location.href
    window.history.pushState({ thankYou: true }, '', currentUrl)
    const keepThankYouVisible = () => window.history.pushState({ thankYou: true }, '', currentUrl)
    window.addEventListener('popstate', keepThankYouVisible)
    return () => window.removeEventListener('popstate', keepThankYouVisible)
  }, [])

  return (
    <main className="audience-thank-you-shell">
      <section className="audience-thank-you" role="status" aria-labelledby="audience-thank-you-title">
        <div className="audience-thank-you-mark" aria-hidden="true">✓</div>
        <h1 id="audience-thank-you-title">THANK YOU FOR PARTICIPATING!</h1>
        <button className="button button-primary audience-thank-you-close" type="button" onClick={() => {
          setShowCloseHint(true)
          try { window.close() } catch { /* The browser may refuse to close a tab it did not open. */ }
        }}>Close</button>
        {showCloseHint && <p className="audience-thank-you-hint" role="status">You may now safely close this browser tab.</p>}
        {children}
      </section>
    </main>
  )
}

const kindLabels: Record<AdVideoKind, { title: string; description: string }> = {
  poll: { title: 'Poll video', description: 'Plays full-screen on a participant’s phone right after they cast a vote.' },
  qa: { title: 'Q&A video', description: 'Plays full-screen on a participant’s phone right after they press Enter on a Q&A answer.' },
  game: { title: 'Vanishing Tic-Tac-Toe video', description: 'Plays full-screen for both players when a match ends.' },
  selfie: { title: 'Selfie Cam video', description: 'Plays full-screen on a guest’s phone right after they send their photo to the host.' },
  raffle: { title: 'QR Raffle video', description: 'Plays full-screen on a ticket holder’s phone after they register for a raffle.' },
}

// Full-screen video that cannot be skipped, seeked, paused, or closed; it closes itself when playback ends or fails.
export function AdVideoOverlay({ kind, onDone }: { kind: AdVideoKind; onDone: () => void }) {
  const [url, setUrl] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const lastTime = useRef(0)
  const finish = useRef(onDone)
  finish.current = onDone

  useEffect(() => {
    let active = true
    fetch(`/api/ad-videos/${kind}`)
      .then(async (response) => {
        const result = await response.json() as AdVideoInfo
        if (!active) return
        if (response.ok && result.available && result.url) setUrl(result.url)
        else finish.current()
      })
      .catch(() => { if (active) finish.current() })
    return () => { active = false }
  }, [kind])

  useEffect(() => {
    if (!url) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [url])

  const [needsTap, setNeedsTap] = useState(false)

  // iOS Safari blocks unmuted autoplay and may not preload video, so fall back to muted, then to a tap prompt.
  async function start() {
    const video = videoRef.current
    if (!video || !video.paused || video.ended) return
    try {
      await video.play()
    } catch {
      video.muted = true
      try { await video.play() } catch { setNeedsTap(true) }
    }
  }

  async function tapToPlay() {
    const video = videoRef.current
    if (!video) return
    setNeedsTap(false)
    video.muted = false
    try { await video.play() } catch {
      video.muted = true
      try { await video.play() } catch { finish.current() }
    }
  }

  useEffect(() => {
    if (url) void start()
  }, [url])

  if (!url) return null
  return (
    <div className="ad-video-overlay" role="dialog" aria-modal="true" aria-label="Sponsored video" onContextMenu={(event) => event.preventDefault()}>
      <video
        ref={videoRef}
        className="ad-video-player"
        src={url}
        autoPlay
        playsInline
        disablePictureInPicture
        disableRemotePlayback
        controlsList="nodownload noplaybackrate noremoteplayback"
        preload="auto"
        onLoadedMetadata={() => void start()}
        onCanPlay={() => void start()}
        onTimeUpdate={(event) => { if (!event.currentTarget.seeking) lastTime.current = event.currentTarget.currentTime }}
        onSeeking={(event) => { event.currentTarget.currentTime = lastTime.current }}
        onPause={(event) => { if (!event.currentTarget.ended && !needsTap) void start() }}
        onEnded={() => { markAudienceThankYouCompleted(); finish.current() }}
        onError={() => finish.current()}
      />
      {needsTap && <button type="button" className="ad-video-tap" onClick={() => void tapToPlay()}>Tap to play</button>}
    </div>
  )
}

function formatSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`
}

function AdVideoSlot({ kind, info, maxBytes, onChange }: { kind: AdVideoKind; info: AdVideoInfo; maxBytes: number; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const { title, description } = kindLabels[kind]

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > maxBytes) {
      setError(`Videos must be ${Math.ceil(maxBytes / 1024 / 1024)} MB or smaller.`)
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const data = new FormData()
      data.append('video', file)
      const response = await fetch(`/api/admin/ad-videos/${kind}`, { method: 'PUT', body: data })
      const result = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(result.error || 'The video could not be uploaded.')
      await onChange()
      setNotice('Video uploaded.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The video could not be uploaded.')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!window.confirm(`Remove the ${title.toLowerCase()}? Nothing will play afterwards.`)) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(`/api/admin/ad-videos/${kind}`, { method: 'DELETE' })
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(result.error || 'The video could not be removed.')
      }
      await onChange()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The video could not be removed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="admin-form ad-video-slot">
      <div className="admin-form-title"><Film size={18} /><h2>{title}</h2></div>
      <p className="auth-hint">{description}</p>
      {info.available && info.url ? (
        <>
          <video className="ad-video-preview" src={info.url} controls preload="metadata" />
          <p className="auth-hint">{info.name} · {formatSize(info.size ?? 0)}</p>
        </>
      ) : <p className="auth-hint">No video uploaded. Nothing will play for this activity.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="auth-success" role="status">{notice}</p>}
      <div className="ad-video-actions">
        <label className={`button button-primary ${busy ? 'is-disabled' : ''}`}>
          <Upload size={16} /> {busy ? 'Working…' : info.available ? 'Replace video' : 'Upload video'}
          <input type="file" accept="video/mp4,video/webm" hidden disabled={busy} onChange={(event) => void upload(event)} />
        </label>
        {info.available && <button className="button button-quiet" type="button" onClick={() => void remove()} disabled={busy}><Trash2 size={16} /> Remove</button>}
      </div>
    </section>
  )
}

export function AdVideoSettings({ username, onLogout }: { username: string; onLogout: () => void }) {
  const [videos, setVideos] = useState<{ poll: AdVideoInfo; qa: AdVideoInfo; game: AdVideoInfo; selfie: AdVideoInfo; raffle: AdVideoInfo; maxBytes: number } | null>(null)
  const [error, setError] = useState('')

  async function refresh() {
    try {
      const response = await fetch('/api/admin/ad-videos')
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not load the videos.')
      const missing = { available: false }
      setVideos({ ...result, poll: result.poll ?? missing, qa: result.qa ?? missing, game: result.game ?? missing, selfie: result.selfie ?? missing, raffle: result.raffle ?? missing })
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load the videos.')
    }
  }

  useEffect(() => { void refresh() }, [])

  return (
    <main className="admin-shell">
      <header className="admin-topbar"><ThemeBrand /><div className="admin-top-actions"><span>{username} · ADMIN</span><button className="icon-button signout-button" onClick={onLogout} aria-label="Sign out" title="Sign out"><LogOut size={17} /></button></div></header>
      <div className="admin-content">
        <a className="admin-back" href="/">← Dashboard</a>
        <div className="admin-heading"><span className="auth-eyebrow">VIDEO ADS</span><h1>Videos</h1><p>Upload a separate MP4 or WebM for each activity. Viewers cannot skip, pause, or close these videos.</p></div>
        {error && <p className="form-error" role="alert">{error}</p>}
        {videos && (
          <div className="admin-grid">
            <AdVideoSlot kind="poll" info={videos.poll} maxBytes={videos.maxBytes} onChange={refresh} />
            <AdVideoSlot kind="qa" info={videos.qa} maxBytes={videos.maxBytes} onChange={refresh} />
            <AdVideoSlot kind="game" info={videos.game} maxBytes={videos.maxBytes} onChange={refresh} />
            <AdVideoSlot kind="selfie" info={videos.selfie} maxBytes={videos.maxBytes} onChange={refresh} />
            <AdVideoSlot kind="raffle" info={videos.raffle} maxBytes={videos.maxBytes} onChange={refresh} />
          </div>
        )}
      </div>
    </main>
  )
}
