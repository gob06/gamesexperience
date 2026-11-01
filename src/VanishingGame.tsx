import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { Gamepad2 } from 'lucide-react'
import { AdVideoOverlay } from './AdVideo'
import { useTheme } from './theme'

type Player = 'X' | 'O'
type GameState = {
  id: string
  roomName: string
  status: 'waiting' | 'playing' | 'finished'
  board: Array<Player | null>
  nextPlayer: Player
  winner: Player | null
  rematchDeadline: string | null
  rematchVotes: Record<Player, number | null>
  playerXName: string
  playerOName: string | null
  xImageUrl: string | null
  oImageUrl: string | null
  youAre: Player | null
  isSpectator: boolean
  revision: number
}

function tokenKey(roomId: string) {
  return `vanishing-game-token:${roomId}`
}

export default function VanishingGame({ roomId }: { roomId?: string }) {
  const activeRoomId = roomId || ''
  const isSpectatorMode = new URLSearchParams(window.location.search).get('spectate') === '1'
  const { theme: gameTheme, assetUrls: gameThemeAssetUrls } = useTheme()
  const gameThemeError = ''
  const [token, setToken] = useState(() => roomId && !isSpectatorMode ? sessionStorage.getItem(tokenKey(roomId)) || '' : '')
  const [game, setGame] = useState<GameState | null>(null)
  const [playerName, setPlayerName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingCell, setPendingCell] = useState<number | null>(null)
  const [rematchBusy, setRematchBusy] = useState(false)
  const [rematchRemaining, setRematchRemaining] = useState(0)
  const [showAd, setShowAd] = useState(false)

  // Play once when the rematch countdown ends without both players agreeing; reconnecting after it ended does not replay it.
  const countdownWatched = useRef<string | null>(null)
  useEffect(() => {
    const deadline = game?.status === 'finished' ? game.rematchDeadline : null
    if (!deadline || game?.isSpectator) return
    if (rematchRemaining > 0) {
      countdownWatched.current = deadline
    } else if (countdownWatched.current === deadline) {
      countdownWatched.current = null
      setShowAd(true)
    }
  }, [game?.status, game?.rematchDeadline, game?.isSpectator, rematchRemaining])

  useEffect(() => {
    if (!activeRoomId || (!token && !isSpectatorMode)) return
    let active = true
    async function refresh() {
      try {
        const response = await fetch(`/api/games/${encodeURIComponent(activeRoomId)}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
        const result = await response.json() as GameState & { error?: string }
        if (!response.ok) throw new Error(result.error || 'Could not refresh the game.')
        if (active) {
          setGame((current) => !current || result.revision >= current.revision ? result : current)
          setError('')
        }
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : 'Could not refresh the game.')
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1200)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [activeRoomId, token, isSpectatorMode])

  useEffect(() => {
    const deadline = game?.rematchDeadline
    if (!deadline) {
      setRematchRemaining(0)
      return
    }
    const updateRemaining = () => setRematchRemaining(Math.max(0, Math.ceil((Date.parse(deadline) - Date.now()) / 1000)))
    updateRemaining()
    const timer = window.setInterval(updateRemaining, 250)
    return () => window.clearInterval(timer)
  }, [game?.rematchDeadline])

  async function joinGame(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activeRoomId) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/games/${encodeURIComponent(activeRoomId)}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: playerName.trim() }),
      })
      const result = await response.json() as { error?: string; token?: string; game?: GameState }
      if (!response.ok || !result.token || !result.game) throw new Error(result.error || 'Could not join this game.')
      sessionStorage.setItem(tokenKey(activeRoomId), result.token)
      setToken(result.token)
      setGame(result.game)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not join this game.')
    } finally {
      setBusy(false)
    }
  }

  async function playCell(cell: number) {
    if (!game || !token || pendingCell !== null) return
    setPendingCell(cell)
    setError('')
    try {
      const response = await fetch(`/api/games/${encodeURIComponent(game.id)}/moves`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ cell }),
      })
      const result = await response.json() as GameState & { error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not make that move.')
      setGame((current) => !current || result.revision >= current.revision ? result : current)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not make that move.')
    } finally {
      setPendingCell(null)
    }
  }

  async function respondToRematch(playAgain: boolean) {
    if (!game || !token || rematchBusy) return
    setRematchBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/games/${encodeURIComponent(game.id)}/rematch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ playAgain }),
      })
      const result = await response.json() as GameState & { error?: string }
      if (!response.ok) throw new Error(result.error || 'Could not submit your rematch choice.')
      setGame((current) => !current || result.revision >= current.revision ? result : current)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not submit your rematch choice.')
    } finally {
      setRematchBusy(false)
    }
  }

  const isJoinPage = Boolean(activeRoomId && !token && !isSpectatorMode)
  const myTurn = Boolean(game && game.status === 'playing' && game.nextPlayer === game.youAre)
  const statusText = !game ? '' : game.status === 'waiting'
    ? 'Waiting for Player O to join'
    : game.winner
      ? `${game.winner === game.youAre ? 'You win!' : `${game.winner === 'X' ? game.playerXName : game.playerOName} wins!`}`
    : myTurn ? 'Your turn' : `${game.nextPlayer === 'X' ? game.playerXName : game.playerOName}'s turn`
  const myRematchVote = game?.youAre ? game.rematchVotes[game.youAre] : null
  const opponentRematchVote = game?.youAre ? game.rematchVotes[game.youAre === 'X' ? 'O' : 'X'] : null
  const gameBackgroundUrl = gameThemeAssetUrls.background || gameThemeAssetUrls.adminBackground || gameThemeAssetUrls.resultsBackground || gameThemeAssetUrls.votingBackground
  const gameShellStyle = {
    '--theme-primary': gameTheme.colors.primary,
    '--theme-secondary': gameTheme.colors.secondary,
    '--theme-accent': gameTheme.colors.accent,
    '--theme-background': gameTheme.colors.background,
    '--theme-text': gameTheme.colors.text,
    '--theme-radius': `${gameTheme.background.borderRadius}px`,
    '--theme-glow': gameTheme.background.glow,
    backgroundColor: gameTheme.colors.background,
    backgroundImage: gameBackgroundUrl
      ? `linear-gradient(rgba(0,0,0,${gameTheme.background.overlay}),rgba(0,0,0,${gameTheme.background.overlay})),linear-gradient(rgba(0,0,0,${1 - gameTheme.background.opacity}),rgba(0,0,0,${1 - gameTheme.background.opacity})),url("${gameBackgroundUrl.replaceAll('"', '')}")`
      : 'radial-gradient(ellipse at 18% 0%, #272832 0%, transparent 42%)',
    backgroundSize: gameTheme.background.size === 'repeat' ? 'auto' : gameTheme.background.size,
    backgroundRepeat: gameTheme.background.size === 'repeat' ? 'repeat' : 'no-repeat',
    backgroundPosition: gameTheme.background.position,
  } as CSSProperties

  return (
    <main className="game-shell" style={gameShellStyle}>
      {showAd && <AdVideoOverlay kind="game" onDone={() => setShowAd(false)} />}
      <header className="game-topbar">
        <a className="brand" href="/" aria-label={`${gameTheme.eventTitle} home`}>
          {gameThemeAssetUrls.logo && <img className="theme-brand-logo" src={gameThemeAssetUrls.logo} alt="" />}
          <span>{gameTheme.eventTitle}</span>
        </a>
      </header>
      <div className="game-content">
        <section className="game-intro">
          <span className="game-eyebrow"><Gamepad2 size={15} /> QUICK MATCH · 2 PLAYERS</span>
          <h1>Vanishing<br /><span>Tic-Tac-Toe</span></h1>
          {gameThemeAssetUrls.banner && <img className="game-theme-banner" src={gameThemeAssetUrls.banner} alt="" />}
          <p>One board, two phones, and a little memory. Scan the room QR to join.</p>
        </section>
        {gameThemeError && <p className="game-error" role="status">{gameThemeError}</p>}

        {!activeRoomId && (
          <section className="game-lobby">
            <div className="game-card-heading"><span className="game-card-icon"><Gamepad2 size={18} /></span><div><h2>Join an event game</h2><p>An admin creates the room and displays a QR code for both players.</p></div></div>
            <p className="game-rule-note">Scan the room QR code with your phone camera to claim the next player slot. Each player keeps up to 3 marks; on a non-winning fourth move, their oldest mark disappears. Winning marks stay on the board.</p>
            <a className="button button-primary game-action" href="/">Back to VOTE dashboard</a>
          </section>
        )}

        {isJoinPage && (
          <form className="game-lobby" onSubmit={joinGame}>
            <div className="game-card-heading"><span className="game-card-icon"><Gamepad2 size={18} /></span><div><h2>Join the game</h2><p>Enter your name to take the O pieces.</p></div></div>
            <label htmlFor="guest-name">Your player name</label>
            <input id="guest-name" value={playerName} onChange={(event) => setPlayerName(event.target.value)} maxLength={24} placeholder="Player O" required />
            {error && <p className="game-error" role="alert">{error}</p>}
            <button className="button button-primary game-action" type="submit" disabled={busy}>{busy ? 'Joining…' : 'Join game'}</button>
            <p className="game-rule-note">Each player keeps up to 3 marks. On a non-winning fourth move, your oldest mark disappears; a winning line stays on the board.</p>
          </form>
        )}

        {activeRoomId && token && !game && (
          <section className="game-lobby" aria-live="polite">
            <div className="game-card-heading"><span className="game-card-icon"><Gamepad2 size={18} /></span><div><h2>{error ? 'Game unavailable' : 'Reconnecting to game'}</h2><p>{error || 'Loading the shared board…'}</p></div></div>
            {error && <a className="button button-primary game-action" href="/game">Create a new game</a>}
          </section>
        )}

        {activeRoomId && isSpectatorMode && !game && (
          <section className="game-lobby" aria-live="polite">
            <div className="game-card-heading"><span className="game-card-icon"><Gamepad2 size={18} /></span><div><h2>{error ? 'Spectator access unavailable' : 'Opening spectator view'}</h2><p>{error || 'Connecting to the live game…'}</p></div></div>
            {error && <a className="button button-primary game-action" href="/">Back to dashboard</a>}
          </section>
        )}

        {game && (
          <section className={`game-room ${game.isSpectator ? 'is-spectator' : ''}`}>
            {game.isSpectator && <div className="game-spectator-banner"><Gamepad2 size={15} /> ADMIN SPECTATOR VIEW</div>}
            <div className="game-room-head">
              <span className={`game-status-dot ${game.status === 'playing' ? 'is-live' : ''}`} />
              <div><span className="game-room-label">{game.roomName}</span><span className="game-room-label">{game.status === 'waiting' ? 'ROOM READY' : game.status === 'finished' ? 'MATCH COMPLETE' : 'LIVE MATCH'}</span><h2>{statusText}</h2></div>
            </div>
            <div className="game-player-strip">
              <div className={`game-player-chip ${game.status === 'playing' && game.nextPlayer === 'X' ? 'is-turn' : ''}`}><span className="game-mark mark-x">{game.xImageUrl ? <img src={game.xImageUrl} alt="" /> : 'X'}</span><span>{game.playerXName}<small>{game.status === 'playing' && game.nextPlayer === 'X' ? 'X · PLAYING' : 'PLAYER X'}</small></span></div>
              <span className="game-versus">VS</span>
              <div className={`game-player-chip ${game.status === 'playing' && game.nextPlayer === 'O' ? 'is-turn' : ''}`}><span className="game-mark mark-o">{game.oImageUrl ? <img src={game.oImageUrl} alt="" /> : 'O'}</span><span>{game.playerOName || 'Waiting…'}<small>{game.status === 'playing' && game.nextPlayer === 'O' ? 'O · PLAYING' : 'PLAYER O'}</small></span></div>
            </div>
            <div className="vanishing-board" role="grid" aria-label="Tic-tac-toe board">
              {game.board.map((mark, index) => (
                <button
                  className={`game-cell ${mark ? `has-mark mark-cell-${mark.toLowerCase()}` : ''}`}
                  key={index}
                  type="button"
                  role="gridcell"
                  aria-label={`Row ${Math.floor(index / 3) + 1}, column ${index % 3 + 1}${mark ? `, ${mark}` : ', empty'}`}
                  disabled={!myTurn || mark !== null || pendingCell !== null}
                  onClick={() => void playCell(index)}
                >{mark && (mark === 'X' && game.xImageUrl
                  ? <img className="game-cell-image" src={game.xImageUrl} alt="X" />
                  : mark === 'O' && game.oImageUrl
                    ? <img className="game-cell-image" src={game.oImageUrl} alt="O" />
                    : <span>{mark}</span>)}</button>
              ))}
            </div>
            {game.status === 'waiting' && <p className="game-rule-note">Room joined. Waiting for the other player to scan the admin’s QR code.</p>}
            {game.status === 'playing' && <p className="game-rule-note">On a non-winning fourth move, your oldest mark vanishes. A winning line stays on the board.</p>}
            {game.status === 'finished' && !game.isSpectator && game.rematchDeadline && (
              <div className="game-rematch" aria-live="polite">
                <strong>Play again?</strong>
                {rematchRemaining > 0 && game.rematchVotes.X !== 0 && game.rematchVotes.O !== 0 ? (
                  <>
                    <p>Both players must agree. Choose before the timer ends.</p>
                    <div className="game-rematch-countdown">{rematchRemaining}</div>
                    {myRematchVote === null ? (
                      <div className="game-rematch-actions">
                        <button className="button button-primary" type="button" onClick={() => void respondToRematch(true)} disabled={rematchBusy}>Play again</button>
                        <button className="button button-quiet" type="button" onClick={() => void respondToRematch(false)} disabled={rematchBusy}>No thanks</button>
                      </div>
                    ) : <p>{myRematchVote === 1 ? 'You agreed. Waiting for the other player…' : 'You declined the rematch.'}</p>}
                    {opponentRematchVote === 0 && <p>The other player declined. This game will stay finished.</p>}
                  </>
                ) : <p>{rematchRemaining === 0 ? 'The rematch time has expired.' : 'The other player declined. This game will stay finished.'}</p>}
              </div>
            )}
            {error && <p className="game-error" role="alert">{error}</p>}
          </section>
        )}
      </div>
    </main>
  )
}
