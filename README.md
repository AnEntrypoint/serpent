# serpent

casey, pre-configured for dynamic multi-run research tracking.

```
npx github:AnEntrypoint/serpent up
```

installs [casey](https://github.com/AnEntrypoint/casey) and
[freddie](https://github.com/AnEntrypoint/freddie) as real dependencies and
boots a research-tracking deployment where **each research run can declare
its own field vocabulary**, resolved at read time from that run's own
`schema` blob (see `config/thatcher.config.yml`'s `case.schema` field) --
unlike casey's own default demo or [uhh](https://github.com/AnEntrypoint/uhh)
(both one fixed schema per process), serpent supports many concurrent runs
with different schemas in the same running instance.

## Architecture

- `config/` -- the DEFAULT generic experiment-tracking schema (hypothesis,
  method, dataset_or_sample, result, status, researcher) used when a run has
  no custom schema of its own. Same config-package contract as casey/uhh
  (`report-fields.yml`, `persona.cjs`, `thatcher.config.yml`).
- `src/run-schema.js` -- `resolveRunSchema(runRow)`, the per-run resolver.
  Parses a run's own `schema` JSON blob (same shape as `report-fields.yml`)
  via casey's `deriveReportShape()` export, falling back to the bundled
  default. This is what makes the GUI/tool labels genuinely different per
  concurrent run.
- `src/dashboard-routes.js` -- serpent's own routes (per-run dynamic
  `/api/runs/:id/config`, admin-only schema-setting, on-demand
  notes-consolidation trigger), mounted directly onto casey's real dashboard
  Express app via `CASEY_EXTRA_DASHBOARD_ROUTES` (set in `bin/serpent.js`) --
  same origin/port as the dashboard SPA and every other `/api/*` route, and
  `req.caseyAccount` is already resolved by casey's own session middleware
  by the time these routes mount, so there is no separate auth system here.
- `plugins/research-tools/` -- `research_note`/`research_consolidate` tools,
  registered under casey's `'cases'` toolset (visible to the contact-facing
  agent) wrapping freddie's `contribute()`/`consolidate()` fan-out-to-
  shared-artifact primitive: any number of agent turns can append a note
  into a run's shared notes folder over time (non-linear, long-horizon), and
  an on-demand consolidation pass drafts a summary then adversarially
  reviews it with independent reviewer turns before it's accepted.

## Requirements

Same as casey itself: Node >= 22, a `.env` with channel credentials and an
LLM provider key. Run `npx github:AnEntrypoint/serpent doctor` first.
