## Why

The change detail view added by `openspec-plugin-details` renders as a
modal overlay *inside the plugin's iframe*. The iframe is only the panel
region, so the "modal" cannot cover the page: on desktop it floats
awkwardly inside the narrow right column (reads as a broken popover
under the tile), on mobile it is cramped inside the sheet. First
dogfooding feedback: confusing on desktop, too small on mobile.

## What Changes

- The detail presentation switches from a modal overlay to **inline
  expansion**: clicking a change tile (or archived entry) expands the
  details in place, accordion-style, directly beneath the tile within
  the list. Clicking again (or the collapse control) collapses it.
- Content and behaviour are otherwise unchanged: Why visible on expand,
  What Changes / Requirements / Tasks as collapsed sub-sections,
  start-work inside the expanded area for active changes, keyboard
  operability (Enter/Space toggles), detail fetched lazily on first
  expand.
- At most one change is expanded at a time (expanding another collapses
  the previous one) — keeps the narrow panel readable.
- The modal overlay, backdrop, and Escape-close machinery are removed.

Not in scope: host-app or plugin-contract changes; any redesign of the
detail content itself.

## Capabilities

### Modified Capabilities

- `openspec-plugin`: the change-detail requirement's presentation moves
  from a modal overlay to in-place accordion expansion.

## Impact

- `plugins/openspec/ui/app.js` + `style.css` (modal → inline expansion),
  mounted UI tests updated. Backend untouched.
