# Tasks — control-room-ux-pass

- [x] 1. [server] ACP: `acp/run-log.ts` `AcpRunLogWriter` — agent text (redacted, coalesced per 1 s), one `tool` line per `toolCallId` from the declared kind only, thoughts ignored; flush on turn completion, release on abort; sink errors swallowed
- [x] 2. [server] Wire `ManagedSessionsDeps.runLog` and bind it to `store.appendRunLog` in `runner-router.ts`
- [x] 3. [test] Unit tests for the writer and a `ManagedSessions` test proving session updates land in `run_log`
- [x] 4. [server] SSE keep-alive `: ping` comment every 20 s (`ApiConfig.sseKeepAliveMs`), cleared on close; API test
- [x] 5. [web] SSE reader `onActivity`/`signal`; store watchdog (50 s silence → abort), `resume()` on visibility/pageshow/online/focus, immediate reconnect, full resync on reconnect `hello`, rate-limited resync on a healthy stream; store tests
- [x] 6. [web] PWA manifest, icon and meta tags
- [x] 7. [web] Stage board: `deriveStages`/`stageLabel`/`focusStageIndex`, stage cards with active jobs and steps, `StageRail` + `StageLane`, remove `JobColumn`/`StageSelector`, auto-scroll to the attention stage; tests updated
- [x] 8. [web] Board is one vertical scroll region; RECENT preview 2 on phones, "show all" is a bounded scroll list; phone chip layout
- [x] 9. [web] Step inspector: Logs first, run status badge, tail-follow, empty-log message by step kind
- [x] 10. [web] Feature-level History panel (timeline + findings), clamped long reasons, readable event labels; `?job=` opens the inspector sheet on phones; phone header layout
- [x] 11. [web] Bridge `navigate.to.job` (optional, additive); host routes to `/feature/:id?job=`; protocol test
- [x] 12. [server] OpenSpec plugin `GET /runs` (`changeRunsFromFeatures`); tests
- [x] 13. [web] OpenSpec panel: Show run replaces Start work/Queue for live changes, run status + `job › step`, background refresh; mounted tests (also load `deps.js`, which had broken the existing mounted suite)
- [x] 14. [docs] `docs/http-api.md` keep-alive; `docs/plugins.md` Show run, `/runs`, `navigate.job`, refresh cadence
- [x] 15. [review] `bun run typecheck && bun test && bun run lint && bun run build`, mounted web tests, visual check at 1400×900 and 390×844 against the dogfood daemon
