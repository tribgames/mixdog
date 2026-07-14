import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('..', import.meta.url)
const rawRules = Object.fromEntries(await Promise.all([
  ['cycle1', 'src/rules/agent/40-cycle1-agent.md'],
  ['cycle2', 'src/rules/agent/41-cycle2-agent.md'],
  ['cycle3', 'src/rules/agent/42-cycle3-agent.md'],
].map(async ([name, path]) => [
  name,
  await readFile(new URL(path, root), 'utf8'),
])))
const rules = Object.fromEntries(Object.entries(rawRules)
  .map(([name, text]) => [name, text.replace(/\s+/g, ' ').trim()]))

function includesAll(text, clauses) {
  for (const clause of clauses) assert.ok(text.includes(clause), `missing: ${clause}`)
}

test('cycle1 preserves chunk schema, taxonomy, coverage, and escaping', () => {
  const text = rules.cycle1
  includesAll(text, [
    '<idx_csv>|<element>|<category>|<summary>', 'included input row numbers',
    'comma-separated, without `@`', '5–10-word recall key',
    '`rule` (standing policy)', '`constraint` (hard limit)',
    '`decision` (agreed choice)', '`fact` (verified truth)', '`goal` (open target)',
    '`preference` (style/taste)', '`task` (pending work)', '`issue` (broken state)',
    '1–3 complete sentences', 'important names, paths, IDs, versions, numbers, errors, causes, and outcomes verbatim',
    'match input language', 'Every input row appears exactly once',
    'Group nearby same-topic rows, splitting only at real topic changes',
    'retain clarifications with their topic', 'Never mix `[sess:XXX]` markers',
    'Replace literal `|` with `/`', 'fields contain no newlines',
    'No JSON, fences, prose, preamble, or tool calls',
  ])
})

test('cycle2 preserves essential taxonomy, phases, rejects, formats, and fields', () => {
  const text = rules.cycle2
  includesAll(text, [
    '`is_root` long-term memory', 'candidate `id`/`category`/`score`/`element`/`summary`',
    'only when clearly exactly one essential concept',
    'identity (stable non-derivable user fact)', 'preference (durable taste/style/interaction preference)',
    'goal (long-running committed goal)', 'principle (cross-session behavior directive)',
    'policy (standing team decision)', 'procedure (recurring trigger + steps + caveats)',
    'event (rare foundational change not reconstructible from its rule)',
    'system constant (durable path/schema/model/channel invariant needed later and absent from rules)',
    'Anything unclear or outside these concepts is `archived`',
    '`phase1_new_chunks` → `active` if clearly essential, otherwise `archived`',
    '`phase2_reevaluate` → `active` to promote, otherwise `archived`',
    '`phase3_active_review` requires an `archived`, `active`, `update`, or `merge` verdict for every row',
    'defaults to `archived`', 'never treats silence as keep', 'work narratives', 'static facts without behavior/user value',
    'rule-system meta', 'resolved bug/fix logs', 'rule-file duplicates',
    'single-run measurements/counts/versions', 'session-scoped or in-progress decisions',
    '<id>|<verb>', '<id>|update|<element>|<summary>',
    '<id>|merge|<target_id>|<source_ids_csv>|<element>|<summary>',
    'Use only input IDs; never invent IDs', 'fresh `element` and a 3-sentence `summary`',
    'keeps `target_id`, absorbs `source_ids_csv`, and uses only one `project_id`',
    'complete sentences in input language', 'preserve important specifics verbatim',
    'omit actor/meta filler', '`rule > constraint > decision > fact > goal > preference > task > issue`',
    'Replace literal `|` with `/`', 'fields contain no newlines',
    'Start every verdict with a digit',
  ])
})

test('cycle3 preserves durable-event verdicts, formats, and exceptions', () => {
  const text = rules.cycle3
  includesAll(text, [
    'one digit-starting pipe verdict line per input id', 'CORE is durable standing knowledge',
    'rules, preferences, identity, goals, and current system/structure descriptions—not a log',
    'Each entry is one short clause (≤120 chars)',
    'Current rule/preference/live structure = durable',
    'past event = not durable', 'When unsure, keep',
    '`keep`: durable, already one short clause',
    '`update`: durable but verbose/multi-sentence; compress to one ≤120-char clause',
    '`merge`: duplicate; fold into its survivor in the same project pool',
    '`delete`: past event, not a current rule or structure',
    'Verbose durable is always `update`, never `keep`',
    '<id>|keep', '<id>|update|<element>|<summary>',
    '<id>|merge|<target_id>|<source_ids_csv>', '<id>|delete',
    'IDs match input rows; never invent them', 'summary is one ≤120-char clause',
    '`element` is short', 'retains `target_id`, absorbs sources, and stays within one `project_id`',
    'Replace literal `|` with `/`', 'fields contain no newlines',
    'Emit a digit-starting verdict for every input row',
  ])
})

test('compacted rules remain below their pre-compaction character counts', () => {
  const preCompaction = { cycle1: 1214, cycle2: 2166, cycle3: 1530 }
  for (const [name, before] of Object.entries(preCompaction)) {
    assert.ok(rawRules[name].length < before, `${name} was not compacted`)
  }
})
