import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { getSelfieJoinUrl } from './SelfieCam'

type Submission = { id: string; status: 'pending' | 'approved'; createdAt: string; approvedAt?: string | null }

export default function SelfieDisplay({ sessionId, joinToken }: { sessionId: string; joinToken: string }) {
  const qrRef = useRef<HTMLCanvasElement>(null)
  const [joinUrl, setJoinUrl] = useState('')
  const [photos, setPhotos] = useState<Submission[]>([])
  const [index, setIndex] = useState(0)
  const [closed, setClosed] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    if (!joinToken) return
    getSelfieJoinUrl(joinToken).then((url) => { if (active) setJoinUrl(url) }).catch((caught: unknown) => {
      if (active) setError(caught instanceof Error ? caught.message : 'Could not prepare the QR code.')
    })
    return () => { active = false }
  }, [joinToken])

  useEffect(() => {
    const canvas = qrRef.current
    if (!canvas || !joinUrl) return
    let active = true
    const logoUrl = localStorage.getItem(`selfie-qr-logo:${sessionId}`)
    void QRCode.toCanvas(canvas, joinUrl, { width: 720, margin: 2, errorCorrectionLevel: 'H', color: { dark: '#15151a', light: '#ffffff' } }).then(() => {
      if (!active || !logoUrl) return
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
        context.fillStyle = '#ffffff'
        context.fillRect((canvas.width - boxSize) / 2, (canvas.height - boxSize) / 2, boxSize, boxSize)
        context.drawImage(logo, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height)
      }
      logo.src = logoUrl
    })
    return () => { active = false }
  }, [joinUrl, sessionId])

  useEffect(() => {
    let active = true
    async function refresh() {
      try {
        const response = await fetch(`/api/selfie/sessions/${encodeURIComponent(sessionId)}/submissions`, { cache: 'no-store' })
        const result = await response.json() as { submissions?: Submission[]; closed?: boolean; error?: string }
        if (!active) return
        if (!response.ok || !result.submissions) throw new Error(result.error || 'Could not load photos.')
        setPhotos(result.submissions.filter((submission) => submission.status === 'approved'))
        setClosed(Boolean(result.closed))
        setError('')
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : 'Could not load photos.')
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [sessionId])

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

  const imageUrl = (id: string) => `/api/selfie/sessions/${encodeURIComponent(sessionId)}/submissions/${encodeURIComponent(id)}/image`
  const slides = [...photos].sort((a, b) => (a.approvedAt || a.createdAt).localeCompare(b.approvedAt || b.createdAt))
  const current = slides.length ? slides[index % slides.length] : null

  useEffect(() => {
    if (slides.length < 2) return
    const timer = window.setInterval(() => setIndex((value) => value + 1), 5000)
    return () => window.clearInterval(timer)
  }, [slides.length])

  return (
    <main className="selfie-display">
      <section className="selfie-display-wall" aria-label="Live guest photos">
        {!current ? (
          <p className="selfie-display-empty">{closed ? 'This selfie session has ended.' : error || 'Photos will appear here as guests send them.'}</p>
        ) : (
          <div className="selfie-slide" key={current.id}>
            <img className="selfie-slide-backdrop" src={imageUrl(current.id)} alt="" />
            <img className="selfie-slide-photo" src={imageUrl(current.id)} alt="Guest photo" />
          </div>
        )}
      </section>
      <aside className="selfie-display-qr">
        <canvas ref={qrRef} aria-label="Scan to share your selfie" />
        <p>SCAN TO SHARE YOUR SELFIE!</p>
      </aside>
    </main>
  )
}
