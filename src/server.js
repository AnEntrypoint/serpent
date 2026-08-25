// server.js -- serpent's own thin research-workflow API, running alongside
// casey's own dashboard (a separate Express app, own port -- casey's
// createDashboard() does not expose its `app` for external route attachment,
// see AGENTS.md's "Dashboard composition" note). Shares casey's real
// operator_account session cookie (reuses dashboard/auth.js's own
// verifySession/parseCookies against the SAME store/DB casey's dashboard
// uses) so a serpent-side login is a real casey operator login, not a
// separate auth system.
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

import express from 'express'
import { verifySession, parseCookies, COOKIE_NAME, getAccount } from 'casey/src/dashboard/auth.js'
import { SYSTEM_USER } from 'casey/src/case-store.js'
import { resolveRunSchema, validateSchemaBlob } from './run-schema.js'

async function authedAccount(req, store) {
  const cookies = parseCookies(req.headers.cookie || '')
  const token = cookies[COOKIE_NAME]
  if (!token) return null
  const claim = verifySession(token)
  if (!claim) return null
  const acct = await getAccount(store, claim.id)
  if (!acct || acct.disabled === '1') return null
  // Same epoch-revocation check as casey's own dashboard/routes/auth.js
  // session middleware -- Number() coercion since thatcher may return
  // session_epoch as a string or number depending on the read path.
  const liveEpoch = Number(acct.session_epoch) || 0
  if (claim.epoch !== liveEpoch) return null
  return acct
}

export function createResearchServer(store, { port = 4100 } = {}) {
  if (!store) throw new Error('createResearchServer requires a store instance')
  const app = express()
  app.use(express.json())

  const requireAuth = (req, res, next, roles = null) => {
    authedAccount(req, store).then(acct => {
      if (!acct) return res.status(401).json({ error: 'unauthorized' })
      if (roles && !roles.includes(acct.role)) return res.status(403).json({ error: 'forbidden' })
      req.serpentAccount = acct
      next()
    }).catch(() => res.status(500).json({ error: 'internal error' }))
  }
  const admin = (req, res, next) => requireAuth(req, res, next, ['admin'])
  const anyOperator = (req, res, next) => requireAuth(req, res, next, null)

  // Per-run dynamic config -- the GUI-dynamism the whole rearchitecture is
  // for. Resolves THIS run's own schema (from its stored schema blob, or
  // serpent's bundled default), unlike casey's own /api/config which is
  // one process-wide answer.
  app.get('/api/runs/:id/config', anyOperator, async (req, res) => {
    const run = await store.getCase(req.params.id)
    if (!run) return res.status(404).json({ error: 'run not found' })
    const shape = resolveRunSchema(run)
    res.json({
      entity_label: shape.REPORT_ENTITY_LABEL,
      report_sections: shape.REPORT_SECTIONS,
      visit_critical: shape.CRITICAL_FIELDS.map(k => ({ key: k, label: shape.fieldLabel(k) })),
    })
  })

  // Admin-only schema-setting -- never agent-facing (case_report's own tool
  // schema is fixed at freddie plugin-load time, see AGENTS.md's
  // serpent-architecture-design row; only an operator/admin sets a run's
  // custom field vocabulary, matching contact.tier's own operator-assigned,
  // never-LLM-settable invariant this extends to a new settable surface).
  app.put('/api/runs/:id/schema', admin, async (req, res) => {
    const schemaJson = typeof req.body?.schema === 'string' ? req.body.schema : JSON.stringify(req.body?.schema ?? null)
    const check = validateSchemaBlob(req.body?.schema == null ? null : schemaJson)
    if (!check.ok) return res.status(400).json({ error: check.error })
    const run = await store.getCase(req.params.id)
    if (!run) return res.status(404).json({ error: 'run not found' })
    await store.updateCase(req.params.id, { schema: check.parsed ? JSON.stringify(check.parsed) : '' }, SYSTEM_USER)
    await store.appendEvent(req.params.id, { kind: 'action', actor: 'operator', text: `run schema set by ${req.serpentAccount.username}`, data: { by: req.serpentAccount.username } })
    res.json({ ok: true })
  })

  // On-demand consolidation trigger -- never scheduled/automatic (matches
  // user's explicit answer). Any operator, not admin-only (unlike schema-
  // setting): consolidating notes into a summary is an ordinary research
  // action, not a structural schema change.
  app.post('/api/runs/:id/consolidate', anyOperator, async (req, res) => {
    const run = await store.getCase(req.params.id)
    if (!run) return res.status(404).json({ error: 'run not found' })
    try {
      const { consolidate } = await import('freddie')
      const result = await consolidate({ runId: run.ref, reviewerCount: req.body?.reviewerCount })
      await store.updateCase(req.params.id, { summary: result.draft }, SYSTEM_USER)
      await store.appendEvent(req.params.id, {
        kind: 'action', actor: 'operator', text: `notes consolidated by ${req.serpentAccount.username} (${result.noteCount} notes, ${result.reviews.length} adversarial reviews)`,
        data: { draft: result.draft, reviews: result.reviews, noteCount: result.noteCount, unreadableNotes: result.unreadableNotes },
      })
      res.json(result)
    } catch (e) {
      res.status(500).json({ error: String(e?.message || e) })
    }
  })

  app.use((err, req, res, next) => {
    res.status(err?.status || 500).json({ error: 'internal error' })
  })

  return new Promise((resolve, reject) => {
    const server = app.listen(port)
    server.once('error', reject)
    server.once('listening', () => resolve({ app, server }))
  })
}
