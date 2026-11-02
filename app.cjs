// Startup file for cPanel/Passenger, which loads the entry with require().
import('./server/index.js').catch((error) => {
  console.error('VOTE failed to start:', error)
  process.exit(1)
})
