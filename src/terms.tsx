import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { LogOut, X } from 'lucide-react'
import { ThemeBrand } from './theme'

type TermsDocument = { content: string; version: number; updatedAt: string | null }

async function fetchTerms(): Promise<TermsDocument> {
  const response = await fetch('/api/terms', { cache: 'no-store' })
  if (!response.ok) throw new Error('Could not load the Terms of Service.')
  return await response.json() as TermsDocument
}

// Supports "#" headings, "- " bullets, **bold**, and blank lines between paragraphs.
function renderInline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, index) => (
    part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : part
  ))
}

export function TermsContent({ content }: { content: string }) {
  const blocks: ReactNode[] = []
  let paragraph: string[] = []
  let bullets: string[] = []
  const flush = () => {
    if (paragraph.length) blocks.push(<p key={blocks.length}>{renderInline(paragraph.join(' '))}</p>)
    if (bullets.length) blocks.push(<ul key={blocks.length}>{bullets.map((item, index) => <li key={index}>{renderInline(item)}</li>)}</ul>)
    paragraph = []
    bullets = []
  }
  for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim()
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (!line) flush()
    else if (heading) {
      flush()
      blocks.push(heading[1].length === 1 ? <h2 key={blocks.length}>{heading[2]}</h2> : <h3 key={blocks.length}>{heading[2]}</h3>)
    } else if (line.startsWith('- ')) {
      if (paragraph.length) flush()
      bullets.push(line.slice(2))
    } else {
      if (bullets.length) flush()
      paragraph.push(line)
    }
  }
  flush()
  return <>{blocks}</>
}

function TermsModal({ onClose }: { onClose: () => void }) {
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [terms, setTerms] = useState<TermsDocument | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    fetchTerms().then((result) => { if (active) setTerms(result) }).catch((caught) => {
      if (active) setError(caught instanceof Error ? caught.message : 'Could not load the Terms of Service.')
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    return () => {
      document.body.style.overflow = overflow
      previous?.focus?.()
    }
  }, [])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])')
    if (!focusable?.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  return createPortal(
    <div className="terms-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }} onKeyDown={handleKeyDown}>
      <div className="terms-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef}>
        <header className="terms-modal-header">
          <h2 id={titleId}>Terms of Service</h2>
          <button className="terms-modal-x" type="button" onClick={onClose} aria-label="Close Terms of Service"><X size={18} /></button>
        </header>
        <div className="terms-modal-body" tabIndex={0}>
          {error ? <p className="form-error" role="alert">{error}</p> : terms ? <TermsContent content={terms.content} /> : <p>Loading…</p>}
        </div>
        <footer className="terms-modal-footer">
          {terms && <span>Version {terms.version}{terms.updatedAt ? ` · updated ${new Date(terms.updatedAt).toLocaleDateString()}` : ''}</span>}
          <button className="button button-primary" type="button" ref={closeRef} onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

// Place directly under an audience Submit button. The link is a plain button, so it never submits the surrounding form.
export function TermsNotice({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return (
    <>
      <p className={`terms-notice ${className}`.trim()}>
        By clicking to submit content, you agree to our{' '}
        <button className="terms-link" type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen(true) }}>Terms of Service</button>.
      </p>
      {open && <TermsModal onClose={close} />}
    </>
  )
}

export function TermsSettings({ username, onLogout }: { username: string; onLogout: () => void }) {
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState<TermsDocument | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    fetchTerms().then((result) => { setSaved(result); setContent(result.content) }).catch((caught) => setError(caught instanceof Error ? caught.message : 'Could not load the Terms of Service.'))
  }, [])

  async function publish() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch('/api/admin/terms', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) })
      const result = await response.json() as TermsDocument & { error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not publish the Terms of Service.')
      setSaved(result)
      setContent(result.content)
      setNotice(`Published as version ${result.version}. Audiences see it immediately.`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not publish the Terms of Service.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="admin-shell">
      <header className="admin-topbar"><ThemeBrand /><div className="admin-top-actions"><span>{username} · ADMIN</span><button className="icon-button signout-button" onClick={onLogout} aria-label="Sign out" title="Sign out"><LogOut size={17} /></button></div></header>
      <div className="admin-content">
        <a className="admin-back" href="/">← Dashboard</a>
        <div className="admin-heading"><span className="auth-eyebrow">AUDIENCE AGREEMENT</span><h1>Terms of Service</h1><p>One document is shown to every audience through the “Terms of Service” link under each Submit button. Use # for headings, - for bullets and **bold** for emphasis.</p></div>
        {error && <p className="form-error" role="alert">{error}</p>}
        {notice && <p className="terms-admin-notice" role="status">{notice}</p>}
        <label className="auth-field-label" htmlFor="terms-text">Terms of Service text{saved ? ` · current version ${saved.version}` : ''}</label>
        <textarea id="terms-text" className="terms-editor" value={content} onChange={(event) => setContent(event.target.value)} rows={24} maxLength={60000} />
        <div className="terms-editor-actions">
          <button className="button button-primary" type="button" onClick={() => void publish()} disabled={busy || !content.trim() || content === saved?.content}>{busy ? 'Publishing…' : 'Publish new version'}</button>
        </div>
      </div>
    </main>
  )
}
