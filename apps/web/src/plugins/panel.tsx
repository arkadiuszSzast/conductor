/**
 * Plugin panel body — sandboxed same-origin iframe on the plugin's
 * proxied UI route, or an inline diagnostic when the plugin is broken
 * (plugin-panels spec: "Broken plugin shows a diagnostic panel").
 *
 * `<iframe onError>` never fires for an HTTP-level failure (404/503 from
 * a down backend still "loads" successfully as far as the iframe's own
 * navigation is concerned — only a network-level failure like DNS/CORS
 * would fire it, neither of which applies to a same-origin proxied
 * route) — so before rendering the iframe at all, a same-origin
 * `fetch` probes the exact UI route the iframe would load and only
 * renders it once that probe answers `ok`; a non-OK response renders
 * the inline error state with retry instead of a broken frame, matching
 * the diagnostic panel already shown for `plugin.state === "error"`.
 */

import { useEffect, useRef, useState } from "react"
import { usePluginBridge, type BridgeContextPayload } from "./bridge.ts"
import { useApp } from "../app-context.ts"
import type { PluginListingItem } from "../api/types.ts"
import styles from "./panel.module.css"

export interface PluginPanelProps {
  readonly plugin: PluginListingItem
  readonly context: BridgeContextPayload
  readonly onNavigateToFeature: (featureId: string) => void
  readonly onRetry: () => void
}

function uiSrcFor(pluginId: string, project: string | null): string {
  const base = `/v1/plugins/${encodeURIComponent(pluginId)}/ui/`
  return project !== null ? `${base}?project=${encodeURIComponent(project)}` : base
}

export function PluginPanel({ plugin, context, onNavigateToFeature, onRetry }: PluginPanelProps): React.ReactNode {
  const { client } = useApp()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  // `null` = probing in flight, `true`/`false` = settled — kept separate
  // from `loadFailed` so a probe success doesn't have to fabricate a
  // "not failed" value, and a retry can cleanly re-enter the probing
  // state rather than assume the previous outcome.
  const [probeOk, setProbeOk] = useState<boolean | null>(null)
  const src = uiSrcFor(plugin.id, context.project)

  usePluginBridge({
    iframeRef,
    context,
    onNavigateToFeature,
    onRefresh: onRetry,
  })

  useEffect(() => {
    let cancelled = false
    setProbeOk(null)
    client.probePluginUi(src).then(ok => {
      if (!cancelled) setProbeOk(ok)
    })
    return () => {
      cancelled = true
    }
    // Re-probes whenever the plugin, project, or a retry click changes
    // which route the iframe is about to load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, plugin.id])

  const retry = (): void => {
    setLoadFailed(false)
    onRetry()
  }

  if (plugin.state === "error" || loadFailed || probeOk === false) {
    const diagnostic = plugin.diagnostics[0]
    return (
      <div className={styles.diagnostic}>
        <p>this plugin isn't running.</p>
        {diagnostic !== undefined ? <p className={styles.diagnosticMessage}>{diagnostic.message}</p> : null}
        <button type="button" onClick={retry}>
          retry
        </button>
      </div>
    )
  }

  if (probeOk === null) return null

  return (
    <iframe
      ref={iframeRef}
      key={plugin.id}
      className={styles.frame}
      src={src}
      sandbox="allow-scripts allow-same-origin allow-forms"
      title={plugin.panel.title}
      onError={() => setLoadFailed(true)}
    />
  )
}
