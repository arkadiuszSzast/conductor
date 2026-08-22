/**
 * Recovery sheet — replaces `window.prompt` for escalated-feature
 * recovery. A required, validated notes field; pending/error states;
 * and on a stale/conflict response the note is preserved while the
 * feature detail is refetched so the operator can review what changed
 * before resubmitting (design.md "Use application-owned action sheets").
 *
 * When the feature exposes more than one `recoverableTargets` candidate,
 * a required target select renders so the operator picks one explicitly
 * (retry-budget spec: "Parallel failures require a selected target").
 * Exactly one candidate keeps the prior no-select behavior. An
 * `ambiguous_target` response (a race that added a second candidate
 * after this sheet loaded) surfaces the server's target list the same
 * way, so the operator can retry with an explicit selection even before
 * a refetch lands.
 */

import { useEffect, useState } from "react"
import { useApp } from "../app-context.ts"
import { useCommand, useFeatureDetail } from "../api/hooks.ts"
import { createIdempotencyKey } from "../lib/id.ts"
import { mapGateError } from "../gate/gate-logic.ts"
import { pushToast } from "../ui/toast-store.ts"
import { ActionSheet } from "../ui/action-sheet.tsx"
import { ApiError } from "../api/client.ts"
import styles from "./recovery-sheet.module.css"

export interface RecoverySheetProps {
  readonly featureId: string
  readonly onClose: () => void
}

function targetKey(target: { readonly jobId: string; readonly stepId: string }): string {
  return `${target.jobId}\u0000${target.stepId}`
}

/** Loads its own feature detail so callers only need a feature id — the
 *  recover command's `expectedVersion` must reflect the freshest known
 *  `updatedAt`, and reusing the shared cache avoids a second fetch when
 *  the detail is already loaded for the workspace/board card. */
export function RecoverySheet({ featureId, onClose }: RecoverySheetProps): React.ReactNode {
  const { store } = useApp()
  const detailState = useFeatureDetail(store, featureId)
  const runCommand = useCommand(store)
  const [notes, setNotes] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [selectedTarget, setSelectedTarget] = useState<string>("")
  const [ambiguousTargets, setAmbiguousTargets] = useState<readonly { readonly jobId: string; readonly stepId: string }[] | null>(null)
  // Fixed for the lifetime of this sheet instance: a retry after a
  // conflict must reuse the same key so the server can dedupe it as the
  // same logical attempt, per the recover command's idempotency contract.
  const [idempotencyKey] = useState(() => createIdempotencyKey())

  const feature = detailState.data?.feature
  const candidates = ambiguousTargets ?? feature?.recoverableTargets ?? []
  const needsSelect = candidates.length > 1
  const singleCandidateKey = candidates.length === 1 ? targetKey(candidates[0]!) : null
  const trimmed = notes.trim()
  const invalid = trimmed === "" || feature === undefined || (needsSelect && selectedTarget === "")

  // Once exactly one candidate is known, pre-select it so `invalid`
  // reflects the notes field alone — matching the prior single-candidate
  // no-select behavior.
  useEffect(() => {
    if (singleCandidateKey !== null) setSelectedTarget(singleCandidateKey)
  }, [singleCandidateKey])

  const submit = async (): Promise<void> => {
    if (invalid || pending || feature === undefined) return
    setError(null)
    setPending(true)
    try {
      const target = selectedTarget !== "" ? candidates.find(candidate => targetKey(candidate) === selectedTarget) : undefined
      const response = await runCommand(featureId, client =>
        client.recover(featureId, notes, { expectedVersion: feature.updatedAt, idempotencyKey, target }),
      )
      pushToast(`✓ ${response.result}`)
      onClose()
    } catch (err) {
      if (err instanceof ApiError && err.code === "ambiguous_target" && err.targets !== null) {
        setAmbiguousTargets(err.targets)
        setError(err.message)
      } else {
        const handled = mapGateError(err)
        if (handled.refetch) {
          store.refetchFeatureDetail(featureId)
          setStale(true)
          setError(handled.toast !== "" ? handled.toast : "feature state changed — review and resubmit")
        } else {
          setError(handled.toast !== "" ? handled.toast : "recovery failed")
        }
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <ActionSheet
      title="Recover feature"
      context={feature?.title}
      onClose={onClose}
      closeDisabled={pending}
      actions={
        <>
          <button onClick={onClose} disabled={pending}>
            cancel
          </button>
          <button className="primary" onClick={() => void submit()} disabled={pending || invalid}>
            {pending ? "recovering…" : "recover"}
          </button>
        </>
      }
    >
      <p className={styles.hint}>
        Recovery resumes an escalated feature. Explain what changed or what the runner should do differently — this
        note is recorded on the feature's timeline.
      </p>
      {stale ? (
        <div className={styles.staleNotice}>
          ⚠ The feature's state changed since this sheet opened. Review the latest status, then resubmit if the note
          still applies.
        </div>
      ) : null}
      {needsSelect ? (
        <label className={styles.field}>
          <span className={styles.label}>
            target <span className={styles.required}>(required)</span>
          </span>
          <select value={selectedTarget} onChange={e => setSelectedTarget(e.target.value)} disabled={pending}>
            <option value="" disabled>
              select a failed/blocked step…
            </option>
            {candidates.map(candidate => (
              <option key={targetKey(candidate)} value={targetKey(candidate)}>
                {candidate.jobId}/{candidate.stepId}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className={styles.field}>
        <span className={styles.label}>
          recovery note <span className={styles.required}>(required)</span>
        </span>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="e.g. the flaky network dependency is back; retry the same plan"
          disabled={pending}
          autoFocus
          rows={5}
        />
      </label>
      {error !== null ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}
    </ActionSheet>
  )
}
