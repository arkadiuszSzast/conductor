/**
 * Panel bridge — versioned `postMessage` protocol between the Control
 * Room shell and a plugin panel iframe (plugin-panels spec, design D5).
 *
 * Every message is wrapped in `{ conductor: true, v: 1, type, payload }`;
 * the `conductor` discriminator avoids colliding with unrelated
 * `postMessage` traffic (browser extensions, devtools) sharing the same
 * window. Panel→host: `ready`, `navigate`, `refresh`. Host→panel:
 * `context` (sent once per `ready`), `context-changed` (pushed on scope
 * change while the panel is open). Any envelope with the wrong
 * discriminator, an unsupported version, or a shape that doesn't match
 * its declared `type` is dropped silently by both sides — never thrown,
 * never surfaced to the plugin as an error.
 *
 * The token NEVER appears in a bridge message: `BridgeContextPayload`
 * carries only `project`/`selection`/`theme`, and every panel-originated
 * network call is expected to hit the plugin's own proxied backend
 * routes, which authenticate server-side with the daemon's token — never
 * through the browser bridge.
 */

import { useEffect, useRef } from "react"

export const BRIDGE_VERSION = 1 as const

export interface BridgeContextPayload {
  readonly project: string | null
  readonly selection: { readonly feature: string | null }
  readonly theme: { readonly mode: "dark" }
}

export type HostToPanelMessage =
  | { readonly type: "context"; readonly payload: BridgeContextPayload }
  | { readonly type: "context-changed"; readonly payload: BridgeContextPayload }

export type PanelToHostMessage =
  | { readonly type: "ready"; readonly payload: { readonly v: number } }
  | { readonly type: "navigate"; readonly payload: { readonly to: { readonly feature?: string } } }
  | { readonly type: "refresh"; readonly payload: Record<string, never> }

interface BridgeEnvelope {
  readonly conductor: true
  readonly v: typeof BRIDGE_VERSION
  readonly type: string
  readonly payload: unknown
}

export function encodeHostMessage(message: HostToPanelMessage): BridgeEnvelope {
  return { conductor: true, v: BRIDGE_VERSION, type: message.type, payload: message.payload }
}

/** Validates and narrows an arbitrary `MessageEvent.data` into a
 *  panel-originated message. Returns null for anything that isn't the
 *  bridge's envelope, isn't version 1, or has a shape that doesn't match
 *  its declared `type` — the caller drops it silently. */
export function parsePanelMessage(data: unknown): PanelToHostMessage | null {
  if (typeof data !== "object" || data === null) return null
  const envelope = data as Partial<BridgeEnvelope>
  if (envelope.conductor !== true) return null
  if (envelope.v !== BRIDGE_VERSION) return null
  if (typeof envelope.type !== "string") return null
  const payload = envelope.payload

  if (envelope.type === "ready") {
    if (typeof payload !== "object" || payload === null) return null
    const v = (payload as { v?: unknown }).v
    if (typeof v !== "number") return null
    return { type: "ready", payload: { v } }
  }
  if (envelope.type === "navigate") {
    if (typeof payload !== "object" || payload === null) return null
    const to = (payload as { to?: unknown }).to
    if (typeof to !== "object" || to === null) return null
    const feature = (to as { feature?: unknown }).feature
    if (feature !== undefined && typeof feature !== "string") return null
    return { type: "navigate", payload: { to: feature !== undefined ? { feature } : {} } }
  }
  if (envelope.type === "refresh") {
    return { type: "refresh", payload: {} }
  }
  return null
}

export interface UsePluginBridgeInput {
  readonly iframeRef: React.RefObject<HTMLIFrameElement | null>
  readonly context: BridgeContextPayload
  readonly onNavigateToFeature: (featureId: string) => void
  readonly onRefresh: () => void
}

/**
 * Wires the host side of the bridge to one panel iframe: validates
 * inbound messages (origin AND source, both required — an iframe pointed
 * at the same origin as an unrelated same-origin frame must never be
 * mistaken for this panel), answers `ready` with `context`, forwards
 * `navigate`/`refresh` to the caller, and pushes `context-changed`
 * whenever `context` changes while the panel has already completed its
 * handshake.
 */
export function usePluginBridge(input: UsePluginBridgeInput): void {
  const { iframeRef, context, onNavigateToFeature, onRefresh } = input
  const readyRef = useRef(false)
  const contextRef = useRef(context)
  contextRef.current = context

  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      if (event.origin !== window.location.origin) return
      const panelWindow = iframeRef.current?.contentWindow
      if (panelWindow === null || panelWindow === undefined || event.source !== panelWindow) return
      const message = parsePanelMessage(event.data)
      if (message === null) return

      if (message.type === "ready") {
        readyRef.current = true
        panelWindow.postMessage(encodeHostMessage({ type: "context", payload: contextRef.current }), window.location.origin)
        return
      }
      if (message.type === "navigate") {
        const featureId = message.payload.to.feature
        if (featureId !== undefined) onNavigateToFeature(featureId)
        return
      }
      if (message.type === "refresh") {
        onRefresh()
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [iframeRef, onNavigateToFeature, onRefresh])

  useEffect(() => {
    if (!readyRef.current) return
    const panelWindow = iframeRef.current?.contentWindow
    if (panelWindow === null || panelWindow === undefined) return
    panelWindow.postMessage(encodeHostMessage({ type: "context-changed", payload: context }), window.location.origin)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.project, context.selection.feature, context.theme.mode])
}
