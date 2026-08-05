import { describe, expect, it } from "bun:test"
import { validateWorkflow } from "./src/validate.ts"
import { actionStep, agentStep, commandStep, humanStep, job, next, rerunJobs, rerunSteps, workflow } from "./testing.ts"
import type { JobDef, WorkflowDef } from "./src/types.ts"

const roles: WorkflowDef["roles"] = {
  architect: { agent: "build" },
  judge: { agent: "review" },
  fixer: { agent: "build" },
}

const consensusJob: JobDef = job(
  [
    agentStep("agree", "judge", "compare", {
      outcomes: { approved: next, changes_requested: rerunJobs(["arch-a", "arch-b"], 3) },
    }),
  ],
  ["arch-a", "arch-b"],
  undefined,
  { decision: "{{ steps.agree.outputs.report }}" },
)

const base = workflow(
  {
    "arch-a": job(
      [agentStep("design", "architect", "design")],
      [],
      undefined,
      { design: "{{ steps.design.outputs.report }}" },
    ),
    "arch-b": job([agentStep("design", "architect", "design")]),
    consensus: consensusJob,
  },
  roles,
  "refs",
)

const validate = (def: WorkflowDef): readonly string[] => validateWorkflow(def).errors

function errorsIn(jobs: WorkflowDef["jobs"]): readonly string[] {
  return validateWorkflow({ ...base, jobs }).errors
}

describe("expression validation", () => {
  it("accepts the consensus workflow with legal references", () => {
    expect(validate(base)).toEqual([])
  })

  it("rejects a job output with a syntax error", () => {
    const def = workflow(
      { main: job([agentStep("a", "architect", "x")], [], undefined, { o: "{{ steps.a.outputs.report + }}" }) },
      roles,
    )
    expect(errorsIn(def.jobs).join("\n")).toContain('outputs["o"]')
  })

  it("rejects an unknown expression context in a prompt", () => {
    const def = workflow({ main: job([agentStep("a", "architect", "{{ feature }}")]) }, roles)
    expect(errorsIn(def.jobs).join("\n")).toContain('unknown context "feature"')
  })

  it("rejects a bare environment-style read", () => {
    const def = workflow({ main: job([agentStep("a", "architect", "{{ env.PATH }}")]) }, roles)
    expect(errorsIn(def.jobs).join("\n")).toContain('unknown context "env"')
  })

  it("rejects an unknown status function", () => {
    const def = workflow({ main: job([agentStep("a", "architect", "{{ eval() }}")]) }, roles)
    expect(errorsIn(def.jobs).join("\n")).toContain("eval")
  })

  it("rejects a type error in an expression", () => {
    const def = workflow({
      main: job([agentStep("a", "architect", "{{ 1 == 1 }}")]),
    })
    // boolean expression inside a prompt is fine; a number/boolean misuse is not
    const def2 = workflow({
      main: job([agentStep("a", "architect", "{{ 'x' && true }}")]),
    })
    expect(validateWorkflow({ ...def, jobs: def2.jobs }).errors.join("\n")).toContain(
      '"&&" expects boolean, got string',
    )
  })

  it("accepts status functions in step conditions", () => {
    const withIf = { ...base.jobs, always: job([commandStep("c", ["true"])], ["arch-a"], "always()") }
    expect(errorsIn(withIf)).toEqual([])
  })

  it("validates a job if condition over needs and inputs (accepted with an inert-condition warning)", () => {
    const good = {
      ...base.jobs,
      gated: job([commandStep("c", ["true"])], ["arch-a"], "needs['arch-a'].outputs.design == 'go'"),
    }
    const result = validateWorkflow({ ...base, jobs: good })
    expect(result.errors).toEqual([])
    expect(result.warnings.join("\n")).toContain('job "gated": if')
    const bad = {
      ...base.jobs,
      gated: job([commandStep("c", ["true"])], ["arch-a"], "needs['ghost'].outputs.x == 'go'"),
    }
    expect(errorsIn(bad).join("\n")).toContain('job "gated": if')
  })

  it("does not warn for the interpreted always()/failure() conditions", () => {
    const jobs = { ...base.jobs, cleanup: job([commandStep("c", ["true"])], ["arch-a"], "always()") }
    expect(validateWorkflow({ ...base, jobs }).warnings).toEqual([])
  })

  it("rejects a syntax error in a job if condition", () => {
    const jobs = { ...base.jobs, gated: job([commandStep("c", ["true"])], ["arch-a"], "always(") }
    expect(errorsIn(jobs).join("\n")).toContain('job "gated": if')
  })

  it("accepts a static string output with no references", () => {
    const def = workflow(
      { main: job([agentStep("a", "architect", "x")], [], undefined, { note: "static" }) },
      roles,
    )
    expect(errorsIn(def.jobs)).toEqual([])
  })

  it("validates templates in command run lines", () => {
    const jobs = { main: job([commandStep("c", ["echo {{ inputs.ghost }}"])]) }
    expect(errorsIn(jobs).join("\n")).toContain("run[0]")
  })

  it("validates templates in action with values", () => {
    const step = { ...actionStep("push", "git/push@v1"), with: { remote: "{{ inputs.ghost }}" } }
    const jobs = { main: job([step]) }
    expect(errorsIn(jobs).join("\n")).toContain('with["remote"]')
  })
})

