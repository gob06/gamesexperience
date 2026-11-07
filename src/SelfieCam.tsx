import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import QRCode from 'qrcode'
import { ArrowLeft, Camera, Check, Copy, ImagePlus, Maximize, Minimize, Pause, Play, QrCode, Trash2, Upload, X } from 'lucide-react'
import { ThemeBrand } from './theme'
import { AdVideoOverlay } from './AdVideo'
import { TermsNotice } from './terms'
import { SavedLogoPicker, logoToFile, saveLogo, type SavedLogo } from './logoLibrary'

type SelfieSession = { id: string; joinToken: string; displayToken: string; expiresAt: string }
type SelfieSubmission = { id: string; fileName: string; status: 'pending' | 'approved'; createdAt: string }

export async function getSelfieJoinUrl(token: string) {
  const path = `/selfie/join/${encodeURIComponent(token)}`
  const url = new URL(path, window.location.origin)
  if (!['localhost', '127.0.0.1'].includes(window.location.hostname)) return url.href
  const response = await fetch('/api/network-addresses')
  if (!response.ok) throw new Error('Could not prepare a phone-friendly selfie link.')
  const result = await response.json() as { addresses: string[] }
  if (result.addresses.length) url.hostname = result.addresses[0]
  return url.href
}

export default function SelfieCam() {
  const logoInputRef = useRef<HTMLInputElement>(null)
  const qrCanvasRef = useRef<HTMLCanvasElement>(null)
  const displayRef = useRef<HTMLElement>(null)
  const logoUrlRef = useRef('')
  const bannerInputRef = useRef<HTMLInputElement>(null)
  const [bannerFile, setBannerFile] = useState<File | null>(null)
  const [bannerPreview, setBannerPreview] = useState('')
  const [session, setSession] = useState<SelfieSession | null>(null)
  const [joinUrl, setJoinUrl] = useState('')
  const [qrLogoUrl, setQrLogoUrl] = useState('')
  const [submissions, setSubmissions] = useState<SelfieSubmission[]>([])
  const [displaySubmission, setDisplaySubmission] = useState<SelfieSubmission | null>(null)
  const [fallbackFullscreen, setFallbackFullscreen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [paused, setPaused] = useState(false)

  async function togglePause() {
    if (!session) return
    const next = !paused
    setPaused(next)
    try {
      const response = await fetch(`/api/selfie/sessions/${encodeURIComponent(session.id)}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: next }),
      })
      if (!response.ok) throw new Error('Could not change the pause state.')
    } catch (caught) {
      setPaused(!next)
      setError(caught instanceof Error ? caught.message : 'Could not change the pause state.')
    }
  }
  function chooseQrLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Choose a JPEG, PNG, or WebP QR logo.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('The QR logo must be 5 MB or smaller.')
      return
    }
    if (logoUrlRef.current) URL.revokeObjectURL(logoUrlRef.current)
    const url = URL.createObjectURL(file)
    logoUrlRef.current = url
    setQrLogoUrl(url)
    setError('')
    void saveLogo(file)
  }

  function useSavedLogo(logo: SavedLogo) {
    if (logoUrlRef.current.startsWith('blob:')) URL.revokeObjectURL(logoUrlRef.current)
    logoUrlRef.current = logo.dataUrl
    setQrLogoUrl(logo.dataUrl)
    setError('')
  }

  async function useSavedBanner(logo: SavedLogo) {
    const file = await logoToFile(logo)
    setBannerFile(file)
    setBannerPreview(URL.createObjectURL(file))
  }

  function chooseBanner(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Choose a JPEG, PNG, or WebP photo.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('The guest page photo must be 5 MB or smaller.')
      return
    }
    setError('')
    setBannerFile(file)
    setBannerPreview(URL.createObjectURL(file))
    void saveLogo(file)
  }

  async function createSession() {
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/selfie/sessions', { method: 'POST' })
      const result = await response.json() as SelfieSession & { error?: string }
      if (!response.ok || !result.id || !result.joinToken || !result.displayToken) throw new Error(result.error || 'Could not create a selfie session. Update and restart the server, then try again.')
      if (bannerFile) {
        const form = new FormData()
        form.append('image', bannerFile)
        await fetch(`/api/selfie/sessions/${encodeURIComponent(result.id)}/banner`, { method: 'POST', body: form }).catch(() => undefined)
      }
      const url = await getSelfieJoinUrl(result.joinToken)
      try {
        if (qrLogoUrl) {
          const blob = await (await fetch(qrLogoUrl)).blob()
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result))
            reader.onerror = () => reject(reader.error)
            reader.readAsDataURL(blob)
          })
          localStorage.setItem(`selfie-qr-logo:${result.id}`, dataUrl)
        }
      } catch {
        // The live screen simply shows a plain QR if the logo can't be stored.
      }
      setSession(result)
      setJoinUrl(url)
      setSubmissions([])
      setDisplaySubmission(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create a selfie session.')
    } finally {
      setLoading(false)
    }
  }

  async function refreshSubmissions(sessionId: string) {
    try {
      const response = await fetch(`/api/selfie/sessions/${encodeURIComponent(sessionId)}/submissions`)
      const result = await response.json() as { submissions?: SelfieSubmission[]; closed?: boolean; error?: string }
      if (!response.ok || !result.submissions) throw new Error(result.error || 'Could not load selfie submissions.')
      setSubmissions(result.submissions)
      setPaused(Boolean((result as { paused?: boolean }).paused))
      if (result.closed) {
        setNotice('This selfie session has ended.')
        setSession(null)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not refresh selfie submissions.')
    }
  }

  useEffect(() => {
    if (!session) return
    void refreshSubmissions(session.id)
    const timer = window.setInterval(() => void refreshSubmissions(session.id), 2000)
    return () => window.clearInterval(timer)
  }, [session?.id])

  useEffect(() => {
    const canvas = qrCanvasRef.current
    if (!canvas || !joinUrl) return
    let active = true
    void QRCode.toCanvas(canvas, joinUrl, {
      width: 256,
      margin: 2,
      errorCorrectionLevel: 'H',
      color: { dark: '#15151a', light: '#ffffff' },
    }).then(() => {
      if (!active || !qrLogoUrl) return
      const logo = new Image()
      logo.onload = () => {
        if (!active) return
        const context = canvas.getContext('2d')
        if (!context) return
        const boxSize = Math.round(canvas.width * 0.23)
        const padding = Math.round(canvas.width * 0.025)
        const innerSize = boxSize - padding * 2
        const scale = Math.min(innerSize / logo.naturalWidth, innerSize / logo.naturalHeight)
        const width = logo.naturalWidth * scale
        const height = logo.naturalHeight * scale
        const left = (canvas.width - boxSize) / 2
        const top = (canvas.height - boxSize) / 2
        context.fillStyle = '#ffffff'
        context.fillRect(left, top, boxSize, boxSize)
        context.drawImage(logo, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
      }
      logo.src = qrLogoUrl
    }).catch((caught: unknown) => {
      if (active) setError(caught instanceof Error ? caught.message : 'Could not generate the selfie QR code.')
    })
    return () => { active = false }
  }, [joinUrl, qrLogoUrl])

  useEffect(() => {
    const syncFullscreen = () => {
      if (!document.fullscreenElement) setFallbackFullscreen(false)
    }
    const closeFallbackOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFallbackFullscreen(false)
    }
    document.addEventListener('fullscreenchange', syncFullscreen)
    window.addEventListener('keydown', closeFallbackOnEscape)
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreen)
      window.removeEventListener('keydown', closeFallbackOnEscape)
      if (logoUrlRef.current) URL.revokeObjectURL(logoUrlRef.current)
    }
  }, [])

  async function updateSubmission(submission: SelfieSubmission, action: 'approve' | 'reject') {
    if (!session) return
    setError('')
    setNotice('')
    try {
      const endpoint = `/api/selfie/sessions/${encodeURIComponent(session.id)}/submissions/${encodeURIComponent(submission.id)}`
      const response = await fetch(action === 'approve' ? `${endpoint}/approve` : endpoint, { method: action === 'approve' ? 'POST' : 'DELETE' })
      const result = response.status === 204 ? null : await response.json() as { error?: string }
      if (!response.ok) throw new Error(result?.error || `Could not ${action} this photo.`)
      if (action === 'approve') {
        setNotice('Photo approved. It can now be shown on the big screen.')
      } else {
        setNotice('Photo rejected and deleted.')
      }
      await refreshSubmissions(session.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not ${action} this photo.`)
    }
  }

  async function showFullscreen(submission: SelfieSubmission) {
    setDisplaySubmission(submission)
    setError('')
    if (!displayRef.current) return
    try {
      if (displayRef.current.requestFullscreen) await displayRef.current.requestFullscreen()
      else setFallbackFullscreen(true)
    } catch (caught) {
      setFallbackFullscreen(true)
      setError(caught instanceof Error ? `Fullscreen mode was blocked; showing the photo in presentation mode instead. ${caught.message}` : 'Fullscreen mode was blocked; showing presentation mode instead.')
    }
  }

  async function exitFullscreen() {
    setFallbackFullscreen(false)
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen()
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not exit fullscreen.')
      }
    }
  }

  async function endSession() {
    if (!session || !window.confirm('End this selfie session? Participants will no longer be able to submit photos.')) return
    try {
      const response = await fetch(`/api/selfie/sessions/${encodeURIComponent(session.id)}/close`, { method: 'POST' })
      const result = response.status === 204 ? null : await response.json() as { error?: string }
      if (!response.ok) throw new Error(result?.error || 'Could not end the selfie session.')
      setSession(null)
      setJoinUrl('')
      setSubmissions([])
      setDisplaySubmission(null)
      setNotice('Selfie session ended.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not end the selfie session.')
    }
  }

  const pendingSubmissions = submissions.filter((submission) => submission.status === 'pending')
  const approvedSubmissions = submissions.filter((submission) => submission.status === 'approved')
  const liveScreenUrl = session ? new URL(`/selfie/display/${encodeURIComponent(session.id)}#${new URLSearchParams({ join: session.joinToken, display: session.displayToken })}`, window.location.origin).href : ''

  async function copyLiveScreenUrl() {
    try {
      await navigator.clipboard.writeText(liveScreenUrl)
      setNotice('OBS URL copied. Paste it into an OBS Browser Source.')
      setError('')
    } catch {
      setError('Clipboard access is unavailable. Select and copy the OBS URL below manually.')
    }
  }

  return (
    <main className="selfie-shell">
      <header className="selfie-topbar">
        <ThemeBrand />
        <a className="game-back-link" href="/"><ArrowLeft size={16} /> Back to dashboard</a>
      </header>
      <div className="selfie-content">
        <section className="selfie-heading">
          <span className="activity-eyebrow"><Camera size={15} /> SELFIE CAM · HOST</span>
          <h1>Make it a moment.</h1>
          <p>Create a QR code for guests. Review each photo before approving it for the big screen.</p>
        </section>

        <section className="selfie-panel">
          {!session ? (
            <div className="selfie-empty">
              <span className="selfie-empty-icon"><QrCode size={26} /></span>
              <h2>Start a selfie session</h2>
              <p>Guests scan your QR code to submit photos. Submissions are private until you approve them. Sessions last up to four hours.</p>
              <input ref={logoInputRef} className="selfie-file-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseQrLogo} aria-label="Upload a logo for the selfie QR code" />
              <div className="selfie-qr-logo-picker">
                {qrLogoUrl ? <img src={qrLogoUrl} alt="QR code logo preview" /> : <ImagePlus size={20} />}
                <span>{qrLogoUrl ? 'Custom QR logo selected' : 'Optional center logo · JPEG, PNG, WebP · 5 MB max'}</span>
                <button className="button button-secondary" type="button" onClick={() => logoInputRef.current?.click()}><Upload size={15} /> {qrLogoUrl ? 'Change logo' : 'Upload QR logo'}</button>
              </div>
              <SavedLogoPicker onSelect={useSavedLogo} label="Image bank (QR logo)" />
              <input ref={bannerInputRef} className="selfie-file-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseBanner} aria-label="Upload a photo for the guest page" />
              <div className="selfie-qr-logo-picker">
                {bannerPreview ? <img src={bannerPreview} alt="Guest page photo preview" /> : <ImagePlus size={20} />}
                <span>{bannerPreview ? 'Guest page photo selected' : 'Optional photo shown at the top of the guest page · JPEG, PNG, WebP · 5 MB max'}</span>
                <button className="button button-secondary" type="button" onClick={() => bannerInputRef.current?.click()}><Upload size={15} /> {bannerPreview ? 'Change photo' : 'Upload guest page photo'}</button>
              </div>
              <SavedLogoPicker onSelect={(logo) => void useSavedBanner(logo)} label="Image bank (guest page photo)" />
              <button className="button button-primary selfie-start-button" type="button" onClick={() => void createSession()} disabled={loading}><QrCode size={17} /> {loading ? 'Creating session…' : 'Create selfie QR code'}</button>
            </div>
          ) : (
            <div className="selfie-host-session">
              <div className="selfie-session-heading"><div><span className="selfie-session-label">GUEST UPLOAD QR</span><h2>Scan to submit a selfie</h2></div><div className="selfie-session-buttons"><button className="button button-secondary" type="button" onClick={() => void togglePause()}>{paused ? <Play size={15} /> : <Pause size={15} />} {paused ? 'Resume session' : 'Pause session'}</button><button className="button button-quiet selfie-end-button" type="button" onClick={() => void endSession()}><X size={15} /> End session</button></div></div>
              {paused && <p className="selfie-paused-note">Session paused — guests can't upload and the live screen is holding its current photo.</p>}
              <div className="selfie-session-share">
                <div className="selfie-qr-frame"><canvas ref={qrCanvasRef} aria-label="Scan this QR code to submit a selfie" /></div>
                <p>Scan with a phone camera. Photos must be approved before they appear on screen.</p>
                <a href={joinUrl} target="_blank" rel="noreferrer">Open guest upload page</a>
                <a className="button button-primary" href={liveScreenUrl} target="_blank" rel="noreferrer"><Maximize size={15} /> Open live screen (QR + photos)</a>
                <button className="button button-secondary" type="button" onClick={() => void copyLiveScreenUrl()}><Copy size={15} /> Copy OBS URL</button>
                <label htmlFor="selfie-obs-url">OBS Browser Source URL</label>
                <input id="selfie-obs-url" type="text" readOnly value={liveScreenUrl} onFocus={(event) => event.currentTarget.select()} />
                <p>In OBS, add a Browser Source, paste this entire URL, and set its size to 1920 × 1080. Opening the live screen only opens a browser tab; it does not add an OBS source. Keep this link private: it grants read-only access to approved photos until the session ends.</p>
                <span className="selfie-expiry">Session ends {new Date(session.expiresAt).toLocaleTimeString()}</span>
              </div>
              <div className="selfie-review-heading"><h3>Photo review</h3><span>{pendingSubmissions.length} waiting · {approvedSubmissions.length} approved</span></div>
              {submissions.length === 0 ? <p className="selfie-empty-submissions">Waiting for guests to submit photos…</p> : (
                <div className="selfie-submission-list">
                  {submissions.map((submission) => (
                    <article className="selfie-submission" key={submission.id}>
                      <img src={`/api/selfie/sessions/${encodeURIComponent(session.id)}/submissions/${encodeURIComponent(submission.id)}/image`} alt={submission.status === 'approved' ? 'Approved guest photo' : 'Photo awaiting review'} />
                      <div className="selfie-submission-copy"><strong>{submission.status === 'approved' ? 'Approved photo' : 'Needs review'}</strong><span>{new Date(submission.createdAt).toLocaleTimeString()}</span></div>
                      {submission.status === 'pending' ? (
                        <div className="selfie-submission-actions">
                          <button className="button button-primary" type="button" onClick={() => void updateSubmission(submission, 'approve')} aria-label="Approve photo"><Check size={16} /> Approve</button>
                          <button className="icon-button selfie-reject-button" type="button" onClick={() => void updateSubmission(submission, 'reject')} aria-label="Reject and delete photo"><Trash2 size={16} /></button>
                        </div>
                      ) : (
                        <div className="selfie-submission-actions">
                          <button className="button button-secondary" type="button" onClick={() => void showFullscreen(submission)}><Maximize size={15} /> Show full screen</button>
                          <button className="icon-button selfie-reject-button" type="button" onClick={() => { if (window.confirm('Remove this photo from the live screen? It will be deleted.')) void updateSubmission(submission, 'reject') }} aria-label="Delete approved photo"><Trash2 size={16} /></button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              )}
            </div>
          )}
          {error && <p className="selfie-error" role="alert">{error}</p>}
          {notice && <p className="selfie-notice" role="status">{notice}</p>}
        </section>
      </div>

      <section ref={displayRef} className={`selfie-fullscreen ${fallbackFullscreen ? 'is-fallback-fullscreen' : ''}`} aria-label="Approved guest photo">
        {session && displaySubmission && <img src={`/api/selfie/sessions/${encodeURIComponent(session.id)}/submissions/${encodeURIComponent(displaySubmission.id)}/image`} alt="Host-approved guest photo" />}
        <button className="selfie-exit-button" type="button" onClick={() => void exitFullscreen()} aria-label="Exit fullscreen"><Minimize size={20} /><span>Exit full screen</span></button>
      </section>
    </main>
  )
}

export function SelfieParticipant({ token }: { token: string }) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const previewUrlRef = useRef('')
  const [cameraActive, setCameraActive] = useState(false)
  const [photo, setPhoto] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [showAd, setShowAd] = useState(false)
  const [bannerOk, setBannerOk] = useState(true)
  const [uploadsPaused, setUploadsPaused] = useState(false)

  useEffect(() => {
    let active = true
    async function check() {
      try {
        const response = await fetch(`/api/selfie/join/${encodeURIComponent(token)}/status`, { cache: 'no-store' })
        if (!response.ok) return
        const result = await response.json() as { paused?: boolean }
        if (active) setUploadsPaused(Boolean(result.paused))
      } catch { /* Keep the last known state. */ }
    }
    void check()
    const timer = window.setInterval(() => void check(), 3000)
    return () => { active = false; window.clearInterval(timer) }
  }, [token])
  const [error, setError] = useState('')

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setCameraActive(false)
  }

  function selectPhoto(file: File) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Choose a JPEG, PNG, or WebP photo.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('The photo must be 5 MB or smaller.')
      return
    }
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    const url = URL.createObjectURL(file)
    previewUrlRef.current = url
    setPhoto(file)
    setPreviewUrl(url)
    setSubmitted(false)
    setError('')
  }

  useEffect(() => {
    if (!cameraActive || !videoRef.current || !streamRef.current) return
    videoRef.current.srcObject = streamRef.current
    void videoRef.current.play().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Could not start the camera preview.'))
  }, [cameraActive])

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
  }, [])

  async function startCamera() {
    setError('')
    if (!navigator.mediaDevices?.getUserMedia) {
      // Without HTTPS the live preview is blocked, but the capture input still opens the phone's camera app.
      fileInputRef.current?.click()
      return
    }
    try {
      stopCamera()
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user' } })
      setCameraActive(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not access the camera. Check browser permissions.')
    }
  }

  function takePhoto() {
    const video = videoRef.current
    if (!video || !video.videoWidth || !video.videoHeight) {
      setError('The camera is not ready yet. Try again in a moment.')
      return
    }
    const scale = Math.min(1, 1920 / Math.max(video.videoWidth, video.videoHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    const context = canvas.getContext('2d')
    if (!context) {
      setError('Could not capture a photo in this browser.')
      return
    }
    context.translate(canvas.width, 0)
    context.scale(-1, 1)
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    canvas.toBlob((blob) => {
      if (!blob) {
        setError('Could not create the photo. Try again.')
        return
      }
      selectPhoto(new File([blob], 'selfie.jpg', { type: 'image/jpeg' }))
      stopCamera()
    }, 'image/jpeg', 0.88)
  }

  async function submitPhoto() {
    if (!photo || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const data = new FormData()
      data.append('image', photo)
      const response = await fetch(`/api/selfie/join/${encodeURIComponent(token)}`, { method: 'POST', body: data })
      const result = await response.json() as { error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not send your photo to the host.')
      setSubmitted(true)
      setShowAd(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not send your photo to the host.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="selfie-shell">
      {showAd && <AdVideoOverlay kind="selfie" onDone={() => setShowAd(false)} />}
      <div className="selfie-content">
        {bannerOk ? (
          <section className="selfie-guest-banner"><img src={`/api/selfie/join/${encodeURIComponent(token)}/banner`} alt="" onError={() => setBannerOk(false)} /></section>
        ) : (
          <section className="selfie-heading"><span className="activity-eyebrow"><Camera size={15} /> SELFIE CAM</span><h1>Share your moment.</h1><p>Your photo goes to the host for review and will only appear on the big screen if approved.</p></section>
        )}
        <section className="selfie-panel">
          {uploadsPaused && <p className="selfie-paused-note">The host has paused uploads for now. Please wait a moment.</p>}
          <input ref={fileInputRef} className="selfie-file-input" type="file" accept="image/jpeg,image/png,image/webp" capture="user" onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file) selectPhoto(file)
          }} aria-label="Choose or capture a selfie" />
          {cameraActive ? (
            <div className="selfie-camera"><video ref={videoRef} autoPlay playsInline muted aria-label="Camera preview" /><div className="selfie-controls"><button className="button button-secondary" type="button" onClick={stopCamera}><X size={16} /> Cancel</button><button className="button button-primary" type="button" onClick={takePhoto}><Camera size={16} /> Take photo</button></div></div>
          ) : previewUrl ? (
            <>
              <div className="selfie-photo-preview"><img src={previewUrl} alt="Your photo preview" /></div>
              <div className="selfie-controls">
                <button className="button button-secondary" type="button" onClick={() => fileInputRef.current?.click()}><ImagePlus size={16} /> Choose another</button>
                <button className="button button-primary" type="button" onClick={() => void submitPhoto()} disabled={submitting || submitted || uploadsPaused}><Upload size={16} /> {submitted ? 'Sent for host approval' : uploadsPaused ? 'Uploads paused' : submitting ? 'Sending…' : 'Send to host'}</button>
              </div>
              <TermsNotice />
              {submitted && <p className="selfie-notice">Your photo was sent. The host will review it before displaying it.</p>}
              <button className="selfie-retake-link" type="button" onClick={() => void startCamera()}><Camera size={14} /> Take a new photo</button>
            </>
          ) : (
            <div className="selfie-empty"><span className="selfie-empty-icon"><Camera size={26} /></span><h2>Share your picture and get on the big screen.</h2><div className="selfie-controls"><button className="button button-primary" type="button" onClick={() => void startCamera()}><Camera size={16} /> Open camera</button><button className="button button-secondary" type="button" onClick={() => fileInputRef.current?.click()}><ImagePlus size={16} /> Choose a photo</button></div></div>
          )}
          {error && <p className="selfie-error" role="alert">{error}</p>}
        </section>
      </div>
    </main>
  )
}
