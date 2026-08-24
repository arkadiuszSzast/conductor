import { describe, expect, it } from "bun:test"

const root = new URL("../", import.meta.url)

async function source(path: string): Promise<string> {
  return Bun.file(new URL(path, root)).text()
}

describe("viewport containment contracts", () => {
  it("supports safe-area app chrome and a dynamic-height shell", async () => {
    const [html, globalCss, topBarCss] = await Promise.all([
      source("index.html"),
      source("src/styles/global.css"),
      source("src/top-bar.module.css"),
    ])
    expect(html).toContain("viewport-fit=cover")
    // Hard height, not min-height: the shell is a fixed app frame whose
    // panes scroll internally — min-height would let a tall inspector
    // column grow the document and shift scrolling to the page itself.
    expect(globalCss).toContain("height: 100dvh")
    expect(globalCss).not.toContain("min-height: 100dvh")
    expect(globalCss).toContain("overflow: hidden")
    expect(topBarCss).toContain("var(--safe-top)")
    expect(topBarCss).toContain("var(--safe-left)")
    expect(topBarCss).toContain("var(--safe-right)")
  })

  it("keeps board, graph, inspector, and logs in bounded local scroll regions", async () => {
    const [boardCss, featureCss, graphCss, inspectorCss] = await Promise.all([
      source("src/board/board.module.css"),
      source("src/feature/feature-view.module.css"),
      source("src/graph/graph-viewport.module.css"),
      source("src/feature/step-inspector.module.css"),
    ])
    expect(boardCss).toContain("overflow-x: auto")
    expect(boardCss).toContain("overflow-y: auto")
    expect(featureCss).toContain("min-width: 0")
    expect(featureCss).toContain("overflow: hidden")
    expect(graphCss).toContain("touch-action: pan-y")
    expect(graphCss).toContain("touch-action: none")
    expect(inspectorCss).toContain("overflow-y: auto")
    expect(inspectorCss).toContain("word-break: break-word")
  })

  it("aligns narrow composition and action-sheet breakpoints at 768px", async () => {
    const [viewportTs, featureCss, sheetCss] = await Promise.all([
      source("src/lib/viewport.ts"),
      source("src/feature/feature-view.module.css"),
      source("src/ui/action-sheet.module.css"),
    ])
    expect(viewportTs).toContain("breakpointPx = 768")
    expect(featureCss).toContain("@media (max-width: 767px)")
    expect(sheetCss).toContain("@media (max-width: 767px)")
    expect(sheetCss).toContain("92dvh")
    expect(sheetCss).toContain("position: sticky")
    expect(sheetCss).toContain("var(--safe-bottom)")
  })

  it("defines coarse-pointer sizing and reduced-motion fallbacks", async () => {
    const [globalCss, graphCss, inspectorCss, gateCss] = await Promise.all([
      source("src/styles/global.css"),
      source("src/graph/graph-viewport.module.css"),
      source("src/feature/step-inspector.module.css"),
      source("src/gate/gate-actions.module.css"),
    ])
    for (const css of [globalCss, graphCss, inspectorCss, gateCss]) {
      expect(css).toContain("@media (pointer: coarse)")
      expect(css).toContain("40px")
    }
    expect(globalCss).toContain("@media (prefers-reduced-motion: reduce)")
    expect(globalCss).toContain("animation-duration: 0.001ms !important")
  })

  it("keeps touch graph steps readable when fullscreen fitting large workflows", async () => {
    const [graphSource, viewportSource] = await Promise.all([
      source("src/graph/workflow-graph.tsx"),
      source("src/graph/graph-viewport.tsx"),
    ])
    expect(graphSource).toContain("fullscreenFitMinScale={2}")
    expect(viewportSource).toContain("fullscreen ? fullscreenFitMinScale : undefined")
  })

  it("keeps the start-work sheet's target list wrapping and unclipped at 320px (no fixed widths, long paths wrap)", async () => {
    const sheetCss = await source("src/start-work/start-work-sheet.module.css")
    // The form itself and every target row stay width-fluid — no `width:
    // <fixed px>` anywhere that could force horizontal scroll at 320px.
    expect(sheetCss).not.toMatch(/width:\s*\d+px/)
    expect(sheetCss).toContain("min-width: 0")
    // Full project paths (`.targetPath`, added for target disambiguation)
    // and diagnostics (`.targetMeta`) wrap rather than overflow.
    expect(sheetCss).toContain(".targetPath")
    expect(sheetCss).toMatch(/\.targetPath\s*\{[^}]*word-break:\s*break-word/)
    expect(sheetCss).toMatch(/\.targetMeta\s*\{[^}]*word-break:\s*break-word/)
    // Coarse-pointer target rows stay reachable (>= 40px) even with the
    // extra native-radio row markup.
    expect(sheetCss).toContain("@media (pointer: coarse)")
  })
})
