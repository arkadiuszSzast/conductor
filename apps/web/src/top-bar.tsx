import { useEffect, useId, useRef, useState } from "react"
import { useApp } from "./app-context.ts"
import { useAuthStatus } from "./auth/use-auth.ts"
import { useHealth, useStreamConnected } from "./api/hooks.ts"
import { useStartWork } from "./start-work/start-work-context.ts"
import { formatAge } from "./lib/time.ts"
import styles from "./top-bar.module.css"

export function TopBar(): React.ReactNode {
  const { store, session } = useApp()
  useAuthStatus(session)
  const healthState = useHealth(store)
  const connected = useStreamConnected(store)
  const startWork = useStartWork()
  const [open, setOpen] = useState(false)
  const popoverId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const health = healthState.data
  const healthy = health !== null && health.alive && health.ready
  const healthLabel = health === null ? "health unavailable" : healthy ? "ready" : health.alive ? "not ready" : "offline"
  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent | PointerEvent): void => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return
      } else if (triggerRef.current?.contains(event.target as Node)) {
        return
      }
      setOpen(false)
      if (event instanceof KeyboardEvent) triggerRef.current?.focus()
    }
    document.addEventListener("keydown", close)
    document.addEventListener("pointerdown", close)
    return () => {
      document.removeEventListener("keydown", close)
      document.removeEventListener("pointerdown", close)
    }
  }, [open])
  return (
    <header className={styles.bar}>
      <span className={styles.brand}>
        <span className={styles.brandMark} aria-hidden="true">
          ▸
        </span>
        CONDUCTOR
      </span>
      <span className={styles.spacer} />
      <div className={styles.right}>
        {!connected ? <span className={styles.chip}>reconnecting…</span> : null}
        <button type="button" className={`primary tap-target ${styles.startWorkBtn}`} onClick={startWork} aria-label="Start work">
          <span aria-hidden="true">+</span> <span className={styles.startWorkLabel} aria-hidden="true">start work</span>
        </button>
        <button
          ref={triggerRef}
          className={styles.healthBtn}
          onClick={() => setOpen(o => !o)}
          title="Daemon health"
          aria-expanded={open}
          aria-controls={popoverId}
        >
          <span className={`${styles.dot} ${healthy ? styles.dotOk : styles.dotBad}`} aria-hidden="true" />
          <span>{health?.phase ?? "…"}</span>
          <span className={styles.dim}>· {healthLabel}</span>
          <span className={styles.dim} aria-hidden="true"> ▾</span>
        </button>
        {open ? <HealthPopover id={popoverId} /> : null}
      </div>
    </header>
  )
}

function HealthPopover({ id }: { readonly id: string }): React.ReactNode {
  const { store } = useApp()
  const healthState = useHealth(store)
  const health = healthState.data
  if (health === null) return <div id={id} className={styles.popover}>no health data</div>
  const hb = health.heartbeat
  return (
    <div id={id} className={styles.popover}>
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
