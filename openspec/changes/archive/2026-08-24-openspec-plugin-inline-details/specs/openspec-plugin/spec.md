## RENAMED Requirements

- FROM: `### Requirement: Clicking a change opens a detail modal with progressive disclosure`
- TO: `### Requirement: Clicking a change expands its details inline with progressive disclosure`

## MODIFIED Requirements

### Requirement: Clicking a change expands its details inline with progressive disclosure

Clicking a change tile (anywhere except its start-work action) SHALL
expand the change's details **in place directly beneath the tile**,
accordion-style, within the listing; clicking the expanded tile again
SHALL collapse it. The expanded area SHALL show the change's task
progress and the proposal's Why text immediately, with What Changes,
Requirements (grouped by capability), and Tasks as sections collapsed
by default and expandable individually. At most one change SHALL be
expanded at a time — expanding another collapses the previous one. The
tile's own start-work action SHALL remain the only one — the expanded
area adds no duplicate button. Tiles SHALL be operable by
keyboard (Enter/Space toggles the expansion). Details SHALL be fetched
lazily on first expansion, with fetch failures shown inline in the
expanded area. Markdown in displayed texts SHALL be rendered with a
minimal safe renderer (no raw HTML injection). No modal overlay SHALL
be used.

#### Scenario: Expand, read, expand deeper

- **WHEN** the user clicks an active change's tile
- **THEN** the details expand beneath the tile with the Why text
  visible, and expanding Requirements reveals each capability's
  requirement headings and bodies

#### Scenario: Accordion keeps one open

- **WHEN** one change is expanded and the user clicks another change
- **THEN** the first collapses and the second expands

#### Scenario: One start-work action per change

- **WHEN** an active change is expanded
- **THEN** the tile's start-work button remains the only start-work
  control — the expanded area contains no duplicate

#### Scenario: Archived change expands without start-work

- **WHEN** the user clicks an archived change
- **THEN** its details expand with no start-work action

#### Scenario: Collapse

- **WHEN** the user clicks the expanded change's tile again
- **THEN** the details collapse and the listing remains as it was
