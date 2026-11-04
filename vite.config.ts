import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiPort = process.env.PORT || '4180'
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || `http://localhost:${apiPort}`

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: apiProxyTarget,
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest, request) => {
            if (request.headers.host) proxyRequest.setHeader('x-forwarded-host', request.headers.host)
          })
        },
      },
    },
  },
})