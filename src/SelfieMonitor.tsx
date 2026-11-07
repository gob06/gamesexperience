import { useEffect, useState } from 'react'
import { ArrowLeft, LogOut } from 'lucide-react'
import { ThemeBrand } from './theme'

type Photo = { id: string; status: 'pending' | 'approved'; createdAt: string }
type Session = { id: string; host: string; createdAt: string; expiresAt: string; paused: boolean; santaEnabled: boolean; photos: Photo[] }

export default function SelfieMonitor({ username, onLogout }: { username: string; onLogout: () => void }) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [imageError, setImageError] = useState('')

  useEffect(() => {
    let active = true
    let timer: number
    async function refresh() {
      try {
        const response = await fetch('/api/admin/selfie/sessions', { cache: 'no-store' })
        const result = await response.json() as { sessions?: Session[]; error?: string }
        if (!response.ok || !result.sessions) throw new Error(result.error || 'Could not load active selfie sessions.')
        if (active) {
          setSessions(result.sessions)
          setError('')
        }
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : 'Could not load active selfie sessions.')
      } finally {
        if (active) {
          setLoading(false)
          timer = window.setTimeout(() => void refresh(), 3000)
        }
      }
    }
    void refresh()
    return () => { active = false; window.clearTimeout(timer) }
  }, [])

  const selected = sessions.find((session) => session.id === selectedId) || sessions[0]

  return (
    <main className="activity-shell">
      <header className="topbar">
        <ThemeBrand />
        <div className="topbar-actions">
          <a className="button button-quiet" href="/"><ArrowLeft size={16} /> Dashboard</a>
          <span className="signed-in-user">{username}</span>
          <button className="icon-button signout-button" onClick={onLogout} aria-label="Sign out"><LogOut size={17} /></button>
        </div>
      </header>
      <section className="activity-dashboard">
        <header className="activity-heading">
          <span className="activity-eyebrow">READ-ONLY MONITOR</span>
          <h1>Selfie Cam sessions</h1>
          <p>View current sessions and guest photos. Only the session host can approve, delete, or manage submissions.</p>
        </header>
        {error && <p className="selfie-error" role="alert">{error}</p>}
        {loading ? <p role="status">Loading sessions...</p> : !sessions.length ? (
          <p>No active Selfie Cam sessions.</p>
        ) : (
          <div className="selfie-monitor-layout">
            <nav className="selfie-monitor-sessions" aria-label="Active selfie sessions">
              {sessions.map((session) => (
                <button className="button button-secondary" type="button" key={session.id} aria-pressed={selected?.id === session.id} onClick={() => { setSelectedId(session.id); setImageError('') }}>
                  <strong>{session.host} - {session.santaEnabled ? 'Santa selfie' : 'Selfie Cam'}</strong>
                  <span>Started {new Date(session.createdAt).toLocaleString()}</span>
                  <span>{session.photos.length} photos | {session.paused ? 'Paused' : 'Uploads open'}</span>
                </button>
              ))}
            </nav>
            {selected && <section aria-label="Session photos">
              <h2>{selected.host}'s session</h2>
              <p>Expires {new Date(selected.expiresAt).toLocaleString()} | {selected.photos.filter((photo) => photo.status === 'pending').length} pending | {selected.photos.filter((photo) => photo.status === 'approved').length} approved</p>
              {imageError && <p className="selfie-error" role="alert">{imageError}</p>}
              {!selected.photos.length ? <p>No photos uploaded yet.</p> : <div className="selfie-monitor-photos">
                {selected.photos.map((photo) => (
                  <figure key={photo.id}>
                    <img src={`/api/admin/selfie/sessions/${encodeURIComponent(selected.id)}/photos/${encodeURIComponent(photo.id)}/image`} alt={photo.status === 'approved' ? 'Approved guest photo' : 'Guest photo awaiting approval'} loading="lazy" onError={() => setImageError('A photo could not be loaded. The session or photo may have been removed.')} />
                    <figcaption>{photo.status === 'approved' ? 'Approved' : 'Pending approval'} - {new Date(photo.createdAt).toLocaleString()}</figcaption>
                  </figure>
                ))}
              </div>}
            </section>}
          </div>
        )}
      </section>
    </main>
  )
}
