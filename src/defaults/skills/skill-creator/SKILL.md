---
name: skill-creator
description: Create, audit, repair, or simplify your Mixdog skills and their SKILL.md.
when_to_use: 'Create, audit, repair, or edit skills, including activation failures; not ordinary feature work.'
dependencies:
  tools:
    - type: tool
      value: read
    - type: tool
      value: shell
---

# Skill Creator

Manages the skills a user keeps in Mixdog: turning a recurring workflow into a
skill, repairing one that misfires, and keeping the whole set small and tidy.
A skill earns its place by changing results — decisions, procedure, recovery
and a way to prove completion — not by narrating what the model or a tool
schema already knows.

## Pick the deliverable

| Need | Home |
|---|---|
| Reusable judgement or a repeatable procedure with existing tools | Skill |
| A new runtime capability, authentication, streaming, binary handling | Tool or product code |
| Facts and conventions of one repository | That repository's docs |
| A standing personal preference or constraint | Memory, with approval |
| A one-off task | Do the task; no skill |

Never create a skill whose job is to list other skills. When an existing skill
already owns the outcome, extend it instead.

## Where skills live

- The user's skills: `<mixdog-data>/skills/<name>/SKILL.md`, available in
  every project.
- Enabled plugins and Mixdog's built-ins are read in place. A user skill with
  the same name replaces them and stops following their updates, so pick a new
  name unless replacing is the point.
- The folder name equals the frontmatter `name`.

## Create a skill

1. **Recover the workflow.** From the conversation, successful tool calls,
   corrections and produced artifacts, capture the one recurring outcome; the
   requests that should select the skill and the nearby requests another skill
   or tool owns; inputs, side effects and approvals; completion evidence and
   recovery. Ask only about gaps that change the design. Result: another agent
   could tell when to use it and what done looks like.
2. **Draft** with `references/design.md`: the listing line first, then the
   body in its section order; detail that loads only in some cases goes to
   `references/`, deterministic repeated work to `scripts/`. Every tool, path
   and dependency it names exists. Result: the trigger fits its budget, and
   removing any section would lose judgement, execution, recovery or
   verification.
3. **Validate:**
   `node "${MIXDOG_SKILL_DIR}/scripts/validate-skill.mjs" "<skill-directory>"`.
   Result: no errors; each warning fixed or kept on purpose.
4. **Exercise** with `references/evaluation.md`: realistic requests, including
   an implicit positive and a near-miss negative. Result: the scenarios pass
   without hints, or the failures are reported.
5. **Tighten:** delete duplicated rules, generic advice, stale examples and
   rules no scenario needed; replace an obsolete rule instead of adding an
   exception. Result: smaller or clearer, with the same proven behaviour.

## Repair or update a skill

- Keep its name and scope unless the user asks otherwise.
- Classify the defect first (`references/evaluation.md`) and edit the part
  that owns it: a trigger that never selects the skill is not fixed in the
  body, and more prose does not fix a broken tool.
- Keep a copy of the prior version and rerun the same scenarios against both.
- Keep its approvals, bounds, warnings and recovery paths.
- Rerun only the checks the edit affects.

## Audit the set

When asked to review or tidy skills rather than fix one:

1. List the skills in scope: the user's (`<mixdog-data>/skills`), enabled
   plugins, built-ins.
2. Run the validator on each and collect its errors and warnings.
3. Read each against the audit checklist in `references/design.md` and give a
   verdict: **Keep**; **Improve** (name the defect); **Merge** into another
   (name it); **Retire** (name what covers the need instead).
4. Report one table — skill, verdict, finding, proposed fix — and edit only
   what the user approves. Plugin and built-in skills are never edited in
   place.
5. Rerun the validator on every edited skill.

Result: every edited skill validates; unresolved findings are reported with
their reason.

## Resources

- `references/design.md` — read before drafting or auditing: ownership,
  frontmatter, listing line, body, resources, audit checklist.
- `references/evaluation.md` — read when exercising a skill or diagnosing a
  failure.
- `scripts/validate-skill.mjs` — run on every created or edited skill.
