import { useEffect, useState } from 'react'

const storageKey = 'qr-logo-library'
const maxLogos = 12
const maxSide = 400

export type SavedLogo = { id: string; name: string; dataUrl: string }

export function loadSavedLogos(): SavedLogo[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || '[]')
    return Array.isArray(parsed) ? parsed.filter((logo) => logo && typeof logo.dataUrl === 'string') : []
  } catch {
    return []
  }
}

function persist(logos: SavedLogo[]) {
  while (logos.length) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(logos))
      return
    } catch {
      logos = logos.slice(0, -1)
    }
  }
}

function toDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
      canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/png'))
    }
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read the image.')) }
    image.src = url
  })
}

export async function saveLogo(file: File) {
  try {
    const dataUrl = await toDataUrl(file)
    const logos = [{ id: crypto.randomUUID(), name: file.name, dataUrl }, ...loadSavedLogos().filter((logo) => logo.dataUrl !== dataUrl)].slice(0, maxLogos)
    persist(logos)
    window.dispatchEvent(new Event('qr-logo-library'))
  } catch { /* Saving is best-effort. */ }
}

export function removeSavedLogo(id: string) {
  persist(loadSavedLogos().filter((logo) => logo.id !== id))
  window.dispatchEvent(new Event('qr-logo-library'))
}

export async function logoToFile(logo: SavedLogo) {
  const blob = await (await fetch(logo.dataUrl)).blob()
  const base = logo.name.replace(/\.[^.]+$/, '') || 'logo'
  return new File([blob], `${base}.png`, { type: 'image/png' })
}

export function SavedLogoPicker({ onSelect }: { onSelect: (logo: SavedLogo) => void }) {
  const [logos, setLogos] = useState<SavedLogo[]>(loadSavedLogos)

  useEffect(() => {
    const sync = () => setLogos(loadSavedLogos())
    window.addEventListener('qr-logo-library', sync)
    return () => window.removeEventListener('qr-logo-library', sync)
  }, [])

  if (!logos.length) return null
  return (
    <div className="saved-logos" role="group" aria-label="Previously uploaded logos">
      <span className="saved-logos-label">Previously uploaded</span>
      <div className="saved-logos-list">
        {logos.map((logo) => (
          <span className="saved-logo" key={logo.id}>
            <button type="button" onClick={() => onSelect(logo)} title={`Use ${logo.name}`} aria-label={`Use ${logo.name}`}><img src={logo.dataUrl} alt="" /></button>
            <button type="button" className="saved-logo-remove" onClick={() => removeSavedLogo(logo.id)} aria-label={`Forget ${logo.name}`} title="Forget">×</button>
          </span>
        ))}
      </div>
    </div>
  )
}
