/**
 * Dependency readiness for the panel — pure, DOM-free, so it is unit
 * tested (deps.test.ts) and loaded as a classic script by index.html.
 *
 * A dependency counts as satisfied once it is merged: archived in the
 * checkout (`openspec/changes/archive/<date>-<name>`) or a `merged` queue
 * entry. The daemon's scheduler checks the remote default branch, so the
 * panel can only lag behind it until the checkout is fast-forwarded —
 * never claim a dependency is satisfied that the scheduler would not.
 */
;(function (root) {
  "use strict"

  const ARCHIVE_NAME = /^\d{4}-\d{2}-\d{2}-(.+)$/
  const IN_PROGRESS = ["starting", "running"]
  const STUCK = ["escalated", "blocked", "invalid"]

  function archivedName(entry) {
    const match = ARCHIVE_NAME.exec(entry)
    return match ? match[1] : entry
  }

  /**
   * @param {string} dep
   * @param {{ archived: string[], active: {name: string}[], queueEntries: {change: string, status: string}[] }} context
   * @returns {{ name: string, state: "merged"|"in_progress"|"stuck"|"queued"|"pending"|"unknown", label: string }}
   */
  function dependencyState(dep, context) {
    const archived = new Set((context.archived || []).map(archivedName))
    const entries = (context.queueEntries || []).filter(entry => entry.change === dep)
    if (archived.has(dep) || entries.some(entry => entry.status === "merged")) {
      return { name: dep, state: "merged", label: "merged" }
    }
    const live = entries.find(entry => entry.status !== "merged")
    if (live && IN_PROGRESS.includes(live.status)) return { name: dep, state: "in_progress", label: "in progress" }
    if (live && STUCK.includes(live.status)) return { name: dep, state: "stuck", label: live.status }
    if (live) return { name: dep, state: "queued", label: "queued" }
    if ((context.active || []).some(change => change.name === dep)) {
      return { name: dep, state: "pending", label: "not started" }
    }
    return { name: dep, state: "unknown", label: "unknown change" }
  }

  /**
   * Readiness of one change from its declared dependencies.
   * `ready`: every dependency merged (or none declared) — safe to pick up.
   * `waiting`: nothing stuck, only work still in flight or queued.
   * `blocked`: at least one dependency is stuck, not started or unknown.
   */
  function changeReadiness(change, context) {
    const deps = Array.isArray(change.dependsOn) ? change.dependsOn : []
    const states = deps.map(dep => dependencyState(dep, context))
    const open = states.filter(dep => dep.state !== "merged")
    let readiness = "ready"
    if (open.some(dep => dep.state === "stuck" || dep.state === "pending" || dep.state === "unknown")) readiness = "blocked"
    else if (open.length > 0) readiness = "waiting"
    const summary = deps.length === 0
      ? "Ready — no dependencies"
      : open.length === 0
        ? "Ready — all " + deps.length + " dependencies merged"
        : (readiness === "blocked" ? "Blocked" : "Waiting") + " — " + (deps.length - open.length) + "/" + deps.length + " dependencies merged"
    return { readiness, summary, dependencies: states }
  }

  const api = { dependencyState, changeReadiness }
  if (typeof module !== "undefined" && module.exports) module.exports = api
  else root.OpenSpecDeps = api
})(typeof window !== "undefined" ? window : globalThis)
