import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, Download, Search, ShieldCheck } from 'lucide-react'
import { ThemeBrand } from './theme'

type Row = {
  sessionId: string
  rank: number | null
  fullName: string
  ticketNumber: string
  question: string
  selectedAnswer: string | null
  result: 'WIN' | 'LOSE' | 'PENDING'
  submittedAt: string | null
  registeredAt: string | null
  adStatus: string
  verificationStatus: 'pending' | 'verified' | 'rejected'
}

type Monitor = {
  poll: { id: string; question: string; votingEnabled: boolean; revealCorrect: boolean; correctAnswer: string | null }
  stats: { participants: number; submissions: number; winners: number; nonWinners: number; participationPercentage: number; adCompletions: number }
  rows: Row[]
  generatedAt: string
}

type Filter = 'all' | 'winners' | 'losers'

function formatTime(value: string | null) {
  return value ? new Date(value).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' }) : '—'
}

export default function QaMonitor({ pollId, isAdmin }: { pollId: string; isAdmin: boolean }) {
  const [data, setData] = useState<Monitor | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [toast, setToast] = useState('')
  const seenWinners = useRef<Set<string> | null>(null)
  const toastTimer = useRef<number>()
  const url = `/api/polls/${encodeURIComponent(pollId)}`

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${url}/monitor`)
      if (!response.ok) throw new Error(response.status === 401 ? 'Sign in as a host to view this page.' : 'This Q&A could not be found.')
      const next: Monitor = await response.json()
      const winners = new Set(next.rows.filter((row) => row.result === 'WIN').map((row) => row.sessionId))
      if (seenWinners.current) {
        const fresh = next.rows.filter((row) => row.result === 'WIN' && !seenWinners.current?.has(row.sessionId))
        if (fresh.length) {
          setToast(`🏆 New winner: ${fresh[0].fullName} · Ticket ${fresh[0].ticketNumber}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''}`)
          window.clearTimeout(toastTimer.current)
          toastTimer.current = window.setTimeout(() => setToast(''), 6000)
        }
      }
      seenWinners.current = winners
      setData(next)
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load the monitor.')
    }
  }, [url])

  useEffect(() => {
    void load()
    const source = new EventSource(`${url}/monitor/stream`)
    source.addEventListener('update', () => void load())
    // Polling is a safety net in case the stream is blocked by a proxy.
    const timer = window.setInterval(() => void load(), 10000)
    return () => { source.close(); window.clearInterval(timer); window.clearTimeout(toastTimer.current) }
  }, [load, url])

  const rows = useMemo(() => {
    if (!data) return []
    const query = search.trim().toLowerCase()
    return data.rows
      .filter((row) => filter === 'all' || (filter === 'winners' ? row.result === 'WIN' : row.result === 'LOSE'))
      .filter((row) => !query || row.fullName.toLowerCase().includes(query) || row.ticketNumber.toLowerCase().includes(query))
  }, [data, search, filter])

  async function verify(row: Row, status: Row['verificationStatus']) {
    const response = await fetch(`${url}/submissions/${encodeURIComponent(row.sessionId)}/verification`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    if (response.ok) void load()
    else setError((await response.json().catch(() => ({}))).error || 'Could not update verification.')
  }

  if (!data) return <main className="display-loading">{error || 'Loading monitor…'}</main>

  const { stats } = data
  const cards: Array<[string, string | number]> = [
    ['Total participants', stats.participants],
    ['Total submissions', stats.submissions],
    ['Total winners', stats.winners],
    ['Total non-winners', stats.nonWinners],
    ['Participation', `${stats.participationPercentage}%`],
    ['Ads completed', stats.adCompletions],
  ]
  const exportQuery = new URLSearchParams({ filter, q: search.trim() }).toString()

  return (
    <main className="monitor-shell">
      {toast && <div className="monitor-toast" role="status">{toast}</div>}
      <header className="monitor-top">
        <ThemeBrand />
        <div className="display-live"><span className="live-indicator" /> LIVE WINNER MONITOR</div>
        <a className="display-exit" href="/voting?mode=qa">Dashboard <ArrowUpRight size={15} /></a>
      </header>
      <section className="monitor-heading">
        <h1>{data.poll.question || 'Image question'}</h1>
        {data.poll.correctAnswer && <p>Correct answer: <strong>{data.poll.correctAnswer}</strong></p>}
      </section>
      <section className="monitor-cards" aria-label="Summary">
        {cards.map(([label, value]) => <article className="monitor-card" key={label}><strong>{value}</strong><span>{label}</span></article>)}
      </section>
      <section className="monitor-tools">
        <label className="monitor-search"><Search size={16} /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or ticket number" aria-label="Search by name or ticket number" /></label>
        <div className="question-type-toggle" role="radiogroup" aria-label="Filter results">
          {(['all', 'winners', 'losers'] as const).map((value) => (
            <button key={value} type="button" role="radio" aria-checked={filter === value} className={filter === value ? 'is-active' : ''} onClick={() => setFilter(value)}>{value === 'all' ? 'All' : value === 'winners' ? 'Winners' : 'Non-winners'}</button>
          ))}
        </div>
        <a className="button button-secondary" href={`${url}/monitor.csv?${exportQuery}`}><Download size={16} /> Export CSV</a>
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="monitor-table-wrap">
        <table className="monitor-table">
          <thead>
            <tr><th>Rank</th><th>Participant</th><th>Ticket</th><th>Question</th><th>Answer</th><th>Result</th><th>Submitted</th><th>Ad</th><th>Verification</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={9} className="monitor-empty">No participants match yet.</td></tr>}
            {rows.map((row) => (
              <tr key={row.sessionId} className={row.result === 'WIN' ? 'is-win' : ''}>
                <td>{row.rank ?? '—'}</td>
                <td>{row.fullName}</td>
                <td>{row.ticketNumber}</td>
                <td className="monitor-question">{row.question}</td>
                <td>{row.selectedAnswer ?? '—'}</td>
                <td><span className={`monitor-pill pill-${row.result.toLowerCase()}`}>{row.result}</span></td>
                <td>{formatTime(row.submittedAt)}</td>
                <td>{row.adStatus}</td>
                <td>
                  {row.result !== 'WIN' ? '—' : isAdmin ? (
                    <span className="monitor-verify">
                      <span className={`monitor-pill pill-${row.verificationStatus}`}>{row.verificationStatus}</span>
                      {row.verificationStatus !== 'verified' && <button className="button button-quiet" type="button" onClick={() => void verify(row, 'verified')}><ShieldCheck size={14} /> Verify</button>}
                      {row.verificationStatus !== 'rejected' && <button className="button button-quiet" type="button" onClick={() => void verify(row, 'rejected')}>Reject</button>}
                    </span>
                  ) : <span className={`monitor-pill pill-${row.verificationStatus}`}>{row.verificationStatus}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  )
}
