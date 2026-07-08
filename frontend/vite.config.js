import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Port selection for dev mode is driven by run.py, which picks free
// ports before spawning this Vite instance and passes the chosen values
// via environment variables. Fall back to the historical defaults
// (8000 / 8001) when Vite is started standalone (e.g. `npm run dev`
// directly, no run.py wrapper). `strictPort: true` is the important
// bit — without it, Vite silently walks to the next port when its
// requested port is busy, which is exactly how the frontend used to
// collide with the backend at port 8001 during dev-server restarts.
const FRONTEND_PORT = parseInt(process.env.NN_FRONTEND_PORT || '8000', 10)
const BACKEND_PORT = parseInt(process.env.NN_BACKEND_PORT || '8001', 10)

// Vite logs every proxy ECONNREFUSED to the console even when the app
// handles the failure gracefully (startup race, backend briefly down).
// This plugin patches the dev-server logger to swallow those entries.
// Real backend errors still surface via the app's disconnection banner.
function suppressProxyConnRefused() {
  return {
    name: 'suppress-proxy-conn-refused',
    configureServer(server) {
      const orig = server.config.logger.error.bind(server.config.logger)
      server.config.logger.error = (msg, opts) => {
        if (opts?.error?.code === 'ECONNREFUSED') return
        orig(msg, opts)
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), suppressProxyConnRefused()],
  server: {
    port: FRONTEND_PORT,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${BACKEND_PORT}`,
        changeOrigin: true,
        // ws: true forwards WebSocket upgrade requests too — required for
        // `/api/mcp/bridge` (Phase 2.1 MCP bridge). HTTP routes and WS
        // routes coexist under the same `/api` prefix; the backend mounts
        // `mcp_bridge.router` at both bare and `/api/...` like every
        // other router, so the rewrite rule below works for both.
        ws: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
    // Allow imports from `docs/help/**` so the in-app help panel can
    // reference shipped help screenshots via Vite's asset pipeline.
    // Default `fs.allow` is `frontend/` only; the help screenshots
    // live at the repo root under `docs/help/`.
    fs: {
      allow: ['..'],
    },
  },
})
