import { Trophy } from 'lucide-react'

type DisplayWinner = {
  id: string
  participantName: string
  ticketNumber: string
}

export function DisplayWinners({ winners, label = 'Announced winners' }: { winners: DisplayWinner[]; label?: string }) {
  return (
    <div className="raffle-screen-winners">
      <h2>{winners.length} {winners.length === 1 ? 'winner' : 'winners'}</h2>
      <ol className="raffle-screen-winner-list" aria-label={label}>
        {winners.map((winner, index) => (
          <li key={winner.id}>
            <span className="raffle-screen-winner-rank"><Trophy aria-hidden="true" /> {index + 1}</span>
            <strong>{winner.participantName}</strong>
            <span className="raffle-screen-ticket">TICKET {winner.ticketNumber}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
