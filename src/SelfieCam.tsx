import { lazy, Suspense, useEffect, useRef, useState, type ChangeEvent } from 'react'
import QRCode from 'qrcode'
import { ArrowLeft, Camera, Check, Copy, ImagePlus, Maximize, Minimize, Pause, Play, QrCode, Trash2, Upload, X } from 'lucide-react'
import { getDisplayPresentation, ThemeBrand, useTheme } from './theme'
import { AdVideoOverlay } from './AdVideo'
import { TermsNotice } from './terms'
import { SavedLogoPicker, logoToFile, saveLogo, type SavedLogo } from './logoLibrary'
import { readSelfieJson } from './selfieResponse'

function SantaLoadError({ onError }: { onError: () => void }) {
  const errorCallback = useRef(onError)
  errorCallback.current = onError
  useEffect(() => { errorCallback.current() }, [])
  return <></>
}

const SantaOverlay = lazy(() => import('./SantaOverlay').catch((error: unknown) => {
  console.error('Could not load the 3D Santa renderer:', error)
  return { default: SantaLoadError }
}))

type SelfieSession = { id: string; joinToken: string; displayToken: string; createdAt: string; closedAt: string | null; paused: boolean; rotationSeconds: number; qrLogoUrl?: string | null }
type RecentSession = { id: string; host: string; createdAt: string; closedAt: string | null; paused: boolean; photoCount: number; approvedCount: number; santaEnabled: boolean }
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
  const [recentSessions, setRecentSessions] = useState<RecentSession[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [sessionsError, setSessionsError] = useState('')
  const selectedSessionId = useRef<string | null>(null)
  const [joinUrl, setJoinUrl] = useState('')
  const [qrLogoUrl, setQrLogoUrl] = useState('')
  const [submissions, setSubmissions] = useState<SelfieSubmission[]>([])
  const [submissionsError, setSubmissionsError] = useState('')
  const submissionRequest = useRef(0)
  const [displaySubmission, setDisplaySubmission] = useState<SelfieSubmission | null>(null)
  const [fallbackFullscreen, setFallbackFullscreen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [paused, setPaused] = useState(false)
  const [rotationInput, setRotationInput] = useState('5')
  const [selectedPhotos, setSelectedPhotos] = useState<string[]>([])
  const [savingRotation, setSavingRotation] = useState(false)
  const [deletingPhotos, setDeletingPhotos] = useState(false)

  useEffect(() => {
    let active = true
    let timer: number
    async function refresh() {
      try {
        const response = await fetch('/api/selfie/sessions', { cache: 'no-store' })
        const result = await readSelfieJson<{ sessions?: RecentSession[]; error?: string }>(response, 'Could not load recent selfie sessions')
        if (!response.ok || !result.sessions) throw new Error(result.error || 'Could not load recent selfie sessions.')
        if (active) { setRecentSessions(result.sessions); setSessionsError('') }
      } catch (caught) {
        if (active) setSessionsError(caught instanceof Error ? caught.message : 'Could not load recent selfie sessions.')
      } finally {
        if (active) { setSessionsLoading(false); timer = window.setTimeout(() => void refresh(), 3000) }
      }
    }
    void refresh()
    return () => { active = false; window.clearTimeout(timer) }
  }, [])

  async function selectSession(id: string) {
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(`/api/selfie/sessions/${encodeURIComponent(id)}/links`, { method: 'POST' })
      const result = await readSelfieJson<SelfieSession & { error?: string }>(response, 'Could not open this selfie session')
      if (!response.ok || !result.id || !result.joinToken || !result.displayToken) throw new Error(result.error || 'Could not open this selfie session.')
      const url = await getSelfieJoinUrl(result.joinToken)
      selectedSessionId.current = result.id
      setSession(result)
      setRotationInput(String(result.rotationSeconds))
      setSelectedPhotos([])
      setJoinUrl(url)
      setPaused(result.paused)
      setSubmissions([])
      setSubmissionsError('')
      setDisplaySubmission(null)
      setQrLogoUrl(result.qrLogoUrl || '')
      if (!result.qrLogoUrl) {
        const legacyLogo = localStorage.getItem(`selfie-qr-logo:${result.id}`)
        if (legacyLogo) {
          await persistQrLogo(result, legacyLogo)
          localStorage.removeItem(`selfie-qr-logo:${result.id}`)
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not open this selfie session.')
    } finally {
      setLoading(false)
    }
  }

  async function persistQrLogo(target: SelfieSession, source: string) {
    const imageResponse = await fetch(source)
    if (!imageResponse.ok) throw new Error('Could not load the selected selfie QR logo.')
    const form = new FormData()
    form.append('image', await imageResponse.blob(), 'qr-logo.png')
    const response = await fetch(`/api/selfie/sessions/${encodeURIComponent(target.id)}/qr-logo`, { method: 'POST', body: form })
    if (!response.ok) {
      const result = await readSelfieJson<{ error?: string }>(response, 'Could not save the selfie QR logo')
      throw new Error(result.error || 'Could not save the selfie QR logo. Update and restart the API, then reopen the session.')
    }
    const result = await readSelfieJson<{ version: string }>(response, 'Could not read the saved selfie QR logo')
    if (typeof result.version !== 'string' || !result.version) throw new Error('The API did not return the saved QR logo version. Update and restart the API.')
    const url = `/api/selfie/join/${encodeURIComponent(target.joinToken)}/qr-logo?v=${encodeURIComponent(result.version)}`
    setSession((current) => current?.id === target.id ? { ...current, qrLogoUrl: url } : current)
    setQrLogoUrl(url)
  }

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
    void saveLogo(file).then((saved) => { if (!saved) setError('QR logo selected, but could not be saved to the image bank.') })
    if (session) void updateQrLogo(session, url)
  }

  function useSavedLogo(logo: SavedLogo) {
    if (logoUrlRef.current.startsWith('blob:')) URL.revokeObjectURL(logoUrlRef.current)
    logoUrlRef.current = logo.dataUrl
    setQrLogoUrl(logo.dataUrl)
    setError('')
    if (session) void updateQrLogo(session, logo.dataUrl)
  }

  async function updateQrLogo(target: SelfieSession, source: string) {
    setLoading(true)
    try {
      await persistQrLogo(target, source)
      setNotice('QR logo saved for the live screen and OBS.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the selfie QR logo.')
    } finally {
      setLoading(false)
    }
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

  async function createSession(santaEnabled = false) {
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const form = new FormData()
      form.append('santaEnabled', String(santaEnabled))
      if (qrLogoUrl) {
        const logoResponse = await fetch(qrLogoUrl)
        if (!logoResponse.ok) throw new Error('Could not load the selected QR logo. Select it again before creating the session.')
        form.append('qrLogo', await logoResponse.blob(), 'qr-logo.png')
      }
      if (bannerFile) form.append('banner', bannerFile)
      const response = await fetch('/api/selfie/sessions', { method: 'POST', body: form })
      const result = await readSelfieJson<SelfieSession & { error?: string }>(response, 'Could not create a selfie session')
      if (!response.ok || !result.id || !result.joinToken || !result.displayToken) throw new Error(result.error || 'Could not create a selfie session. Update and restart the server, then try again.')
      if (qrLogoUrl && !result.qrLogoUrl) throw new Error('The API did not save the selected QR logo. Update and restart the API before creating another session.')
      const url = await getSelfieJoinUrl(result.joinToken)
      selectedSessionId.current = result.id
      setSession(result)
      setQrLogoUrl(result.qrLogoUrl || '')
      setRotationInput(String(result.rotationSeconds))
      setSelectedPhotos([])
      setPaused(false)
      setJoinUrl(url)
      setSubmissions([])
      setSubmissionsError('')
      setDisplaySubmission(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create a selfie session.')
    } finally {
      setLoading(false)
    }
  }

  async function refreshSubmissions(sessionId: string) {
    const requestId = ++submissionRequest.current
    try {
      const response = await fetch(`/api/selfie/sessions/${encodeURIComponent(sessionId)}/submissions`)
      const result = await readSelfieJson<{ submissions?: SelfieSubmission[]; closed?: boolean; closedAt?: string | null; paused?: boolean; rotationSeconds?: number; error?: string }>(response, 'Could not load selfie submissions')
      if (selectedSessionId.current !== sessionId || requestId !== submissionRequest.current) return
      if (!response.ok || !result.submissions) throw new Error(result.error || 'Could not load selfie submissions.')
      setSubmissionsError('')
      setSubmissions(result.submissions)
      const approvedIds = new Set(result.submissions.filter((submission) => submission.status === 'approved').map((submission) => submission.id))
      setSelectedPhotos((current) => current.filter((id) => approvedIds.has(id)))
      setPaused(Boolean(result.paused))
      setSession((current) => current?.id === sessionId ? { ...current, closedAt: result.closedAt || null, rotationSeconds: result.rotationSeconds ?? current.rotationSeconds } : current)
    } catch (caught) {
      if (selectedSessionId.current === sessionId && requestId === submissionRequest.current) setSubmissionsError(caught instanceof Error ? caught.message : 'Could not refresh selfie submissions.')
    }
  }

  useEffect(() => {
    if (!session) return
    let active = true
    let timer: number
    const sessionId = session.id
    async function refresh() {
      await refreshSubmissions(sessionId)
      if (active) timer = window.setTimeout(() => void refresh(), 2000)
    }
    void refresh()
    return () => { active = false; window.clearTimeout(timer) }
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
      logo.onerror = () => { if (active) setError('Could not load the selfie QR logo.') }
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
      const result = response.status === 204 ? null : await readSelfieJson<{ error?: string }>(response, `Could not ${action} this photo`)
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

  async function saveRotation() {
    if (!session || savingRotation) return
    const seconds = Number(rotationInput)
    if (!Number.isInteger(seconds) || seconds < 2 || seconds > 300) {
      setError('Rotation duration must be a whole number between 2 and 300 seconds.')
      return
    }
    const id = session.id
    setSavingRotation(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(`/api/selfie/sessions/${encodeURIComponent(id)}/rotation`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seconds }),
      })
      const result = await readSelfieJson<{ rotationSeconds?: number; error?: string }>(response, 'Could not save rotation duration')
      if (!response.ok || typeof result.rotationSeconds !== 'number') throw new Error(result.error || 'Could not save rotation duration.')
      if (selectedSessionId.current === id) {
        const rotationSeconds = result.rotationSeconds
        setSession((current) => current?.id === id ? { ...current, rotationSeconds } : current)
        setNotice('Rotation duration saved for the live screen and OBS.')
      }
    } catch (caught) {
      if (selectedSessionId.current === id) setError(caught instanceof Error ? caught.message : 'Could not save rotation duration.')
    } finally {
      setSavingRotation(false)
    }
  }

  async function deleteSelectedPhotos() {
    if (!session || deletingPhotos || !selectedPhotos.length || !window.confirm(`Permanently delete ${selectedPhotos.length} selected approved photo(s)? This cannot be undone.`)) return
    const id = session.id
    const ids = selectedPhotos
    setDeletingPhotos(true)
    setError('')
    setNotice('')
    let deleted = 0
    let processed = 0
    try {
      for (let offset = 0; offset < ids.length; offset += 250) {
        const batch = ids.slice(offset, offset + 250)
        const response = await fetch(`/api/selfie/sessions/${encodeURIComponent(id)}/submissions/delete-approved`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: batch }),
        })
        const result = await readSelfieJson<{ deleted?: number; error?: string }>(response, 'Could not delete selected photos')
        if (!response.ok || typeof result.deleted !== 'number') throw new Error(result.error || 'Could not delete selected photos.')
        deleted += result.deleted
        processed += batch.length
      }
      if (selectedSessionId.current === id) {
        setSelectedPhotos([])
        setDisplaySubmission((current) => current && ids.includes(current.id) ? null : current)
        setNotice(`Deleted ${deleted} approved photo(s). Photos already removed were skipped.`)
        await refreshSubmissions(id)
      }
    } catch (caught) {
      if (selectedSessionId.current === id) {
        setSelectedPhotos((current) => current.filter((photoId) => !ids.slice(0, processed).includes(photoId)))
        setDisplaySubmission((current) => current && ids.slice(0, processed).includes(current.id) ? null : current)
        await refreshSubmissions(id)
        const message = caught instanceof Error ? caught.message : 'Could not delete selected photos.'
        setError(`${message} ${deleted} photo(s) were deleted before the error. Refresh and retry the remaining selection.`)
      }
    } finally {
      setDeletingPhotos(false)
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
      const result = response.status === 204 ? null : await readSelfieJson<{ error?: string }>(response, 'Could not end the selfie session')
      if (!response.ok) throw new Error(result?.error || 'Could not end the selfie session.')
      await refreshSubmissions(session.id)
      setNotice('Selfie session ended. Photos remain playable; the live screen uses the newest ongoing session from the same host for its QR.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not end the selfie session.')
    }
  }

  async function deleteSession() {
    if (!session?.closedAt || loading || !window.confirm('Permanently delete this ended session and all its photos? Its OBS links will stop working. This cannot be undone.')) return
    const id = session.id
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(`/api/selfie/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
      const result = response.status === 204 ? null : await readSelfieJson<{ error?: string }>(response, 'Could not delete the selfie session')
      if (!response.ok) throw new Error(result?.error || 'Could not delete the selfie session.')
      selectedSessionId.current = null
      setSession(null)
      setRecentSessions((current) => current.filter((recent) => recent.id !== id))
      setSubmissions([])
      setDisplaySubmission(null)
      setJoinUrl('')
      setPaused(false)
      setNotice('Selfie session and all its photos permanently deleted.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete the selfie session.')
    } finally {
      setLoading(false)
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

        <section className="selfie-panel selfie-history" aria-label="Recent selfie sessions">
          <div className="selfie-session-heading">
            <div><h2>Recent sessions</h2><p>Open a session to review its photos or reuse its OBS display.</p></div>
            <button className="button button-secondary" type="button" disabled={loading} onClick={() => {
              selectedSessionId.current = null
              setSession(null); setSubmissions([]); setSelectedPhotos([]); setDisplaySubmission(null); setJoinUrl(''); setError(''); setNotice('')
            }}>New session</button>
          </div>
          {sessionsError && <p className="selfie-error" role="alert">{sessionsError}</p>}
          {sessionsLoading ? <p role="status">Loading sessions...</p> : !recentSessions.length ? <p>No sessions yet.</p> : (
            <nav className="selfie-monitor-sessions selfie-history-list" aria-label="Choose a selfie session">
              {recentSessions.map((recent) => (
                <button className="button button-secondary" type="button" key={recent.id} disabled={loading} aria-pressed={session?.id === recent.id} onClick={() => void selectSession(recent.id)}>
                  <strong>{recent.host} - {recent.santaEnabled ? 'Santa selfie' : 'Selfie Cam'}</strong>
                  <span>{new Date(recent.createdAt).toLocaleString()} | {recent.closedAt ? 'Ended' : recent.paused ? 'Paused' : 'Uploads open'}</span>
                  <span>{recent.photoCount} photos | {recent.approvedCount} approved</span>
                </button>
              ))}
            </nav>
          )}
        </section>

        <section className="selfie-panel">
          {!session ? (
            <div className="selfie-empty">
              <span className="selfie-empty-icon"><QrCode size={26} /></span>
              <h2>Start a selfie session</h2>
              <p>Guests scan your QR code to submit photos. Submissions are private until you approve them. Uploads stay open until the host or an admin ends the session.</p>
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
              <div className="selfie-session-heading"><div><span className="selfie-session-label">{session.closedAt ? 'SAVED SESSION' : 'GUEST UPLOAD QR'}</span><h2>{session.closedAt ? 'Session ended - photos saved' : 'Scan to submit a selfie'}</h2></div><div className="selfie-session-buttons"><button className="button button-secondary" type="button" disabled={loading} onClick={() => void togglePause()}>{paused ? <Play size={15} /> : <Pause size={15} />} {paused ? 'Resume display' : session.closedAt ? 'Pause display' : 'Pause session'}</button>{session.closedAt ? <button className="button button-quiet selfie-end-button" type="button" disabled={loading} onClick={() => void deleteSession()}><Trash2 size={15} /> {loading ? 'Deleting...' : 'Delete session'}</button> : <button className="button button-quiet selfie-end-button" type="button" onClick={() => void endSession()}><X size={15} /> End session</button>}</div></div>
              {paused && <p className="selfie-paused-note">{session.closedAt ? 'Display paused on its current photo.' : "Session paused — guests can't upload and the live screen is holding its current photo."}</p>}
              <div className="selfie-session-share">
                <input ref={logoInputRef} className="selfie-file-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseQrLogo} aria-label="Upload a logo for the selfie QR code" disabled={loading} />
                <button className="button button-secondary" type="button" disabled={loading} onClick={() => logoInputRef.current?.click()}><Upload size={15} /> {qrLogoUrl ? 'Change QR logo' : 'Upload QR logo'}</button>
                {!loading && <SavedLogoPicker onSelect={useSavedLogo} label="Image bank (QR logo)" />}
                {!session.closedAt && <>
                <div className="selfie-qr-frame"><canvas ref={qrCanvasRef} aria-label="Scan this QR code to submit a selfie" /></div>
                <p>Scan with a phone camera. Photos must be approved before they appear on screen.</p>
                <a href={joinUrl} target="_blank" rel="noreferrer">Open guest upload page</a>
                </>}
                <a className="button button-primary" href={liveScreenUrl} target="_blank" rel="noreferrer"><Maximize size={15} /> Open live screen {session.closedAt ? '(saved photos)' : '(QR + photos)'}</a>
                <button className="button button-secondary" type="button" onClick={() => void copyLiveScreenUrl()}><Copy size={15} /> Copy OBS URL</button>
                <form className="selfie-rotation" onSubmit={(event) => { event.preventDefault(); void saveRotation() }}>
                  <label htmlFor="selfie-rotation">Photo rotation (seconds)</label>
                  <input id="selfie-rotation" type="number" min="2" max="300" step="1" required value={rotationInput} onChange={(event) => setRotationInput(event.currentTarget.value)} />
                  <button className="button button-secondary" type="submit" disabled={savingRotation}>{savingRotation ? 'Saving...' : 'Save duration'}</button>
                  <span>Current: {session.rotationSeconds} seconds (2–300)</span>
                </form>
                <label htmlFor="selfie-obs-url">OBS Browser Source URL</label>
                <input id="selfie-obs-url" type="text" readOnly value={liveScreenUrl} onFocus={(event) => event.currentTarget.select()} />
                <p>In OBS, add a Browser Source, paste this entire URL, and set its size to 1920 × 1080. Opening the live screen only opens a browser tab; it does not add an OBS source. Keep this link private: it grants read-only access to approved photos, including after uploads end. Previously copied OBS URLs continue to work. Ended-session displays show the newest ongoing session from the same host as their upload QR, while continuing to play the ended session's photos.</p>
                <span className="selfie-expiry">{session.closedAt ? `Uploads ended ${new Date(session.closedAt).toLocaleString()}` : 'No time limit - uploads stay open until you end the session.'}</span>
              </div>
              <div className="selfie-review-heading"><h3>Photo review</h3><span>{pendingSubmissions.length} waiting · {approvedSubmissions.length} approved</span></div>
              {submissionsError && <p className="selfie-error" role="alert">{submissionsError}</p>}
              {approvedSubmissions.length > 0 && <div className="selfie-batch-actions">
                <label><input type="checkbox" disabled={deletingPhotos} checked={approvedSubmissions.every((photo) => selectedPhotos.includes(photo.id))} onChange={(event) => setSelectedPhotos(event.currentTarget.checked ? approvedSubmissions.map((photo) => photo.id) : [])} /> Select all approved</label>
                <button className="button button-secondary" type="button" disabled={deletingPhotos || !selectedPhotos.length} onClick={() => void deleteSelectedPhotos()}><Trash2 size={15} /> {deletingPhotos ? 'Deleting...' : `Delete selected (${selectedPhotos.length})`}</button>
              </div>}
              {submissions.length === 0 ? !submissionsError && <p className="selfie-empty-submissions">Waiting for guests to submit photos…</p> : (
                <div className="selfie-submission-list">
                  {submissions.map((submission) => (
                    <article className="selfie-submission" key={submission.id}>
                      {submission.status === 'approved' && <input type="checkbox" aria-label={`Select approved photo from ${new Date(submission.createdAt).toLocaleString()}`} disabled={deletingPhotos} checked={selectedPhotos.includes(submission.id)} onChange={(event) => {
                        const checked = event.currentTarget.checked
                        setSelectedPhotos((current) => checked ? [...current, submission.id] : current.filter((id) => id !== submission.id))
                      }} />}
                      <img className="audience-submitted-image" src={`/api/selfie/sessions/${encodeURIComponent(session.id)}/submissions/${encodeURIComponent(submission.id)}/image`} alt={submission.status === 'approved' ? 'Approved guest photo' : 'Photo awaiting review'} loading="lazy" decoding="async" onError={() => setError('A review photo could not be loaded. It may have been removed or the server may be unavailable.')} />
                      <div className="selfie-submission-copy"><strong>{submission.status === 'approved' ? 'Approved photo' : 'Needs review'}</strong><span>{new Date(submission.createdAt).toLocaleTimeString()}</span></div>
                      {submission.status === 'pending' ? (
                        <div className="selfie-submission-actions">
                          <button className="button button-secondary" type="button" onClick={() => void showFullscreen(submission)}><Maximize size={15} /> Preview full screen</button>
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

      <section ref={displayRef} className={`selfie-fullscreen ${fallbackFullscreen ? 'is-fallback-fullscreen' : ''}`} aria-label="Guest photo preview">
        {session && displaySubmission && <img className="audience-submitted-image" src={`/api/selfie/sessions/${encodeURIComponent(session.id)}/submissions/${encodeURIComponent(displaySubmission.id)}/image`} alt={displaySubmission.status === 'approved' ? 'Host-approved guest photo' : 'Guest photo awaiting approval'} />}
        <button className="selfie-exit-button" type="button" onClick={() => void exitFullscreen()} aria-label="Exit fullscreen"><Minimize size={20} /><span>Exit full screen</span></button>
      </section>
    </main>
  )
}

export function SelfieParticipant({ token }: { token: string }) {
  const { theme, assetUrls } = useTheme()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const santaRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const previewUrlRef = useRef('')
  const [cameraActive, setCameraActive] = useState(false)
  const [withSanta, setWithSanta] = useState(false)
  const [santaEnabled, setSantaEnabled] = useState(false)
  const santaModeRef = useRef<boolean | null>(null)
  const [santaReady, setSantaReady] = useState(false)
  const [videoSize, setVideoSize] = useState({ width: 4, height: 3 })
  const [photo, setPhoto] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [showAd, setShowAd] = useState(false)
  const [bannerOk, setBannerOk] = useState(true)
  const [uploadsPaused, setUploadsPaused] = useState(false)
  const [uploadsClosed, setUploadsClosed] = useState(false)

  useEffect(() => {
    let active = true
    santaModeRef.current = null
    setSantaEnabled(false)
    setWithSanta(false)
    setUploadsClosed(false)
    async function check() {
      try {
        const response = await fetch(`/api/selfie/join/${encodeURIComponent(token)}/status`, { cache: 'no-store' })
        if (response.status === 404) {
          if (active) setUploadsClosed(true)
          return
        }
        if (!response.ok) return
        const result = await response.json() as { paused?: boolean; santaEnabled?: boolean }
        if (active) {
          setUploadsPaused(Boolean(result.paused))
          const enabled = result.santaEnabled === true
          setSantaEnabled(enabled)
          if (santaModeRef.current !== enabled) {
            santaModeRef.current = enabled
            setWithSanta(enabled)
          }
        }
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
    setSantaReady(false)
  }

  useEffect(() => {
    if (uploadsClosed) stopCamera()
  }, [uploadsClosed])

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
      setError('Live camera effects require HTTPS and camera access. You can still choose a photo without Santa.')
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
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    if (withSanta) {
      const santa = santaRef.current
      if (!santaReady || !santa) {
        setError('Santa is still loading. Please try again or turn off the Santa effect.')
        return
      }
      const height = Math.min(canvas.height * 0.85, canvas.width * 0.48 * 2)
      const width = height / 2
      context.drawImage(santa, canvas.width * 0.97 - width, canvas.height - height, width, height)
    }
    canvas.toBlob((blob) => {
      if (!blob) {
        setError('Could not create the photo. Try again.')
        return
      }
      selectPhoto(new File([blob], 'selfie.jpg', { type: 'image/jpeg' }))
      stopCamera()
    }, 'image/jpeg', 0.88)
  }

  const santaHeight = Math.min(0.85, 0.96 * videoSize.width / videoSize.height)
  const santaWidth = santaHeight * videoSize.height / videoSize.width / 2

  async function submitPhoto() {
    if (!photo || submitting || uploadsClosed) return
    setSubmitting(true)
    setError('')
    try {
      const data = new FormData()
      data.append('image', photo)
      const response = await fetch(`/api/selfie/join/${encodeURIComponent(token)}`, { method: 'POST', body: data })
      const result = await readSelfieJson<{ error?: string }>(response, 'Could not send your photo to the host')
      if (!response.ok) throw new Error(result.error || 'Could not send your photo to the host.')
      setSubmitted(true)
      setShowAd(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not send your photo to the host.')
    } finally {
      setSubmitting(false)
    }
  }

  const display = getDisplayPresentation(theme, assetUrls, 'selfie-submission')

  return (
    <main className={`selfie-shell selfie-submission-shell ${display.className}`} style={display.style}>
      {showAd && <AdVideoOverlay kind="selfie" activityId={token} onDone={() => setShowAd(false)} />}
      <div className="selfie-content">
        {bannerOk ? (
          <section className="selfie-guest-banner"><img src={`/api/selfie/join/${encodeURIComponent(token)}/banner`} alt="" onError={() => setBannerOk(false)} /></section>
        ) : (
          <section className="selfie-heading"><span className="activity-eyebrow"><Camera size={15} /> SELFIE CAM</span><h1>Share your moment.</h1><p>Your photo goes to the host for review and will only appear on the big screen if approved.</p></section>
        )}
        <section className="selfie-panel">
          {uploadsClosed ? <p className="selfie-paused-note" role="status">This selfie session has ended. New photos can no longer be submitted.</p> : <>
          {uploadsPaused && <p className="selfie-paused-note">The host has paused uploads for now. Please wait a moment.</p>}
          <input ref={fileInputRef} className="selfie-file-input" type="file" accept="image/jpeg,image/png,image/webp" capture="user" onChange={(event) => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file) selectPhoto(file)
          }} aria-label="Choose or capture a selfie" />
          {cameraActive ? (
            <div className="selfie-camera">
              <div className="selfie-camera-frame" style={{ aspectRatio: `${videoSize.width} / ${videoSize.height}`, width: `min(100%, 520px, ${65 * videoSize.width / videoSize.height}vh)` }}>
                <video ref={videoRef} autoPlay playsInline muted aria-label="Camera preview" onLoadedMetadata={(event) => {
                  const video = event.currentTarget
                  if (video.videoWidth && video.videoHeight) setVideoSize({ width: video.videoWidth, height: video.videoHeight })
                }} />
                {withSanta && <Suspense fallback={null}><SantaOverlay canvasRef={santaRef} width={santaWidth} height={santaHeight} onReady={() => setSantaReady(true)} onError={() => { setSantaReady(false); setError('Could not load 3D Santa. Turn off the Santa effect to take a regular selfie.') }} /></Suspense>}
              </div>
              {santaEnabled && <label className="selfie-santa-choice"><input type="checkbox" checked={withSanta} onChange={(event) => { setWithSanta(event.target.checked); setSantaReady(false); setError('') }} /> Take a selfie with 3D Santa</label>}
              {withSanta && !santaReady && !error && <p className="selfie-santa-loading" role="status">Loading 3D Santa…</p>}
              <div className="selfie-controls"><button className="button button-secondary" type="button" onClick={stopCamera}><X size={16} /> Cancel</button><button className="button button-primary" type="button" onClick={takePhoto} disabled={withSanta && !santaReady}><Camera size={16} /> Take photo</button></div>
            </div>
          ) : previewUrl ? (
            <>
              <div className="selfie-photo-preview"><img className="audience-submitted-image" src={previewUrl} alt="Your photo preview" /></div>
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
          </>}
          {error && <p className="selfie-error" role="alert">{error}</p>}
        </section>
      </div>
    </main>
  )
}
