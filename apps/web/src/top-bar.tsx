import { useState } from "react"
import { useApp } from "./app-context.ts"
import { useAuthStatus } from "./auth/use-auth.ts"
import { useHealth, useStreamConnected } from "./api/hooks.ts"
import { formatAge } from "./lib/time.ts"
import styles from "./top-bar.module.css"

export function TopBar(): React.ReactNode {
  const { store, session } = useApp()
  useAuthStatus(session)
  const healthState = useHealth(store)
  const connected = useStreamConnected(store)
  const [open, setOpen] = useState(false)
  const health = healthState.data
  const healthy = health !== null && health.alive && health.ready
  return (
    <header className={styles.bar}>
      <span className={styles.brand}>CONDUCTOR</span>
      <span className={styles.spacer} />
      <div className={styles.right}>
        {!connected ? <span className={styles.chip}>reconnecting…</span> : null}
        <button className={styles.healthBtn} onClick={() => setOpen(o => !o)} title="Daemon health">
          <span className={`${styles.dot} ${healthy ? styles.dotOk : styles.dotBad}`} />
          <span>{health?.phase ?? "…"}</span>
          {health ? <span className={styles.dim}>· ready</span> : null}
          <span className={styles.dim}> ▾</span>
        </button>
        {open ? <HealthPopover /> : null}
      </div>
    </header>
  )
}

function HealthPopover(): React.ReactNode {
  const { store } = useApp()
  const healthState = useHealth(store)
  const health = healthState.data
  if (health === null) return <div className={styles.popover}>no health data</div>
  const hb = health.heartbeat
  return (
    <div className={styles.popover}>
      <h4>phase</h4>
      <div className={styles.line}>
        {health.phase} · {health.alive ? "alive" : "not alive"} · {health.ready ? "ready" : "not ready"}
      </div>
      <h4>heartbeat</h4>
      <div className={styles.line}>
        cycles {hb.cycles} · interval {Math.round(hb.intervalMs / 1000)}s
      </div>
      <div className={styles.lineDim}>
        last completed {hb.lastCompletedAt !== null ? formatAge(Date.now(), hb.lastCompletedAt) + " ago" : "—"}
      </div>
      {hb.lastError !== null ? <div className={styles.diag}>last error: {hb.lastError}</div> : null}
      <h4>projects</h4>
      <ul>
        {health.projects.map(project => (
          <li key={project.projectDir}>
            <span className={styles.line}>{project.state}</span> · {project.projectDir}
          </li>
        ))}
        {health.projects.length === 0 ? <li className={styles.lineDim}>none registered</li> : null}
      </ul>
      <h4>runner</h4>
      <div className={styles.line}>{health.runner}</div>
    </div>
  )
}
