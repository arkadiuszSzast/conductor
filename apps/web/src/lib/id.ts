interface RandomSource {
  readonly randomUUID?: () => string
  readonly getRandomValues?: (bytes: Uint8Array) => Uint8Array
}

export function createIdempotencyKey(source: RandomSource | null = globalThis.crypto): string {
  if (typeof source?.randomUUID === "function") return source.randomUUID()

  if (typeof source?.getRandomValues !== "function") {
    return `recover-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  }

  const bytes = source.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
