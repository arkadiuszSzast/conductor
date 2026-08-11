import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * The SPA always calls a relative `/v1` base — same-origin in production
 * (the daemon serves the built bundle via `ApiConfig.ui.staticDir`), and
 * proxied to the daemon here in development. The only client-side
 * configuration is therefore the dev proxy target, overridable via
 * `VITE_DAEMON_ORIGIN`.
 */
const daemonOrigin = process.env.VITE_DAEMON_ORIGIN ?? "http://127.0.0.1:18080"

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/v1": daemonOrigin,
    },
  },
  build: {
    outDir: "dist",
  },
})
