/**
 * Graph camera — pure viewport transform state for the pannable workflow
 * stage. `{x, y, scale}` describes the CSS transform applied to the graph
 * layer; every operation here is arithmetic over plain numbers so the
 * pan/zoom/fit math is unit-testable without a DOM or pointer events.
 *
 * The camera never touches the server: it is local view state the graph
 * component owns, reset per feature/workflow the way selection is.
 */

export interface CameraState {
  readonly x: number
  readonly y: number
  readonly scale: number
}

export interface Size {
  readonly width: number
  readonly height: number
}

export const MIN_SCALE = 0.25
export const MAX_SCALE = 2.5
export const DEFAULT_SCALE = 1
export const ZOOM_STEP = 1.25

export const IDENTITY_CAMERA: CameraState = { x: 0, y: 0, scale: DEFAULT_SCALE }

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/** Pan by a pointer-space delta (already divided by any device pixel ratio). */
export function panBy(camera: CameraState, dx: number, dy: number): CameraState {
  return { ...camera, x: camera.x + dx, y: camera.y + dy }
}

/**
 * Zoom around a fixed viewport point (typically the pointer or viewport
 * center) so that point stays visually still: solve for the new
 * translation such that `(point - translation) / scale` is invariant.
 */
export function zoomAt(camera: CameraState, nextScaleRaw: number, focal: { readonly x: number; readonly y: number }): CameraState {
  const nextScale = clampScale(nextScaleRaw)
  if (nextScale === camera.scale) return camera
  const worldX = (focal.x - camera.x) / camera.scale
  const worldY = (focal.y - camera.y) / camera.scale
  return {
    scale: nextScale,
    x: focal.x - worldX * nextScale,
    y: focal.y - worldY * nextScale,
  }
}

export function zoomIn(camera: CameraState, viewport: Size): CameraState {
  return zoomAt(camera, camera.scale * ZOOM_STEP, { x: viewport.width / 2, y: viewport.height / 2 })
}

export function zoomOut(camera: CameraState, viewport: Size): CameraState {
  return zoomAt(camera, camera.scale / ZOOM_STEP, { x: viewport.width / 2, y: viewport.height / 2 })
}

export function resetCamera(): CameraState {
  return IDENTITY_CAMERA
}

/**
 * Fit-to-content: compute the scale that fits `content` inside `viewport`
 * (with padding, never upscaling past `maxFitScale`) and the translation
 * that centers the scaled content in the viewport.
 */
export function fitCamera(content: Size, viewport: Size, padding = 32, maxFitScale = 1, minFitScale = MIN_SCALE): CameraState {
  if (content.width <= 0 || content.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return IDENTITY_CAMERA
  }
  const availableWidth = Math.max(1, viewport.width - padding * 2)
  const availableHeight = Math.max(1, viewport.height - padding * 2)
  const scale = clampScale(Math.max(minFitScale, Math.min(maxFitScale, availableWidth / content.width, availableHeight / content.height)))
  const x = (viewport.width - content.width * scale) / 2
  const y = (viewport.height - content.height * scale) / 2
  return { x, y, scale }
}
