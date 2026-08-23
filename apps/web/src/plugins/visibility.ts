/**
 * Rail visibility — pure filter over a plugin listing (plugin-panels
 * spec: "global plugins are always candidates; project plugins appear
 * only when the UI's active scope is their owning project").
 *
 * Filtered defensively on the client even though the request already
 * asks the daemon to scope by `?project=`: the registry's own
 * `listPlugins(undefined)` returns every discovered plugin (not just
 * global ones) when no project is supplied, so a request made before the
 * active project is known must never let another project's plugin leak
 * into the rail.
 */

import type { PluginListingItem } from "../api/types.ts"

export function visiblePlugins(plugins: readonly PluginListingItem[], activeProject: string | null): readonly PluginListingItem[] {
  return plugins.filter(plugin => {
    if (plugin.scope === "global") return true
    return activeProject !== null && plugin.project === activeProject
  })
}
