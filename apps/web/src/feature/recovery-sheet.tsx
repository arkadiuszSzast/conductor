/**
 * Recovery sheet — replaces `window.prompt` for escalated-feature
 * recovery. A required, validated notes field; pending/error states;
 * and on a stale/conflict response the note is preserved while the
 * feature detail is refetched so the operator can review what changed
 * before resubmitting (design.md "Use application-owned action sheets").
 *
 * When the feature exposes more than one `recoverableTargets` candidate,
 * a pre-checked checkbox list renders so the operator recovers all of
 * them in one atomic request or narrows the selection explicitly
 * (retry-budget spec: "Parallel failures recover together or by
 * explicit selection"). Exactly one candidate keeps the prior no-select
 * behavior. An `ambiguous_target` response (a race that added a second
 * candidate after this sheet loaded) surfaces the server's target list
 * the same way, so the operator can retry with an explicit selection
 * even before a refetch lands.
 *
 * A selected target behind an unresolved runner fence (execution
 * uncertain) cannot be recovered with a plain request: the operator must
 * explicitly acknowledge the unproven effects and, when the daemon could
 * not confirm the old process stopped, attest cleanup themselves. Those
 * confirmations render only when needed and are sent as
 * `acknowledgeUncertain` / `cleanupAttested`.
 */

