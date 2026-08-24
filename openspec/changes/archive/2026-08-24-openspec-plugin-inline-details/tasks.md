## 1. Inline expansion

- [x] 1.1 [web] `plugins/openspec/ui/`: replace the modal with in-place
  accordion expansion under the clicked tile/archived entry — lazy
  detail fetch on first expand, Why visible, collapsed sub-sections,
  start-work for active changes, one-expanded-at-a-time, Enter/Space
  toggle, inline fetch-error display; remove overlay/backdrop/Escape
  machinery and modal CSS
- [x] 1.2 [test] Update mounted UI tests: expand-on-click (detail fetch
  with ?project= preserved, Why visible, Requirements expandable),
  second click collapses, expanding another collapses the first,
  archived expands without start-work, start-work from expanded area,
  keyboard toggle

## 2. Verification

- [x] 2.1 [test] Full suite green; redeploy dogfood plugin and verify
  on desktop and mobile
