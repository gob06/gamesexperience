import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { ImagePlus, X } from 'lucide-react'

export function DisplayImagePicker({ label, file, onChange, onError }: { label: string; file: File | null; onChange: (file: File | null) => void; onError: (message: string) => void }) {
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
