import { useSyncExternalStore } from "react"
import type { AuthSession, AuthStatus } from "./auth-store.ts"

export function useAuthStatus(session: AuthSession): AuthStatus {
  return useSyncExternalStore(
    listener => session.subscribe(listener),
    () => session.status,
    () => session.status,
  )
}
