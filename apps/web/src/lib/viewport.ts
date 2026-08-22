/**
 * Media-query hooks — the only place breakpoint logic lives. The mobile
 * board/workspace layouts branch in JS (stage selector, fullscreen graph)
 * rather than purely in CSS, so components need a live match instead of
 * a one-shot read.
 */

import { useEffect, useState } from "react"

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof globalThis.matchMedia === "function" ? globalThis.matchMedia(query).matches : false))
  useEffect(() => {
    if (typeof globalThis.matchMedia !== "function") return
    const mql = globalThis.matchMedia(query)
    const listener = (e: MediaQueryListEvent): void => setMatches(e.matches)
    setMatches(mql.matches)
    mql.addEventListener("change", listener)
    return () => mql.removeEventListener("change", listener)
  }, [query])
  return matches
}

/** True at and below the mobile breakpoint (~768 CSS px). */
export function useIsNarrowViewport(breakpointPx = 768): boolean {
  return useMediaQuery(`(max-width: ${breakpointPx - 1}px)`)
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)")
}
