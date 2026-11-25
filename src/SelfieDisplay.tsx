import { useEffect, useReducer, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Smartphone } from 'lucide-react'
import { getSelfieJoinUrl } from './SelfieCam'
import { initialCarouselState, selfieCarousel } from './selfieCarousel'
import { readSelfieJson } from './selfieResponse'

type Submission = { id: string; status: 'pending' | 'approved'; createdAt: string; approvedAt?: string | null }
type QrSession = { id: string; joinToken: string; paused: boolean }

export default function SelfieDisplay({ sessionId, joinToken, displayToken = '' }: { sessionId: string; joinToken: string; displayToken?: string }) {
  const qrRef = useRef<HTMLCanvasElement>(null)
  const [preparedQr, setPreparedQr] = useState({ token: '', url: '' })
  const [carousel, dispatch] = useReducer(selfieCarousel, initialCarouselState)
  const [closed, setClosed] = useState(false)
  const [rotationSeconds, setRotationSeconds] = useState(5)
  const [ongoingQr, setOngoingQr] = useState<QrSession | null>(null)
  const [error, setError] = useState('')
  const [qrError, setQrError] = useState('')
  const qrToken = ongoingQr?.joinToken || (!closed ? joinToken : '')
  const qrSessionId = ongoingQr?.id || (!closed ? sessionId : '')
  const joinUrl = preparedQr.token === qrToken ? preparedQr.url : ''

  useEffect(() => {
    let active = true
    setQrError('')
    if (!qrToken) return
    getSelfieJoinUrl(qrToken).then((url) => { if (active) setPreparedQr({ token: qrToken, url }) }).catch((caught: unknown) => {
      if (active) setQrError(caught instanceof Error ? caught.message : 'Could not prepare the QR code.')
    })
    return () => { active = false }
  }, [qrToken])

  useEffect(() => {
    const canvas = qrRef.current
    if (!canvas || !joinUrl) return
    let active = true
    const logoUrl = localStorage.getItem(`selfie-qr-logo:${qrSessionId}`)
    void QRCode.toCanvas(canvas, joinUrl, { width: 480, margin: 2, errorCorrectionLevel: 'H', color: { dark: '#15151a', light: '#ffffff' } }).then(() => {
      if (!active || !logoUrl) return
      const logo = new Image()
      logo.onload = () => {
        if (!active) return
        const context = canvas.getContext('2d')
        if (!context) return
        const boxSize = 200
        const padding = Math.round(canvas.width * 0.025)
        const innerSize = boxSize - padding * 2
        const scale = Math.min(innerSize / logo.naturalWidth, innerSize / logo.naturalHeight)
        const width = logo.naturalWidth * scale
        const height = logo.naturalHeight * scale
        context.fillStyle = '#ffffff'
        context.fillRect((canvas.width - boxSize) / 2, (canvas.height - boxSize) / 2, boxSize, boxSize)
        context.drawImage(logo, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
      }
      logo.src = logoUrl
    }).catch((caught: unknown) => {
      if (active) setQrError(caught instanceof Error ? caught.message : 'Could not generate the QR code.')
    })
    return () => { active = false }
  }, [joinUrl, qrSessionId])

  useEffect(() => {
    let active = true
    let timer: number
    dispatch({ type: 'reset' })
    async function refresh() {
      try {
        const base = displayToken ? '/api/selfie/display' : '/api/selfie/sessions'
        const response = await fetch(`${base}/${encodeURIComponent(sessionId)}/submissions`, {
          cache: 'no-store',
          headers: displayToken ? { 'X-Selfie-Display-Token': displayToken } : undefined,
        })
        const result = await readSelfieJson<{ submissions?: Submission[]; closed?: boolean; paused?: boolean; rotationSeconds?: number; qrSession?: QrSession | null; error?: string }>(response, 'Could not load photos')
        if (!active) return
        if (response.status === 404 || response.status === 410) {
          dispatch({ type: 'reset' })
          setClosed(true)
          setOngoingQr(null)
          setError(result.error || 'This selfie session has ended.')
          return
        }
        if (!response.ok || !result.submissions) throw new Error(result.error || 'Could not load photos.')
        dispatch({ type: 'refresh', photos: result.submissions.filter((submission) => submission.status === 'approved'), paused: Boolean(result.paused) })
        if (typeof result.rotationSeconds === 'number') setRotationSeconds(result.rotationSeconds)
        setClosed(Boolean(result.closed))
        setOngoingQr(result.qrSession || null)
        setError('')
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : 'Could not load photos.')
      } finally {
        if (active) timer = window.setTimeout(() => void refresh(), 2000)
      }
    }
    void refresh()
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [sessionId, displayToken])

  useEffect(() => {
    function enterFullscreen() {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => undefined)
    }
    // Browsers only allow fullscreen after a user gesture, so retry on the first interaction.
    enterFullscreen()
    window.addEventListener('pointerdown', enterFullscreen, { once: true })
    window.addEventListener('keydown', enterFullscreen, { once: true })
    function exitFullscreen() {
      if (document.fullscreenElement) void document.exitFullscreen()
    }
    window.addEventListener('dblclick', exitFullscreen)
    return () => {
      window.removeEventListener('pointerdown', enterFullscreen)
      window.removeEventListener('keydown', enterFullscreen)
      window.removeEventListener('dblclick', exitFullscreen)
    }
  }, [])

  const imageUrl = (id: string) => displayToken
    ? `/api/selfie/display/${encodeURIComponent(sessionId)}/submissions/${encodeURIComponent(id)}/image?token=${encodeURIComponent(displayToken)}`
    : `/api/selfie/sessions/${encodeURIComponent(sessionId)}/submissions/${encodeURIComponent(id)}/image`
  const currentId = carousel.currentId
  const [layers, setLayers] = useState<string[]>([])

  useEffect(() => {
    const ids = new Set(carousel.photos.map((photo) => photo.id))
    setLayers((value) => value.filter((id) => ids.has(id)))
  }, [carousel.photos])

  // Preload the next photo, then fade it in over the previous one so the wall never goes blank.
  useEffect(() => {
    if (!currentId) { setLayers([]); return }
    let active = true
    const preload = new Image()
    const show = () => {
      if (!active) return
      setLayers((value) => (value[value.length - 1] === currentId ? value : [...value.slice(-1), currentId]))
    }
    preload.onload = show
    preload.onerror = show
    preload.src = imageUrl(currentId)
    // Never stay blank if the image is slow to load.
    const fallback = window.setTimeout(show, 1000)
    const trim = window.setTimeout(() => { if (active) setLayers((value) => value.slice(-1)) }, 4600)
    return () => { active = false; window.clearTimeout(trim); window.clearTimeout(fallback) }
  }, [currentId, sessionId, displayToken])

  useEffect(() => {
    if (carousel.paused || (carousel.photos.length < 2 && !carousel.pendingIds.length)) return
    const timer = window.setTimeout(() => dispatch({ type: 'advance' }), rotationSeconds * 1000)
    return () => window.clearTimeout(timer)
  }, [currentId, carousel.photos.length, carousel.pendingIds.length, carousel.paused, rotationSeconds])

  return (
    <main className={`selfie-display${!qrToken ? ' selfie-display-archive' : ''}`}>
      <section className="selfie-display-wall" aria-label="Live guest photos">
        {!layers.length ? (
          <p className="selfie-display-empty">{error || (closed ? 'This selfie session has ended.' : 'Photos will appear here as guests send them.')}</p>
        ) : (
          layers.map((id) => (
            <div className="selfie-slide" key={id}>
              <img className="selfie-slide-photo audience-submitted-image" src={imageUrl(id)} alt="Guest photo" />
            </div>
          ))
        )}
      </section>
      {qrToken && <aside className="selfie-display-qr">
        <div className="selfie-qr-frame">{joinUrl ? <canvas key={qrToken} ref={qrRef} aria-label="Scan to share your selfie" /> : <span role="status">{qrError || 'Preparing QR...'}</span>}</div>
        <p><Smartphone aria-hidden="true" />SCAN TO SHARE YOUR SELFIE</p>
        {ongoingQr?.paused && <span>Current session uploads are paused</span>}
        {qrError && <span role="alert">{qrError}</span>}
      </aside>}
    </main>
  )
}
