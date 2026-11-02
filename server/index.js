// CommonJS entry so cPanel/Passenger can load it with require().
import('./main.mjs').catch((error) => {
  console.error('VOTE failed to start:', error)
  process.exit(1)
})
