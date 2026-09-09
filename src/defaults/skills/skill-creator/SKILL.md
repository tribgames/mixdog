---
name: skill-creator
description: Create, audit, repair, or simplify a Mixdog Agent Skill and its SKILL.md.
when_to_use: 'Create, audit, repair, or edit skills, including activation failures; not ordinary feature work.'
dependencies:
  tools:
    - type: tool
      value: read
    - type: tool
      value: shell
---

# Skill Creator

Build a compact operating guide that makes recurring agent work more reliable.
The result should encode useful decisions and recovery behavior, not narrate
everything a capable model or a tool schema already knows.

## Select the right deliverable

Before writing files, classify the request:

| Need | Best home |
|---|---|
| Reusable judgement or a repeatable procedure using existing tools | Skill |
| Precise new runtime capability, authentication, streaming, or binary handling | Tool or product code |
| Repository facts and contributor conventions | Project documentation |
| A durable fact, preference, or decision | Memory |
| A single task unlikely to recur | Complete the task without a skill |

Do not create a routing-only skill whose main job is listing other skills.
Improve an existing owner when the requested capability already fits there.

## Choose scope before content

- **Machine-global** — personal workflows useful across Projects.
- **Plugin** — capability that ships with an independently installed extension.
- **Built-in** — broadly useful Mixdog behavior with low context and dependency
  cost. Niche or heavy workflows do not belong here.

Mixdog does not discover project-local `.mixdog/skills` directories. Read
`references/design.md` before choosing placement or file structure.

## Creation loop

### 1. Recover the real workflow

Use the conversation, successful tool calls, corrections, failure recovery, and
produced artifacts as evidence. Ask only about gaps that would change the
design.

Capture:

- one recurring outcome;
- phrases and situations that should activate the skill;
- nearby requests that another capability should own;
- inputs, outputs, dependencies, side effects, and approvals;
- completion evidence and important failure recovery.

Completion criterion: another agent could identify when to use the skill and
what successful completion looks like without guessing.

### 2. Check local constraints

Inspect the target skill when modifying one. For a new skill, inspect only the
runtime rules and nearest comparable skills needed to settle naming, placement,
and integration.

Treat system instructions and current tool schemas as higher authority than any
skill. A skill may explain selection and workflow but must not redefine tool
arguments or permission boundaries.

Completion criterion: every proposed dependency and path exists in the target
environment or is explicitly part of the implementation.

### 3. Review external candidates when useful

Read `references/source-review.md` when the user asks to find, import, borrow
from, or compare public skills.

Extract requirements and design lessons rather than copying prose. If exact
third-party content is genuinely needed, surface its license obligations before
editing. Prefer a clean local implementation when a small compatible design can
provide the same behavior.

Completion criterion: the adopt, reimplement, or reject decision is supported
by compatibility, maintenance, executable-content, and license evidence.

### 4. Draft the smallest complete skill

Separate UI metadata, model selection, and loaded instructions:

- `description`: UI-only summary, at most 100 characters. It is not sent in
  the model's skill listing and must never be the sole home of an instruction.
- `when_to_use`: English descriptions of user intents and implicit situations,
  then `not for …` naming the neighbouring owner. Strongest trigger first;
  at most 250 characters, understandable with the skill name alone.
- Write instructions and listing text in English, describing user intent
  across languages rather than listing translated keywords. Preserve exact
  literals and language-specific examples when needed.

Write the body in the section order from `references/design.md`: intro,
boundary or mode selection, prerequisites, procedure with an observable result
per important step, pitfalls, verification, resource links. Body text never
routes the skill. Put capabilities, tool usage, prerequisites, operating rules,
and recovery details here, not in the trigger or UI description. Keep only
selection conditions in the trigger; the body must stand on its own when loaded.

Move conditional detail into directly referenced files. Add scripts only for
deterministic work that would otherwise be rebuilt on repeated invocations.

Completion criterion: the listing line fits its budget with the trigger
intact, and removing any remaining body section would lose judgement,
execution, recovery, or verification value.

### 5. Validate structure

Run:

```text
node "${MIXDOG_SKILL_DIR}/scripts/validate-skill.mjs" "<skill-directory>"
```

Then run checks required by the target repository. The validator catches
portable structure and path problems and warns when the listing line exceeds
its budget; the runtime parser remains authoritative for loading behavior.

Completion criterion: validation passes without warnings, every referenced
resource resolves, and the folder name matches the manifest name.

### 6. Exercise behavior

Read `references/evaluation.md`. Test realistic requests, including an implicit
positive case, an edge case, and a close negative case. For a modified skill,
preserve the prior version before editing and compare the same scenarios.

Judge generated artifacts by observable outcomes. Use deterministic assertions
for mechanical properties and user review for subjective quality.

Completion criterion: required scenarios pass without task-specific harness
hints, and failures have either been fixed or clearly reported.

### 7. Tighten

Remove duplicated rules, generic advice, stale examples, and branches that did
not affect evaluation. When adding a corrected rule, replace the obsolete rule
instead of accumulating exceptions.

Completion criterion: the final skill is smaller or clearer than the draft
without losing proven behavior.

## Updating an existing skill

- Keep its name and scope unless the user requests a change.
- Diagnose whether the defect is routing, instructions, resources, integration,
  or the underlying tool before editing.
- Preserve warnings, resource bounds, user approvals, and recovery paths.
- Read only references implicated by the defect.
- Re-run checks affected by the edit; do not repeat checks already closed by
  unchanged evidence.

## Auditing the skill set

When asked to audit, review, or tidy skills rather than fix one defect:

1. List every skill directory in scope: machine-global
   (`<mixdog-data>/skills`), enabled plugin skills, and built-ins
   (`src/defaults/skills` in the Mixdog repository).
2. Run `scripts/validate-skill.mjs` on each directory and collect the
   warnings; they cover the listing line and resource paths mechanically.
3. Read each body against the audit checklist in `references/design.md` for
   section order, completion results, duplication, and stale instructions.
4. Report findings as one table (skill, check, current value, proposed fix)
   before editing. Edit only after the user approves the scope.
5. Re-run the validator on every edited directory.

Completion criterion: every skill in scope validates without warnings and the
report lists nothing unresolved without an explicit reason.

## Mixdog loading facts

- Discovery precedence is machine-global, enabled plugin, then built-in.
- The directory name must equal frontmatter `name`.
- The model sees `name: when_to_use [tools: linked tool names]`; the trigger is cut at 250 characters
  on a word boundary. UI descriptions are not injected. A missing trigger
  leaves a name-only entry; the body loads once through `Skill`.
- `${MIXDOG_SKILL_DIR}` resolves to the active skill directory.
- `metadata.requires` names a mandatory Mixdog built-in feature. Add it only
  when the skill cannot function without that feature.
- Optional frontmatter has no effect unless the current runtime implements it.
- `dependencies.tools` declares tools loaded with the skill, without granting
  permissions. Use `type: tool` with the exact tool name or `type: mcp` with
  an existing server name. Keep optional tools out; `allowed-tools` is not
  interpreted as dependencies. Imported `agents/openai.yaml` dependencies
  are also read, but never authorize installation or activation.

## Final review

- Is this genuinely a reusable skill rather than another deliverable?
- Does the listing line fit 250 characters with the strongest trigger intact?
- Does every major step end in evidence, not “be careful”?
- Are platform assumptions, external programs, network access, and secrets
  visible?
- Are pitfalls based on plausible or observed failures?
- Can subjective outputs reach the user for review?
- Are temporary evaluation files excluded from the shipped skill?
- Were commit, publish, install, deployment, and restart left to explicit user
  requests?