describe("inputs.* reference validation", () => {
  const inputs: WorkflowDef["inputs"] = {
    feature: { type: "string", presence: "required" },
    "dry-run": { type: "boolean", presence: "optional", default: false },
    budget: { type: "number", presence: "optional", default: 3 },
  }

  it("accepts declared inputs of every type", () => {
    const def = workflow(
      { main: job([agentStep("a", "architect", "{{ inputs.feature }} {{ inputs['dry-run'] }}")]) },
      roles,
      "in",
      inputs,
    )
    expect(validate(def)).toEqual([])
  })

  it("rejects an undeclared input", () => {
    const def = workflow(
      { main: job([agentStep("a", "architect", "{{ inputs.ghost }}")]) },
      roles,
      "in",
      inputs,
    )
    expect(validate(def).join("\n")).toContain("inputs.ghost")
  })

  it("type-checks input references", () => {
    const def = workflow(
      { main: job([agentStep("a", "architect", "{{ inputs.feature < 3 }}")]) },
      roles,
      "in",
      inputs,
    )
    expect(validate(def).join("\n")).toContain('"<" expects number, got string')
    const ok = workflow(
      { main: job([agentStep("a", "architect", "{{ inputs.budget < 3 }}")]) },
      roles,
      "in",
      inputs,
    )
    expect(validate(ok)).toEqual([])
  })
})

describe("the docs' feature-delivery example (IR form)", () => {
  const deliveryRoles: WorkflowDef["roles"] = {
    architect: { agent: "build", model: "prov/architect" },
    judge: { agent: "review", model: "prov/judge" },
    implementer: { agent: "build", model: "prov/implementer" },
    quality: { agent: "review", model: "prov/quality" },
    reviewer: { agent: "review", model: "prov/reviewer" },
  }

  const architectPrompt = (self: string, other: string): string => [
    "Zaproponuj architekturę dla {{ inputs.feature }}.",
    `Twoja poprzednia propozycja: {{ feedback.jobs["${self}"]["design"]["report"] }}`,
    `Propozycja drugiego architekta: {{ feedback.jobs["${other}"]["design"]["report"] }}`,
    'Uwagi sędziego: {{ feedback.jobs["consensus"]["agree"]["report"] }}',
    "Powód zwrotki: {{ feedback.message }}",
  ].join("\n")

  const def = workflow(
    {
      "architect-a": job(
        [agentStep("design", "architect", architectPrompt("architect-a", "architect-b"))],
        [],
        undefined,
        { design: "{{ steps.design.outputs.report }}" },
      ),
      "architect-b": job(
        [agentStep("design", "architect", architectPrompt("architect-b", "architect-a"))],
        [],
        undefined,
        { design: "{{ steps.design.outputs.report }}" },
      ),
      consensus: job(
        [
          agentStep(
            "agree",
            "judge",
            'A: {{ needs["architect-a"].outputs.design }}\nB: {{ needs["architect-b"].outputs.design }}',
            {
              outcomes: {
                approved: next,
                changes_requested: rerunJobs(["architect-a", "architect-b"], 5),
              },
            },
          ),
        ],
        ["architect-a", "architect-b"],
        undefined,
        { decision: "{{ steps.agree.outputs.report }}" },
      ),
      deliver: job(
        [
          commandStep("worktree", ['name="feature-{{ inputs.feature }}"\ngit worktree add "../$name"']),
          agentStep(
            "openspec",
            "implementer",
            'Pracuj w {{ steps.worktree.outputs.path }}. Architektura: {{ needs["consensus"].outputs.decision }}',
          ),
          agentStep(
            "implement",
            "implementer",
            [
              "Zaimplementuj {{ inputs.feature }} według {{ steps.openspec.outputs.report }}.",
              'Poprzednia iteracja: {{ feedback.jobs["deliver"]["implement"]["report"] }}',
              'Uwagi quality: {{ feedback.jobs["deliver"]["quality"]["report"] }}',
              'Uwagi z PR: {{ feedback.jobs["deliver"]["pr-review"]["notes"] }}',
            ].join("\n"),
          ),
          agentStep("quality", "quality", "Build, testy, lint.", {
            outcomes: { approved: next, issues: rerunSteps(["implement"], 3) },
          }),
          agentStep("internal-review", "reviewer", "Zreviewuj diff.", {
            outcomes: { approved: next, changes_requested: rerunSteps(["implement", "quality"], 3) },
          }),
          actionStep("push", "git/push@v1"),
          humanStep("pr-review", {
            outcomes: {
              approved: next,
              rejected: rerunSteps(["implement", "quality", "internal-review"], 3),
            },
          }),
          actionStep("merge", "git/pr-merge@v1"),
        ],
        ["consensus"],
      ),
    },
    deliveryRoles,
    "feature-delivery",
    { feature: { type: "string", presence: "required" } },
  )

  it("validates cleanly end to end", () => {
    expect(validate(def)).toEqual([])
  })
})

