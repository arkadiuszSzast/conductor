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
  const { session, store } = useApp()
  const status = useAuthStatus(session)

  useEffect(() => {
    if (status === "authenticated") {
      if (!store.isStreamConnected()) void store.start()
    } else if (status === "needs-token") {
      store.stop()
    }
  }, [status, store])

  if (status !== "authenticated") return <AuthGate />

  return (
    <>
      <TopBar />
      <main>
        <Route path="/" component={Board} />
        <Route path="/feature/:id" component={FeatureView} />
      </main>
      <Toasts />
    </>
  )
}
