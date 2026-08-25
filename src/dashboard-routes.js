// dashboard-routes.js -- serpent's own routes, mounted directly onto casey's
// real dashboard Express app via CASEY_EXTRA_DASHBOARD_ROUTES (see
// AGENTS.md's "CASEY_EXTRA_DASHBOARD_ROUTES" entry in casey's own repo).
//
// This REPLACES an earlier design (server.js's createResearchServer) that
// ran its own express() app on a separate port under a now-falsified
// assumption that casey's createDashboard() never exposes its `app` --
// direct source inspection showed createDashboard already resolves
// {app, server, port, close}. Mounting here instead means:
//   - one origin/port, so the dashboard SPA's existing same-origin relative
//     fetches (src/dashboard/public/src/api.js) can reach these routes with
//     no proxy/CORS/second-port plumbing
//   - req.caseyAccount is already resolved by casey's own session middleware
//     (dashboard/routes/auth.js, registered before this module ever mounts,
//     per bin/worker.js's CASEY_EXTRA_DASHBOARD_ROUTES contract) -- no
//     duplicate session-cookie-parsing code path
//
// Three concerns live here, none of which belong in casey's own core:
//   1. Admin-only run-schema setting (security boundary: never agent-facing,
//      never plain-operator-facing -- matches AGENTS.md's tier-is-operator-
//      assigned invariant this extends).
//   2. Per-run dynamic /api/runs/:id/config (resolveRunSchema, replacing the
//      global /api/config for GUI-rendering purposes -- multiple concurrent
//      runs in one instance need DIFFERENT resolved schemas, not one
//      process-wide one).
//   3. The on-demand consolidation trigger (freddie's research_consolidate,
//      wrapping the result back into the run's own report/summary).

import { SYSTEM_USER } from 'casey/src/case-store.js'
import { resolveRunSchema, validateSchemaBlob } from './run-schema.js'

export default function mount(app, { store }) {
  if (!store) throw new Error('serpent dashboard-routes mount requires a store instance')

  // Same isAdmin/authed shape casey's own dashboard/server.js uses --
  // req.caseyAccount is already resolved by the session middleware
  // registered ahead of this mount point.
  const authed = (req) => !!req.caseyAccount
  const isAdmin = (req) => req.caseyAccount?.role === 'admin'

  // Every handler below is async and can reject (a thatcher/busybase
  // transient failure, an optimistic-lock conflict) -- Express 4 does NOT
  // forward a rejected async-handler promise to error middleware on its
  // own, so an unguarded route here becomes an unhandled promise rejection.
  // bin/worker.js installs a process-wide 'unhandledRejection' handler that
  // treats that as fatal and crashes the ENTIRE worker (every WhatsApp/
  // Discord contact's in-flight turn, not just this one HTTP request) --
  // a real defect an independent adversarial review caught. wrap() is the
  // fix: every route below is wrapped so a thrown/rejected error becomes a
  // normal 500 JSON response instead of an unhandled rejection, and is
  // caught HERE (before Express's own default handler) rather than
  // reaching casey's error middleware -- that middleware is registered
  // inside createDashboard() as the LAST step before it resolves
  // (dashboard/server.js), strictly before CASEY_EXTRA_DASHBOARD_ROUTES
  // mounts (bin/worker.js), so Express's stack-order semantics mean it
  // can never catch an error from a route added afterward. Never leaking
  // casey's own error middleware's `internal error` wording matters less
  // than never leaking Express's own default handler's stack trace +
  // absolute filesystem paths (casey never sets NODE_ENV=production
  // anywhere -- dashboard/server.js's own comment), which is what an
  // unwrapped route risks here.
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    console.error('[serpent dashboard-routes]', req.method, req.path, e && e.stack || e)
    if (!res.headersSent) res.status(500).json({ error: 'internal error' })
  })

  // Per-run dynamic config -- the GUI-dynamism the whole rearchitecture is
  // for. Resolves THIS run's own schema (from its stored schema blob, or
  // serpent's bundled default), unlike casey's own /api/config which is
  // one process-wide answer.
  app.get('/api/runs/:id/config', wrap(async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const run = await store.getCase(req.params.id)
    if (!run) return res.status(404).json({ error: 'run not found' })
    const shape = resolveRunSchema(run)
    res.json({
      entity_label: shape.REPORT_ENTITY_LABEL,
      report_sections: shape.REPORT_SECTIONS,
      visit_critical: shape.CRITICAL_FIELDS.map(k => ({ key: k, label: shape.fieldLabel(k) })),
    })
  }))

  // Admin-only schema-setting -- never agent-facing (case_report's own tool
  // schema is fixed at freddie plugin-load time; only an operator/admin
  // sets a run's custom field vocabulary, matching contact.tier's own
  // operator-assigned, never-LLM-settable invariant this extends to a new
  // settable surface). Bounded retry-on-conflict, same expectedVersion
  // discipline as case-store.js's own updateCaseChecked -- a dashboard
  // write racing another dashboard write (two admins editing the same
  // run's schema concurrently) must retry against the fresh row, never
  // silently clobber or crash the worker (AGENTS.md: "A dashboard
  // operator's concurrent edit is detected via optimistic locking and the
  // merge retries against the fresh row").
  const SCHEMA_WRITE_RETRY_LIMIT = 3
  app.put('/api/runs/:id/schema', wrap(async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' })
    const schemaJson = typeof req.body?.schema === 'string' ? req.body.schema : JSON.stringify(req.body?.schema ?? null)
    const check = validateSchemaBlob(req.body?.schema == null ? null : schemaJson)
    if (!check.ok) return res.status(400).json({ error: check.error })
    const patch = { schema: check.parsed ? JSON.stringify(check.parsed) : '' }
    let run = await store.getCase(req.params.id)
    if (!run) return res.status(404).json({ error: 'run not found' })
    for (let attempt = 0; ; attempt++) {
      try {
        await store.updateCase(req.params.id, patch, SYSTEM_USER, run._version != null ? { expectedVersion: run._version } : {})
        break
      } catch (e) {
        if (e.code !== 'conflict' || attempt === SCHEMA_WRITE_RETRY_LIMIT) throw e
        run = await store.getCase(req.params.id)
        if (!run) return res.status(404).json({ error: 'run not found' })
      }
    }
    await store.appendEvent(req.params.id, { kind: 'action', actor: 'operator', text: `run schema set by ${req.caseyAccount.username}`, data: { by: req.caseyAccount.username } })
    res.json({ ok: true })
  }))

  // On-demand consolidation trigger -- never scheduled/automatic (matches
  // user's explicit answer). Any operator, not admin-only: consolidating
  // notes into a summary is an ordinary research action, not a structural
  // schema change.
  app.post('/api/runs/:id/consolidate', wrap(async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const run = await store.getCase(req.params.id)
    if (!run) return res.status(404).json({ error: 'run not found' })
    const { consolidate } = await import('freddie')
    const result = await consolidate({ runId: run.ref, reviewerCount: req.body?.reviewerCount })
    await store.updateCase(req.params.id, { summary: result.draft }, SYSTEM_USER)
    await store.appendEvent(req.params.id, {
      kind: 'action', actor: 'operator', text: `notes consolidated by ${req.caseyAccount.username} (${result.noteCount} notes, ${result.reviews.length} adversarial reviews)`,
      data: { draft: result.draft, reviews: result.reviews, noteCount: result.noteCount, unreadableNotes: result.unreadableNotes },
    })
    res.json(result)
  }))
}
