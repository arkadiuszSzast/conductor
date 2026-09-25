# Mapa drogowa: ACP i graf zadań (roadmap, nie plan wdrożenia)

Status: **roadmap do delegacji**, nie zatwierdzony plan OpenSpec. Każdy etap
oznaczony `[impl]` wymaga osobnej propozycji w `openspec/changes/` (zgodnie z
`AGENTS.md`) — dla ACP: uzgodnienia/rekoncyliacji z `runner-protocol`
(`openspec/changes/runner-protocol/{proposal,design,tasks}.md`), bo oba
opisują tę samą granicę `SessionClient` (`packages/server/src/ports.ts:112`).
Nie duplikować `runner-protocol` — rozszerzyć go lub jawnie zamknąć jako
zastąpiony.

Kontekst: prace z sesji już scommitowane (`03e50dd`, `025ce83`) — nie
powtarzać. Ten dokument dotyczy kolejnych, niezależnie zlecalnych kroków.

## Ścieżka A — ACP (Agent Client Protocol): ACP-first, nie ACP-only

### Etap 1 — Przegląd projektowy (read-only)
- **Zakres:** porównać ACP z `SessionClient` (`ports.ts`) i niedokończonym
  `runner-protocol` (kontrakt wersji/capabilities, leased registration,
  idempotentne create/prompt — patrz `design.md` sekcja "Decisions").
  Zidentyfikować luki i pokrycie.
- **Zależności:** brak (czysto analityczny).
- **Deliverable:** notatka gap-analysis (markdown, w `openspec/changes/` jako
  draft `design.md` fragment lub osobny research note) mapująca każdą
  capability `runner-protocol` na odpowiednik/brak w ACP.
- **Kryteria akceptacji:** każda decyzja projektowa `runner-protocol` ma
  jawne "ACP: tak/nie/częściowo + dlaczego"; brak nieuzasadnionych założeń.
- **Bramka decyzyjna:** czy ACP pokrywa wystarczająco dużo, by uzasadnić
  spike (Etap 2)? Jeśli nie — udokumentować i zamknąć wątek.

