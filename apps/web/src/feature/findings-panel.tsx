import type { FindingView } from "../api/types.ts"
import styles from "./workspace-panels.module.css"

export function FindingsPanel({ findings }: { readonly findings: FindingView[] | undefined }): React.ReactNode {
  return (
    <div className={styles.panel}>
      {findings === undefined ? (
        <div className={styles.empty}>loading…</div>
      ) : findings.length === 0 ? (
        <div className={styles.empty}>no findings</div>
      ) : (
        findings.map(finding => (
          <div key={finding.id} className={styles.finding}>
            <span className={`${styles.sev} ${styles[severityClass(finding.severity)]}`}>{finding.severity}</span>
            <span className={styles.fstatus}>{finding.status}</span>
            <span className={styles.fbody}>{finding.body}</span>
          </div>
        ))
      )}
    </div>
  )
}

function severityClass(severity: string): string {
  const v = severity.toLowerCase()
  if (v === "high" || v === "critical") return "high"
  if (v === "medium") return "medium"
  return "low"
}
