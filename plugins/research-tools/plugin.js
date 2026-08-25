// serpent's own research tools -- registered with toolset: 'cases' (not
// 'community') specifically so they are visible under casey's hardcoded,
// deliberately narrow enabledToolsets: ['cases'] for the contact-facing
// agent turn (see casey's src/hooks/handler.js's own security-invariant
// comment on that literal) -- casey's core is untouched; this plugin loads
// via CASEY_EXTRA_PLUGINS_DIR (see casey's src/casey.js), additive only.
//
// Wraps freddie's own generic contribute()/consolidate() (toolset-agnostic
// functions, not tools) rather than freddie's plugins/community/
// research_workflow -- that plugin's tools are hardcoded toolset:'community',
// which casey's contact-facing turn never enables. Reusing the underlying
// functions with a different toolset label here is the correct composition:
// freddie owns the primitive, serpent owns which toolset exposes it.

import { contribute, consolidate, listNotes } from 'freddie'

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })

export default {
  name: 'serpent-research-tools',
  surfaces: 'pi',
  register({ pi }) {
    pi.tools.register({
      name: 'research_note',
      toolset: 'cases',
      schema: {
        name: 'research_note',
        description: 'Append a note into this research run\'s shared notes folder. Call this any time the researcher tells you something worth recording -- multiple notes accumulate over the life of the run, this is never a single final report.',
        parameters: {
          type: 'object',
          properties: {
            note: str('The note content, in your own words summarizing what the researcher just told you.'),
          },
          required: ['note'],
        },
      },
      handler: async ({ note }, ctx = {}) => {
        const runRef = ctx?.activeCaseBinding?.ref || ctx?.activeCaseRef
        if (!runRef) return { error: 'no active run bound to this conversation -- cannot record a note' }
        const out = await contribute({ runId: runRef, prompt: `Record this research note verbatim, no changes: ${note}`, model: ctx.model, callLLM: ctx.callLLM })
        return { ok: !out.error, error: out.error }
      },
    })

    pi.tools.register({
      name: 'research_consolidate',
      toolset: 'cases',
      schema: {
        name: 'research_consolidate',
        description: 'On-demand: consolidate every note recorded for this run so far into one summary, adversarially reviewed. Only call this when the researcher explicitly asks for a summary or to wrap up -- never automatically.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      handler: async (_args, ctx = {}) => {
        const runRef = ctx?.activeCaseBinding?.ref || ctx?.activeCaseRef
        if (!runRef) return { error: 'no active run bound to this conversation -- cannot consolidate' }
        if (!listNotes(runRef).length) return { error: 'no notes recorded yet for this run' }
        const result = await consolidate({ runId: runRef, model: ctx.model, callLLM: ctx.callLLM })
        return { ok: true, draft: result.draft, noteCount: result.noteCount, reviewCount: result.reviews.length }
      },
    })
  },
}
