import { useState } from "react"
import { useApp } from "../app-context.ts"
import { useAuthStatus } from "./use-auth.ts"
import styles from "./auth-gate.module.css"

export function AuthGate(): React.ReactNode {
  const { session } = useApp()
  const status = useAuthStatus(session)
  const [token, setToken] = useState("")
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    const ok = await session.setToken(token.trim())
    if (!ok) {
      setError(session.error ?? "token rejected")
      setToken("")
    }
  }

  const checking = status === "checking"
  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.title}>Conductor</div>
        <div className={styles.hint}>Enter the daemon's bearer token to open the board.</div>
        <div className={styles.row}>
          <input
            type="password"
            placeholder="bearer token"
            value={token}
            disabled={checking}
            onChange={e => setToken(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && token.trim() !== "") submit()
            }}
            autoFocus
          />
          <button className="primary" disabled={checking || token.trim() === ""} onClick={submit}>
            {checking ? "…" : "Connect"}
          </button>
        </div>
        <div className={styles.error}>{error ?? ""}</div>
        {session.token !== null ? (
          <button
            className={styles.reconnect}
            onClick={() => session.forget()}
            title="Clear the stored token and re-authenticate."
          >
            forget token
          </button>
        ) : null}
      </div>
    </div>
  )
}
