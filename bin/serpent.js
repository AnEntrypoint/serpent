#!/usr/bin/env node
// serpent -- casey pre-configured for dynamic multi-run research tracking.
// Same bootstrap pattern as uhh's bin/uhh.js: installs casey as a real
// dependency, points it at this package's own bundled config/ via
// CASEY_CONFIG_DIR, then hands off to casey's own CLI unmodified.
//
// CASEY_CONFIG_DIR is set here, in the deployer's own launch script, never
// derived from anything a contact/end-user sends -- matches casey's own
// config-loader contract.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

process.env.CASEY_CONFIG_DIR = process.env.CASEY_CONFIG_DIR || path.join(ROOT, 'config')

await import('casey/bin/casey.js')
