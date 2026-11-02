// Fixed-window, in-memory limiter keyed by client IP (honours TRUST_PROXY_HOPS via request.ip).
export function rateLimit({ windowMs, max, message = 'Too many requests. Please wait a moment and try again.' }) {
  const hits = new Map()
  const cleanup = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key)
  }, windowMs)
  cleanup.unref()

  return (request, response, next) => {
    const now = Date.now()
    let entry = hits.get(request.ip)
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs }
      hits.set(request.ip, entry)
    }
    entry.count += 1
    if (entry.count > max) {
      response.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)))
      return response.status(429).json({ error: message })
    }
    next()
  }
}
