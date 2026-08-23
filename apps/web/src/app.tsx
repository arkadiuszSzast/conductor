import { useEffect, useState } from "react"
import { Route, Router } from "wouter"
import { AppContext, useApp, type AppServices } from "./app-context.ts"
import { AuthSession, localStorageAuthStorage } from "./auth/auth-store.ts"
import { ApiClient } from "./api/client.ts"
import { DataSource } from "./api/store.ts"
import { useAuthStatus } from "./auth/use-auth.ts"
import { AuthGate } from "./auth/auth-gate.tsx"
import { Board } from "./board/board.tsx"
import { FeatureView } from "./feature/feature-view.tsx"
import { TopBar } from "./top-bar.tsx"
import { Toasts } from "./ui/toasts.tsx"
import { pushToast } from "./ui/toast-store.ts"
import { StartWorkContext } from "./start-work/start-work-context.ts"
import { StartWorkSheet } from "./start-work/start-work-sheet.tsx"
import { PluginRail } from "./plugins/plugin-rail.tsx"

async function probeHealth(token: string | null): Promise<number> {
  const headers: Record<string, string> = {}
  if (token !== null) headers["authorization"] = `Bearer ${token}`
  try {
    const res = await fetch("/v1/health", { headers })
    return res.status
  } catch {
    return 0
  }
}

export function App(): React.ReactNode {
  const [services, setServices] = useState<AppServices | null>(null)

  useEffect(() => {
    let active = true
    const storage = localStorageAuthStorage()
    const session = new AuthSession({ storage, probe: probeHealth })
    const client = new ApiClient({
      token: () => session.getToken(),
      onUnauthorized: () => {
        session.handleUnauthorized()
        pushToast("session expired — re-authentication required", "info")
      },
    })
    const store = new DataSource({ client })
    void session.bootstrap().then(() => {
      if (!active) return
      if (session.status === "authenticated") void store.start()
      setServices({ session, client, store })
    })
    return () => {
      active = false
      store.stop()
    }
  }, [])

  if (services === null) return <div style={{ padding: 24, color: "var(--text-dim)" }}>starting…</div>

  return (
    <AppContext.Provider value={services}>
      <Router>
        <Shell />
      </Router>
    </AppContext.Provider>
  )
}

function Shell(): React.ReactNode {
  const { session, store, client } = useApp()
  const status = useAuthStatus(session)
  const [startWorkOpen, setStartWorkOpen] = useState(false)

  useEffect(() => {
    if (status === "authenticated") {
      if (!store.isStreamConnected()) void store.start()
      // Fire-and-forget: sets the plugin-session cookie iframe
      // navigations and panel fetches ride under bearer auth (design D5).
      // A failure here just means panels 401 until the store's own
      // retry-on-401 re-exchanges — never blocks the board from loading.
      void client.exchangePluginSession().catch(() => {})
    } else if (status === "needs-token") {
      store.stop()
    }
  }, [status, store, client])

  if (status !== "authenticated") return <AuthGate />

  return (
    <StartWorkContext.Provider value={() => setStartWorkOpen(true)}>
      <div className="app-shell">
        <a href="#main" className="skip-link">
          skip to content
        </a>
        <TopBar />
        <main id="main" tabIndex={-1}>
          <div className="main-content">
            <Route path="/" component={Board} />
            <Route path="/feature/:id" component={FeatureView} />
          </div>
          <PluginRail />
        </main>
        <Toasts />
        {startWorkOpen ? <StartWorkSheet onClose={() => setStartWorkOpen(false)} /> : null}
      </div>
    </StartWorkContext.Provider>
  )
}
