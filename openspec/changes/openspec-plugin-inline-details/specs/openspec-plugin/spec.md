## MODIFIED Requirements

### Requirement: Clicking a change opens a detail modal with progressive disclosure

Clicking a change tile (anywhere except its start-work action) SHALL
expand the change's details **in place directly beneath the tile**,
accordion-style, within the listing; clicking the expanded tile again
SHALL collapse it. The expanded area SHALL show the change's task
progress and the proposal's Why text immediately, with What Changes,
Requirements (grouped by capability), and Tasks as sections collapsed
by default and expandable individually. At most one change SHALL be
expanded at a time — expanding another collapses the previous one. The
expanded area SHALL offer the same start-work action as the tile for
active changes (absent for archived ones). Tiles SHALL be operable by
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

#### Scenario: Start work from the expanded area

- **WHEN** the user triggers Start work inside the expanded details
- **THEN** the same feature-creation flow runs as from the tile (and
  the Control Room navigates to the created feature)

#### Scenario: Archived change expands without start-work

- **WHEN** the user clicks an archived change
- **THEN** its details expand with no start-work action

#### Scenario: Collapse

- **WHEN** the user clicks the expanded change's tile again
- **THEN** the details collapse and the listing remains as it was
