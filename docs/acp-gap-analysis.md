# ACP vs `runner-protocol` / `SessionClient` — analiza luk (gap analysis)

> **Status: notatka doradcza (advisory), NIE zatwierdzony plan.** To jest
> deliverable Etapu 1 ze `docs/development-roadmap.md` ("Ścieżka A —
> Etap 1 — Przegląd projektowy (read-only)"). Nie zmienia kodu, nie
> zawiera commitów, nie zastępuje `openspec/changes/runner-protocol/`.
> Każda rekomendacja poniżej wymaga osobnej propozycji OpenSpec, zanim
> stanie się wykonalna (`AGENTS.md`, `openspec/config.yaml`).

Data analizy: 2026-09-25. Źródła ACP pobrane tego samego dnia (linki w
sekcji [Źródła](#źródła)); wersje SDK/CLI **zaobserwowane** przez
`registry.npmjs.org` tego samego dnia — to punkt-w-czasie, **nie**
przypięcie/decyzja o wersji (przypięcie jest zadaniem Etapu 2) i nie
gwarancja niezmienności (ACP v1 otrzymał ≥15 stabilizowanych RFD w ciągu
ostatniego roku, patrz [`rfds/updates`](https://agentclientprotocol.com/rfds/updates.md)).

## 1. Cel i zakres

Porównać granicę `SessionClient` (`packages/server/src/ports.ts:112-141`)
i niedokończony kontrakt `runner-protocol`
(`openspec/changes/runner-protocol/{proposal,design,tasks}.md`, **0/20
tasków ukończonych** — zweryfikowane `grep -c '\[x\]' tasks.md` = 0) z
Agent Client Protocol (ACP) w wersji stabilnej v1 (major=1) oraz szkicu v2
(draft, 2026-07-20). Cel: dla każdej decyzji projektowej i każdego
requirementu trzech specs `runner-protocol` ustalić jawne **tak /
częściowo / nie** pokrycie przez ACP, zidentyfikować granice
architektoniczne i operacyjne, których ACP **nie** może przejąć bez
zmiany fundamentów Conductora, i dać rekomendację "preserve/change/replace"
— **nie** "zbuduj konkurencyjny protokół".

### Metodologia

- Kod: `packages/server/src/{ports,runner-transport,runner-registry,engine}.ts`,
  `packages/runner-opencode/src/{sessions,hub,plugin,tools}.ts`,
  `packages/server/src/{migrations,store}.ts` (fragmenty `answer_delivery`).
- Spec/design: `openspec/changes/runner-protocol/{proposal,design,tasks}.md`
  i wszystkie trzy `specs/*/spec.md`; kontekst `openspec/config.yaml` i
  `AGENTS.md`; status sąsiednich zmian `runner-liveness` (**8/8 shipped**)
  i `retry-policy` (**25/25 shipped**) jako punkt odniesienia dla tego, co
  `runner-protocol` ma zastąpić/rozszerzyć.
- ACP: strony `protocol/v1/*` (stabilne), `protocol/v2/*` (draft),
  `rfds/updates` (historia stabilizacji), `announcements/acp-v2-draft`.
  Wersje pakietów **zaobserwowane** (nie przypięte — patrz niżej)
  `registry.npmjs.org` 2026-09-25: `@agentclientprotocol/sdk@1.5.0`,
  `opencode-ai@1.18.32`, `@agentclientprotocol/codex-acp@1.13.1`
  (zależność `@openai/codex@^0.156.1`), `@google/gemini-cli@0.61.0`.
- Nie uruchomiono żadnych testów kompatybilności SDK/runtime — to wymaga
  Etapu 2 (spike). Żadna wersja pakietu w tej notatce nie jest
  "przypięciem" ani decyzją — to punkty-w-czasie z rejestru npm,
  do zweryfikowania/przypięcia dopiero w Etapie 2.

**Numeracja SDK vs numeracja protokołu (nie mylić):** `protocolVersion`
w `initialize` to pojedyncza liczba całkowita identyfikująca **główną
wersję protokołu** (dziś `1`, [`initialization.md`](https://agentclientprotocol.com/protocol/v1/initialization.md):
"a single integer that identifies a MAJOR protocol version"). SDK-y mają
**własne, niezależne** numery wydań semver — `@agentclientprotocol/sdk`
w wersji `1.5.0` implementuje `protocolVersion: 1` (stabilny) i,
częściowo/eksperymentalnie, artefakty draft v2 (SDK dokumentuje osobne,
niestabilne wejście dla v2 — traktować jako opt-in eksperyment, nie
domyślną ścieżkę). Analogicznie Rust SDK `1.0.0`/Python SDK `0.12.1` czy
`1.0rc2` to numeracje pakietu, nie protokołu — SDK w wersji `≥1.0.0` nie
oznacza "obsługuje protokół v2", tylko "stabilne API pakietu dla
protokołu v1". Ta notatka celowo **nie** analizuje Rust/Python SDK poza
tą jedną uwagą — pozostaje to poza zakresem, żeby nie rozmywać fokusu na
TypeScript/Bun (zgodnie ze stackiem Conductora).

**Rola Context7 w tej analizie:** zapytania Context7 (wykonane przed tą
rewizją) posłużyły do **odkrycia** kandydatów bibliotek/dokumentacji
(np. potwierdzenia istnienia i lokalizacji `@agentclientprotocol/sdk`,
`opencode-ai`, dokumentacji OpenCode ACP) — **nie** jako źródło
rozstrzygające dla żadnego twierdzenia w tej notatce. Wszystkie
konkretne cytaty/wymogi protokołu opierają się na bezpośrednio pobranych
stronach `agentclientprotocol.com` i tagowanych źródłach GitHub/npm
(linki w tekście i w sekcji [Źródła](#źródła)) — Context7 był narzędziem
nawigacyjnym, źródła oficjalne/tagowane są decydujące.

### Uwaga o kontekście projektu (bez reopeningu)

`AGENTS.md` deklaruje "Greenfield, no legacy obligations" — dowolna część
`opencode-conductor` może być zastąpiona. `openspec/config.yaml` zawiera
jednocześnie "The DB schema is adopted additively: in-flight conductor
features survive the migration to the standalone daemon" oraz listę
"Confirmed decisions (do not reopen without a proposal)" — w tym
"Agent report-back is the daemon's HTTP API plus a `conductor` CLI — a
runner only needs createSession/prompt/status/note." To ostatnie zdanie
**jest** dokładnie granicą `SessionClient`, którą ta notatka bada — samo
istnienie tej "confirmed decision" nie przesądza wyniku Etapu 1, ale każda
rekomendacja "replace" poniżej koliduje z nią i wymagałaby jawnego
otwarcia tej decyzji w propozycji OpenSpec, nie cichego obejścia.

---

## 2. Mapa: co jest zaimplementowane dziś

### 2.1 `SessionClient` — granica portu (zaimplementowana, w repo dziś — "produkcyjna" tu znaczy: kod na `main`, nie "wdrożona/eksploatowana")

`packages/server/src/ports.ts:112-141` definiuje **sześć** operacji:

| Operacja | Sygnatura | Semantyka |
|---|---|---|
| `createSession` | `{title, directory, parentID?, runId?}` → `Promise<{id}>` | **Awaituje `id`** zanim silnik przejdzie dalej (`engine.ts:491-508`) — to NIE jest fire-and-forget: wywołujący czeka na odpowiedź HTTP z utworzonym `id`, tylko nie ma osobnej trwałej potwierdzonej-dostawy warstwy nad tym `await`. `runId` to opcjonalny hint do logowania (patrz 2.4). |
| `prompt` | `{sessionID, text, agent?, model?}` → `Promise<void>` | Silnik **awaituje** wywołanie (`engine.ts:530`), ale zwrotka niesie tylko "żądanie HTTP się powiodło", nie "agent przetworzył/zakończył" — brak retry ani idempotency-key na poziomie portu. |
| `sessionExists` | `sessionID` → `Promise<boolean>` | Konserwatywne: niepewność → `true`. |
| `status` | `sessionID` → `Promise<"busy"\|"idle"\|"retry"\|"missing">` | `"retry"` = provider retrying (traktowane jak busy przez callerów); niepewność → `"busy"`. |
| `note` | `{sessionID, text}` → `Promise<void>` | Append **bez wywoływania inferencji modelu** (`noReply`) — to NIE jest obietnica "zero tokenów zawsze"; to zależy od implementacji runnera po drugiej stronie portu (kontrakt portu gwarantuje tylko brak *jawnego* żądania odpowiedzi). |
| `abort` | `sessionID` → `Promise<void>` | Best-effort; no-op na zakończonej/nieistniejącej sesji. |

Kluczowe: **`note` nie jest dziś wywoływane przez `engine.ts` w ogóle**
(`grep -n "sessions\.\(note\|abort\|...\)" engine.ts` → brak trafienia dla
`note`). Kontrakt portu deklaruje operację, silnik jej nie używa — to samo
zauważa `design.md` runner-protocol ("Timeline notes do not trigger
inference" — patrz sekcja 4, wymaganie nadal ważne mimo braku obecnego
wywołania).

### 2.2 `runner-transport.ts` — implementacja portu nad HTTP (`packages/server/src/runner-transport.ts`)

- `NoLiveRunnerError` (linie 11-16) — dedykowany typ dla "brak działającego
  runnera"; łapany przez `engine.ts` do rozróżnienia resource-wait od
  zwykłej awarii (patrz 2.4).
- `probe()` (66-78): **health pre-probe** przed każdym zapisem —
  `GET /v1/health`, timeout 10s (`AbortSignal.timeout(10_000)`, linia 57).
  Tylko *definitywne* błędy pre-connect (`ECONNREFUSED`, `ENOTFOUND`,
  `EAI_AGAIN`, `ConnectionRefused` — `isDefinitivePreConnectFailure`,
  linie 18-22) pozwalają pominąć runnera; wszystko inne rzuca
  `NoLiveRunnerError` **bez wysłania zapisu**.
- `write()` (79-88) i `sessionWrite()` (89-103): **ambiguous POST failure
  NIE jest replay'owany** na innego runnera — jeśli zapis już poszedł i
  odpowiedź się zgubiła, transport nie zgaduje, tylko propaguje błąd.
  Komentarz w `runner-liveness` spec to nazywa wprost: "Ambiguous POST
  failures SHALL NOT be replayed against another endpoint by the
  transport."
- `owners` (linia 41, LRU do 1024 wpisów, linia 45): **in-memory** mapa
  sessionID→runnerID, nietrwała, nie przeżywa restartu daemona.
- `read()` (104-124): dla `status`/`exists`, niepewność (brak znanego
  właściciela, błąd, nieprawidłowa wartość) → `unknown→busy` /
  `unknown→true` (safe direction), zgodnie z kontraktem portu.
- `routeForDirectory()` (24-37): wybór runnera po najdłuższym prefiksie
  ścieżki projektu — **nie** po capability matching (bo capabilities nie
  istnieją w dzisiejszym rejestrze).

### 2.3 `runner-registry.ts` — rejestr w pamięci (`packages/server/src/runner-registry.ts`)

- Klucz rejestracji: **endpoint** (URL), nie stabilna tożsamość runnera
  (linia `this.registrations.get(endpoint)`, ok. linii 44-52). Restart
  runnera na innym porcie = nowa tożsamość.
- Lease: **60 000 ms** (`leaseMs = 60_000`, konstruktor, linia 29),
  odświeżany przez re-announce huba co **15 000 ms**
  (`DEFAULT_REANNOUNCE_MS = 15_000`, `packages/runner-opencode/src/hub.ts:81`).
- `list()` (linie ok. 82-86) usuwa wygasłe rejestracje przy każdym
  odczycie (lazy expiry), nie przez osobny timer.
- **Brak** capabilities, wersji protokołu, stabilnej tożsamości poza
  endpointem — to dokładnie luka, którą `runner-protocol` design.md
  nazywa "Alternative: retain endpoint-keyed in-memory identity. Rejected
  because ephemeral ports and daemon restarts create false identities and
  stale availability."
- **Wszystko w pamięci procesu** — restart daemona = pusty rejestr
  (healed tylko przez re-announce huba, nie przez trwały zapis).

### 2.4 `engine.ts` — orkiestracja wokół portu

- **Linie 418-435** (`executeAgent`): `this.deps.runnerAvailable?.() === false`
  → **przed** utworzeniem runu wpisuje `resource_wait` z powodem
  `"runner_unavailable"` przez `decideResourceWaitRoute` (czysta funkcja
  interpretera) i **wraca bez tworzenia runu**. To jest ścieżka "no
  runner at all" — zero-attempt.
- **Linie 471-567**: gdy runner jest zarejestrowany, silnik **najpierw
  wstawia run** (`store.insertRun`, linia 475 — *przed* jakimkolwiek
  `await`, komentarz w kodzie tłumaczy to jako zamknięcie wyścigu z
  równoległym reconcile), potem tworzy sesję rodzica/dziecka
  (`createSession` ×2, linie 491-508) i dopiero potem `prompt` (linia
  530). Jeśli `sessions.prompt` rzuci `NoLiveRunnerError` (linia 548),
  run zostaje **cofnięty** do `resource_wait` przez
  `concludeRunForResourceWait` (linie 556-561) — **bez konsumpcji
  attemptu**. Jeśli rzuci **inny** błąd (np. ambiguous POST z
  `runner-transport.ts`), run kończy się `"failed"` z klasyfikacją przez
  `classifyThrownBoundary` (linia 565) — **to konsumuje attempt i może
  prowadzić do duplikatów**, bo `createSession`/`prompt` mogły się
  faktycznie wykonać po stronie runnera zanim błąd doleciał do silnika.
  **To jest realna luka**, którą `runner-protocol` design.md wprost
  adresuje ("Idempotent create and prompt state machine... Lost create
  responses are redelivered with the same key... never blind fresh
  prompting").
- **Linia 2279** (`classifyThrownBoundary`): klasyfikacja błędów przez
  **regex na tekście komunikatu** (`/ECONNREFUSED|.../i`,
  `/429|rate limit.../i`, `/502|503|504.../i`, `/timeout|timed out/i`,
  fallback `"internal"`). To **wprost sprzeczne** z zasadą z
  `runner-contract/spec.md`: "The engine SHALL apply the generic policy
  from `retry-policy` and SHALL NOT parse message text." Dzisiejszy kod
  robi dokładnie to, czego planowany design zabrania — luka między stanem
  bieżącym a projektowanym, nie luka ACP.
- **Linie 1654-1664** (`pause`/`abandon`): obie metody wywołują **tylko**
  `this.dispatch(featureId, {kind: "human.paused"/"human.abandoned"})` —
  **żadna nie wywołuje `sessions.abort`**. Stan durowalny (SQLite) zmienia
  się natychmiast. `abort` **nie jest gwarantowany** w żadnym konkretnym
  terminie po tym: `reconcileFeature` (linia 1693: `if (input.status ===
  "paused") return`) **pomija** wszystkie kolejne kroki reconcile dla
  wstrzymanej cechy — w tym `reconcileTtl`/`reap`, które są jedynym
  miejscem wywołującym `abort` (patrz niżej). Dla `pause` runner może więc
  pozostać nieabortowany na czas nieokreślony (dopóki cecha nie zostanie
  wznowiona i dopiero wtedy ewentualnie zreapowana po TTL); dla `abandon`
  (`feature.status === "abandoned"` sprawdzane na starcie `reconcileFeature`,
  linia 1855) reconcile także wraca wcześnie. Żadna z dwóch ścieżek nie
  gwarantuje odwołania sesji w żadnym oknie czasowym — to jest
  best-effort bez terminu, nie "prędzej czy później reap i tak posprząta".
- **Linie 2112-2135** (`reap`): jedyne miejsce, które wywołuje
  `sessions.abort` (linia 2125), i to **best-effort w try/catch** —
  błąd abortu jest logowany, nigdy nie blokuje konkluzji runu. Kolejność
  jest zamierzona: abort **przed** conclude (komentarz w kodzie: gdyby
  daemon padł między nimi, reconcile ponownie zreapuje wciąż-aktywny run;
  odwrotna kolejność zostawiłaby sierocą sesję palącą tokeny).
- Dopiero **wtedy**, gdy agent jawnie wywoła `report()` z `outcome`/
  `verdict` (`engine.ts:1013`, patrz sekcja 5.5), silnik uznaje krok za
  zakończony — nigdy na podstawie `status: idle` z portu. `ask` (ta sama
  metoda `report()`, gałąź `input.ask !== undefined`, `engine.ts:1039-1062`)
  **nie kończy** kroku — `store.setRunQuestion` zostawia run w stanie
  `"running"` i **parkuje** go na pytaniu do człowieka; krok kończy się
  dopiero późniejszym, osobnym wywołaniem `report()` z `outcome`/`verdict`.

### 2.5 `packages/runner-opencode/` — jedyny dzisiejszy adapter

- `sessions.ts` (204 linii) implementuje `SessionClient` nad SDK
  opencode. `status()` (linie 155-202) ma wielowarstwową logikę "safe
  direction": `lookup unknown → busy` (161), timeline unreachable →
  `busy` (193-197), brak wiadomości asystenta w oknie 5 → `busy` (189),
  ostatnia wiadomość bez `completed` timestamp lub z pending/running tool
  → `busy` (190-192). To jest dokładnie zachowanie, które
  `runner-lifecycle/spec.md` chce ustandaryzować jako "Unknown status is
  handled in the safe direction" — **dziś zaimplementowane
  opencode-specyficznie, nie jako kontrakt**.
- `hub.ts`: jeden proces opencode może obsługiwać wiele katalogów
  projektów (linia routing po najdłuższym prefiksie, `isPathPrefix`,
  linie 71-73); re-announce co 15s (linia 81); auth przez stały token
  lub `CONDUCTOR_RUNNER_AUTH=none` (`authorized`, linie 66-70,
  `timingSafeEqual`).
- `plugin.ts`: rejestruje `conductor_start/report/ask/status/approve/
  request_changes` jako **narzędzia pluginu opencode**
  (`tool.schema.*` z `@opencode-ai/plugin`, linie 110-191) — **nie jako
  MCP server run-scoped**. `tools.ts` implementuje je jako proste
  wywołania HTTP do `ApiClient` (daemon REST API), nie do wewnętrznego
  silnika. To znaczy: raportowanie idzie przez **CLI/HTTP API daemona**,
  nie przez protokół agenta.
- `note` port **istnieje** w `sessions.ts` (`noReply: true`,
  `session.promptAsync`) ale — jak w 2.1 — silnik go nie wywołuje.

### 2.6 Dostarczanie odpowiedzi człowieka — `answer_delivery` (SQLite, at-least-once)

`packages/server/src/migrations.ts:456-531` (migracja `0014_answer_delivery`
+ `0015_answer_delivery_retry_schedule`): tabela `answer_delivery` z
`delivery_token` (linia 483, komentarz: "Conductor's own idempotency
marker, carried into the prompt so an opencode-side dedup can [happen]"),
unikalny indeks `idx_answer_delivery_open_run` na `(run_id) WHERE status
IN ('pending','claimed')` (497-498) — **jeden otwarty delivery na run**.
`store.ts:1168` sprawdza dedup przed insertem; `engine.ts:1214` osadza
`[conductor delivery <token>]` w promptcie. To jest **at-least-once z
tokenem po stronie Conductora** — **runtime (opencode) nie robi dedup
sam z siebie**; token istnieje po to, żeby *agent* mógł go rozpoznać w
treści, nie żeby protokół transportowy gwarantował dedup.

### 2.7 Status `runner-protocol` i sąsiednich zmian OpenSpec

| Zmiana | Tasks | Status |
|---|---|---|
| `runner-protocol` | 0/20 (`grep -c '\[x\]'` = 0) | **Nierozpoczęta implementacja.** `proposal.md`/`design.md`/`tasks.md` istnieją, kod nie. |
| `runner-liveness` | 8/8 | **Shipped.** Dostarczyła 60s lease + 15s re-announce + health-probe + ambiguous-write semantics opisane w 2.2-2.3 — to jest **dzisiejszy stan**, nie plan. |
| `retry-policy` | 25/25 | **Shipped.** Dostarczyła `FailureClass`, `resource_wait`, `recover()` z optimistic concurrency (`engine.ts:1490-1529`) — generalny mechanizm, na który `runner-protocol` design.md się powołuje jako właściciela retry/budget/escalation. |

**Uwaga o świeżości `design.md`:** `design.md` runner-protocol opisuje
"Decisions" (identity/lease, offer przed attempt, idempotentny
create/prompt) tak, jakby dzisiejszy stan był czysto in-memory bez leasy —
ale `runner-liveness` (shipped) **już wprowadziła** 60s lease/15s
re-announce/health-probe/ambiguous-write-no-replay, co częściowo
pokrywa motywację `design.md` (choć nie durable identity, nie capability
matching, nie idempotentne create/prompt). **`design.md` jest częściowo
nieaktualny względem stanu repo** — kontekst do uwzględnienia przy
ewentualnej rewizji `runner-protocol`, nie powód do jej zamknięcia.

---

## 3. Tabela pokrycia: 8 decyzji projektowych `design.md`

Legenda: **Tak** = ACP v1 stabilne pokrywa intencję wprost; **Częściowo**
= ACP daje prymityw, ale słabszy/opcjonalny/bez gwarancji, których
`runner-protocol` wymaga; **Nie** = ACP nie ma odpowiednika **w warstwie
protokołu** — nawet jeśli decyzja jest wewnętrzna dla Conductora (np.
migracje SQLite), klasyfikujemy ją **Nie** (ACP nie może jej pokryć z
definicji), nie jako "nie dotyczy" — każdy wiersz musi mieć jedną z
trzech wartości, bez wyjątku.

| # | Decyzja (`design.md`) | ACP | Uzasadnienie |
|---|---|---|---|
| 1 | Durable stable identity + leased registration | **Nie** | ACP `initialize` ma `agentCapabilities`/`agentInfo`, ale `agentInfo` to **nie tożsamość** ([`initialization.md`](https://agentclientprotocol.com/protocol/v1/initialization.md): "Both take the following three fields... Intended for programmatic or logical use") — brak stabilnego ID przeżywającego restart procesu, brak leasy w ogóle. (Capability-negotiation jako osobna sprawa jest oceniona niżej, wiersz 4.3 — tu chodzi wyłącznie o identity+lease, których ACP nie ma.) ACP nie ma pojęcia "rejestr wielu agentów z heartbeatem" — to model 1:1 klient↔proces uruchamiany przez klienta (stdio transport), nie model N:1 (wiele projektów przez jeden zarejestrowany runner, jak `runner-opencode`). Stabilna tożsamość i lease pozostają w całości obowiązkiem Conductora. |
| 2 | Daemon-initiated callback protocol (JSON HTTP, wersjonowany media type) | **Nie** | ACP jest **client-initiated na poziomie połączenia**: klient (Conductor jako client ACP) uruchamia agenta jako subprocess po stdio ([`transports.md`](https://agentclientprotocol.com/protocol/v1/transports.md): "The client launches the agent as a subprocess... All Agents MUST support stdio"). To NIE jest sprzeczne z dzisiejszym kierunkiem callbacku daemon→runner — przeciwnie, jest z nim **zgodne**: Conductor jako ACP-client już dziś inicjuje połączenie do runnera (dzisiejszy `runner-transport.ts` POST-uje do endpointu runnera, dokładnie tak jak klient ACP uruchamia/łączy się z agentem). Różnica leży gdzie indziej: (a) dzisiejszy callback to **własny wire format** (JSON HTTP ad-hoc), nie JSON-RPC-nad-stdio ACP — to jest do zastąpienia, nie kierunek; (b) **odwrotny** kierunek (runner→daemon) **już istnieje dziś**, nie tylko w planowanym `runner-protocol` — `hub.ts` już dziś POST-uje rejestrację+heartbeat do daemona (`announce()`, `hub.ts:204-212`, wywoływane z `registerProject`/re-announce timer, `hub.ts:138-158`, co 15s); to jest jednak **in-memory, endpoint-keyed** (sekcja 2.3), nie durable/stable-identity, jakiej żąda `runner-protocol`. Sam kierunek "runner ogłasza się do rejestru" więc **istnieje** w Conductorze — ACP go nie definiuje jako część protokołu agent↔klient (nie ma pojęcia "rejestr wielu agentów", patrz decyzja #1), ale to nie jest luka "czegoś nieistniejącego dziś", tylko luka "ACP nie standaryzuje tego wzorca, który Conductor już ma własnym mechanizmem". Po nawiązaniu połączenia ACP **jest** dwukierunkowe wewnątrz tej jednej sesji: agent może wysyłać żądania do klienta (`session/request_permission`, `fs/read_text_file`/`fs/write_text_file`, `terminal/*`, `elicitation/create`), nie tylko push `session/update` — ale to wciąż w obrębie połączenia, które klient zainicjował, nie nowe wychodzące połączenie inicjowane przez agenta. Zdalny transport HTTP dla samego ACP (nie mylić z MCP-over-HTTP, patrz 4.1/4.3) to osobny RFD "Streamable HTTP & WebSocket Transport" — stan **Active** (przeniesiony z Draft 2026-07-02, zweryfikowane [`rfds/updates`](https://agentclientprotocol.com/rfds/updates.md)), a więc bieżący fokus maintainerów, ale **nie stabilny/completed** — traktować jako niestabilną propozycję w ruchu, nie jako "wciąż Draft". |
| 3 | Durable offer precedes executable run attempt (`wait_resource` przed utworzeniem attemptu) | **Nie** | ACP nie ma pojęcia "runner offline" jako stanu protokołu — połączenie albo istnieje (bo klient je otworzył), albo nie istnieje. Nie ma "durable assignment offer" czekającej na dostępność zdalnego agenta; to czysto orkiestracyjna koncepcja Conductora, zgodna z `retry-policy`'s `resource_wait`, bez odpowiednika w ACP. |
| 4 | Idempotent create/prompt state machine (idempotency key, redelivery, no blind resend) | **Nie** | ACP nie ma **żadnego** pola idempotency-key na `session/new`/`session/prompt` w v1 ani v2. ACP v2 `prompt-lifecycle.md` wprost przyznaje brak gwarancji: "If the response is lost, the submission's outcome remains uncertain: replay may omit live-only or discarded messages, and a retry can create another submission." `messageId`/`toolCallId`/`_meta` służą **korelacji**, nie deduplikacji ([`extensibility.md`](https://agentclientprotocol.com/protocol/v1/extensibility.md): "JSON-RPC id correlation"). Osadzenie `run_id` w treści promptu i poleganie na `conductor_report` jako potwierdzeniu **nie czyni samego `create`/`prompt` idempotentnym** — to obchodzi problem przez zewnętrzny mechanizm (dokładnie taki, jaki Conductor już ma w `answer_delivery`, sekcja 2.6), nie rozwiązanie w warstwie protokołu. Stąd **Nie**, nie "Częściowo" — ACP nie dostarcza żadnego prymitywu w tym kierunku, tylko nazywa problem. |
| 5 | Availability wake-up jako optymalizacja, heartbeat jako correctness | **Nie** | Bez modelu rejestru wieloagentowego (patrz #1) nie ma czego "obudzić" — ACP nie definiuje zdarzenia "nowy agent dostępny". |
| 6 | Error ownership boundary (`compatible_runner_unavailable` jako resource reason, nie operation failure; reszta mapowana do `FailureClass`, bez parsowania tekstu) | **Częściowo** | ACP ma `StopReason` (`prompt-turn.md`: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`) — zamknięty, mały zestaw **konkluzji turnu**, nie ogólna taksonomia błędów wykonania. Błędy transportowe to zwykłe błędy JSON-RPC (kod + `message` string) — bez ustandaryzowanej klasy `transient_upstream`/`capacity`/`timeout` w stylu `retry-policy`. Odwzorowanie na `FailureClass` Conductora nadal wymaga logiki po stronie adaptera (dziś: regex na tekście w `classifyThrownBoundary`, `engine.ts:2279` — a to jest już dziś złamanie własnej zasady "no message parsing", niezależnie od ACP). |
| 7 | Safe status i cancellation (unknown→nie nudge/reap; cancel best-effort, audytowany) | **Częściowo** | Cancellation: `cancellation.md`/`prompt-turn.md` — `$/cancel_request` i `session/cancel` to **best-effort**, "MAY cancel", agent "SHOULD stop... as soon as possible" — zgodne kierunkowo z "best-effort" Conductora, ale **audyt (request+observed result) pozostaje w całości obowiązkiem Conductora** — ACP nie loguje ani nie gwarantuje żadnego trwałego zapisu wyniku anulowania. Status: ACP **nie ma metody `session/status`** w ogóle — jest tylko strumień `session/update` (push) i odpowiedź `session/prompt` na końcu turnu (`stopReason`, tylko w v1; w v2 przez `state_update`). Nie ma sposobu **odpytania** "czy sesja X jest busy/idle/retry/missing" poza obserwowaniem żywego strumienia — a wnioskowanie stanu z historii `session/update` **nie jest** bezpiecznym zamiennikiem: cisza w strumieniu jest równie niejednoznaczna jak dzisiejsza "niepewność" (nie odróżnia "long-running tool" od "utracone połączenie" od "nic nigdy nie miało nadejść"). To istotna luka względem `runner-lifecycle/spec.md` wymogu "Status SHALL distinguish busy, idle, provider-retrying and missing." |
| 8 | Migracja (additive, no rollback destrukcyjny) | **Nie** | Czysto wewnętrzna decyzja Conductora (SQLite migrations) — ACP z definicji nie ma tu żadnej roli, więc pokrycie jest **Nie**, nie "nie dotyczy": ACP nie może pokryć tej decyzji, tak jak nie pokrywa 1/2/3/4/5. |

---

## 4. Tabela pokrycia: requirements trzech specs

### 4.1 `agent-assignment/spec.md` (4 requirements)

| Requirement | ACP | Uzasadnienie |
|---|---|---|
| Every assignment is self-contained (run/attempt ID, cwd, role, prompt, capabilities, reporting instr., lease) | **Częściowo** | `session/new` niesie `cwd` (absolutny, `session-setup.md`: "MUST be an absolute path... MUST remain the base for relative-path resolution") i `mcpServers` — to pokrywa *routing katalogu* i *wstrzykiwanie narzędzi raportujących* (przez MCP server w `mcpServers`). Nie niesie roli/capabilities-wymagań ani leasy — to muszą dołożyć warstwy nad ACP (np. treść promptu, konfiguracja MCP per-run). |
| Unassigned work is durable and visible (offer bez failed run, recoverowalny po restarcie) | **Nie** | Brak odpowiednika — patrz decyzja #3 w sekcji 3. |
| Assignment acceptance is leased and atomic (jeden runner, race dwóch runnerów rozstrzygnięty atomowo) | **Nie** | ACP nie ma modelu wielu kandydujących runnerów per zadanie — klient wybiera *z góry*, którego agenta uruchomić (skonfigurowana komenda/binarka), zanim nawiąże połączenie. Brak "race" w warstwie protokołu. |
| Timeline notes do not trigger inference (best-effort note, failure nie blokuje) | **Nie** | `rfds/session-notices` (Preview, 2026-09-24) wprowadza `notice` — ale jest **od agenta do klienta**, dokładnie odwrotny kierunek od `note()` Conductora (Conductor→sesja agenta). Kierunek jest tu rozstrzygający, nie tylko dojrzałość: nawet gdyby `notice` był stabilny, nie zaadresowałby wymogu "klient dopisuje coś do sesji agenta bez wywoływania inferencji", bo to nie ta strona protokołu. Jedyny kanał klient→agent w ACP to `session/prompt`, który zawsze jest wejściem do modelu. Stąd **Nie**, a nie "Częściowo" — `notice` jest nieistotny (irrelevant) dla tego konkretnego wymogu, nie słabszą wersją go. |

### 4.2 `runner-lifecycle/spec.md` (5 requirements)

| Requirement | ACP | Uzasadnienie |
|---|---|---|
| Runner availability is leased, not assumed (heartbeat, expiry, brak usuwania tożsamości) | **Nie** | Patrz decyzja #1/#5 sekcja 3 — brak modelu rejestru z heartbeatem. |
| Availability changes wake compatible waiting work | **Nie** | Jw. |
| Session creation and prompting are idempotent (idempotency key, redelivery bez duplikatu) | **Nie** | Patrz decyzja #4 sekcja 3 — ACP nie ma żadnego pola idempotency-key; `messageId` koreluje **odpowiedzi agenta**, nie deduplikuje **żądania klienta**. Zero prymitywu w protokole w tym kierunku. |
| Unknown status is handled in the safe direction (busy/idle/retry/missing rozróżnione; brak endpointu → transient error) | **Nie** | Brak metody `session/status` w ACP w ogóle (patrz decyzja #7 sekcja 3) — nie da się "zapytać o niepewność", bo nie da się zapytać wcale. Wnioskowanie z historii `session/update` (streaming) nie jest bezpiecznym zamiennikiem request/response `status()` (patrz sekcja 3, wiersz 7) — to inny model, nie słabsza wersja tego samego. |
| Cancellation is best-effort and audited (request nie czeka na dostępność runnera; audyt request+result) | **Częściowo** | `session/cancel` (notification, nie blokuje na odpowiedzi) + `$/cancel_request` to dokładnie best-effort: "MAY cancel... The calling side MAY implement graceful cancellation processing by waiting for the response" — pasuje do "request nie czeka". Ale **audyt** (trwały zapis request+observed result) jest w całości obowiązkiem Conductora — ACP nie loguje ani nie przechowuje nic z tego; stąd **Częściowo**, nie **Tak**: protokół pokrywa tylko połowę requirementu (mechanikę żądania), nie audytowalność. |

### 4.3 `runner-contract/spec.md` (3 requirements)

| Requirement | ACP | Uzasadnienie |
|---|---|---|
| Runners implement a small versioned contract (version negotiation, capability reg/heartbeat, create/prompt/status/note/cancel) | **Częściowo** | Version negotiation: **częściowo pasuje**, nie w pełni — ACP faktycznie negocjuje wersję (`initialization.md`: "If the Agent supports the requested version, it MUST respond with the same version. Otherwise... the latest version it supports"), ale `runner-contract/spec.md` żąda diagnostyki "both supported **ranges**" przy niekompatybilności — ACP `protocolVersion` to **pojedyncza liczba całkowita głównej wersji** na stronę (dziś `1`), nie zakres wielu wspieranych wersji jednocześnie; diagnostyka "zakres po obu stronach" nie ma więc dokładnego odpowiednika — agent/klient zwraca jedną liczbę, nie listę/zakres, więc ten konkretny fragment requirementu jest tylko **częściowo** wykonalny (samą niekompatybilność da się zgłosić, "zakresy" nie w sensie dosłownym). Create/prompt/cancel: **Tak** jako prymitywy (`session/new`, `session/prompt`, `session/cancel`). Capability registration/heartbeat jako osobny **rejestr** (patrz #1/#5): **Nie**. Status: **Nie** (patrz wyżej). Note: **Nie** (patrz 4.1, kierunek odwrotny). Zbiorczo: rdzeń "sesyjny" (create/prompt/cancel) pokryty, version negotiation częściowo, rdzeń "rejestrowy" (capability/heartbeat/status/note-do-agenta) niepokryty. |
| Capabilities are negotiated before assignment (required tool surface, opaque model binding, brak assignmentu bez kompatybilnego runnera) | **Częściowo** | `initialize` capabilities (`mcpCapabilities.http/sse`, `promptCapabilities.image/audio/embeddedContext`, `sessionCapabilities.{loadSession,resume,close,delete,additionalDirectories}`) negocjują **funkcje protokołu**, nie **zdolności wykonawcze specyficzne dla zadania** (np. "czy ten runner ma dostęp do worktree X"). Kilka rozróżnień doprecyzowujących: (a) **`parentID` NIE jest częścią stabilnego ACP v1** — `session/new` w ACP niesie tylko `cwd`/`mcpServers` ([`session-setup.md`](https://agentclientprotocol.com/protocol/v1/session-setup.md)); "parent session" to własny koncept portu Conductora (`SessionClient.createSession({parentID})`, dzisiejszy wzorzec przez SDK opencode, `engine.ts:491-508`), bez odpowiednika w samym ACP — nie mylić z `session/fork` (wciąż Draft), który jest **czymś innym** (rozgałęzienie historii istniejącej sesji), nie transportem dla `parentID`; adapter ACP musiałby zaimplementować hierarchię rodzic/dziecko poza protokołem (np. przez własną warstwę nad wieloma niezależnymi `session/new`). (b) Model/wariant/tryb **nie są uniwersalnymi identyfikatorami** — `configOptions` z `category: "model"` to *opcjonalny* mechanizm, każdy agent definiuje własne `value`/`id` bez wspólnego słownika między runtime'ami; walidacja jest jednak możliwa **po utworzeniu sesji, przed promptem**: `session/new` może zwrócić initial `configOptions` w odpowiedzi, i/albo `session/set_config_option` zwraca **pełną, aktualną** listę z `currentValue` — Conductor może odczytać ją i **odrzucić przed wysłaniem `session/prompt`**, jeśli żądany model nie figuruje wśród opcji; to nie jest "brak sposobu odrzucić przed próbą", tylko "walidacja jest możliwa dopiero po `session/new`, nie przed nim" — assignment-gating **przed utworzeniem sesji** (na etapie wyboru runnera) pozostaje niemożliwy, walidacja **po utworzeniu, przed promptem** jest możliwa. (c) "Required tool surface" (np. `conductor_report` przez MCP) zależy od tego, czy agent **faktycznie zaakceptował i podłączył** skonfigurowany serwer MCP — `session-setup.md`: "Agents **SHOULD** connect to all MCP servers specified by the Client" (SHOULD, nie MUST) — nie ma potwierdzenia w odpowiedzi `session/new`, że dany serwer MCP jest gotowy/narzędzia widoczne; gotowość trzeba zweryfikować empirycznie (patrz sekcja 7.1 ryzyko OpenCode), nie założyć z samej akceptacji `mcpServers` w żądaniu. Podsumowując: assignment-gating **przed** utworzeniem sesji, w oparciu o wymagane zdolności, pozostaje odpowiedzialnością Conductora — tylko część walidacji (model) da się przesunąć na "po utworzeniu, przed promptem". |
| Runner errors use the shared failure model (stabilna klasa błędu, resource-unavailability ≠ operation failure) | **Częściowo** | Patrz decyzja #6 sekcja 3 — `StopReason` jest zamkniętym zbiorem konkluzji turnu, nie ogólną taksonomią; JSON-RPC error codes (`-32800` Cancelled, standardowe `-32601`/`-32602` itd.) dają strukturę, ale nie klasy w stylu `transient_upstream`/`capacity` — mapowanie nadal wymaga logiki adaptera. |

**Uwaga o liczeniu:** ta notatka celowo **nie** agreguje wierszy sekcji 3
i 4 w jedną liczbę "X/Y pokrycia". Decyzje projektowe (sekcja 3) i
requirementy specs (sekcja 4) nie są jednostkami porównywalnej wagi —
sumowanie ich sugerowałoby precyzję pomiaru, której ta jakościowa
analiza nie ma. Wniosek ilościowy jest prostszy i solidniejszy: **żaden
wiersz w żadnej z dwóch tabel nie jest "Tak" poza cancellation-mechanics
(sekcja 4, częściowo) i version-negotiation/create/prompt/cancel jako
pojedyncze prymitywy sesji (sekcja 4.3, w ramach wiersza ocenionego
całościowo jako Częściowo)** — dominują "Nie" i "Częściowo", co
wystarcza do wniosku w sekcji 10 bez potrzeby sumy liczbowej.

---

## 5. Analizy granic: sześć architektonicznych + uprawnienia/auth/izolacja

Poniższe granice są fundamentalne dla architektury Conductora
(`AGENTS.md`, `openspec/config.yaml`) i **żadna z nich nie jest tym,
czym jest ACP** — mylenie ich prowadzi do architektury, w której ACP
po cichu przejmuje odpowiedzialność, której nie powinien mieć. Sekcje
5.1-5.6 to sześć granic architektonicznych (source-of-truth, czystość
interpretera, własność retry, własność review/gates, end_turn-vs-sukces,
recovery-konwersacji-vs-wykonania). Sekcje 5.7-5.8 dodają dwie granice
operacyjne — uprawnienia/autoryzacja/izolacja oraz tożsamość/lease/nadzór
procesów — które recenzja tej notatki wskazała jako brakujące i które
**nie są zastępowane** przez pozostałe sześć: dotyczą innego pytania
("kto/co wolno agentowi zrobić pod jaką tożsamością, i kto nadzoruje sam
proces", nie "gdzie żyje prawda stanu/efekty/retry/gates").

### 5.1 Prawda stanu: SQLite vs sesja ACP

`AGENTS.md`: "SQLite is the source of truth. Sessions are disposable
executors." ACP nie ma pojęcia trwałości poza opcjonalnym
`session/load` (replay historii) i `session/resume` (bez replay) —
**obie zależą od tego, czy agent sam trzyma trwały stan** (capability
`loadSession`/`sessionCapabilities.resume`, oba opcjonalne, oba mogą być
`false`). ACP **nie gwarantuje**, że jakikolwiek stan przeżyje restart
agenta — to decyzja implementacji agenta, nie protokołu. Conductor już
dziś nie polega na trwałości sesji (`state.sessionId` jest odtwarzane
przez `sessionExists` + rekreację, `engine.ts:484-497`) — to jest zgodne
z ACP, ale **z innego powodu**: Conductor projektuje sesje jako
jednorazowe z założenia, ACP po prostu nie obiecuje trwałości.
**Wniosek: SQLite jako source of truth pozostaje niezmienione; ACP nie
może i nie powinien tego zastąpić — to nie jest jego rola.**

### 5.2 Czystość interpretera: gdzie żyją efekty uboczne

`AGENTS.md`: "Interpreter pure, engine owns I/O. Routing decisions live
in a pure function; all side effects live in the engine/reconciler."
ACP z natury **jest** protokołem efektów ubocznych — `session/prompt`
wywołuje model, agent wykonuje narzędzia i **raportuje** je przez
`tool_call`/`tool_call_update` (obserwacja stanu, nie żądanie wykonania
przez klienta), a `session/request_permission` to żądanie **decyzji**
klienta (allow/deny), nie samo wykonanie akcji — efekt uboczny (np.
zapis pliku) wykonuje agent, dopiero **po** ewentualnym pozwoleniu.
Niezależnie od tego rozróżnienia, ACP jako całość pozostaje protokołem
niosącym efekty uboczne, których interpreter nie powinien dotykać
bezpośrednio. Gdyby interpreter Conductora (funkcja
czysta, decydująca o routingu grafu) zyskał bezpośredni dostęp do
klienta ACP, złamałoby to podział. **Granica pozostaje: interpreter
dalej tylko decyduje "co dalej" (np. `decideResourceWaitRoute`,
`engine.ts:422`), a wywołanie ACP (analog dzisiejszego `sessions.prompt`)
zostaje w `engine.ts`/warstwie I/O, tak jak dziś `SessionClient` jest
wstrzykiwany do silnika, nie do interpretera.** Adapter ACP zastąpiłby
`runner-opencode`/`runner-transport.ts` jako **implementację portu**,
nie zmienił architektury warstw.

### 5.3 Własność retry / failure-classification: `retry-policy` vs ACP

`runner-contract/spec.md`: "The engine SHALL apply the generic policy
from `retry-policy` and SHALL NOT parse message text." `retry-policy`
(**shipped**, 25/25) już dostarcza `FailureClass`, budżety
tries-and-elapsed, `resource_wait`, `recover()` z optimistic concurrency
(`engine.ts:1490-1529`). ACP `StopReason` (5 wartości) i JSON-RPC error
codes **nie są** i nie mogą być taksonomią retry — nie niosą hintów
retry (`retry hint` z `runner-contract` requirement "Provider outage is
classified" nie ma odpowiednika w ACP poza swobodnym tekstem błędu).
**Każdy adapter ACP musi tłumaczyć swoje błędy na `FailureClass` po
stronie Conductora — dokładnie tak, jak dziś robi to (źle, przez regex)
`classifyThrownBoundary`.** ACP nie przejmuje i nie powinien przejąć
własności retry.

### 5.4 Własność review/findings lifecycle i human gates

Structured review (`conductor report --review`, findings z ID/severity/
blocking/acceptanceTests — `tools.ts` `createReportTool`, pełny schemat
w `plugin.ts:40-78`) oraz human gates (`approve`/`requestChanges`,
`conductor_approve`/`conductor_request_changes`, `plugin.ts:164-190`) są
**w pełni własnością Conductora** — stan żyje w SQLite (`findings` table,
`store.listFindings`), przejścia idą przez `dispatch()` interpretera
(`human.paused`/`human.abandoned`/analogiczne dla approve). ACP nie ma
pojęcia "finding", "review verdict" ani "approval gate" jako pierwszej
klasy — to co ACP ma najbliższego to `session/request_permission`
(pojedyncze tool-call, per-akcja, nie per-run gate) i **elicitation**
(`elicitation/create`, stabilne od 2026-07-24). Elicitation jest jednak
**UI-interaction**, nie durable gate: żądanie jest scoped do żywego
połączenia agent↔klient (`elicitation.md`: "Agents MUST bind each
elicitation and related state to the receiving Client connection"),
**nie przeżywa restartu**, nie ma budżetu/audytu w stylu findings, i
explicite nie jest execution-authority ("An accept response means the
user consented to open the URL. It does not mean the external
interaction completed"). **Human gates i findings lifecycle pozostają w
100% po stronie Conductora; ACP elicitation nie jest ich substytutem —
to inna warstwa (per-tool-call UI prompt vs per-run durable approval
state machine).**

### 5.5 `end_turn` (StopReason) ≠ sukces zadania

To jest **najbardziej niebezpieczna** potencjalna pomyłka projektowa.
ACP v1 `prompt-turn.md`: `stopReason: "end_turn"` oznacza wyłącznie "The
language model finishes responding without requesting more tools" —
**nic o tym, czy zadanie zostało wykonane poprawnie, czy w ogóle
zaraportowane**. ACP v2 `prompt-lifecycle.md` to samo, plus explicite:
"A successful prompt response is not an `idle` signal" (dla `session/
prompt` samego w sobie) i osobno definiuje `idle` `state_update` jako
koniec foreground-worku — ale **żaden z tych sygnałów nie jest
Conductorowym `run.status = "succeeded"`**. Conductor już dziś **celowo
nie** wnioskuje sukcesu z `status: idle` (`sessions.status()`) — najbliższy
autorytatywny sygnał to jawne wywołanie `report()` (`engine.ts:1013`,
guard `if (run.status !== "running") return alreadyConcludedText(...)`)
przez agenta z `outcome`/`verdict`. Ale nawet to trzeba doprecyzować, nie
upraszczać do "report/ask = zakończone":

- `report(..., ask: question)` **NIE kończy runu** — wprost przeciwnie,
  **zawiesza** go: `store.setRunQuestion` (`engine.ts:1050`) zostawia
  run w stanie `running` i czeka na odpowiedź człowieka jako nowy prompt;
  to jest "koniec turnu, nie koniec zadania" (patrz niżej, uzupełnienie
  sekcji 6), nie sukces ani porażka.
- Run **może zakończyć się bez żadnego `report()` od agenta w ogóle** —
  `reap()` (`engine.ts:2112-2135`) konkluduje run jako `"reaped"` po
  przekroczeniu TTL ciszy, niezależnie od tego, czy agent kiedykolwiek
  zawoła `conductor_report`. Autorytatywność `report()` jest więc
  warunkowa: jest jedynym **pozytywnym** sygnałem sukcesu, ale **nie**
  jedynym sposobem, w jaki run się kończy — reap i inne ścieżki
  `concludeAndDispatch` (błąd promptu, `step.failed`) kończą run bez
  udziału agenta.

Gdyby adapter ACP zaczął traktować `stopReason: "end_turn"` samo w sobie
jako sygnał zakończenia **kroku** (sukcesu), złamałby to dokładnie tę
zasadę — end_turn to **zdarzenie modelu językowego** (koniec turnu
promptu), `report()` to **zdarzenie protokołu biznesowego Conductora**
(koniec zadania), a nieotrzymanie żadnego z nich prowadzi do reap, nie do
domyślnego sukcesu. **Wniosek: adapter ACP musi nadal czekać na jawny,
pozytywny `report()` (przez MCP tool run-scoped, patrz sekcja 6) dla
sukcesu, i pozostawić TTL/reap jako jedyną ścieżkę dla ciszy — nigdy nie
inferować sukcesu z samego `stopReason`.**

### 5.6 Recovery konwersacji ≠ recovery wykonania

`session/load` (replay pełnej historii przed odpowiedzią) i `session/
resume` (bez replay, "MUST NOT replay... restores the session context...
returns once ready") to **recovery połączenia/kontekstu konwersacji** —
odpowiadają na pytanie "jak wrócić do rozmowy z tym samym agentem". To
**nie jest** to samo co "recovery wykonania kroku workflow" — czyli
pytanie, które zadaje `retry-policy`: czy dany `run`/`attempt` zakończył
się, czy trzeba go ponowić, z jakim budżetem, z jaką klasą błędu.
Dowód wprost z ACP v2: "If the response [do `session/prompt`] is lost,
the submission's outcome remains uncertain: **replay may omit live-only
or discarded messages, and a retry can create another submission**." —
ACP **przyznaje**, że nawet mając `session/load`, nie da się bezpiecznie
odtworzyć "czy dany prompt doszedł" bez dodatkowego mechanizmu poza
protokołem. Doprecyzowanie roli `messageId`/`load`, żeby nie
uogólniać ponad to, co spec faktycznie mówi:

- `messageId`/`toolCallId`/`_meta` służą **korelacji żądanie↔odpowiedź**
  — to nie jest ograniczone tylko do jednego, wciąż-żywego połączenia:
  jeśli agent retencjonuje i replayuje wiadomość (przy `session/load`),
  MUSI użyć **tego samego** `messageId` co przy oryginalnym wysłaniu
  (`session-setup.md`/`prompt-lifecycle.md`: "If the message is retained
  and replayed, the Agent MUST use the same ID") — więc identyfikator
  *może* przetrwać między połączeniami, o ile agent zdecyduje się
  przechowywać historię. To, czego brakuje, to **deduplikacja żądania
  klienta** (idempotency-key po stronie `session/prompt`), nie
  korelacja odpowiedzi jako taka — te dwie rzeczy nie są tożsame.
- `session/load`, tam gdzie agent **wspiera** `loadSession` (capability
  opcjonalna), **faktycznie dostarcza trwałą historię konwersacji** —
  to nie jest "ACP nigdy nie gwarantuje trwałości" w sposób blankietowy;
  to jest "trwałość jest opcjonalną capability, zależną od
  implementacji agenta", co jest różnicą ważną dla oceny per-agent w
  sekcji 7 (który z trzech kandydatów faktycznie ją wspiera i jak
  długo). To, czego `session/load`/`session/resume` **nie** gwarantują,
  to nie sama trwałość kontekstu (którą, gdy wspierana, dostarczają), a
  **potwierdzenie, że efekty uboczne zgłoszone w tej historii faktycznie
  wystąpiły dokładnie raz** — replay/resume odtwarza **kontekst
  rozmowy**, nie audytuje **skutki w świecie zewnętrznym** (pliki,
  commity, wywołania narzędzi). To rozróżnienie — kontekst vs efekty —
  jest sednem tej granicy, nie brak trwałości per se.

**Wniosek: `session/resume`/`session/load`, tam gdzie wspierane, mogą
faktycznie pomóc wznowić rozmowę i kontekst z agentem po utracie
połączenia transportowego, ale to nie rozwiązuje wykonania. Conductor
nadal potrzebuje własnego mechanizmu (idempotency key/delivery_token w
stylu dzisiejszego `answer_delivery`, sekcja 2.6) — ale nawet ten
mechanizm **koreluje próby dostawy**, ale bez deduplikacji i dowodu po
stronie odbiorcy nie potwierdza nawet dostarczenia dokładnie raz.
**Nie dowodzi też sam z siebie**, że efekt uboczny w świecie
zewnętrznym wystąpił dokładnie raz: token bez efekt-specyficznego dowodu
(np. sprawdzenia stanu repo/PR) zostawia crash-po-efekcie-przed-raportem
w stanie **nieznanym** (patrz sekcja 6, "Krytyczne zastrzeżenie") — ACP
dostarcza (opcjonalnie) recovery kontekstu/konwersacji; ani ACP, ani sam
token korelacyjny nie dostarczają audytu wykonania i jego efektów.**

### 5.7 Uprawnienia, autoryzacja, izolacja (headless daemon, deny-default)

Conductor uruchamia agentów **bez interaktywnego człowieka przy
klawiaturze** — to jest headless orchestrator, nie IDE. ACP zakłada w
wielu miejscach obecność klienta z UI (Zed, edytor) i **nie** definiuje
sam z siebie bezpiecznej postawy dla headless-hosta. Ta granica jest
osobna od 5.1-5.6: dotyczy tego, **co wolno agentowi zrobić i pod jaką
tożsamością**, nie tego, gdzie żyje prawda stanu.

- **`cwd` to granica konwencji, nie sandbox.** `session-setup.md`:
  "This root set **SHOULD** serve as a boundary for tool operations on
  the file system" — `SHOULD`, nie `MUST`, i "boundary for tool
  operations" nie jest równoznaczne z hermetyczną izolacją procesu.
  ACP nie sandboxuje niczego samo z siebie — `cwd`/`additionalDirectories`
  to instrukcja dla *grzecznego* agenta, nie wymuszenie na poziomie OS.
  Rzeczywista izolacja (namespace/chroot/kontener/uprawnienia
  systemowe) musi pochodzić z **hosta uruchamiającego proces agenta**
  (dzisiejszy `PluginProcessSpawner`, `ports.ts:101-103, w kontekście
  długo-żyjących procesów), nie z ACP.
- **`session/request_permission` jest opcjonalne po stronie agenta, nie
  uniwersalne wymuszenie.** `tool-calls.md`: "The Agent **MAY** request
  permission from the user before executing a tool call" — `MAY`, nie
  `MUST`. Agent, który uzna, że dane narzędzie nie wymaga potwierdzenia
  (albo jest źle zaimplementowany), po prostu je wykona bez pytania.
  Conductor **nie może polegać** na `request_permission` jako jedynej
  linii obrony dla headless-runu — potrzebuje własnej, deny-default
  polityki (np. sandboxing procesu, allowlist katalogów, brak dostępu
  do sieci poza tym co jawnie dozwolone) **niezależnej** od tego, czy
  konkretny agent zapyta.
- **Autoryzacja providera ≠ autoryzacja uruchomienia (run authorization).**
  `authentication.md` reguluje wyłącznie to, czy agent ma ważne
  poświadczenia do swojego modelu/API (`authenticate`, `authMethods`,
  `logout`) — to pytanie "czy ten agent może w ogóle rozmawiać z
  providerem", zupełnie osobne od pytania Conductora "czy **temu
  runowi/temu workflow** wolno tu wykonać to zadanie w tym repo".
  ACP nie ma pojęcia autoryzacji na poziomie run/attempt — to musi
  pozostać wyłącznie po stronie Conductora (np. dzisiejszy
  `CONDUCTOR_RUNNER_TOKEN`/`timingSafeEqual` w `hub.ts:66-70`, albo
  jego odpowiednik w warstwie MCP-report, patrz sekcja 6).
- **Deny-default, bounded, headless czekanie na potwierdzenie.** Skoro
  `request_permission` jest opcjonalne i UI-owe z natury (klient
  "prezentuje" opcje użytkownikowi), headless-hosting Conductora musi
  **sam** odpowiadać na te żądania (albo automatyczną polityką
  allow/deny, albo eskalacją do człowieka przez istniejący mechanizm
  `conductor_ask`/human-gate, nie przez czekanie w nieskończoność na
  UI, którego nie ma) — z jawnym, ograniczonym w czasie timeoutem, nie
  nieskończonym blokowaniem połączenia ACP.
- **Ograniczenia OS/proces/env/sieć pozostają poza ACP w całości.**
  Protokół nie ma pojęcia limitów zasobów, ograniczeń sieciowych,
  ograniczeń zmiennych środowiskowych przekazywanych do subprocessu,
  ani nadzoru nad drzewem procesów. Wszystko to jest — i pozostaje —
  odpowiedzialnością warstwy hostującej Conductora (uruchamiającej
  proces agenta/adaptera), analogicznie do dzisiejszego
  `PluginProcessSpawner`/`ProcessRunner`.

**Wniosek: ACP nie dostarcza ani sandboxu, ani wymuszonej autoryzacji
uruchomienia, ani polityki OS/sieć/proces. Deny-default nie jest dziś w
pełni zaimplementowane nawet dla `runner-opencode` — token-auth na
callbacku istnieje (`hub.ts:66-70`), ale katalog-routing (`hub.ts:247-258`,
`sessionsForDirectory`) **spada na pierwszy zarejestrowany projekt w
kolejności sortowania**, gdy żądany katalog leży poza wszystkimi
zarejestrowanymi rootami, zamiast odrzucić żądanie — to jest
permisywny fallback, nie enforced allowlist. Adapter ACP musi więc nie
tylko "importować" istniejące założenia, ale **faktycznie domknąć** tę
lukę (odrzucać, nie fallbackować, poza zadeklarowanym `cwd`/rootami) —
ACP samo tego nie zastępuje ani nie osłabia wymogu, ale też nie
rozwiązuje go za Conductora.**

### 5.8 Tożsamość, lease i nadzór procesów — trwałość pozostaje po stronie Conductora

Uzupełnienie 5.1/5.7 skupione konkretnie na **procesie**, nie tylko na
danych: ACP identyfikuje **połączenie i sesję** (`sessionId` zwrócony z
`session/new`), nie **proces systemu operacyjnego**. Kilka konsekwencji:

- **Brak identity opartej o PID.** Subprocess uruchomiony przez klienta
  po stdio nie ma stabilnego identyfikatora przeżywającego restart —
  `sessionId` jest własnością ACP (opcjonalnie trwałą, jeśli agent
  wspiera `loadSession`/`resume`), ale **proces**, który go obsługiwał,
  ginie i jest zastępowany nowym przy każdym restarcie klienta. Fencing
  (zapobieganie temu, by dwa procesy dla tej samej logicznej pracy
  działały równocześnie i kolidowały) nie jest częścią ACP — musi być
  zbudowany przez hosta (Conductor). Dzisiejszy `RunnerRegistry`
  (sekcja 2.3) **nie jest** przykładem gotowego rozwiązania tego
  problemu — jest keyed po endpoincie, **w pamięci procesu**, nie
  durowały ani stabilny poza restartem (luka #1 w sekcji 3); to raczej
  ilustracja, że nawet dzisiejszy, nie-ACP-owy mechanizm jeszcze nie
  rozwiązał fencing/stabilnej tożsamości — punkt, który adapter ACP
  odziedziczyłby jako otwarty problem, nie jako coś, co Conductor już
  ma gotowe i tylko trzeba podłączyć.
- **Nadzór drzewa procesów jest zadaniem hosta, nie ACP.** Gdy klient
  anuluje (`session/cancel`) albo terminuje połączenie, ACP nie
  gwarantuje, że **cały** proces potomny (i jego własne pod-procesy,
  np. narzędzia uruchomione przez agenta) rzeczywiście zginął —
  protokół mówi tylko o stanie sesji/turnu (`cancelled` stop reason),
  nie o stanie procesu OS. Weryfikacja drzewa procesów pozostaje
  obowiązkiem hosta (patrz scenariusz spike'a 8.3 punkt 9).
- **Żadna trwałość nie jest automatyczna.** Nawet gdy agent wspiera
  `loadSession`/`resume`, to *jego* wybór implementacyjny, czy i jak
  długo trzyma stan — ACP nie narzuca ani nie gwarantuje okresu
  retencji. Conductor nie może założyć, że "skoro agent zadeklarował
  `resume`, to stan przetrwa restart" — to zależy wyłącznie od
  implementacji agenta, weryfikowalne tylko empirycznie (spike,
  scenariusz 8.3 punkt 5/6).

**Wniosek: durowała tożsamość, fencing i nadzór procesu pozostają w
100% odpowiedzialnością Conductora (hosta) — ACP identyfikuje
połączenia/sesje, nie procesy systemowe, i nie obiecuje trwałości poza
tym, co dany agent sam zdecyduje się zaimplementować.**

---

## 6. Rekomendacja: adapter, nie konkurencyjny protokół

**Nie budować** drugiego wire protocol równoległego do `SessionClient`/
`runner-protocol`. Zamiast tego, jeśli Etap 2 (spike) wypadnie pozytywnie:

- **Preserve (bez zmian):** SQLite jako source of truth (5.1); interpreter
  pure / engine owns I/O (5.2); `retry-policy` jako jedyny właściciel
  `FailureClass`/budżetów/`resource_wait` (5.3); findings lifecycle i
  human gates jako stan Conductora, nie ACP (5.4); `conductor_report` jako
  jedyny autorytatywny sygnał sukcesu, nie `stopReason` (5.5); furtka
  natywnej integracji (`SessionClient` bezpośrednio nad SDK runtime'u, jak
  dziś `runner-opencode`) pozostaje dostępna — ACP jej nie zastępuje
  siłowo dla runtime'ów, które mają lepszą natywną integrację.
- **Change (adapter implementuje port, port się nie zmienia radykalnie):**
  Punktem odniesienia dla ewentualnego adaptera powinno być **stabilne
  v1**, nie draft v2 — v2 jest w Draft (od 2026-07-20) i jego semantyka
  ("acceptance means insertion, not completion", `prompt-lifecycle.md`)
  **nie jest** tym, co v1 gwarantuje. W v1 `session/prompt` **jest
  długo-żyjącym żądaniem** ([`prompt-turn.md`](https://agentclientprotocol.com/protocol/v1/prompt-turn.md):
  odpowiedź z `stopReason` przychodzi dopiero **na końcu turnu**, po
  wszystkich `session/update`) — adapter nie może traktować lokalnego
  wysłania żądania jako równoważnego trwałemu potwierdzeniu przyjęcia;
  jedyne, co v1 gwarantuje od razu, to że żądanie zostało wysłane, nie że
  zostało "zaakceptowane" w sensie v2. `runner-opencode`-style adapter dla
  ACP implementowałby **ten sam** `SessionClient` (ew. rozszerzony
  `runner-protocol` port, gdy ten powstanie) nad połączeniem ACP zamiast
  nad SDK opencode: `createSession` → `session/new`; `prompt` →
  `session/prompt` (długo-żyjące w v1, nie fire-and-forget); `abort` →
  `session/cancel`. Osobne, nie pojedyncze 10s (jak dzisiejszy
  `runner-transport.ts:57`), budżety czasowe są konieczne per operację:
  **startup** (uruchomienie/połączenie z procesem agenta), **write**
  (dostarczenie pojedynczego żądania JSON-RPC), **turn** (cały
  `session/prompt` do `stopReason` — może trwać minuty), **cancel**
  (oczekiwanie na potwierdzone `cancelled` po `session/cancel`) — jeden
  wspólny timeout myliłby "agent long-running" z "połączenie martwe".
  `status`/`sessionExists` → **nie mają portable, wspólnego dla wszystkich
  agentów odpowiednika** (luka potwierdzona sekcja 3 wiersz 7, sekcja 4.2)
  — jedyna droga to (a) wnioskowanie z historii `session/update`
  utrzymywanej w adapterze, co **nie jest bezpiecznym zamiennikiem**
  (cisza w strumieniu nie odróżnia "agent liczy" od "połączenie zerwane"
  — nie inferować "idle"/"missing" z samej ciszy transkryptu), albo (b)
  rozszerzenie przez `_`-prefiksowaną metodę custom (`extensibility.md`),
  co jest z definicji **nieportable** między agentami, które jej nie
  implementują — każdy z trzech kandydatów w sekcji 7 musiałby być
  weryfikowany osobno, nie założony. Raportowanie
  (`conductor_report`/`conductor_ask`) przechodzi przez **MCP server
  run-scoped**, wstrzyknięty przez `mcpServers` w
  `session/new`/`session/load`/`session/resume` po stdio (baseline, MUST
  wspierane przez każdego agenta ACP — `session-setup.md`; HTTP nagłówki
  auth są dostępne jako opcja transportu MCP, ale same MCP-HTTP/SSE
  capabilities są opcjonalne po stronie agenta, nie MUST) — **nie** przez
  dzisiejszy model "narzędzia pluginu opencode wołające HTTP API" (2.5),
  bo to jest opencode-specyficzne, nie ACP. MCP-tool-surface eksponowany
  agentowi powinien ograniczać się do `report`/`ask` (i odczytu statusu
  własnego runu) — **nie** do `approve`/`request_changes`/admin-owych
  operacji: broad admin-scope przez narzędzie wywoływane przez sam
  wykonywany agent byłby odwróceniem granicy z 5.7 (agent przyznający
  sobie uprawnienia). Same wywołania MCP powinny trafiać do **tego
  samego** istniejącego API daemona/SQLite (`ApiClient`/`store`), nie do
  równoległej ścieżki prawdy — MCP-server jest tu transportem, nie nowym
  źródłem stanu.
- **Replace (jedyny kandydat na wymianę):** transport `runner-opencode`
  (dzisiejszy `hub.ts`/`sessions.ts`, callback HTTP daemon→runner) **dla
  runtime'ów, które mają maintained adapter ACP** — ale to decyzja per
  runtime (patrz sekcja 7), nie blanket replacement, i wymaga rekoncyliacji
  z `runner-protocol` (ten sam kontrakt wersji/capabilities/lease, albo
  jawne zamknięcie wybranych jego decyzji jako zastąpionych przez granicę
  ACP+MCP-report — **nigdy cichej duplikacji**).

### Uzupełnienie: zakres poświadczeń MCP-report i higiena logów stdio

Jeśli raportowanie przechodzi przez MCP server run-scoped (wyżej), kilka
dodatkowych warunków musi być spełnionych, niezależnie od ACP:

- **Poświadczenie scoped do pojedynczego attemptu**, nie do sesji/agenta
  ogólnie — token/klucz wstrzyknięty do konfiguracji MCP powinien
  identyfikować dokładnie `run_id`/`attempt`, analogicznie do dzisiejszego
  `delivery_token` (sekcja 2.6), żeby duplikat/nieaktualne wywołanie dało
  się jednoznacznie odrzucić po stronie daemona (walidacja stale/duplicate
  musi żyć w Conductorze — MCP transport tego nie daje za darmo).
- **`session-setup.md` MCP stdio niesie `env`** (zmienne środowiskowe
  przekazywane do procesu serwera MCP) — jeśli poświadczenie trafia tą
  drogą, musi być traktowane jak sekret: nigdy nie logować argumentów/env
  procesu MCP wprost (ten sam wymóg redakcji, jaki dzisiejszy
  `boundDiagnostic` już stosuje do komunikatów błędów, `engine.ts:537-546`).
- **Rozróżnić `mcpCapabilities.http` (ACP, opcjonalne dla agenta) od
  "ACP przez HTTP" (transport samego ACP, wciąż RFD w stanie Active, nie
  stabilny)** — to dwie różne rzeczy: pierwsze to zdolność agenta do
  łączenia się z serwerami MCP po HTTP (część stabilnego ACP v1), drugie
  to hipotetyczny zdalny transport dla samego połączenia klient↔agent
  (patrz sekcja 3, wiersz 2) — nie mylić dojrzałości jednego z drugim.

### Krytyczne zastrzeżenie: durowałość MCP-report ≠ automatyczna idempotencja

Durable MCP report (agent wywołuje `conductor_report` przez run-scoped MCP
tool) **commituje wynik** do SQLite z tym samym rygorem co dziś
(`WHERE status = 'running'` guard, `run_already_concluded` na duplikat —
`tools.ts` `describeError`/`ApiError` obsługa). To rozwiązuje "czy wynik
dotarł", **nie** rozwiązuje "czy efekt uboczny (np. `git commit`, `gh pr
create` wykonany przez agenta) wystąpił dokładnie raz". Crash **po**
zdalnym efekcie, **przed** zapisem raportu, zostawia stan **UNKNOWN** —
wymaga dowodu (np. sprawdzenia repo/PR), fencing tokena, albo eskalacji do
człowieka — **nie** ślepego retry. To jest dokładnie ten sam problem,
który `retry-policy`/`runner-protocol` już projektują generalnie
(`resource_wait`, `recover()` z operator-selected target) — ACP niczego
tu nie zmienia i nie upraszcza.

### `conductor_ask` / human gates: koniec turnu ≠ koniec zadania (uzupełnienie 5.5)

`conductor_ask` (`plugin.ts:135-154`) kończy prompt turn (agent kończy
turn, sesja zostaje żywa, odpowiedź człowieka przychodzi jako **nowy**
prompt) — to jest wzorzec, który **pasuje** do ACP: `end_turn` faktycznie
kończy turn, a odpowiedź to nowy `session/prompt`. To jest jedyne miejsce,
gdzie `end_turn` i "task paused pending human" są zgodne z zamiarem — ale
**tylko dlatego, że Conductor explicite differencjuje "koniec turnu" od
"koniec zadania"** (durable `answer_delivery`, sekcja 2.6, nie polega na
tym, że sesja "pamięta", że czeka). Elicitation ACP (5.4) **nie** powinna
zastąpić tego mechanizmu — elicitation jest scoped do żywego połączenia i
nie ma delivery-token/retry-schedule w stylu `answer_delivery`.

---

## 7. Per-agent go/no-go + spike na tym samym zadaniu

### 7.1 OpenCode — natywny ACP

- **Wersja:** `opencode-ai@1.18.32` (npm, zweryfikowane 2026-09-25).
  Komenda: `opencode acp --cwd <ABS>` (natywna, wbudowana w binarkę
  `opencode`, brak zewnętrznego adaptera pośredniczącego). Dokumentacja: <https://opencode.ai/docs/acp/>,
  <https://opencode.ai/docs/cli/>. Źródło (tag `v1.18.32`):
  <https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/acp/service.ts>.
- **Capabilities zaobserwowane:** `load`/`list`/`resume`/`close`/`fork`
  advertised — ale `fork` jest **wciąż draft** w samym ACP (`rfds/updates`:
  "session/fork RFD moves to Draft stage", 2025-11-20, brak stabilizacji
  do 2026-09-25) — advertising draft-capability jest ryzykiem
  interoperacyjności, nie powodem do odrzucenia natywnego OpenCode.
  MCP HTTP/SSE: wspierane.
- **Ryzyko:** rejestracja MCP servera jest **directory-scoped, nie
  session-scoped** w źródle serwisu, i **ignoruje niektóre błędy** przy
  łączeniu — to podważa gwarancję "readiness narzędzia raportującego
  przed pierwszym promptem" (`agent-assignment` requirement "Required
  tool surface unavailable"). Wymaga jawnego testu w spike'u: czy
  `conductor_report`-MCP jest gotowy, zanim agent może go wywołać, czy
  trzeba pollować/czekać.
- **Auth:** `opencode-login` zwraca sukces, ale **zewnętrzny provider
  auth nadal wymagany** osobno (nie jest to "magic" auth via ACP).
- **Abort:** błędy abortu są **połykane** (swallowed) w źródle — trzeba
  obserwować faktyczny `cancelled` stop reason / stan procesu, nie ufać
  samemu wywołaniu `session/cancel` jako dowodowi.
- **Go/No-Go: GO** (natywny, aktywnie rozwijany, najniższe ryzyko
  dodatkowego procesu-pośrednika) — **warunek:** spike musi zweryfikować
  MCP-readiness i faktyczny efekt `session/cancel` (nie tylko brak błędu).

### 7.2 Codex — warunkowy GO (maintained adapter, nie natywny)

- **Codex CLI natywnie NIE jest ACP** — `codex app-server`
  (<https://developers.openai.com/codex/cli/reference/>, CLI 0.157.0) to
  osobny protokół, nie ACP. Stary `zed-industries/codex-acp` **przekierowuje**
  na maintained `agentclientprotocol/codex-acp`.
- **Wersja adaptera:** `@agentclientprotocol/codex-acp@1.13.1` (npm,
  zweryfikowane 2026-09-25) deklaruje zależność `@openai/codex@^0.156.1` w
  swoim `package.json` — dla wersji `0.x`, semver caret zamyka zakres na
  poziomie patch (`^0.156.1` = `>=0.156.1 <0.157.0`), więc ten
  zadeklarowany zakres **wyklucza** `0.157.0` — zaobserwowaną w tej
  notatce wydaną wersję Codex CLI (sekcja 7.2 pierwsza pozycja). Adapter
  i aktualnie wydany Codex CLI mogą więc **nie być deklarowanie
  kompatybilne** — to nie jest potwierdzona niezgodność (adapter mógł
  faktycznie działać mimo węższej deklaracji, albo autorzy jeszcze nie
  zaktualizowali zakresu), ale jest to sygnał do zweryfikowania w
  spike'u, nie do zignorowania. **Dwa pinowania wymagane w spike'u**:
  wersja adaptera ORAZ faktycznie zweryfikowana, kompatybilna wersja
  binarki Codex (`CODEX_PATH`, prawdopodobnie `0.156.x`, do potwierdzenia
  empirycznie, nie z założenia) — nie zakładać zgodności z żadnej strony
  bez testu. Źródło (commit `b1b8490cd165c18626dc3fe83836cdacdef94cd3`):
  <https://github.com/agentclientprotocol/codex-acp/blob/b1b8490cd165c18626dc3fe83836cdacdef94cd3/src/CodexAcpServer.ts>.
- **Capabilities:** `load`/`resume`/`list`/`close`/`fork`/`delete`
  advertised; MCP HTTP **true**, SSE **false**.
- **Uruchomienie:** przyszła komenda pinowana (binarka jawnie
  zainstalowana) lub `npx -y @agentclientprotocol/codex-acp@1.13.1` —
  **nie wykonane w tej notatce** (poza zakresem Etapu 1, read-only).
- **Auth:** ChatGPT-login **lub** `CODEX_API_KEY` z pierwszeństwem nad
  `OPENAI_API_KEY` — wymaga **jawnego wyboru metody** przed spikem;
  `NO_BROWSER` ukrywa login, nie zastępuje autoryzacji ("no auth magic").
- **Ryzyko:** proces pośredniczący (adapter) to **dodatkowa warstwa
  awarii** poza samym Codex CLI — crash adaptera ≠ crash Codex, wymaga
  osobnej obserwacji w spike'u (proces-tree, nie tylko połączenie ACP).
  Nie generalizować z tego adaptera na "background tasks"/rozszerzenia
  Codex — poza zakresem tej notatki.
- **Go/No-Go: WARUNKOWY GO** — warunek: przypięcie **obu** wersji
  (adapter + `CODEX_PATH`), jawny wybór metody auth, test restartu procesu
  potomnego Codex niezależnie od procesu adaptera ACP.

### 7.3 Gemini — warunkowy GO (natywna flaga)

- **Wersja:** `@google/gemini-cli@0.61.0` (npm, zweryfikowane
  2026-09-25), wymaga Node ≥20. Komenda: `gemini --acp` (natywna flaga;
  `--experimental-acp` **deprecated** wg
  <https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/config/config.ts>).
- **Rozbieżność dokumentacja vs kod:** przewodnik
  (<https://github.com/google-gemini/gemini-cli/blob/v0.61.0/docs/cli/acp-mode.md>)
  opisuje "MCP initialize", ale kod dispatchera
  (<https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/acp/acpRpcDispatcher.ts>)
  pokazuje `session new`/`session load` — **dokumentacja nie odzwierciedla
  dokładnie ścieżki kodu**, wymaga weryfikacji w spike'u, nie ufania
  samemu przewodnikowi.
- **Capabilities zaobserwowane w dispatcherze:** `load` **true**, MCP
  HTTP/SSE **true**. (`session/new` nie jest osobną negocjowaną
  capability — to część bazowego zestawu metod, które **każdy** agent ACP
  MUST wspierać: `initialization.md`, "As a baseline, all Agents MUST
  support `session/new`, `session/prompt`, `session/cancel`, and
  `session/update`" — nie wymaga potwierdzenia w dispatcherze.) `list`/
  `resume`/`close` **nie są explicite advertised** w dispatcherze —
  traktować jako niewspierane do potwierdzenia w spike'u: zgodnie z ACP
  ("Clients MUST NOT attempt to call" nieadvertised opcjonalną metodę)
  brak advertised capability oznacza **brak fallbacku** — nie zakładać,
  że operacja "może zadziałać mimo wszystko", tylko że jest niedostępna,
  dopóki spike nie potwierdzi inaczej.
- **Model API:** legacy unstable model API (poprzedzająca usunięty
  `session/set_model`, ACP `rfds/updates` 2026-06-01) — **nie portable**,
  wymaga adapter-specyficznej obsługi wyboru modelu, nie ogólnego
  `configOptions`.
- **Ryzyko odtworzenia (nie zweryfikowany bug, wymaga testu):**
  <https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/acp/acpSessionManager.ts>
  — replay historii przy `load` **nie jest awaitowany** w pozornej ścieżce
  kodu — to może (nie potwierdzone) prowadzić do race'a w kolejności
  zdarzeń przy `session/load`. **Wymaga jawnego testu w spike'u**, nie
  założenia ani w jedną, ani w drugą stronę.
- **Auth:** API key **lub** Vertex/cached login — izolować ustawienia
  (<https://geminicli.com/docs/get-started/authentication/>), jawnie wybrać
  metodę **przed** spikem, bo `load` może wymagać zapisanej wcześniej
  metody.
- **Nie testowano:** żadnych płatnych wywołań modelu w ramach tej
  notatki.
- **Go/No-Go: WARUNKOWY GO** — warunek: zweryfikować w spike'u (a) czy
  `acp-mode.md` faktycznie opisuje realną ścieżkę kodu czy jest
  nieaktualny, (b) kolejność zdarzeń przy `session/load` (race czy nie),
  (c) które capabilities są faktycznie advertised na żywo (nie tylko w
  źródle na dany tag).

### 7.4 Podsumowanie: ten sam mały spike na wszystkich trzech

Warunek Etapu 2 z `docs/development-roadmap.md` — "ten sam mały zadaniowy
task na OpenCode/Codex/Gemini przez ACP" — patrz sekcja 8 dla pełnej
specyfikacji środowiska, scenariuszy i kryteriów sukcesu. Żaden z trzech
agentów nie jest dyskwalifikujący sam z siebie; OpenCode ma najniższe
ryzyko (natywny, brak pośrednika), Codex i Gemini wymagają dodatkowych
warunków przed uruchomieniem spike'a, nie po jego rozpoczęciu.

---

## 8. Specyfikacja spike'a (Etap 2 — nie wykonane w tej notatce)

### 8.1 Środowisko

- **Osobny, jednorazowy (disposable) worktree**, poza `main`, nieintegrowany
  z żadnym pakietem workspace. Nie modyfikować `packages/*`.
- **Jeden proces/attempt** — izolacja profilu na runtime (żaden agent nie
  dzieli katalogu/profilu z innym w trakcie testu, poza jawnym scenariuszem
  8.3 "izolacja tego samego `cwd`").
- **Tymczasowa baza SQLite** (nie produkcyjna, nie `gloam-idle`), zgodna
  ze schematem `answer_delivery`/`runs` jeśli spike odtwarza tę część, albo
  minimalny log efektu, jeśli spike jest czysto protokolarny.
- **Zamockowany MCP-report jako pierwszy krok** — dopiero po zweryfikowaniu
  mechaniki na mocku, przejść do prawdziwych agentów; **prawdziwe wywołania
  modeli wymagają osobnego, jawnego budżetu/zgody** (koszt), i traktować
  jako **osobny, oddzielnie zatwierdzony etap** spike'a, nie domyślną
  kontynuację mocka.
- **Stack:** Bun + TypeScript (zgodnie ze stackiem Conductora,
  `AGENTS.md`), plus przypięty SDK ACP (`@agentclientprotocol/sdk`, patrz
  sekcja 9 dla wersji do potwierdzenia w samym spike'u — Node ≥20 dla
  Gemini CLI wymusza, że środowisko uruchamiające musi spełniać ten sam
  minimalny runtime niezależnie od Bun-a).
- **Egress zablokowany domyślnie (offline-first).** Faza mockowa (patrz
  wyżej) działa **bez wyjścia sieciowego** — dopiero faza z prawdziwymi
  agentami, po osobnej zgodzie na budżet, otwiera dostęp do sieci
  providera modelu, i to jawnie, nie jako efekt uboczny domyślnej
  konfiguracji.
- **Ramy czasowe: dwa dni robocze** na całość Etapu 2 (środowisko + 15
  scenariuszy × 3 runtime'y + raport) — przekroczenie tego okna jest
  sygnałem do przerwania i zredukowania zakresu (np. do 2 z 3
  runtime'ów), nie do rozszerzania spike'a w nieskończoność (zgodnie z
  zasadą z sekcji 8.4: to ma pozostać mały, ograniczony eksperyment).
- Wersje-kandydaci jak w sekcji 7 (`opencode-ai@1.18.32`,
  `@agentclientprotocol/codex-acp@1.13.1` + `CODEX_PATH` do zweryfikowania
  względem faktycznie zainstalowanego `@openai/codex`, `@google/gemini-cli@0.61.0`)
  — **przypięcie następuje w samym spike'u** po weryfikacji, nie jest tu
  z góry ustalone jako pewnik.

### 8.2 Zadanie (identyczne na wszystkich trzech)

Mały, deterministyczny task z efektem ubocznym markowalnym po `run-id`:
np. "dopisz linię `spike-marker-<run_id>` do pliku `MARKER.md` w danym
worktree i zgłoś wynik przez `conductor_report`-ekwiwalent (MCP tool
run-scoped)". Wymaga: log efektu (czy plik faktycznie zmieniony),
raport (czy MCP-wywołanie doszło), `ask` (jedno wymagane pytanie do
człowieka w trakcie), potem `cancel` na osobnym powtórzeniu.

### 8.3 Scenariusze (wszystkie trzy runtime'y, ten sam zestaw)

1. Utracona odpowiedź na `session/new` (create) — proces klienta udaje
   utratę odpowiedzi po tym, jak żądanie faktycznie dotarło.
2. Utracony `session/prompt` **przed** wystąpieniem efektu ubocznego.
3. Utracony `session/prompt` **po** wystąpieniu efektu ubocznego (agent
   zdążył napisać do pliku, zanim odpowiedź/potwierdzenie zaginęło).
4. Utracone ACK raportu MCP (`conductor_report`-ekwiwalent wywołany,
   odpowiedź nie dotarła) → duplikat raportu.
5. Śmierć i restart procesu agenta/klienta (dla Codex: **osobno** proces
   potomny Codex vs proces adaptera `codex-acp`).
6. Raport zapisany trwale **przed** crashem (baseline pozytywny —
   sprawdzić, że to *działa* zanim testować negatywy).
7. Cancel w trakcie generowania modelu.
8. Cancel w trakcie oczekiwania na `session/request_permission`.
9. Cancel w trakcie wolno-działającego narzędzia + weryfikacja drzewa
   procesów (czy proces potomny faktycznie ginie, nie tylko połączenie
   ACP raportuje `cancelled`).
10. Stare/nieaktualne **scoped credentials** (poświadczenia MCP scoped
    do attemptu, sekcja 6, nie "delivery ID" — to inna warstwa: delivery
    ID koreluje wiadomość, credential autoryzuje wywołanie) po stronie
    mocka — upewnić się, że nieaktualny/unieważniony credential jest
    jawnie odrzucony, nie cicho zaakceptowany ani niedeterministycznie
    obsłużony.
11. Izolacja worktree — oraz **osobno**, dla OpenCode: wiele **faktycznych
    rejestracji ACP** (nie analogia do `hub.ts`) na tym samym `cwd` —
    zweryfikować **rzeczywiste** zachowanie natywnego `opencode acp` przy
    kolizji katalogu, nie zakładać, że dzisiejszy routing
    `runner-opencode`/`hub.ts` (który jest specyficzny dla dzisiejszego
    callback-protokołu, nie ACP) przenosi się wprost.
12. `session/load` transkryptu **vs** przerwane zadanie — nie robić
    ślepego "resend" po `load`; potwierdzić, że Conductor-side logika nie
    zakłada, że `load` = "zadanie się nie wykonało".
13. Niewspierane capabilities (np. `resume` nie advertised) — musi
    **fail closed** (jawny błąd/odmowa), nie cicho udawać wznowienia.
14. Brak poprawnych credentiali — testować **na wszystkich trzech**,
    włącznie z OpenCode (nie tylko Codex/Gemini): OpenCode wymaga
    osobnej autoryzacji providera niezależnie od `opencode-login` (patrz
    sekcja 7.1) — musi dać jawny, rozróżnialny błąd auth, nie mylić się
    z "runner unavailable".
15. MCP server nie zdążył się połączyć przed pierwszym promptem (dla
    OpenCode w szczególności, patrz 7.1 ryzyko) — zweryfikować readiness.
16. **Pozytywny baseline sukcesu** (`end_turn` + poprawny `report()`) —
    zweryfikować **najpierw**, że szczęśliwa ścieżka działa na wszystkich
    trzech, zanim testuje się negatywy; bez tego punktu odniesienia
    wynik scenariuszy negatywnych nie da się poprawnie zinterpretować.
17. **Negatyw: `end_turn` bez żadnego `report()`** — zweryfikować, że
    Conductor-side logika (reap po TTL, sekcja 5.5) faktycznie się
    uruchamia i **nie** myli samego `end_turn` z sukcesem zadania —
    bezpośredni test granicy z sekcji 5.5.
18. **Polityka uprawnień allow/deny** (`session/request_permission`) —
    zweryfikować zarówno automatyczne `allow` jak i `deny` z poziomu
    klienta/mocka, i potwierdzić że odrzucenie uprawnienia nie jest
    mylone z błędem transportowym ani nie blokuje bezterminowo runu
    (patrz sekcja 5.7).
19. **Bounded cancellation z twardym limitem** — po `session/cancel`,
    jeśli `cancelled` stop reason/`state_update` nie nadejdzie w
    ustalonym oknie (np. 5 s), klient spike'a **zabija drzewo procesów**
    i **rejestruje** to zdarzenie jako fakt obserwowany (nie ukrywa go w
    logu) — dokładnie ta granica, którą sekcja 5.8 nazywa "ACP nie
    gwarantuje nadzoru drzewa procesów".
20. **Redakcja logów** — potwierdzić, że żaden surowy log JSON-RPC
    zapisany przez spike nie zawiera w czystym tekście
    poświadczeń/tokenów/kluczy API przekazanych przez `env` w
    konfiguracji MCP stdio (sekcja 6) ani w treści błędów providera.

### 8.4 Kryteria sukcesu

- Wszystkie **3** runtime'y przetestowane na **tym samym** zadaniu i
  **tym samym** zestawie scenariuszy (8.3), z odtwarzalnym raportem
  (kroki + surowe logi JSON-RPC, nie tylko podsumowanie).
- **≥2 z 3** runtime'y wykazują spójne zachowanie: MCP-report doszedł
  dokładnie raz (albo jawnie wykryty duplikat, nigdy cichy), `cancel`
  zaobserwowany jako faktyczne zatrzymanie (nie tylko brak błędu), i
  bezpieczny recovery (żaden scenariusz nie kończy się ślepym retry ani
  fałszywym sukcesem) — **przed** przejściem do Etapu 3.
- Scenariusz "niewspierane capabilities" (13) musi zakończyć się fail
  closed na **każdym** z trzech, nie tylko na większości — to jest
  twardy warunek bezpieczeństwa, nie statystyczny.
- To jest **mały, ograniczony eksperyment**, nie budowa infrastruktury
  produkcyjnej — spike, który sam zaczyna wyglądać jak `runner-protocol`
  w miniaturze, oznacza przekroczenie zakresu Etapu 2.

---

## 9. Ryzyka i niewiadome

- **ACP jako protokół wciąż aktywnie ewoluuje** (≥15 RFD stabilizowanych
  w ~roku, v2 w Draft od 2026-07-20 z otwartymi RFD jak Session Notices
  wciąż w Preview 2026-09-24) — każda decyzja "pin do v1" wymaga
  monitoringu `rfds/updates`, nie założenia stabilności ad infinitum.
- **Brak zmierzonej zgodności runtime↔SDK** — nie uruchomiono żadnego
  testu w tej notatce; wersje są punktem-w-czasie z registry.npmjs.org,
  nie dowodem działania razem.
- **Rozbieżność dokumentacja/kod w Gemini CLI** (7.3) — nieznana skala,
  wymaga weryfikacji w spike'u.
- **Nieznana kolejność zdarzeń przy `session/load`** w Gemini
  (`acpSessionManager.ts`, replay niepewny co do await) — potencjalny
  bug, nie potwierdzony w tej notatce (read-only).
- **Adapter jako dodatkowa warstwa awarii** dla Codex (osobny proces
  `codex-acp` + osobny proces potomny `codex`) — podwaja powierzchnię
  do monitorowania restartu względem dzisiejszego jednowarstwowego
  `runner-opencode`.
- **Fork (`session/fork`) jest draft w samym ACP** — jeśli którykolwiek
  runtime reklamuje `fork` jako gotowe, to reklama wyprzedza stabilizację
  protokołu; nie budować na tym żadnej ścieżki krytycznej.
- **`design.md` runner-protocol częściowo nieaktualny** (sekcja 2.7) —
  jeśli Etap 3 w ogóle nastąpi, wymaga rewizji `design.md` względem
  tego, co `runner-liveness`/`retry-policy` już dostarczyły, zanim
  dopisze się warstwę ACP na wierzchu.
- **Elicitation/session-notices to funkcje UI-warstwy klienta ACP**
  (Conductor jako headless orchestrator nie ma "użytkownika w oknie
  dialogowym" w tym samym sensie co Zed) — ich przydatność dla
  headless-daemon jest niejasna i wymaga osobnej oceny w spike'u, nie
  założenia, że "istnieją w spec więc się nadają".
- **Sprzeczność konfiguracji** (patrz sekcja 1, "Uwaga o kontekście
  projektu") między "greenfield, no legacy obligations" a "confirmed
  decisions" listującymi dzisiejszy kontrakt `createSession/prompt/
  status/note` — nierozstrzygnięta w tej notatce, do jawnego adresowania
  w ewentualnej przyszłej propozycji, nie do cichego obejścia.
- **Mapowanie ryzyk `design.md` runner-protocol na konkretne decyzje ACP
  (żeby przyszła rewizja `design.md` nie musiała szukać ponownie):**
  - *Idempotency storage retention* (`design.md` "Risks/Trade-offs":
    "Idempotency storage grows... finite retention after attempts become
    terminal") — bezpośrednio dotyczy luki z sekcji 3 wiersz 4: ACP nie
    ma pola idempotency-key w ogóle, więc retencja tego rodzaju wpisów
    pozostaje w całości po stronie Conductora, niezależnie od tego, czy
    transport to dzisiejszy HTTP callback czy przyszły ACP.
  - *Stable local identity configuration / cloning rules* (`design.md`:
    "reference adapter persists/generated identity outside ephemeral
    process state and documents cloning rules") — bezpośrednio dotyczy
    luki z sekcji 3 wiersz 1 (brak stabilnej tożsamości w ACP) i sekcji
    5.8 (brak identity opartej o PID) — jeśli adapter ACP kiedyś
    powstanie, musi rozwiązać identity/cloning **dokładnie tym samym
    mechanizmem**, jaki `design.md` już projektuje dla dzisiejszego
    transportu, nie osobnym dla ACP.
  - *Conformance suite* (`runner-protocol` task 1.3: "transport-independent
    conformance suite for versioning, capabilities, idempotency, safe
    status and cancellation") — jeśli adapter ACP ma zastąpić
    `runner-opencode` dla danego runtime'u (sekcja 6, "Replace"), musi
    przejść **ten sam** conformance suite, gdy ten powstanie — nie
    osobny, ACP-specyficzny zestaw testów, żeby uniknąć dokładnie tego,
    przed czym `design.md` ostrzega w "Protocol surface precedes second
    adapter": "conformance suite and mock runner prevent
    opencode-specific leakage" — analogicznie, zapobiec ACP-specific
    leakage.

---

## 10. Bramka decyzyjna i gotowy prompt na kolejne zadanie

**Bramka Etapu 1 → Etap 2** (z `docs/development-roadmap.md`): czy ACP
pokrywa wystarczająco dużo, by uzasadnić spike? **Wynik tej notatki: TAK,
warunkowo.** ACP dostarcza wspólne prymitywy sesji, promptów, zdarzeń,
anulowania i konfiguracji MCP. Tabele w sekcjach 3-4 pokazują zarazem,
że złożone wymagania trwałego wykonania pozostają pokryte tylko częściowo
albo wcale. Wartość wspólnej integracji sesyjnej wystarcza, by uzasadnić
spike **testujący konkretne luki**
(idempotencja, status-bez-query, end_turn-vs-success, capability-gating)
— nie uzasadnia przejścia od razu do Etapu 3. Osiem granic z sekcji 5
(5.1-5.8: sześć architektonicznych + uprawnienia/auth/izolacja +
tożsamość/lease/nadzór procesów) pozostaje nienaruszalnych niezależnie
od wyniku spike'a.

### Gotowy prompt (do wklejenia jako kolejne zadanie — Etap 2)

> Przeprowadź Etap 2 (spike kompatybilności, disposable, poza `main`) z
> `docs/development-roadmap.md`, na podstawie
> `docs/acp-gap-analysis.md` (ta notatka — w szczególności sekcja 7
> per-agent go/no-go i sekcja 8 specyfikacja środowiska/scenariuszy/
> kryteriów sukcesu). Zbuduj ten sam mały zadaniowy task (sekcja 8.2) na
> OpenCode (`opencode-ai@1.18.32`, natywny `opencode acp`), Codex
> (`@agentclientprotocol/codex-acp@1.13.1` — **zweryfikuj i przypnij**
> kompatybilną wersję `@openai/codex`/`CODEX_PATH` w samym spike'u, nie
> zakładaj `^0.156.1` z `package.json` bez testu, patrz sekcja 7.2) i
> Gemini (`@google/gemini-cli@0.61.0`, `gemini --acp`) przez ACP, w
> osobnym worktree, nieintegrowany z `packages/*`. Zacznij od mocka
> MCP-report (bez prawdziwych wywołań modelu), potem — **tylko po
> osobnej, jawnej zgodzie na budżet** — prawdziwe agenty. Przetestuj
> **wszystkie** scenariusze z sekcji 8.3 na wszystkich trzech
> runtime'ach; **bez ślepych retry** przy żadnej
> niepewności (zgodnie z "safe unknown status" z
> `runner-lifecycle/spec.md`). Dostarcz: kod spike'a (nieintegrowany),
> raport z macierzą capability × runtime, listę przypadków utraty
> połączenia i zaobserwowane zachowanie recovery (surowe logi JSON-RPC),
> rekomendację wersji ACP do przypięcia. Kryteria sukcesu: sekcja 8.4 tej
> notatki (≥2/3 runtime'y spójne na MCP-report + cancel + bezpieczny
> recovery; scenariusz "niewspierane capabilities" musi fail-closed na
> wszystkich trzech). Zakończ jawną bramką go/no-go dla Etapu 3
> (właściwy adapter ACP + rekoncyliacja z `runner-protocol` —
> **wymaga osobnej propozycji OpenSpec**, nie realizuj Etapu 3 w tym
> zadaniu).

---

## Źródła

Skróty w formacie `` `nazwa.md` `` użyte w tekście odnoszą się do
poniższych stron ACP (wszystkie pobrane 2026-09-25):

- `initialization.md` — <https://agentclientprotocol.com/protocol/v1/initialization.md>
- `session-setup.md` — <https://agentclientprotocol.com/protocol/v1/session-setup.md>
- `prompt-turn.md` — <https://agentclientprotocol.com/protocol/v1/prompt-turn.md>
- `cancellation.md` — <https://agentclientprotocol.com/protocol/v1/cancellation.md>
- `tool-calls.md` — <https://agentclientprotocol.com/protocol/v1/tool-calls.md>
- `authentication.md` — <https://agentclientprotocol.com/protocol/v1/authentication.md>
- `transports.md` — <https://agentclientprotocol.com/protocol/v1/transports.md>
- `extensibility.md` — <https://agentclientprotocol.com/protocol/v1/extensibility.md>
- `elicitation.md` — <https://agentclientprotocol.com/protocol/v1/elicitation.md>
- `session-config-options.md` — <https://agentclientprotocol.com/protocol/v1/session-config-options.md>
- `prompt-lifecycle.md` (v2) — <https://agentclientprotocol.com/protocol/v2/prompt-lifecycle.md>
- `rfds/updates` — <https://agentclientprotocol.com/rfds/updates.md>
- `rfds` (proces RFD, definicje Draft/Active/Preview/Completed) — <https://agentclientprotocol.com/rfds>
- `rfds/session-notices` — <https://agentclientprotocol.com/rfds/session-notices.md>
- `rfds/streamable-http-websocket-transport` — <https://agentclientprotocol.com/rfds/streamable-http-websocket-transport.md>
- `announcements/acp-v2-draft` — <https://agentclientprotocol.com/announcements/acp-v2-draft.md>

SDK/CLI (wersje zaobserwowane `registry.npmjs.org` 2026-09-25):

- `@agentclientprotocol/sdk@1.5.0` — <https://registry.npmjs.org/@agentclientprotocol/sdk/latest>, dokumentacja SDK: <https://agentclientprotocol.github.io/typescript-sdk/>
- `opencode-ai@1.18.32` — <https://registry.npmjs.org/opencode-ai/latest>; docs: <https://opencode.ai/docs/acp/>, <https://opencode.ai/docs/cli/>; źródło (tag): <https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/acp/service.ts>
- `@agentclientprotocol/codex-acp@1.13.1` — <https://registry.npmjs.org/@agentclientprotocol/codex-acp/latest>; źródło (commit `b1b8490cd165c18626dc3fe83836cdacdef94cd3`): <https://github.com/agentclientprotocol/codex-acp/blob/b1b8490cd165c18626dc3fe83836cdacdef94cd3/src/CodexAcpServer.ts>; upstream Codex CLI docs: <https://developers.openai.com/codex/cli/reference/>
- `@google/gemini-cli@0.61.0` — <https://registry.npmjs.org/@google/gemini-cli/latest>; docs (guide): <https://github.com/google-gemini/gemini-cli/blob/v0.61.0/docs/cli/acp-mode.md>; źródło dispatchera: <https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/acp/acpRpcDispatcher.ts>; auth: <https://geminicli.com/docs/get-started/authentication/>
