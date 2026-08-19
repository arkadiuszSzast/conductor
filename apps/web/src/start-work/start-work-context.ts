/**
 * Shell-owned "open the start-work sheet" trigger — the shell (`app.tsx`)
 * owns whether the sheet is open; the top bar and board empty states only
 * need one callback to trigger it, not the sheet's own open/close state
 * (design.md "The authenticated shell owns whether the form is open and
 * passes one trigger callback").
 */

import { createContext, useContext } from "react"

export const StartWorkContext = createContext<(() => void) | null>(null)

export function useStartWork(): () => void {
  const trigger = useContext(StartWorkContext)
  if (trigger === null) throw new Error("StartWorkContext missing")
  return trigger
}
