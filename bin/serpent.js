#!/usr/bin/env node
// serpent -- casey pre-configured for dynamic multi-run research tracking.
// Same bootstrap pattern as uhh's bin/uhh.js: installs casey as a real
// dependency, points it at this package's own bundled config/ via
// CASEY_CONFIG_DIR, then hands off to casey's own CLI unmodified.
//
// Three deployer-set env vars, all set here in the launch script, never
// derived from anything a contact/end-user sends -- matches casey's own
// config-loader contract:
//   CASEY_CONFIG_DIR            -- research_run domain vocabulary (fields,
//                                  persona, thatcher schema)
//   CASEY_EXTRA_PLUGINS_DIR     -- registers research_note/research_consolidate
//                                  under the contact-facing agent's 'cases'
//                                  toolset (plugins/research-tools/)
//   CASEY_EXTRA_DASHBOARD_ROUTES -- mounts serpent's per-run config/schema/
//                                  consolidate routes onto casey's own real
//                                  dashboard Express app (src/dashboard-routes.js)
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

process.env.CASEY_CONFIG_DIR = process.env.CASEY_CONFIG_DIR || path.join(ROOT, 'config')
process.env.CASEY_EXTRA_PLUGINS_DIR = process.env.CASEY_EXTRA_PLUGINS_DIR || path.join(ROOT, 'plugins')
process.env.CASEY_EXTRA_DASHBOARD_ROUTES = process.env.CASEY_EXTRA_DASHBOARD_ROUTES || path.join(ROOT, 'src', 'dashboard-routes.js')

await import('casey/bin/casey.js')