import { useEffect, useState } from "react"
import { useApp } from "../app-context.ts"
import { useCommand, useFeatureDetail } from "../api/hooks.ts"
import { createIdempotencyKey } from "../lib/id.ts"
import { mapGateError } from "../gate/gate-logic.ts"
import { pushToast } from "../ui/toast-store.ts"
import { ActionSheet } from "../ui/action-sheet.tsx"
import { ApiError } from "../api/client.ts"
import type { RecoverableTarget } from "../api/types.ts"
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
  const [checkedTargets, setCheckedTargets] = useState<ReadonlySet<string> | null>(null)
  const [ambiguousTargets, setAmbiguousTargets] = useState<readonly RecoverableTarget[] | null>(null)
  // Set when the server demanded uncertainty acknowledgement this view did
  // not know about (a fence appeared after load, or an older projection):
  // ask for both confirmations rather than guess which one is missing.
  const [uncertaintyDemanded, setUncertaintyDemanded] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [cleanupAttested, setCleanupAttested] = useState(false)
  // Fixed for the lifetime of this sheet instance: a retry after a
  // conflict must reuse the same key so the server can dedupe it as the
  // same logical attempt, per the recover command's idempotency contract.
  const [idempotencyKey] = useState(() => createIdempotencyKey())

  const feature = detailState.data?.feature
  const candidates: readonly RecoverableTarget[] = ambiguousTargets ?? feature?.recoverableTargets ?? []
  const showList = candidates.length > 1
  // Pre-check everything once the candidate set is known: recovering the
  // whole frontier is the common case after a shared-cause outage, and a
  // narrower selection is one click away.
  const candidatesKey = candidates.map(targetKey).join("|")
  useEffect(() => {
    if (candidates.length > 0) setCheckedTargets(new Set(candidates.map(targetKey)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidatesKey])

  const checked = checkedTargets ?? new Set<string>()
  const selectedCandidates = candidates.filter(candidate => checked.has(targetKey(candidate)))
  const uncertainSelected = selectedCandidates.filter(candidate => candidate.uncertain !== undefined)
  const needsAcknowledgement = uncertaintyDemanded || uncertainSelected.length > 0
  const needsCleanupAttestation = uncertainSelected.length > 0
    ? uncertainSelected.some(candidate => candidate.uncertain?.cleanupAttestationRequired === true)
    : uncertaintyDemanded
  const trimmed = notes.trim()
  const invalid = trimmed === "" || feature === undefined || (showList && selectedCandidates.length === 0)
    || (needsAcknowledgement && !acknowledged) || (needsCleanupAttestation && !cleanupAttested)

  const toggleTarget = (key: string): void => {
    const next = new Set(checked)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setCheckedTargets(next)
  }

  const submit = async (): Promise<void> => {
    if (invalid || pending || feature === undefined) return
    setError(null)
    setPending(true)
    try {
      // Exact selection under the version check: send `targets` (not
      // `all`) so the server re-arms precisely what this view showed,
      // even if the candidate set widened concurrently.
      const pick = (candidate: RecoverableTarget) => ({ jobId: candidate.jobId, stepId: candidate.stepId })
      const selection = candidates.length === 1
        ? { target: pick(candidates[0]!) }
        : selectedCandidates.length === candidates.length || selectedCandidates.length > 1
          ? { targets: selectedCandidates.map(pick) }
          : { target: pick(selectedCandidates[0]!) }
      const uncertainty = needsAcknowledgement
        ? { acknowledgeUncertain: true, ...(needsCleanupAttestation ? { cleanupAttested: true } : {}) }
        : {}
      const response = await runCommand(featureId, client =>
        client.recover(featureId, notes, { expectedVersion: feature.updatedAt, idempotencyKey, ...selection, ...uncertainty }),
      )
      pushToast(`✓ ${response.result}`)
      onClose()
    } catch (err) {
      if (err instanceof ApiError && err.code === "ambiguous_target" && err.targets !== null) {
        setAmbiguousTargets(err.targets)
        setError(err.message)
      } else if (err instanceof ApiError && err.code === "uncertainty_required") {
        store.refetchFeatureDetail(featureId)
        setUncertaintyDemanded(true)
        setError("A selected step's execution is uncertain — confirm below before recovering.")
      } else {
        const handled = mapGateError(err)
        if (handled.refetch) {
          store.refetchFeatureDetail(featureId)
          if (err instanceof ApiError && (err.code === "stale_version" || err.code === "stale_target")) setStale(true)
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
            {pending
              ? "recovering…"
              : showList && selectedCandidates.length > 1
                ? `recover ${selectedCandidates.length} steps`
                : "recover"}
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
      {showList ? (
        <div className={styles.field}>
          <span className={styles.label}>
            targets <span className={styles.required}>(at least one)</span>
          </span>
          <div className={styles.targetList} role="group" aria-label="recoverable targets">
            {candidates.map(candidate => {
              const key = targetKey(candidate)
              return (
                <label key={key} className={styles.targetRow}>
                  <input
                    type="checkbox"
                    checked={checked.has(key)}
                    onChange={() => toggleTarget(key)}
                    disabled={pending}
                  />
                  <span>
                    {candidate.jobId}/{candidate.stepId}
                    {candidate.uncertain !== undefined ? <span className={styles.uncertainTag}> · uncertain</span> : null}
                  </span>
                </label>
              )
            })}
          </div>
          <div className={styles.targetActions}>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => setCheckedTargets(new Set(candidates.map(targetKey)))}
              disabled={pending || selectedCandidates.length === candidates.length}
            >
              recover all
            </button>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => setCheckedTargets(new Set())}
              disabled={pending || selectedCandidates.length === 0}
            >
              clear
            </button>
          </div>
        </div>
      ) : null}
      {needsAcknowledgement ? (
        <div className={styles.uncertainBox} role="group" aria-label="uncertain execution">
          <strong>Execution uncertain{uncertainSelected.length > 0 ? `: ${uncertainSelected.map(c => `${c.jobId}/${c.stepId}`).join(", ")}` : ""}</strong>
          <p>
            The previous attempt was neither confirmed failed nor succeeded — it may have had effects. Recovery never
            resends it; it starts a fresh attempt.
          </p>
          <label className={styles.confirmRow}>
            <input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} disabled={pending} />
            <span>I acknowledge the previous attempt's effects are unproven, not confirmed absent.</span>
          </label>
          {needsCleanupAttestation ? (
            <label className={styles.confirmRow}>
              <input
                type="checkbox"
                checked={cleanupAttested}
                onChange={e => setCleanupAttested(e.target.checked)}
                disabled={pending}
              />
              <span>
                I independently verified the old runner process was terminated (the daemon could not confirm it).
              </span>
            </label>
          ) : null}
        </div>
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
