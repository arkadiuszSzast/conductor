/**
 * `run-auth.ts` — hashed attempt-credential issue/verify/revoke
 * (design.md D8, task 4.1). Owns the ONE authority that decides whether
 * a presented worker token authorizes access to a specific run's
 * attempt: no admin token, no auth:none bypass, no cross-run access ever
 * flows through this module.
 *
 * A plaintext token is generated ONCE at issuance and handed to the
 * caller (who injects it into the spawned worker's environment); only
 * its SHA-256 hash is ever persisted (`RunnerSafetyStore.issueCredential`)
 * or compared against. There is no reverse lookup from hash to
 * plaintext, by construction — `verifyRunCredential` re-hashes the
 * PRESENTED token and looks up by hash, never the other way around.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import type { RunCredentialRecord, RunnerSafetyStore } from "./runner-execution.ts"

/** 256-bit random token, hex-encoded (D8: "Generate a random 256-bit
 *  token per attempt"). */
export function generateRunToken(): string {
  return randomBytes(32).toString("hex")
}

export function hashRunToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

export interface IssuedRunCredential {
  /** The ONE time this plaintext value exists — the caller must inject
   *  it into the worker's environment immediately and never log it. */
  readonly token: string
  readonly record: RunCredentialRecord
}

/** Issues a fresh credential for one attempt. Called BEFORE `session/new`
 *  (D8: "Generate a random 256-bit token per attempt before session/new;
 *  store hash before injection"). */
export function issueRunCredential(
  store: RunnerSafetyStore,
  input: { readonly runId: string; readonly attempt: number; readonly processGeneration: number; readonly nowMs: number; readonly expiresAt?: number },
): IssuedRunCredential {
  const token = generateRunToken()
  const record = store.issueCredential({
    runId: input.runId,
    attempt: input.attempt,
    processGeneration: input.processGeneration,
    tokenHash: hashRunToken(token),
    issuedAt: input.nowMs,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  })
  return { token, record }
}

export type VerifyRunCredentialResult =
  | { readonly ok: true; readonly credential: RunCredentialRecord }
  /** A revoked credential due to NORMAL conclusion authorizes exactly
   *  ONE thing: the stable `run_already_concluded` rejection for a
   *  duplicate report (D8) — never a state mutation/read. Distinguished
   *  from every other rejection reason so the caller can implement that
   *  narrow allowance without granting anything else. */
  | { readonly ok: false; readonly reason: "missing" | "expired" | "revoked" | "malformed" }
  | { readonly ok: false; readonly reason: "revoked_concluded"; readonly credential: RunCredentialRecord }

/**
 * Verifies a presented plaintext token against the store, by hash only.
 * `nowMs` is required (no ambient clock) so tests are deterministic.
 * Rechecked at MUTATION commit time by callers, not just before parsing
 * the request body (D8: "Token race checks are revalidated at mutation
 * commit, not merely before awaiting body parsing") — this function is
 * the fast preflight; a report/ask mutation must call it again (or an
 * equivalent store-level guard) inside its own commit.
 */
export function verifyRunCredential(
  store: RunnerSafetyStore,
  token: string,
  nowMs: number,
  options: { readonly revocationReasonForConcluded?: string } = {},
): VerifyRunCredentialResult {
  if (typeof token !== "string" || token.trim() === "") return { ok: false, reason: "malformed" }
  const credential = store.findCredentialByHash(hashRunToken(token))
  if (!credential) return { ok: false, reason: "missing" }
  if (credential.expiresAt !== null && credential.expiresAt <= nowMs) return { ok: false, reason: "expired" }
  if (credential.revokedAt !== null) {
    const reason = options.revocationReasonForConcluded ?? "run_concluded"
    if (credential.revocationReason === reason) return { ok: false, reason: "revoked_concluded", credential }
    return { ok: false, reason: "revoked" }
  }
  return { ok: true, credential }
}

/** Constant-time comparison helper for any secondary in-band token
 *  comparison a caller might need (e.g. comparing an optional
 *  compatibility run_id field) — exported so `run-reporting.ts`/`api.ts`
 *  never hand-roll a `===` comparison on secret material. */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8")
  const bufferB = Buffer.from(b, "utf8")
  if (bufferA.length !== bufferB.length) return false
  return timingSafeEqual(bufferA, bufferB)
}

/** Extracts a bearer-style token from an Authorization header value —
 *  shared parsing so `run-reporting.ts`'s HTTP routes and any future
 *  transport agree on the exact same "Bearer " prefix contract the
 *  admin API already uses (api.ts's own `bearerAuthorized`). */
export function extractBearerToken(header: string | null): string | null {
  if (header === null || !header.startsWith("Bearer ")) return null
  const token = header.slice("Bearer ".length)
  return token.trim() === "" ? null : token
}