describe("steps.* reference validation", () => {
  const def = workflow(
    {
      main: job([
        agentStep("first", "architect", "one"),
        agentStep("second", "architect", "two"),
      ]),
    },
    roles,
  )

  it("allows an earlier step's declared output", () => {
    const prompt = "{{ steps.first.outputs.report }}"
    const jobs = { main: job([agentStep("first", "architect", "one"), agentStep("second", "architect", prompt)]) }
    expect(errorsIn(jobs)).toEqual([])
  })

  it("rejects a later step reference", () => {
    const prompt = "{{ steps.second.outputs.report }}"
    const jobs = { main: job([agentStep("first", "architect", prompt), agentStep("second", "architect", "two")]) }
    expect(errorsIn(jobs).join("\n")).toContain("steps.second.outputs.report")
  })

  it("rejects an unknown step", () => {
    const jobs = { main: job([agentStep("first", "architect", "{{ steps.ghost.outputs.report }}")]) }
    expect(errorsIn(jobs).join("\n")).toContain("steps.ghost.outputs.report")
  })

  it("rejects a misspelled agent output name", () => {
    const jobs = { main: job([agentStep("first", "architect", "{{ steps.first.outputs.reprot }}")]) }
    expect(errorsIn(jobs).join("\n")).toContain("steps.first.outputs.reprot")
  })

  it("accepts any output name on a command step", () => {
    const jobs = {
      main: job([commandStep("gate", ["true"]), agentStep("next", "architect", "{{ steps.gate.outputs.branch }}")]),
    }
    expect(errorsIn(jobs)).toEqual([])
  })

  it("rejects a reference into a non-output field", () => {
    const jobs = { main: job([agentStep("first", "architect", "{{ steps.first.report }}")]) }
    expect(errorsIn(jobs).join("\n")).toContain("steps.first.report")
  })
})

describe("needs.* reference validation", () => {
  it("rejects a dependency not listed in needs", () => {
    const jobs = {
      "arch-a": base.jobs["arch-a"],
      consensus: job([agentStep("agree", "judge", "{{ needs['arch-a'].outputs.design }}")]),
    }
    expect(errorsIn(jobs).join("\n")).toContain("needs.arch-a.outputs.design")
  })

  it("rejects an undeclared job output", () => {
    const jobs = {
      "arch-a": base.jobs["arch-a"],
      consensus: job(
        [agentStep("agree", "judge", "{{ needs['arch-a'].outputs.branch }}")],
        ["arch-a"],
      ),
    }
    expect(errorsIn(jobs).join("\n")).toContain("needs.arch-a.outputs.branch")
  })

  it("accepts a declared job output of a listed dependency", () => {
    const jobs = {
      "arch-a": base.jobs["arch-a"],
      consensus: job(
        [agentStep("agree", "judge", "{{ needs['arch-a'].outputs.design }}")],
        ["arch-a"],
      ),
    }
    expect(errorsIn(jobs)).toEqual([])
  })
})

