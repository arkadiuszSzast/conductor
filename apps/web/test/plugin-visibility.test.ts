/**
 * Rail visibility filter — pure, DOM-free (plugin-panels spec: "Project
 * plugin tab appears only in its project").
 */
import { describe, expect, it } from "bun:test"
import { visiblePlugins } from "../src/plugins/visibility.ts"
import type { PluginListingItem } from "../src/api/types.ts"

function plugin(overrides: Partial<PluginListingItem>): PluginListingItem {
  return {
    id: "p",
    scope: "global",
    panel: { title: "P" },
    state: "running",
    diagnostics: [],
    ...overrides,
  }
}

describe("visiblePlugins", () => {
  it("always includes global plugins regardless of active project", () => {
    const global = plugin({ id: "global-one", scope: "global" })
    expect(visiblePlugins([global], null)).toEqual([global])
    expect(visiblePlugins([global], "/proj/a")).toEqual([global])
  })

  it("includes a project plugin only when the active project matches", () => {
    const projectPlugin = plugin({ id: "openspec", scope: "project", project: "/proj/a" })
    expect(visiblePlugins([projectPlugin], "/proj/a")).toEqual([projectPlugin])
    expect(visiblePlugins([projectPlugin], "/proj/b")).toEqual([])
    expect(visiblePlugins([projectPlugin], null)).toEqual([])
  })

  it("mixes global and matching project plugins, excluding non-matching ones", () => {
    const global = plugin({ id: "global-one", scope: "global" })
    const matching = plugin({ id: "openspec", scope: "project", project: "/proj/a" })
    const other = plugin({ id: "other-proj-plugin", scope: "project", project: "/proj/b" })
    expect(visiblePlugins([global, matching, other], "/proj/a")).toEqual([global, matching])
  })

  it("an empty listing yields no visible plugins", () => {
    expect(visiblePlugins([], "/proj/a")).toEqual([])
  })
})
