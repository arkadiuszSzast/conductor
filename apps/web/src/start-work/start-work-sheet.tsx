/**
 * Start-work sheet — one shell-owned form on the existing `ActionSheet`.
 * No `/feature/new` route, no second modal primitive: the authenticated
 * shell owns whether this is open and hands one trigger callback to the
 * persistent top bar and useful board empty states (design.md "Render
 * one shared shell-owned start sheet").
 *
 * A real `<form>` wraps the body and the submit button is associated by
 * `form={formId}` in the sticky action row so Enter-to-submit and
 * assistive-technology form semantics work without nesting a form inside
 * `ActionSheet`'s own footer markup. `closeDisabled` while pending blocks
 * Escape/backdrop/close-button dismissal so a request in flight can never
 * be abandoned mid-flight (spec: "Duplicate submit is blocked while
 * pending"). The submit button's `disabled` follows `canSubmit` (derived
 * in `useStartWorkForm` from discovery/target/validation state, per
 * spec "Derive canSubmit") rather than merely `pending`, and its
 * `title` carries `blockedReason` so a disabled button still explains
 * itself. The markup itself lives in `StartWorkFormFields` — split out
 * so it renders (via `renderToStaticMarkup`) without `ActionSheet`'s
 * `createPortal`, which needs a real DOM this test environment lacks.
 */

import { useId } from "react"
import { useLocation } from "wouter"
import { ActionSheet } from "../ui/action-sheet.tsx"
import { useStartWorkForm } from "./use-start-work-form.ts"
import { StartWorkFormFields } from "./start-work-form-fields.tsx"

export interface StartWorkSheetProps {
  readonly onClose: () => void
}

export function StartWorkSheet({ onClose }: StartWorkSheetProps): React.ReactNode {
  const [, navigate] = useLocation()
  const formId = useId()

  const form = useStartWorkForm({
    onSuccess: featureId => {
      onClose()
      navigate(`/feature/${featureId}`)
    },
  })

  return (
    <ActionSheet
      title="Start work"
      onClose={onClose}
      closeDisabled={form.pending}
      actions={
        <>
          <button type="button" onClick={onClose} disabled={form.pending}>
            cancel
          </button>
          <button
            type="submit"
            form={formId}
            className="primary"
            disabled={!form.canSubmit}
            title={!form.canSubmit && form.blockedReason !== null ? form.blockedReason : undefined}
          >
            {form.pending ? "starting…" : "start work"}
          </button>
        </>
      }
    >
      <StartWorkFormFields formId={formId} form={form} />
    </ActionSheet>
  )
}
