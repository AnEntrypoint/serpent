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
// Four concerns live here, none of which belong in casey's own core:
//   1. Admin-only run-schema setting (security boundary: never agent-facing,
//      never plain-operator-facing -- matches AGENTS.md's tier-is-operator-
//      assigned invariant this extends).
//   2. Per-run dynamic /api/runs/:id/config (resolveRunSchema, replacing the
//      global /api/config for GUI-rendering purposes -- multiple concurrent
//      runs in one instance need DIFFERENT resolved schemas, not one
//      process-wide one).
//   3. The on-demand consolidation trigger (freddie's research_consolidate,
//      wrapping the result back into the run's own report/summary).
//   4. The on-demand web-research trigger (freddie's real web_search/
//      web_fetch primitives -- see the /research route below for why this
//      is NOT the same thing as gm's own oxibrowser/CDP session tooling).

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

  // /research (below) is the only route in this file that issues outbound
  // requests to arbitrary external hosts on the operator's behalf, with the
  // fetched URLs themselves coming from a public search index rather than
  // being operator-typed -- an adversarial review found freddie's own
  // website_policy rate-limit field (ratelimit_ms) is computed but never
  // enforced by any caller, so nothing upstream throttles this. Same sliding-
  // window bucket shape as casey's own dashboard/routes/auth.js
  // reportRateLimited (per-key count in a fixed window, periodic sweep so the
  // map cannot grow unbounded), keyed by operator username (this route is
  // always authed, unlike the public /report form auth.js guards by IP) --
  // bounds how often ANY operator can trigger external fetches through this
  // route, independent of contributeRaw's own MAX_NOTES_PER_RUN ceiling.
  const RESEARCH_RATE_LIMIT = 5
  const RESEARCH_RATE_WINDOW_MS = 60000
  const researchRateBuckets = new Map()
  setInterval(() => {
    const now = Date.now()
    for (const [key, b] of researchRateBuckets) {
      if (now - b.windowStart > RESEARCH_RATE_WINDOW_MS) researchRateBuckets.delete(key)
    }
  }, RESEARCH_RATE_WINDOW_MS).unref?.()
  function researchRateLimited(req, res, next) {
    const key = req.caseyAccount?.username || 'unknown'
    const now = Date.now()
    let b = researchRateBuckets.get(key)
    if (!b || now - b.windowStart > RESEARCH_RATE_WINDOW_MS) {
      b = { count: 0, windowStart: now }
      researchRateBuckets.set(key, b)
    }
    b.count++
    if (b.count > RESEARCH_RATE_LIMIT) return res.status(429).json({ error: 'too many research requests -- please wait a moment and try again' })
    next()
  }

  // Read side for the run's shared notes folder -- the actual research
  // content (search results, agent-contributed notes) collected via
  // /research and research_note has had NO dashboard surface at all until
  // this route: casey's own case-detail view only ever rendered the report
  // fields (hypothesis/method/etc) and the one-line audit-log summary of
  // each research action, never the note bodies themselves. Read-only,
  // any authed operator (matches /consolidate's own non-admin gating --
  // viewing notes is not a structural change).
  app.get('/api/runs/:id/notes', wrap(async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const run = await store.getCase(req.params.id)
    if (!run) return res.status(404).json({ error: 'run not found' })
    const { listNotes } = await import('freddie')
    const notes = listNotes(run.ref)
    res.json({
      count: notes.length,
      notes: notes.map(n => ({ name: n.name, text: n.text, error: n.error || null })),
    })
  }))

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
    const timeoutMs = Number(process.env.SERPENT_CONSOLIDATE_TIMEOUT_MS) || undefined
    const result = await consolidate({ runId: run.ref, reviewerCount: req.body?.reviewerCount, timeoutMs })
    await store.updateCase(req.params.id, { summary: result.draft }, SYSTEM_USER)
    await store.appendEvent(req.params.id, {
      kind: 'action', actor: 'operator', text: `notes consolidated by ${req.caseyAccount.username} (${result.noteCount} notes, ${result.reviews.length} adversarial reviews)`,
      data: { draft: result.draft, reviews: result.reviews, noteCount: result.noteCount, unreadableNotes: result.unreadableNotes },
    })
    res.json(result)
  }))

  // On-demand web-research trigger -- operator/dashboard-only, NEVER agent-
  // facing (research_note/research_consolidate above stay the only
  // contact-facing tools; this route requires an authenticated dashboard
  // session, never reachable via casey's hardcoded enabledToolsets:['cases']
  // contact-facing agent turn -- see AGENTS.md's "casey never geocodes or
  // looks anything up on the model's behalf" invariant, which this
  // deliberately does not touch).
  //
  // NOT gm's own oxibrowser/CDP session tooling: gm's serp/browser/cdp
  // verbs are Claude-Code-session-local infrastructure (dispatched via
  // .gm/exec-spool by an orchestrating agent session) with no importable
  // API a Node server process can call -- confirmed by direct inspection
  // of ~/.gm-tools/ and ~/.agentplug/ (local daemon binaries, not an npm
  // package). This route instead uses freddie's OWN real, importable
  // web_search/web_fetch primitives (plugins/tools/web/lib/*.js, a genuine
  // peer-dependency-gated toolset already shipped in freddie, unrelated to
  // gm) -- reachable from serpent's own server code the same way any other
  // freddie export is. A separate `browser` primitive also exists in that
  // same freddie plugin (puppeteer-core-based) for full page automation;
  // not wired here since web_search+web_fetch alone already answer a
  // research query without needing a real Chromium binary.
  app.post('/api/runs/:id/research', researchRateLimited, wrap(async (req, res) => {
    if (!authed(req)) return res.status(401).json({ error: 'unauthorized' })
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : ''
    if (!query) return res.status(400).json({ error: 'query is required' })
    const fetchTop = Math.min(Math.max(Number(req.body?.fetchTop) || 0, 0), 5)
    const run = await store.getCase(req.params.id)
    if (!run) return res.status(404).json({ error: 'run not found' })

    const { webSearch } = await import('freddie/plugins/tools/web/lib/search.js')
    const { contributeRaw } = await import('freddie')
    // A transient search-provider hiccup (DDG scrape network failure, a
    // malformed SerpAPI response) degrades to zero results rather than
    // failing the whole action -- consistent with the per-URL webFetch loop
    // below, which already degrades one bad fetch to a content_error on that
    // one result instead of aborting the others.
    let results = []
    let searchError = null
    try {
      ; ({ results } = await webSearch({ query, num_results: 10, include_content: false }))
    } catch (e) {
      searchError = String(e?.message || e)
    }

    if (fetchTop > 0 && results.length) {
      const { webFetch } = await import('freddie/plugins/tools/web/lib/fetch.js')
      for (const r of results.slice(0, fetchTop)) {
        try {
          const fetched = await webFetch({ url: r.url })
          r.content = fetched?.content || null
          r.content_error = fetched?.ok === false ? fetched.error : null
        } catch (e) {
          r.content = null
          r.content_error = String(e?.message || e)
        }
      }
    }

    const body = [
      `## Research: ${query}`,
      '',
      `Searched by ${req.caseyAccount.username} on ${new Date().toISOString()}.`,
      searchError ? `\nSearch failed: ${searchError} (0 results)` : '',
      '',
      ...results.map((r, i) => [
        `### ${i + 1}. ${r.title}`,
        r.url,
        '',
        r.snippet || '',
        r.content ? `\n<details><summary>fetched content</summary>\n\n${r.content}\n\n</details>` : '',
        r.content_error ? `(fetch failed: ${r.content_error})` : '',
      ].filter(Boolean).join('\n')),
    ].join('\n')

    const written = await contributeRaw({ runId: run.ref, body })
    if (written.error) return res.status(500).json({ error: written.error })

    await store.appendEvent(req.params.id, {
      kind: 'action', actor: 'operator', text: `web research run by ${req.caseyAccount.username}: "${query}" (${results.length} results, ${fetchTop} fetched in full${searchError ? ', search failed: ' + searchError : ''})`,
      data: { query, resultCount: results.length, fetchTop, searchError },
    })
    res.json({ ok: true, query, resultCount: results.length, results, searchError, noteFile: written.file })
  }))
}
