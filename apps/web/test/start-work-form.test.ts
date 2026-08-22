/**
 * Start-work form model — typed validation/serialization and the
 * target-switch reset contract from `start-work-from-control-room`.
 */
import { describe, expect, it } from "bun:test"
import {
  EMPTY_START_FORM_DRAFT,
  NO_FIELDS_TOUCHED,
  NO_FIELD_ERRORS,
  hasFieldErrors,
  initialInputDraft,
  reconcileInputsForRefresh,
  reconcileServerErrorsForRefresh,
  reconcileTouchedForRefresh,
  resetInputsForTarget,
  touchAll,
  validateStartForm,
  visibleFieldErrors,
  type StartFormDraft,
  type StartFormFieldErrors,
  type StartFormTouched,
} from "../src/start-work/form.ts"
import type { InputDef } from "../src/api/types.ts"

describe("initialInputDraft", () => {
  it("seeds optional inputs from their declared default", () => {
    const defs: Record<string, InputDef> = {
      count: { type: "number", presence: "optional", default: 3 },
      flag: { type: "boolean", presence: "optional", default: true },
      label: { type: "string", presence: "optional", default: "auth" },
    }
    expect(initialInputDraft(defs)).toEqual({ count: "3", flag: true, label: "auth" })
  })

  it("required inputs with no default start unset", () => {
    const defs: Record<string, InputDef> = {
      feature: { type: "string", presence: "required" },
      count: { type: "number", presence: "required" },
      flag: { type: "boolean", presence: "required" },
    }
    expect(initialInputDraft(defs)).toEqual({ feature: "", count: "", flag: false })
  })
})

describe("resetInputsForTarget", () => {
  it("replaces only the workflow inputs, preserving title/description/pr", () => {
    const draft: StartFormDraft = {
      title: "Add dark mode",
      description: "task text",
      pr: "42",
      inputs: { old: "stale value" },
    }
    const next = resetInputsForTarget(draft, { feature: { type: "string", presence: "required" } })
    expect(next.title).toBe("Add dark mode")
    expect(next.description).toBe("task text")
    expect(next.pr).toBe("42")
    expect(next.inputs).toEqual({ feature: "" })
  })
})

