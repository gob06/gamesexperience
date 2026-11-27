import { useId } from 'react'
import { DisplayImagePicker } from './DisplayImagePicker'

export function DisplayEventTitleChoice({ useImage, onModeChange, file, onChange, onError }: {
  useImage: boolean
  onModeChange: (useImage: boolean) => void
  file: File | null
  onChange: (file: File | null) => void
  onError: (message: string) => void
}) {
  const name = useId()
  return (
    <>
      <fieldset className="display-title-choice">
        <legend>Open display event name</legend>
        <label><input type="radio" name={name} checked={!useImage} onChange={() => { onModeChange(false); onError('') }} /> Text</label>
        <label><input type="radio" name={name} checked={useImage} onChange={() => { onModeChange(true); onError('') }} /> Image</label>
      </fieldset>
      <p className="raffle-help">The activity name is still used on host and guest pages. The QR logo is separate.</p>
      {useImage && <DisplayImagePicker label="Display event name image" file={file} onChange={onChange} onError={onError} required />}
    </>
  )
}

export function DisplayEventTitle({ title, imageUrl, className }: { title: string; imageUrl?: string | null; className?: string }) {
  return <h1 className={className}>{imageUrl ? <img className="display-event-title-image" src={imageUrl} alt={title} /> : title}</h1>
}