describe("feedback.* reference validation", () => {
  it("accepts feedback reads inside a rerun target job", () => {
    const prompt = [
      "{{ feedback.jobs['arch-a']['design']['report'] }}",
      "{{ feedback.jobs['consensus']['agree']['report'] }}",
    ].join(" ")
    const jobs = {
      "arch-a": job([agentStep("design", "architect", prompt)]),
      "arch-b": job([agentStep("design", "architect", "design")]),
      consensus: consensusJob,
    }
    expect(errorsIn(jobs)).toEqual([])
  })

  it("rejects feedback reads in a job outside any rerun", () => {
    const jobs = {
      "arch-a": job([agentStep("design", "architect", "design")]),
      outside: job([agentStep("o", "architect", "{{ feedback.jobs['arch-a']['design']['report'] }}")], ["arch-a"]),
    }
    expect(errorsIn(jobs).join("\n")).toContain("feedback.jobs")
  })

  it("rejects a job that is not a rerun target or routing job", () => {
    const prompt = "{{ feedback.jobs['ghost']['design']['report'] }}"
    const jobs = {
      "arch-a": job([agentStep("design", "architect", prompt)]),
      "arch-b": job([agentStep("design", "architect", "design")]),
      consensus: consensusJob,
    }
    expect(errorsIn(jobs).join("\n")).toContain("feedback.jobs")
  })

  it("rejects a wrong step in the routing job", () => {
    const prompt = "{{ feedback.jobs['consensus']['other']['report'] }}"
    const jobs = {
      "arch-a": job([agentStep("design", "architect", prompt)]),
      "arch-b": job([agentStep("design", "architect", "design")]),
      consensus: consensusJob,
    }
    expect(errorsIn(jobs).join("\n")).toContain("feedback.jobs")
  })

  it("accepts feedback.message and rejects its extension", () => {
    const ok = { "arch-a": job([agentStep("design", "architect", "{{ feedback.message }}")]) }
    expect(errorsIn({ ...base.jobs, ...ok })).toEqual([])
    const bad = { "arch-a": job([agentStep("design", "architect", "{{ feedback.message.extra }}")]) }
    expect(errorsIn({ ...base.jobs, ...bad }).join("\n")).toContain("feedback.message")
  })

  it("rejects a feedback read with no output name", () => {
    const prompt = "{{ feedback.jobs['arch-a']['design'] }}"
    const jobs = {
      "arch-a": job([agentStep("design", "architect", prompt)]),
      "arch-b": job([agentStep("design", "architect", "design")]),
      consensus: consensusJob,
    }
    expect(errorsIn(jobs).join("\n")).toContain("feedback.jobs")
  })

  it("allows step-scope rerun feedback within the routing job", () => {
    const jobs = {
      main: job([
        agentStep("implement", "fixer", "implement"),
        agentStep("review", "judge", "{{ feedback.jobs['main']['implement']['report'] }}", {
          outcomes: { approved: next, changes_requested: rerunSteps(["implement"], 3) },
        }),
      ]),
    }
    expect(errorsIn(jobs)).toEqual([])
  })
})

describe("job outputs reference validation", () => {
  it("rejects a job output referencing an unknown step", () => {
    const jobs = {
      main: job(
        [agentStep("a", "architect", "x")],
        [],
        undefined,
        { o: "{{ steps.ghost.outputs.report }}" },
      ),
    }
    expect(errorsIn(jobs).join("\n")).toContain('outputs["o"]')
  })

  it("accepts a job output referencing its own steps or inputs", () => {
    const def = workflow(
      {
        main: job(
          [agentStep("a", "architect", "x")],
          [],
          undefined,
          { o: "{{ steps.a.outputs.report }}" },
        ),
      },
      roles,
    )
    expect(validate(def)).toEqual([])
  })

  it("rejects a job output reading needs — job outputs are job-local", () => {
    const jobs = {
      "arch-a": base.jobs["arch-a"],
      consensus: job(
        [agentStep("agree", "judge", "x")],
        ["arch-a"],
        undefined,
        { o: "{{ needs['arch-a'].outputs.design }}" },
      ),
    }
    expect(errorsIn(jobs).join("\n")).toContain('outputs["o"]')
  })

  it("rejects a job output reading feedback — resolveJobOutputs has no snapshot", () => {
    const jobs = {
      "arch-a": job(
        [agentStep("design", "architect", "design")],
        [],
        undefined,
        { reason: "{{ feedback.message }}" },
      ),
      "arch-b": job([agentStep("design", "architect", "design")]),
      consensus: consensusJob,
    }
    expect(errorsIn(jobs).join("\n")).toContain('outputs["reason"]')
  })
})
