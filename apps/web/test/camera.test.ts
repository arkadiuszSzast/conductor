/**
 * Graph camera math — pan/zoom/fit as pure arithmetic, no DOM.
 */
import { describe, expect, it } from "bun:test"
import {
  clampScale,
  fitCamera,
  IDENTITY_CAMERA,
  MAX_SCALE,
  MIN_SCALE,
  panBy,
  resetCamera,
  zoomAt,
  zoomIn,
  zoomOut,
} from "../src/graph/camera.ts"

describe("clampScale", () => {
  it("clamps within [MIN_SCALE, MAX_SCALE]", () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE)
    expect(clampScale(100)).toBe(MAX_SCALE)
    expect(clampScale(1)).toBe(1)
  })
})

describe("panBy", () => {
  it("moves translation on both axes independently of scale", () => {
    const camera = { x: 10, y: 20, scale: 1.5 }
    expect(panBy(camera, 5, -3)).toEqual({ x: 15, y: 17, scale: 1.5 })
  })
})

describe("zoomAt", () => {
  it("keeps the focal point visually fixed while scale changes", () => {
    const camera = { x: 0, y: 0, scale: 1 }
    const focal = { x: 100, y: 50 }
    const next = zoomAt(camera, 2, focal)
    // world point under the cursor before zoom: (100-0)/1 = 100, (50-0)/1 = 50
    // after zoom, that same world point must still map to the same focal.
    const worldXAfter = (focal.x - next.x) / next.scale
    const worldYAfter = (focal.y - next.y) / next.scale
    expect(worldXAfter).toBeCloseTo(100, 5)
    expect(worldYAfter).toBeCloseTo(50, 5)
    expect(next.scale).toBe(2)
  })

  it("is a no-op at the same clamped scale", () => {
    const camera = { x: 3, y: 4, scale: MAX_SCALE }
    expect(zoomAt(camera, 999, { x: 0, y: 0 })).toEqual(camera)
  })

  it("clamps the target scale", () => {
    const camera = { x: 0, y: 0, scale: 1 }
    const next = zoomAt(camera, 0.001, { x: 0, y: 0 })
    expect(next.scale).toBe(MIN_SCALE)
  })
})

describe("zoomIn / zoomOut", () => {
  it("zoomIn increases scale around the viewport center", () => {
    const camera = { x: 0, y: 0, scale: 1 }
    const next = zoomIn(camera, { width: 800, height: 600 })
    expect(next.scale).toBeGreaterThan(1)
  })

  it("zoomOut decreases scale around the viewport center", () => {
    const camera = { x: 0, y: 0, scale: 1 }
    const next = zoomOut(camera, { width: 800, height: 600 })
    expect(next.scale).toBeLessThan(1)
  })

  it("zoomIn then zoomOut returns close to the original scale", () => {
    const camera = { x: 0, y: 0, scale: 1 }
    const viewport = { width: 800, height: 600 }
    const roundTrip = zoomOut(zoomIn(camera, viewport), viewport)
    expect(roundTrip.scale).toBeCloseTo(1, 5)
  })
})

describe("resetCamera", () => {
  it("returns the identity camera", () => {
    expect(resetCamera()).toEqual(IDENTITY_CAMERA)
  })
})

describe("fitCamera", () => {
  it("centers content smaller than the viewport without upscaling past 1", () => {
    const camera = fitCamera({ width: 200, height: 100 }, { width: 800, height: 600 })
    expect(camera.scale).toBe(1)
    expect(camera.x).toBeCloseTo((800 - 200) / 2, 5)
    expect(camera.y).toBeCloseTo((600 - 100) / 2, 5)
  })

  it("downscales content larger than the viewport to fit within padding", () => {
    const camera = fitCamera({ width: 2000, height: 1000 }, { width: 800, height: 600 }, 32)
    expect(camera.scale).toBeLessThan(1)
    const scaledWidth = 2000 * camera.scale
    const scaledHeight = 1000 * camera.scale
    expect(scaledWidth).toBeLessThanOrEqual(800 - 32 * 2 + 0.01)
    expect(scaledHeight).toBeLessThanOrEqual(600 - 32 * 2 + 0.01)
  })

  it("fits the tighter dimension when content is disproportionate", () => {
    const camera = fitCamera({ width: 4000, height: 200 }, { width: 800, height: 600 }, 0)
    // width-constrained: scale should be 800/4000 = 0.2, clamped to MIN_SCALE=0.25
    expect(camera.scale).toBe(MIN_SCALE)
  })

  it("degrades to identity for degenerate sizes", () => {
    expect(fitCamera({ width: 0, height: 0 }, { width: 800, height: 600 })).toEqual(IDENTITY_CAMERA)
    expect(fitCamera({ width: 100, height: 100 }, { width: 0, height: 0 })).toEqual(IDENTITY_CAMERA)
  })

  it("honors a higher minimum fit scale for touch exploration", () => {
    const camera = fitCamera({ width: 2400, height: 1200 }, { width: 320, height: 640 }, 32, 1, 2)
    expect(camera.scale).toBe(2)
    expect(camera.x).toBeCloseTo((320 - 2400 * 2) / 2, 5)
    expect(camera.y).toBeCloseTo((640 - 1200 * 2) / 2, 5)
  })

  it.each([
    ["compact phone", 320, 640],
    ["phone", 390, 844],
    ["tablet boundary", 768, 1024],
    ["wide desktop", 1440, 900],
  ])("returns a finite bounded fit for the %s viewport", (_name, width, height) => {
    const camera = fitCamera({ width: 2200, height: 760 }, { width, height })
    expect(Number.isFinite(camera.x)).toBe(true)
    expect(Number.isFinite(camera.y)).toBe(true)
    expect(camera.scale).toBeGreaterThanOrEqual(MIN_SCALE)
    expect(camera.scale).toBeLessThanOrEqual(1)
  })
})
