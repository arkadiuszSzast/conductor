import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { buildEvalContext, parseWorkflow, renderTemplate, validateWorkflow } from "@conductor/core"
import type { FeatureState, JobRuntime } from "@conductor/core"
import { loadActionRegistry } from "../packages/server/src/action-registry.ts"
import { checkWorkflowReservation } from "../packages/server/src/workflow-reservation.ts"

const path = process.argv[2]
assert(path, "Usage: bun scripts/validate-operator-workflow.ts <operator/conductor.yaml>")
const parsed = parseWorkflow(await readFile(resolve(path), "utf8"))
assert(parsed.ok, JSON.stringify(parsed))
const workflow = parsed.workflow
assert.deepEqual(validateWorkflow(workflow).errors, [])
const loaded = await loadActionRegistry({ baseDir: resolve(import.meta.dir, ".."), bundledPath: "packages/server/actions" })
assert(loaded.ok, JSON.stringify(loaded))
const reservation = checkWorkflowReservation(workflow, loaded.value)
assert(reservation.ok, JSON.stringify(reservation))
const waits = Object.entries(workflow.jobs).flatMap(([jobId, job]) =>
  job.steps.filter(step => step.type === "action" && step.uses === "github/await-checks@v1").map(step => ({ jobId, step })))
assert.equal(waits.length, 1)
const wait = waits[0]!
assert.equal(wait.jobId, "post_pr")
assert(wait.step.type === "action")
assert.deepEqual(wait.step.with.required_checks, ["PR Gate"])
assert.equal(wait.step.with.expected_sha, "{{ steps.fix_push.outputs.sha }}")
assert.deepEqual(wait.step.onFail, { kind: "rerun", target: { scope: "steps", stepIds: ["fix", "fix_push", "await_checks"], maxRounds: 3 } })
const postPr = workflow.jobs.post_pr!
assert.deepEqual(postPr.steps.map(step => step.id), ["fix", "fix_push", "await_checks"])
for (const [jobId, stepId] of [["ship", "push"], ["post_pr", "fix_push"]]) {
  const step = workflow.jobs[jobId!]!.steps.find(step => step.id === stepId)
  assert(step?.type === "action" && step.uses === "git/push@v1")
  assert.equal(step.with.branch, "{{ needs.prepare.outputs.branch }}")
  assert(workflow.jobs[jobId!]!.needs.includes("prepare"))
}

const initialSha = "a".repeat(40)
const repairedSha = "b".repeat(40)
const runtime = (outputs: JobRuntime["outputs"], steps: JobRuntime["steps"] = {}): JobRuntime => ({
  status: "running", currentStep: null, attempts: {}, reruns: {}, outputs, steps,
})
const fixture = (sha?: string): FeatureState => ({
  id: "fixture", title: "fixture", slug: "fixture", projectDir: "/fixture", workflow: null,
  description: null, status: "running", trigger: null, input: {}, sessionId: null,
  worktree: null, branch: null, pr: 123,
  jobs: {
    prepare: runtime({ path: "/fixture", branch: "feature/fixture", task: "fixture", change: "fixture" }),
    consensus: runtime({ decision: "approved" }),
    ship: runtime({ pr_number: "123", pr_url: "fixture-pr" }, { push: { status: "succeeded", outputs: { sha: initialSha } } }),
    post_pr: runtime({}, sha ? { fix_push: { status: "succeeded", outputs: { sha } } } : {}),
    impl: runtime({}),
  },
})
for (const [round, sha] of [["initial", initialSha], ["rerun", repairedSha]]) {
  const context = buildEvalContext(workflow, fixture(sha), "post_pr")
  assert.deepEqual(renderTemplate(String(wait.step.with.expected_sha), context), { text: sha!, errors: [] })
  assert.deepEqual(renderTemplate(String(wait.step.with.pr), context), { text: "123", errors: [] })
  console.log(`${round}: expected_sha=${sha}`)
}
assert(renderTemplate(String(wait.step.with.expected_sha), buildEvalContext(workflow, fixture(), "post_pr")).errors.length > 0)
const implement = workflow.jobs.impl!.steps.find(step => step.id === "implement")
assert(implement?.type === "agent")
assert.equal(implement.fixFrom, "review_gate/gate")
assert.equal(implement.qualityFrom, "impl/quality")
assert(implement.fixPrompt)
assert(!implement.prompt.includes("feedback."))
assert(!implement.fixPrompt.includes("feedback."))
const gate = workflow.jobs.review_gate!.steps.find(step => step.id === "gate")
assert(gate?.type === "agent")
assert.equal(gate.reviewHead, "{{ steps.capture_review.outputs.head }}")
assert(gate.prompt.includes("conductor_report"))
assert(gate.prompt.includes("acceptanceTests"))
assert.deepEqual(renderTemplate(implement.fixPrompt, buildEvalContext(workflow, fixture(), "impl")).errors, [])
assert.deepEqual(renderTemplate(implement.prompt, buildEvalContext(workflow, fixture(), "impl")).errors, [])
console.log("Source workflow, action manifests, SHA scopes and persisted diagnostic fixture validated; no actions executed.")