describe("reconcileInputsForRefresh", () => {
  const draft: StartFormDraft = {
    title: "Add dark mode",
    description: "task text",
    pr: "42",
    inputs: { feature: "auth", count: "5", verbose: true },
  }

  it("keeps a same-name, same-type value unchanged", () => {
    const prev: Record<string, InputDef> = { feature: { type: "string", presence: "required" } }
    const next: Record<string, InputDef> = { feature: { type: "string", presence: "required" } }
    const result = reconcileInputsForRefresh(draft, prev, next)
    expect(result.inputs.feature).toBe("auth")
    // Feature-level fields are untouched by input reconciliation.
    expect(result.title).toBe("Add dark mode")
    expect(result.pr).toBe("42")
  })

  it("keeps a same-name, same-type value even when its presence/default changed (spec: presence/default alone does not invalidate)", () => {
    const prev: Record<string, InputDef> = { count: { type: "number", presence: "required" } }
    const next: Record<string, InputDef> = { count: { type: "number", presence: "optional", default: 99 } }
    const result = reconcileInputsForRefresh(draft, prev, next)
    expect(result.inputs.count).toBe("5")
  })

  it("seeds a genuinely ADDED input from its default/unset rather than leaving it undefined", () => {
    const prev: Record<string, InputDef> = { feature: { type: "string", presence: "required" } }
    const next: Record<string, InputDef> = {
      feature: { type: "string", presence: "required" },
      brandNew: { type: "string", presence: "optional", default: "seeded" },
    }
    const result = reconcileInputsForRefresh(draft, prev, next)
    expect(result.inputs.feature).toBe("auth")
    expect(result.inputs.brandNew).toBe("seeded")
  })

  it("silently drops a REMOVED input's draft value", () => {
    const prev: Record<string, InputDef> = {
      feature: { type: "string", presence: "required" },
      legacyOnly: { type: "string", presence: "optional", default: "x" },
    }
    const next: Record<string, InputDef> = { feature: { type: "string", presence: "required" } }
    const result = reconcileInputsForRefresh(draft, prev, next)
    expect(result.inputs).toEqual({ feature: "auth" })
    expect("legacyOnly" in result.inputs).toBe(false)
  })

  it("reseeds fresh on a TYPE CHANGE for the same name, dropping the incompatible entered value", () => {
    const prev: Record<string, InputDef> = { count: { type: "number", presence: "required" } }
    const next: Record<string, InputDef> = { count: { type: "boolean", presence: "required" } }
    const result = reconcileInputsForRefresh(draft, prev, next)
    // Boolean required-with-no-default seeds `false`, never the stale "5" string.
    expect(result.inputs.count).toBe(false)
  })

  it("handles a full add+remove+type-change+compatible mix in one refresh", () => {
    const prev: Record<string, InputDef> = {
      feature: { type: "string", presence: "required" },
      count: { type: "number", presence: "required" },
      verbose: { type: "boolean", presence: "optional", default: false },
    }
    const next: Record<string, InputDef> = {
      feature: { type: "string", presence: "required" }, // unchanged — kept
      count: { type: "string", presence: "required" }, // type changed — reseeded
      // verbose removed
      target: { type: "string", presence: "optional", default: "prod" }, // added — seeded
    }
    const result = reconcileInputsForRefresh(draft, prev, next)
    expect(result.inputs.feature).toBe("auth")
    expect(result.inputs.count).toBe("") // reseeded fresh for required string with no default
    expect("verbose" in result.inputs).toBe(false)
    expect(result.inputs.target).toBe("prod")
  })
})

describe("reconcileServerErrorsForRefresh", () => {
  const serverErrors: StartFormFieldErrors = {
    title: "server title problem",
    pr: "server pr problem",
    inputs: { feature: 'input "feature" is required', legacyOnly: "stale diagnostic" },
  }

  it("keeps a server error for a still-compatible same-type input", () => {
    const prev: Record<string, InputDef> = { feature: { type: "string", presence: "required" } }
    const next: Record<string, InputDef> = { feature: { type: "string", presence: "required" } }
    const result = reconcileServerErrorsForRefresh(serverErrors, prev, next)
    expect(result.inputs.feature).toBe('input "feature" is required')
  })

  it("drops a server error for an input removed by the refresh", () => {
    const prev: Record<string, InputDef> = {
      feature: { type: "string", presence: "required" },
      legacyOnly: { type: "string", presence: "optional", default: "x" },
    }
    const next: Record<string, InputDef> = { feature: { type: "string", presence: "required" } }
    const result = reconcileServerErrorsForRefresh(serverErrors, prev, next)
    expect("legacyOnly" in result.inputs).toBe(false)
  })

  it("drops a server error for an input whose type changed", () => {
    const prev: Record<string, InputDef> = { feature: { type: "string", presence: "required" } }
    const next: Record<string, InputDef> = { feature: { type: "boolean", presence: "required" } }
    const result = reconcileServerErrorsForRefresh(serverErrors, prev, next)
    expect("feature" in result.inputs).toBe(false)
  })

  it("always keeps title/pr server errors — those are feature-level, not target-specific", () => {
    const result = reconcileServerErrorsForRefresh(serverErrors, {}, {})
    expect(result.title).toBe("server title problem")
    expect(result.pr).toBe("server pr problem")
  })
})

