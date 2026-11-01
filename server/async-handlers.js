// Express 4 does not forward rejected promises from async handlers to the error middleware.
// This makes a rejected async route or middleware call next(error), as Express 5 does natively.
import Layer from 'express/lib/router/layer.js'

Layer.prototype.handle_request = function patchedHandleRequest(request, response, next) {
  const handler = this.handle
  if (handler.length > 3) return next()
  try {
    const result = handler(request, response, next)
    if (result && typeof result.catch === 'function') result.catch(next)
  } catch (error) {
    next(error)
  }
}
