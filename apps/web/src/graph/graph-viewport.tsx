/**
 * Pannable/zoomable graph stage — owns camera state and pointer/
 * keyboard interaction; the pure math lives in `camera.ts`. Wraps its
 * children (the SVG workflow graph) in a CSS-transformed layer so drag
 * and the explicit zoom/fit/reset controls never touch the document
 * scrollbar. The wheel deliberately does nothing here: drag is the one
 * panning gesture, and stray scrolls must not move the camera. Camera
 * state resets whenever `resetKey` changes (e.g. navigating to a
 * different feature/workflow).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import {
  type CameraState,
  fitCamera,
  IDENTITY_CAMERA,
  panBy,
  resetCamera,
  zoomAt,
  zoomIn as zoomInAt,
  zoomOut as zoomOutAt,
} from "./camera.ts"
import styles from "./graph-viewport.module.css"

export interface GraphViewportProps {
  readonly contentWidth: number
  readonly contentHeight: number
  readonly resetKey: string
  readonly children: React.ReactNode
  /** Below the mobile breakpoint, renders an explicit "explore fullscreen"
   *  toggle so touch panning never has to fight page scrolling in a
   *  constrained inline canvas (spec: "Mobile graph exploration is touch
   *  usable"). Omitted entirely on wide viewports. */
  readonly allowFullscreen?: boolean
  /** Minimum scale used when fitting the mobile fullscreen explorer. The
   *  graph can still be zoomed out explicitly, but it opens with controls
   *  large enough to target by touch instead of preserving a tiny overview. */
  readonly fullscreenFitMinScale?: number
}

export function GraphViewport({ contentWidth, contentHeight, resetKey, children, allowFullscreen, fullscreenFitMinScale }: GraphViewportProps): React.ReactNode {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [camera, setCamera] = useState<CameraState>(IDENTITY_CAMERA)
  const [fullscreen, setFullscreen] = useState(false)
  const dragRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null)

  const viewportSize = useCallback((): { width: number; height: number } => {
    const el = viewportRef.current
    if (el === null) return { width: 0, height: 0 }
    const rect = el.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  }, [])

  const fitToContent = useCallback(() => {
    const size = viewportSize()
    setCamera(fitCamera({ width: contentWidth, height: contentHeight }, size, 32, 1, fullscreen ? fullscreenFitMinScale : undefined))
  }, [contentWidth, contentHeight, fullscreen, fullscreenFitMinScale, viewportSize])

  // Fit on first layout for this content/reset key, whenever content
  // dimensions change meaningfully (e.g. the workflow's job set changes),
  // and when entering/leaving fullscreen (the viewport size just changed).
  useLayoutEffect(() => {
    fitToContent()
  }, [fitToContent, resetKey])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    // Only empty canvas initiates a pan; job/step controls stop
    // propagation on their own pointer-down so clicks still register.
    if (e.button !== 0) return
    ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
    dragRef.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== e.pointerId) return
    const dx = e.clientX - drag.lastX
    const dy = e.clientY - drag.lastY
    dragRef.current = { pointerId: drag.pointerId, lastX: e.clientX, lastY: e.clientY }
    setCamera(prev => panBy(prev, dx, dy))
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== e.pointerId) return
    dragRef.current = null
    try {
      ;(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId)
    } catch {
      // already released — ignore
    }
  }

  const zoomInBtn = (): void => setCamera(prev => zoomInAt(prev, viewportSize()))
  const zoomOutBtn = (): void => setCamera(prev => zoomOutAt(prev, viewportSize()))
  const resetBtn = (): void => setCamera(resetCamera())

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = 48
    switch (e.key) {
      case "+":
      case "=":
        e.preventDefault()
        zoomInBtn()
        break
      case "-":
      case "_":
        e.preventDefault()
        zoomOutBtn()
        break
      case "0":
        e.preventDefault()
        resetBtn()
        break
      case "f":
      case "F":
        e.preventDefault()
        fitToContent()
        break
      case "ArrowLeft":
        e.preventDefault()
        setCamera(prev => panBy(prev, step, 0))
        break
      case "ArrowRight":
        e.preventDefault()
        setCamera(prev => panBy(prev, -step, 0))
        break
      case "ArrowUp":
        e.preventDefault()
        setCamera(prev => panBy(prev, 0, step))
        break
      case "ArrowDown":
        e.preventDefault()
        setCamera(prev => panBy(prev, 0, -step))
        break
    }
  }

  // Double-click zooms in centered on the click point.
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const el = viewportRef.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    const focal = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    setCamera(prev => zoomAt(prev, prev.scale * 1.6, focal))
  }

  useEffect(() => {
    const onResize = (): void => {
      // Keep the current camera on resize — re-fitting on every resize
      // event would fight an operator mid-pan; fit remains an explicit
      // action.
    }
    globalThis.addEventListener("resize", onResize)
    return () => globalThis.removeEventListener("resize", onResize)
  }, [])

  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setFullscreen(false)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [fullscreen])

  // A breakpoint change (e.g. rotating a tablet, or resizing past 768px)
  // can flip `allowFullscreen` to false while fullscreen is still active.
  // The toolbar's exit control always renders while `fullscreen` is true
  // (below), but clearing fullscreen here also restores the normal
  // inline/desktop layout automatically rather than leaving a full-screen
  // overlay stuck open on a viewport that no longer offers the toggle.
  useEffect(() => {
    if (fullscreen && allowFullscreen !== true) setFullscreen(false)
  }, [allowFullscreen, fullscreen])

  const transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`

  return (
    <div className={`${styles.wrap} ${fullscreen ? styles.fullscreen : ""}`}>
      <div
        ref={viewportRef}
        className={styles.viewport}
        aria-label="Workflow graph canvas. Drag to pan, arrow keys pan, plus/minus zoom, F fits, 0 resets. Tab into the graph to reach individual jobs and steps."
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        onDoubleClick={onDoubleClick}
      >
        <div className={styles.stage} style={{ transform }}>
          {children}
        </div>
      </div>
      <div className={styles.toolbar}>
        {/* Rendered whenever fullscreen is active, independent of
         *  `allowFullscreen`: a breakpoint change mid-session must never stall
         *  the operator with an active overlay and no way to leave it, even
         *  in the instant before the effect above clears the state. Outside
         *  fullscreen, the entry toggle only appears when the caller opted
         *  in (mobile graph exploration). */}
        {fullscreen || allowFullscreen === true ? (
          <button
            type="button"
            onClick={() => setFullscreen(v => !v)}
            title={fullscreen ? "Exit fullscreen (Esc)" : "Explore fullscreen"}
          >
            {fullscreen ? "✕ exit" : "⤢ explore"}
          </button>
        ) : null}
        <button type="button" onClick={zoomOutBtn} title="Zoom out (-)" aria-label="Zoom out">
          −
        </button>
        <span className={styles.zoomReadout}>{Math.round(camera.scale * 100)}%</span>
        <button type="button" onClick={zoomInBtn} title="Zoom in (+)" aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={fitToContent} title="Fit workflow to view (F)">
          fit
        </button>
        <button type="button" onClick={resetBtn} title="Reset zoom (0)">
          reset
        </button>
      </div>
    </div>
  )
}
