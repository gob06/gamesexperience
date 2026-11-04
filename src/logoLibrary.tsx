import { useEffect, useState } from 'react'

const legacyStorageKey = 'qr-logo-library'
const maxSide = 400

export type SavedLogo = { id: string; name: string; dataUrl: string }

const imageUrl = (id: string) => `/api/logo-bank/${encodeURIComponent(id)}/image`

async function fetchLogos(): Promise<SavedLogo[]> {
  try {
    const response = await fetch('/api/logo-bank', { credentials: 'same-origin' })
    if (!response.ok) return []
    const { logos } = await response.json() as { logos: { id: string; name: string }[] }
    return logos.map((logo) => ({ id: logo.id, name: logo.name, dataUrl: imageUrl(logo.id) }))
  } catch {
    return []
  }
}

function toPngBlob(file: Blob): Promise<Blob> {
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
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not read the image.'))), 'image/png')
    }
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read the image.')) }
    image.src = url
  })
}

async function uploadLogo(file: Blob, name: string) {
  const png = await toPngBlob(file)
  const form = new FormData()
  form.append('name', name)
  form.append('image', png, `${name.replace(/\.[^.]+$/, '') || 'logo'}.png`)
  await fetch('/api/logo-bank', { method: 'POST', body: form, credentials: 'same-origin' })
}

export async function saveLogo(file: File) {
  try {
    await uploadLogo(file, file.name)
    window.dispatchEvent(new Event('qr-logo-library'))
  } catch { /* Saving is best-effort. */ }
}

export async function removeSavedLogo(id: string) {
  try {
    await fetch(`/api/logo-bank/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' })
  } catch { /* Ignored. */ }
  window.dispatchEvent(new Event('qr-logo-library'))
}

export async function logoToFile(logo: SavedLogo) {
  const blob = await (await fetch(logo.dataUrl, { credentials: 'same-origin' })).blob()
  const base = logo.name.replace(/\.[^.]+$/, '') || 'logo'
  return new File([blob], `${base}.png`, { type: 'image/png' })
}

// Logos saved in this browser by earlier versions are moved into the shared server bank once.
async function migrateLegacyLogos() {
  let legacy: { name?: string; dataUrl?: string }[] = []
  try {
    const parsed = JSON.parse(localStorage.getItem(legacyStorageKey) || '[]')
    if (Array.isArray(parsed)) legacy = parsed
  } catch { /* Nothing to migrate. */ }
  if (!legacy.length) return false
  let failed = false
  for (const logo of legacy) {
    if (typeof logo?.dataUrl !== 'string') continue
    try {
      await uploadLogo(await (await fetch(logo.dataUrl)).blob(), logo.name || 'logo')
    } catch { failed = true }
  }
  if (!failed) localStorage.removeItem(legacyStorageKey)
  return true
}

export function SavedLogoPicker({ onSelect }: { onSelect: (logo: SavedLogo) => void }) {
  const [logos, setLogos] = useState<SavedLogo[]>([])

  useEffect(() => {
    let active = true
    const sync = () => { void fetchLogos().then((next) => { if (active) setLogos(next) }) }
    void migrateLegacyLogos().then((moved) => { if (moved) sync() })
    sync()
    window.addEventListener('qr-logo-library', sync)
    return () => { active = false; window.removeEventListener('qr-logo-library', sync) }
  }, [])

  if (!logos.length) return null
  return (
    <div className="saved-logos" role="group" aria-label="Image bank">
      <span className="saved-logos-label">Image bank</span>
      <div className="saved-logos-list">
        {logos.map((logo) => (
          <span className="saved-logo" key={logo.id}>
            <button type="button" onClick={() => onSelect(logo)} title={`Use ${logo.name}`} aria-label={`Use ${logo.name}`}><img src={logo.dataUrl} alt="" /></button>
            <button type="button" className="saved-logo-remove" onClick={() => void removeSavedLogo(logo.id)} aria-label={`Delete ${logo.name} from the image bank`} title="Delete from image bank">×</button>
          </span>
        ))}
      </div>
    </div>
  )
}
