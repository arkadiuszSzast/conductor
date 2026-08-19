/**
 * Start-work form markup — pure presentation over `useStartWorkForm`'s
 * state/commands, split out of `StartWorkSheet` so it renders with
 * `renderToStaticMarkup` for tests (no `ActionSheet` portal/DOM needed).
 *
 * The target picker uses NATIVE `<input type="radio">` controls grouped
 * by `name` rather than a hand-rolled `role="radio"` button group: native
 * radios get correct roving-tabindex Arrow-key navigation, Space/click
 * selection, and per-option `disabled` (skipped by native Arrow
 * navigation) for free, without reimplementing the ARIA radiogroup
 * keyboard contract by hand.
 */

import type { InputDraftValue } from "./form.ts"
import type { UseStartWorkFormResult } from "./use-start-work-form.ts"
import type { InputDef } from "../api/types.ts"
import styles from "./start-work-sheet.module.css"

export interface StartWorkFormFieldsProps {
  readonly formId: string
  readonly form: UseStartWorkFormResult
}

export function StartWorkFormFields({ formId, form }: StartWorkFormFieldsProps): React.ReactNode {
  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    void form.submit()
  }

  return (
    <form id={formId} className={styles.form} onSubmit={onSubmit}>
      <TargetPicker formId={formId} form={form} />
      {form.resolved !== null && form.resolved.submittable && form.resolved.workflowName !== null ? (
        <div className={styles.workflowNotice}>
          workflow <span className={styles.mono}>{form.resolved.workflowName}</span>
        </div>
      ) : null}
      {form.resolved?.staleWarning !== null && form.resolved?.staleWarning !== undefined ? (
        <div className={styles.staleNotice}>⚠ {form.resolved.staleWarning}</div>
      ) : null}
      {form.resolved?.unavailableReason !== null && form.resolved?.unavailableReason !== undefined ? (
        <div className={styles.unavailableNotice}>
          ✕ {form.resolved.unavailableReason}
          {form.resolved.canRetryWorkflow ? (
            <>
              {" "}
              <button type="button" className={styles.retryButton} onClick={form.retryWorkflow}>
                retry
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {form.resolved?.refreshError !== null && form.resolved?.refreshError !== undefined ? (
        <div className={styles.unavailableNotice} role="alert">
          ✕ could not confirm this target's current configuration — {form.resolved.refreshError}. your entered values are
          preserved; submission is blocked until this succeeds.
          {form.resolved.canRetryWorkflow ? (
            <>
              {" "}
              <button type="button" className={styles.retryButton} onClick={form.retryWorkflow}>
                retry
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {form.runnerWarning ? (
        <div className={styles.runnerNotice}>⚠ no runner is currently available — the feature will still be created and wait</div>
      ) : null}

      <label className={styles.field}>
        <span className={styles.label}>
          title <span className={styles.required}>(required)</span>
        </span>
        <input
          type="text"
          value={form.draft.title}
          onChange={e => form.setTitle(e.target.value)}
          disabled={form.pending}
          placeholder="e.g. Add dark mode"
        />
        {form.errors.title !== undefined ? (
          <span className={styles.fieldError} role="alert">
            {form.errors.title}
          </span>
        ) : null}
      </label>

      <label className={styles.field}>
        <span className={styles.label}>description</span>
        <textarea
          value={form.draft.description}
          onChange={e => form.setDescription(e.target.value)}
          disabled={form.pending}
          placeholder="optional task context"
          rows={4}
        />
      </label>

      <details className={styles.advanced} open={form.errors.pr !== undefined || undefined}>
        <summary className={styles.advancedSummary}>advanced</summary>
        <div className={styles.advancedBody}>
          <label className={styles.field}>
            <span className={styles.label}>existing pull request number</span>
            <input
              type="text"
              inputMode="numeric"
              value={form.draft.pr}
              onChange={e => form.setPr(e.target.value)}
              disabled={form.pending}
              placeholder="optional — e.g. 123"
            />
            <span className={styles.hint}>Attach this run to a pull request that already exists.</span>
            {form.errors.pr !== undefined ? (
              <span className={styles.fieldError} role="alert">
                {form.errors.pr}
              </span>
            ) : null}
          </label>
        </div>
      </details>

      {form.resolved !== null && form.resolved.submittable && Object.keys(form.resolved.inputs).length > 0 ? (
        <fieldset className={styles.inputsFieldset}>
          <legend className={styles.label}>workflow inputs</legend>
          {Object.entries(form.resolved.inputs)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, def]) => (
              <WorkflowInputField
                key={name}
                name={name}
                def={def}
                value={form.draft.inputs[name]}
                error={form.errors.inputs[name]}
                disabled={form.pending}
                onChange={value => form.setInputValue(name, value)}
              />
            ))}
        </fieldset>
      ) : null}

      {form.inlineError !== null ? (
        <div className={styles.inlineError} role="alert">
          {form.inlineError}
        </div>
      ) : null}
    </form>
  )
}

interface TargetPickerProps {
  readonly formId: string
  readonly form: UseStartWorkFormResult
}

function TargetPicker({ formId, form }: TargetPickerProps): React.ReactNode {
  if (form.discovery.status === "loading") {
    return (
      <div className={styles.hint} role="status" aria-live="polite">
        discovering configured projects…
      </div>
    )
  }
  if (form.discovery.status === "error") {
    return (
      <div className={styles.unavailableNotice} role="alert">
        ✕ could not load configured projects{form.discovery.message !== null ? `: ${form.discovery.message}` : ""}
        {form.targets.length > 0 ? (
          <>
            {" "}
            — showing the last known list; it may be stale. <TargetList formId={formId} form={form} />
          </>
        ) : null}
      </div>
    )
  }
  if (form.targets.length === 0) {
    return <div className={styles.hint}>no configured projects — register one with the CLI first.</div>
  }
  return <TargetList formId={formId} form={form} />
}

function TargetList({ formId, form }: TargetPickerProps): React.ReactNode {
  const labelId = `${formId}-project-label`
  return (
    <div className={styles.field}>
      <span className={styles.label} id={labelId}>
        project {form.requiresSelection ? <span className={styles.required}>(required)</span> : null}
      </span>
      <div className={styles.targetList} role="radiogroup" aria-labelledby={labelId}>
        {form.targets.map(target => {
          const selected = target.projectDir === form.selectedProjectDir
          const inputId = `${formId}-target-${target.projectDir}`
          return (
            <label
              key={target.projectDir}
              htmlFor={inputId}
              className={`${styles.targetOption} ${selected ? styles.targetOptionSelected : ""} ${!target.selectable ? styles.targetOptionDisabled : ""}`}
            >
              <input
                id={inputId}
                type="radio"
                name={`${formId}-target`}
                checked={selected}
                disabled={!target.selectable || form.pending}
                onChange={() => form.selectTarget(target.projectDir)}
                className={styles.targetRadio}
              />
              <span className={styles.targetBody}>
                <span className={styles.targetLabel}>{target.projectLabel}</span>
                <span className={styles.targetPath}>{target.projectDir}</span>
                <span className={styles.targetMeta}>
                  {target.state}
                  {target.diagnostics.length > 0 ? ` — ${target.diagnostics.join("; ")}` : ""}
                </span>
              </span>
            </label>
          )
        })}
      </div>
    </div>
  )
}

interface WorkflowInputFieldProps {
  readonly name: string
  readonly def: InputDef
  readonly value: InputDraftValue | undefined
  readonly error: string | undefined
  readonly disabled: boolean
  readonly onChange: (value: InputDraftValue) => void
}

function WorkflowInputField({ name, def, value, error, disabled, onChange }: WorkflowInputFieldProps): React.ReactNode {
  const required = def.presence === "required"
  if (def.type === "boolean") {
    return (
      <label className={styles.checkboxField}>
        <input
          type="checkbox"
          checked={typeof value === "boolean" ? value : false}
          onChange={e => onChange(e.target.checked)}
          disabled={disabled}
        />
        <span>
          {name} {required ? <span className={styles.required}>(required)</span> : null}
        </span>
        {error !== undefined ? (
          <span className={styles.fieldError} role="alert">
            {error}
          </span>
        ) : null}
      </label>
    )
  }
  return (
    <label className={styles.field}>
      <span className={styles.label}>
        {name} <span className={styles.typeTag}>{def.type}</span> {required ? <span className={styles.required}>(required)</span> : null}
      </span>
      <input
        type="text"
        inputMode={def.type === "number" ? "decimal" : undefined}
        value={typeof value === "string" ? value : ""}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        placeholder={def.presence === "optional" ? String(def.default) : undefined}
      />
      {error !== undefined ? (
        <span className={styles.fieldError} role="alert">
          {error}
        </span>
      ) : null}
    </label>
  )
}