### Etap 2 — Spike kompatybilności (disposable, poza main)
- **Zakres:** ten sam mały zadaniowy task na OpenCode/Codex/Gemini przez ACP:
  run-scoped MCP report, permission/cancel, utrata połączenia + restart,
  recovery sesji — **bez ślepych retry** (zgodnie z zasadą "safe unknown
  status" z `design.md`). Zbudować macierz capability: natywne vs adaptery.
  Zweryfikować negocjację stabilnej wersji protokołu i to, że obecna
  dokumentacja (`docs/*.md`, `runner-protocol/specs/`) nie zakłada sztywno
  niewspieranej wersji ACP.
- **Zależności:** Etap 1 (gap-analysis jako punkt wyjścia).
- **Deliverable:** kod spike'a (osobny branch/worktree, nieintegrowany),
  raport: macierz capability × runtime, lista przypadków utraty połączenia i
  zachowanie recovery, rekomendacja wersji ACP do zablokowania.
- **Kryteria akceptacji:** wszystkie trzy runtime'y przetestowane na tym
  samym zadaniu; brak retry bez potwierdzenia stanu; raport jest
  odtwarzalny (kroki + logi).
- **Bramka decyzyjna:** go/no-go dla Etapu 3, na podstawie: czy MCP
  reporting + cancel + recovery działają spójnie na ≥2 runtime'ach.

### Etap 3 — Decyzja + plan produkcyjny `[impl]` (wymaga propozycji OpenSpec)
- **Zakres:** jeśli go — właściwy ACP runner + wspólny raportujący MCP,
  zachowując: Conductor SQLite jako właściciel wyniku run/retry/review/gate
  (supervizja workera ACP po stdio **nie jest automatycznie trwała** — to
  proces, nie stan). Testy, dokumentacja, bramka jakości (typecheck/lint/
  test/build jak w `runner-protocol` task 5.5). Zachować furtkę ucieczki:
  natywna integracja pozostaje dostępna, ACP jej nie zastępuje siłowo.
- **Zależności:** Etap 2 (wynik pozytywny), rekoncyliacja z
  `runner-protocol` (ten sam kontrakt wersji/capabilities/lease albo jawne
  zastąpienie wybranych decyzji).
- **Deliverable:** propozycja OpenSpec (`proposal.md`/`design.md`/`tasks.md`
  w nowym `openspec/changes/<nazwa>/`), potem implementacja wg zwykłego
  procesu tasków.
- **Kryteria akceptacji:** zgodność z `AGENTS.md` (SQLite = source of truth,
  sesje disposable, interpreter pure/engine I/O); przechodzi
  conformance suite równoważny temu z `runner-protocol` 1.3.

## Ścieżka B — dekompozycja zadań / graf pracy (task graph)

### Etap 4 — Kontrakt małego zadania + bramka planowania/oceny rozmiaru
- **Zakres:** OpenSpec pozostaje właścicielem intencji/spec/design (nie tylko
  "biznesowej" części). Rozróżnić **backlog DAG** (zależności między małymi
  zadaniami w obrębie zmiany, opcjonalnie między zmianami) od **workflow DAG** (`needs:` w `conductor.yaml`,
  wykonanie). Obecny plugin OpenSpec parsuje tekst/status checkboxów i
  startuje **całą zmianę na raz** (`plugins/openspec/serve.ts`,
  `handleStartWork`, linie ok. 200–420) — nie ma schedulera zadań. Zdefiniować
  minimalny kontrakt zadania: zakres akceptacji, zależności, dowód
  wykonania (evidence), granica "done", nowo odkryty zakres (follow-up), oraz
  wymóg finalnej walidacji **całej zmiany** mimo podziału na taski.
- **Zależności:** brak twardej zależności od Ścieżki A; może iść równolegle.
- **Deliverable:** krótka notatka projektowa (design note) z kontraktem
  zadania + diagramem backlog DAG vs workflow DAG.
- **Kryteria akceptacji:** kontrakt jest wystarczający, by opisać istniejące
  `tasks.md` bez utraty informacji; jasno oddziela planowanie (backlog) od
  wykonania (workflow).
- **Bramka decyzyjna:** czy przykładowa duża zmiana została rozbita na małe,
  niezależnie weryfikowalne zadania z pełnym kontekstem dla nowej sesji?
  Jeśli nie — poprawić dekompozycję przed wyborem magazynu zadań.

### Etap 5 — Ewaluacja Beads vs natywne SQLite vs interfejs providera
- **Zakres:** ocena z realnego przypadku użycia (Etap 4), nie z góry.
  Uwaga: Beads **nie dzieli zadań automatycznie** — to tylko śledzenie/graf.
  Architektura oparta o Dolt wymaga weryfikacji aktualności w momencie
  decyzji (nie zakładać z dokumentacji). Unikać podwójnej prawdy z
  `tasks.md` — jeśli wybrane rozwiązanie zewnętrzne, zdefiniować jawnie:
  claims, mapowanie run↔task, rekoncyliację, kto ma "completion authority".
- **Zależności:** Etap 4 (kontrakt zadania jako kryterium oceny).
- **Deliverable:** krótkie porównanie (tabela) + ew. pilotaż na jednym
  realnym backlogu, **bez** narzucania Dolta i **bez** budowania pełnego
  klonu Beads.
- **Kryteria akceptacji:** decyzja ma jawne uzasadnienie względem kontraktu
  z Etapu 4; nie wprowadza drugiego źródła prawdy równoległego do SQLite.
- **Bramka decyzyjna:** wybór spośród (a) natywne SQLite, (b) Beads, (c)
  interfejs providera pluggable — dopiero po porównaniu/pilotażu.

### Etap 6 — Implementacja `[impl]` (wymaga propozycji OpenSpec)
- **Zakres:** `conductor.yaml` pozostaje **jedynym** formatem wykonania
  (workflow-as-data) — żadnych duplikatów bramek/gate'ów przez formuły
  Beads ani inny silnik reguł.
- **Zależności:** Etap 5 (decyzja), zgodność z `workflow-format` i
  `retry-policy`.
- **Deliverable:** propozycja OpenSpec + implementacja wg zwykłego procesu.

## Następne zadanie gotowe do wklejenia

> Przeprowadź Etap 1 (przegląd projektowy ACP): porównaj ACP z
> `SessionClient` (`packages/server/src/ports.ts:112`) i decyzjami z
> `openspec/changes/runner-protocol/design.md` (identity/lease, offer przed
> attempt, idempotentny create/prompt, safe unknown status, error ownership
> boundary). Wynik: gap-analysis notatka mapująca każdą decyzję na
> pokrycie ACP (tak/nie/częściowo + uzasadnienie), bez zmian w kodzie, bez
> commitów. Zakończ rekomendacją go/no-go dla spike'a (Etap 2).
