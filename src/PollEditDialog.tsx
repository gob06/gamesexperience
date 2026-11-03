import { useState, type FormEvent } from 'react'
import { X } from 'lucide-react'

type EditablePoll = {
  id: string
  question: string
  joinTitle?: string | null
  options: Array<{ id: string; label: string }>
}

export default function PollEditDialog<T extends EditablePoll>({ poll, onClose, onSaved }: { poll: T; onClose: () => void; onSaved: (poll: T) => void }) {
  const [question, setQuestion] = useState(poll.question)
  const [joinTitle, setJoinTitle] = useState(poll.joinTitle ?? '')
  const [labels, setLabels] = useState(poll.options.map((option) => option.label))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function save(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/polls/${encodeURIComponent(poll.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: question.trim(),
          joinTitle: joinTitle.trim(),
          options: poll.options.map((option, index) => ({ id: option.id, label: labels[index] })),
        }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || 'Could not save your changes.')
      onSaved(result)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save your changes.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <form className="modal qa-edit-modal" role="dialog" aria-modal="true" aria-labelledby="poll-edit-title" onSubmit={(event) => void save(event)}>
        <button className="icon-button modal-close" type="button" onClick={onClose} aria-label="Close"><X size={19} /></button>
        <h2 id="poll-edit-title">Edit poll</h2>
        <label className="field-label" htmlFor="poll-edit-question">Question</label>
        <textarea id="poll-edit-question" value={question} onChange={(event) => setQuestion(event.target.value)} maxLength={160} rows={2} minLength={3} required />
        <label className="field-label" htmlFor="poll-edit-join-title">Join title (live results page)</label>
        <input id="poll-edit-join-title" value={joinTitle} onChange={(event) => setJoinTitle(event.target.value)} maxLength={80} placeholder="JOIN THE VOTE" />
        <span className="field-label">Answers · existing votes are kept</span>
        <div className="option-list">
          {poll.options.map((option, index) => (
            <div className="option-input-row" key={option.id}>
              <span className={`option-marker marker-${index % 4}`}>{String.fromCharCode(65 + index)}</span>
              <input aria-label={`Answer ${index + 1}`} value={labels[index]} maxLength={80} required onChange={(event) => setLabels((current) => current.map((label, labelIndex) => labelIndex === index ? event.target.value : label))} />
            </div>
          ))}
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
      </form>
    </div>
  )
}
