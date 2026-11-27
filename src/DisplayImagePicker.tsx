import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { ImagePlus, X } from 'lucide-react'
import { SavedLogoPicker, logoToFile, saveLogo, type SavedLogo } from './logoLibrary'

export function DisplayImagePicker({ label, file, onChange, onError, required = false }: { label: string; file: File | null; onChange: (file: File | null) => void; onError: (message: string) => void; required?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const selectionRef = useRef(0)
  const [preview, setPreview] = useState('')

  useEffect(() => () => { selectionRef.current++ }, [])

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
    const selection = ++selectionRef.current
    onError('')
    onChange(selected)
    void saveLogo(selected).then((saved) => {
      if (!saved && selection === selectionRef.current) onError(`${label} was selected, but could not be saved to the image bank.`)
    })
  }

  async function selectSaved(logo: SavedLogo) {
    const selection = ++selectionRef.current
    try {
      const selected = await logoToFile(logo)
      if (selection !== selectionRef.current) return
      onError('')
      onChange(selected)
    } catch {
      if (selection === selectionRef.current) onError(`Could not load ${label.toLowerCase()} from the image bank.`)
    }
  }

  return (
    <>
      <input ref={inputRef} className="raffle-file-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={choose} aria-label={`Upload ${label.toLowerCase()}`} />
      <div className="raffle-logo-row">
        <span className="raffle-logo-preview">{preview ? <img src={preview} alt={`${label} preview`} /> : <ImagePlus size={19} />}</span>
        <span className="raffle-logo-name">{file?.name || `${label} · ${required ? 'required' : 'optional'}`}</span>
        <button className="button button-secondary raffle-upload-button" type="button" onClick={() => inputRef.current?.click()}>{file ? 'Change' : 'Upload'}</button>
        {file && <button className="icon-button" type="button" onClick={() => { selectionRef.current++; onChange(null) }} aria-label={`Remove ${label.toLowerCase()}`}><X size={15} /></button>}
      </div>
      <SavedLogoPicker label={`Image bank (${label.toLowerCase()})`} onSelect={(logo) => void selectSaved(logo)} />
    </>
  )
}
