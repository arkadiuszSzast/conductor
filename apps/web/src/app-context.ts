import { createContext, useContext } from "react"
import type { ApiClient } from "./api/client.ts"
import type { DataSource } from "./api/store.ts"
import type { AuthSession } from "./auth/auth-store.ts"

export interface AppServices {
  readonly session: AuthSession
  readonly client: ApiClient
  readonly store: DataSource
}

export const AppContext = createContext<AppServices | null>(null)

export function useApp(): AppServices {
  const ctx = useContext(AppContext)
  if (ctx === null) throw new Error("AppContext missing")
  return ctx
}
