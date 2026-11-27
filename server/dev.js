process.env.NODE_ENV = 'development'
import('./main.mjs').catch((error) => {
  console.error('VOTE failed to start:', error)
  process.exit(1)
})
