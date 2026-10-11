import { expect, test } from "bun:test"
import { assembleDaemonConfig } from "./src/daemon-config.ts"

const base = { databasePath: "/tmp/synthetic.db", projects: [], bind: { host: "127.0.0.1", port: 4400 }, auth: { mode: "bearer", token: "synthetic" } }
const profile = {
  baseUrl: "http://127.0.0.1:4096/",
  passwordFile: "/etc/conductor/opencode.password",
  allowedRoots: ["/repo"],
  maxConcurrent: 2,
  deadlines: { startupMs: 10_000 },
  bindings: { build: { model: "omni/claude/x", variant: "medium" }, review: { variant: "low" } },
}
const runners = (p: Record<string, unknown> = profile, extra: Record<string, unknown> = {}) =>
  ({ default: "native", projects: { "/repo": "v2" }, acp: {}, opencode: { v2: p }, ...extra })
const load = (r: unknown) => assembleDaemonConfig({ ...base, runners: r }).daemon.runners

test("parses an opencode profile without requiring a report bridge", () => {
  const parsed = load(runners())
  expect(parsed?.projects).toEqual({ "/repo": "v2" })
  expect(parsed?.reportBridge).toBeUndefined()
  expect(parsed?.opencode?.v2).toEqual({
    baseUrl: "http://127.0.0.1:4096",
    passwordFile: "/etc/conductor/opencode.password",
    allowedRoots: ["/repo"],
    maxConcurrent: 2,
    deadlines: { startupMs: 10_000 },
    bindings: { build: { model: "omni/claude/x", variant: "medium" }, review: { variant: "low" } },
  })
})

test("rejects inline secrets and ambiguous password sources", () => {
  expect(() => load(runners({ ...profile, password: "x" }))).toThrow("inline secret")
  expect(() => load(runners({ ...profile, passwordEnv: "PW" }))).toThrow("exactly one")
  const { passwordFile: _ignored, ...none } = profile
  expect(() => load(runners(none))).toThrow("exactly one")
  expect(() => load(runners({ ...profile, baseUrl: "http://u:p@host" }))).toThrow("without credentials")
})

test("validates roots, concurrency, deadlines and bindings", () => {
  expect(() => load(runners({ ...profile, allowedRoots: [] }))).toThrow("must not be empty")
  expect(() => load(runners({ ...profile, allowedRoots: ["relative"] }))).toThrow("absolute")
  expect(() => load(runners({ ...profile, maxConcurrent: 0 }))).toThrow("positive integer")
  expect(() => load(runners({ ...profile, deadlines: { turnMs: 1 } }))).toThrow("turnMs")
  expect(() => load(runners({ ...profile, bindings: { build: { model: "nomodel" } } }))).toThrow("provider/id")
  expect(() => load(runners({ ...profile, bindings: { build: { mode: "x" } } }))).toThrow("mode")
})

test("profile ids are unique across transports and projects must reference one", () => {
  const acp = { v2: { command: process.execPath, args: [], allowedRoots: ["/repo"], maxConcurrent: 1, bindings: {}, permissions: { allowKinds: [] } } }
  expect(() => load(runners(profile, { acp, reportBridge: { command: process.execPath, args: [] } }))).toThrow("reuses ACP profile id")
  expect(() => load(runners(profile, { projects: { "/repo": "ghost" } }))).toThrow("unknown profile")
  expect(() => load({ default: "native", projects: {}, acp: { a: acp.v2 } })).toThrow("reportBridge")
})