describe("reconcileTouchedForRefresh", () => {
  it("keeps a touched flag for a still-compatible input", () => {
    const touched: StartFormTouched = { title: true, pr: false, inputs: { feature: true } }
    const prev: Record<string, InputDef> = { feature: { type: "string", presence: "required" } }
    const next: Record<string, InputDef> = { feature: { type: "string", presence: "required" } }
    const result = reconcileTouchedForRefresh(touched, prev, next)
    expect(result.inputs.feature).toBe(true)
    expect(result.title).toBe(true)
    expect(result.pr).toBe(false)
  })

  it("drops a touched flag for a removed or type-changed input", () => {
    const touched: StartFormTouched = { title: false, pr: false, inputs: { feature: true, count: true } }
    const prev: Record<string, InputDef> = {
      feature: { type: "string", presence: "required" },
      count: { type: "number", presence: "required" },
    }
    const next: Record<string, InputDef> = {
      feature: { type: "boolean", presence: "required" }, // type changed
      // count removed
    }
    const result = reconcileTouchedForRefresh(touched, prev, next)
    expect("feature" in result.inputs).toBe(false)
    expect("count" in result.inputs).toBe(false)
  })
})

describe("touchAll", () => {
  it("marks title, pr, and every declared input as touched", () => {
    const defs: Record<string, InputDef> = {
      feature: { type: "string", presence: "required" },
      count: { type: "number", presence: "optional", default: 1 },
    }
    const result = touchAll(defs)
    expect(result.title).toBe(true)
    expect(result.pr).toBe(true)
    expect(result.inputs).toEqual({ feature: true, count: true })
  })
})

describe("visibleFieldErrors", () => {
  const liveErrors: StartFormFieldErrors = { title: "a title is required", pr: "must be positive", inputs: { feature: "required" } }

  it("hides every live error when nothing is touched and no submit was attempted", () => {
    const result = visibleFieldErrors(liveErrors, NO_FIELD_ERRORS, NO_FIELDS_TOUCHED, false)
    expect(result).toEqual({ inputs: {} })
  })

  it("shows only a touched field's live error, not untouched siblings", () => {
    const touched: StartFormTouched = { title: true, pr: false, inputs: {} }
    const result = visibleFieldErrors(liveErrors, NO_FIELD_ERRORS, touched, false)
    expect(result.title).toBe("a title is required")
    expect(result.pr).toBeUndefined()
    expect(result.inputs.feature).toBeUndefined()
  })

  it("shows a touched input's live error, not an untouched one", () => {
    const touched: StartFormTouched = { title: false, pr: false, inputs: { feature: true } }
    const result = visibleFieldErrors(liveErrors, NO_FIELD_ERRORS, touched, false)
    expect(result.inputs.feature).toBe("required")
  })

  it("a submit attempt makes every live error visible regardless of touched state", () => {
    const result = visibleFieldErrors(liveErrors, NO_FIELD_ERRORS, NO_FIELDS_TOUCHED, true)
    expect(result.title).toBe("a title is required")
    expect(result.pr).toBe("must be positive")
    expect(result.inputs.feature).toBe("required")
  })

  it("a server error is always visible regardless of touched/submitAttempted, and takes precedence over a live error for the same field", () => {
    const serverErrors: StartFormFieldErrors = { title: "server says no", inputs: { feature: "server: missing" } }
    const result = visibleFieldErrors(liveErrors, serverErrors, NO_FIELDS_TOUCHED, false)
    expect(result.title).toBe("server says no")
    expect(result.inputs.feature).toBe("server: missing")
  })

  it("recomputes fresh from the current liveErrors on every call — no memoized staleness", () => {
    const touched: StartFormTouched = { title: true, pr: false, inputs: {} }
    const stillInvalid = visibleFieldErrors({ title: "a title is required", inputs: {} }, NO_FIELD_ERRORS, touched, false)
    expect(stillInvalid.title).toBe("a title is required")
    const nowValid = visibleFieldErrors(NO_FIELD_ERRORS, NO_FIELD_ERRORS, touched, false)
    expect(nowValid.title).toBeUndefined()
  })
})

