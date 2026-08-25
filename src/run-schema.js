// run-schema.js -- resolves the per-run field vocabulary that makes serpent
// genuinely runtime-dynamic: unlike casey's own default and uhh (one fixed
// schema per process, picked once at boot via CASEY_CONFIG_DIR), serpent
// resolves a DIFFERENT report-fields.yml-shaped schema per research_run row,
// read from that row's own `schema` blob (see config/thatcher.config.yml).
// A run with no declared schema falls back to serpent's own bundled generic
// default (config/report-fields.yml).
//
// Built entirely on casey's own additive deriveReportShape() export (see
// casey's src/store/report-shape.js) -- casey's process-lifetime
// CASEY_CONFIG_DIR path is completely untouched; this is new code calling
// an existing pure function with a per-row input instead of the
// module-level default.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { deriveReportShape } from 'casey/src/store/report-shape.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SCHEMA_PATH = path.resolve(__dirname, '..', 'config', 'report-fields.yml')

let defaultReportFields = null
function loadDefaultReportFields() {
  if (!defaultReportFields) {
    defaultReportFields = yaml.load(fs.readFileSync(DEFAULT_SCHEMA_PATH, 'utf8'))
  }
  return defaultReportFields
}

// Parses a research_run row's own `schema` blob (JSON text, same fields[]
// shape as report-fields.yml) and derives every shape case-tools.js/
// case-health.js/the dashboard need from it -- REPORT_FIELD_DEFS,
// CRITICAL_FIELDS, REPORT_SECTIONS, fieldLabel, etc. Falls back to
// serpent's own bundled generic default when the row has no schema set or
// the blob fails to parse (never throws on a malformed/missing schema --
// a run record with a bad schema blob still gets a working, generic GUI
// rather than a crashed dashboard).
export function resolveRunSchema(runRow) {
  let reportFields = null
  if (runRow?.schema) {
    try {
      const parsed = JSON.parse(runRow.schema)
      if (parsed && Array.isArray(parsed.fields)) reportFields = parsed
    } catch { /* fall through to default below */ }
  }
  return deriveReportShape(reportFields || loadDefaultReportFields())
}

// Validates a caller-supplied schema blob (JSON string) BEFORE it is
// written to a run row -- same shape contract deriveReportShape() itself
// requires (a fields[] array), checked here so a malformed write is
// rejected loudly at the write boundary rather than silently falling back
// to the default later (which would look like data loss to whoever set it).
export function validateSchemaBlob(schemaJson) {
  if (schemaJson == null || schemaJson === '') return { ok: true, parsed: null } // unset is valid -- falls back to default
  let parsed
  try { parsed = JSON.parse(schemaJson) } catch (e) { return { ok: false, error: `schema is not valid JSON: ${e.message}` } }
  if (!parsed || !Array.isArray(parsed.fields)) return { ok: false, error: 'schema must be an object with a fields[] array' }
  for (const f of parsed.fields) {
    if (!f || typeof f.key !== 'string' || !f.key) return { ok: false, error: 'every schema field needs a non-empty string key' }
  }
  return { ok: true, parsed }
}
