process.env.NODE_ENV = 'production'
import('./main.mjs').catch((error) => {
  console.error('VOTE failed to start:', error)
  process.exit(1)
})