describe("validateStartForm: feature metadata", () => {
  it("requires a non-empty title", () => {
    const result = validateStartForm({ ...EMPTY_START_FORM_DRAFT, title: "   " }, {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.title).toContain("required")
  })

  it("trims the title and omits an empty description", () => {
    const result = validateStartForm({ ...EMPTY_START_FORM_DRAFT, title: "  Add dark mode  ", description: "   " }, {})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.title).toBe("Add dark mode")
      expect(result.value.description).toBeUndefined()
    }
  })

  it("keeps a trimmed multiline description", () => {
    const result = validateStartForm({ ...EMPTY_START_FORM_DRAFT, title: "T", description: "line one\nline two" }, {})
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.description).toBe("line one\nline two")
  })

  it("an unset PR is omitted, not zero", () => {
    const result = validateStartForm({ ...EMPTY_START_FORM_DRAFT, title: "T" }, {})
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.pr).toBeUndefined()
  })

  it("accepts a positive integer PR", () => {
    const result = validateStartForm({ ...EMPTY_START_FORM_DRAFT, title: "T", pr: "123" }, {})
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.pr).toBe(123)
  })

  it("rejects a non-integer, zero, negative, or non-numeric PR", () => {
    for (const bad of ["0", "-1", "1.5", "abc"]) {
      const result = validateStartForm({ ...EMPTY_START_FORM_DRAFT, title: "T", pr: bad }, {})
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.pr).toContain("positive integer")
    }
  })
})

describe("validateStartForm: workflow inputs", () => {
  const defs: Record<string, InputDef> = {
    feature: { type: "string", presence: "required" },
    count: { type: "number", presence: "optional", default: 3 },
    verbose: { type: "boolean", presence: "optional", default: false },
  }

  it("submits required/typed inputs with their JSON types", () => {
    const result = validateStartForm(
      { ...EMPTY_START_FORM_DRAFT, title: "T", inputs: { feature: "auth", count: "5", verbose: true } },
      defs,
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.inputs).toEqual({ feature: "auth", count: 5, verbose: true })
  })

  it("an unchanged submission resolves optional inputs to their declared defaults", () => {
    const optionalOnly: Record<string, InputDef> = {
      count: { type: "number", presence: "optional", default: 3 },
      verbose: { type: "boolean", presence: "optional", default: false },
    }
    const result = validateStartForm({ ...EMPTY_START_FORM_DRAFT, title: "T", inputs: initialInputDraft(optionalOnly) }, optionalOnly)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.inputs).toEqual({ count: 3, verbose: false })
  })

  it("blocks submission on an omitted required value", () => {
    const result = validateStartForm({ ...EMPTY_START_FORM_DRAFT, title: "T", inputs: { count: "1" } }, defs)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.inputs.feature).toContain("required")
  })

  it("rejects an unset number left blank", () => {
    const result = validateStartForm(
      { ...EMPTY_START_FORM_DRAFT, title: "T", inputs: { feature: "auth", count: "" } },
      { feature: { type: "string", presence: "required" }, count: { type: "number", presence: "required" } },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.inputs.count).toContain("required")
  })

  it("rejects a non-finite number", () => {
    const result = validateStartForm(
      { ...EMPTY_START_FORM_DRAFT, title: "T", inputs: { feature: "auth", count: "not-a-number" } },
      defs,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.inputs.count).toContain("finite number")
  })

  it("a boolean input defaults false when required and untouched", () => {
    const result = validateStartForm(
      { ...EMPTY_START_FORM_DRAFT, title: "T", inputs: { feature: "auth" } },
      { ...defs, verbose: { type: "boolean", presence: "required" } },
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.inputs.verbose).toBe(false)
  })
})

describe("hasFieldErrors", () => {
  it("is false with no errors", () => {
    expect(hasFieldErrors({ inputs: {} })).toBe(false)
  })
  it("is true with a title error", () => {
    expect(hasFieldErrors({ title: "required", inputs: {} })).toBe(true)
  })
  it("is true with an input error", () => {
    expect(hasFieldErrors({ inputs: { feature: "required" } })).toBe(true)
  })
})
