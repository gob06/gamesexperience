import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Smartphone } from 'lucide-react'
import { getSelfieJoinUrl } from './SelfieCam'

type Submission = { id: string; status: 'pending' | 'approved'; createdAt: string; approvedAt?: string | null }

export default function SelfieDisplay({ sessionId, joinToken }: { sessionId: string; joinToken: string }) {
  const qrRef = useRef<HTMLCanvasElement>(null)
  const [joinUrl, setJoinUrl] = useState('')
  const [photos, setPhotos] = useState<Submission[]>([])
  const [index, setIndex] = useState(0)
  const [closed, setClosed] = useState(false)
  const [paused, setPaused] = useState(false)
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
        setPaused(Boolean((result as { paused?: boolean }).paused))
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
  const currentId = current?.id ?? null
  const [layers, setLayers] = useState<string[]>([])

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
    const fallback = window.setTimeout(show, 3000)
    const trim = window.setTimeout(() => { if (active) setLayers((value) => value.slice(-1)) }, 4600)
    return () => { active = false; window.clearTimeout(trim); window.clearTimeout(fallback) }
  }, [currentId, sessionId])

  useEffect(() => {
    if (slides.length < 2 || paused) return
    const timer = window.setInterval(() => setIndex((value) => value + 1), 5000)
    return () => window.clearInterval(timer)
  }, [slides.length, paused])

  return (
    <main className="selfie-display">
      <section className="selfie-display-wall" aria-label="Live guest photos">
        {!layers.length ? (
          <p className="selfie-display-empty">{closed ? 'This selfie session has ended.' : error || 'Photos will appear here as guests send them.'}</p>
        ) : (
          layers.map((id) => (
            <div className="selfie-slide" key={id}>
              <img className="selfie-slide-photo" src={imageUrl(id)} alt="Guest photo" />
            </div>
          ))
        )}
      </section>
      <aside className="selfie-display-qr">
        <div className="selfie-qr-frame"><canvas ref={qrRef} aria-label="Scan to share your selfie" /></div>
        <p><Smartphone aria-hidden="true" />SCAN TO SHARE YOUR SELFIE!</p>
      </aside>
    </main>
  )
}
