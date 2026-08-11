/**
 * Minimal toast store — enough for gate/error surfacing without a UI lib.
 * Rendered by `<Toasts>` in `ui/toasts.tsx`; driven from pure error
 * handlers like `mapGateError`.
 */

export interface Toast {
  readonly id: number
  readonly message: string
  readonly kind: "info" | "error"
}

let toasts: Toast[] = []
let nextId = 1
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getToasts(): readonly Toast[] {
  return toasts
}

export function pushToast(message: string, kind: "info" | "error" = "error"): number {
  const id = nextId++
  toasts = [...toasts, { id, message, kind }]
  notify()
  globalThis.setTimeout(() => dismissToast(id), 6_000)
  return id
}

export function dismissToast(id: number): void {
  toasts = toasts.filter(toast => toast.id !== id)
  notify()
}
