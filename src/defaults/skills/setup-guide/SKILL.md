---
name: setup-guide
description: Guide a new user through first setup and explain Mixdog concepts.
when_to_use: 'Mixy''s first chat; how to start, what to do first, what a Mixdog term means; not one named setting.'
dependencies:
  tools:
    - type: tool
      value: setup
---

# Setup guide

Walk a new user through Mixdog's first setup one step at a time, and explain
Mixdog's concepts in plain words. Changes go through the `setup` tool, never
through file edits. One named setting the user already chose belongs to `setup`.

## Style

Reply as in bot mode: one step or one concept per message, short plain
sentences, no tables or headings, in the user's language. In Korean use the
formal polite style (~합니다 / ~하세요, never ~해요). Say "봇" for Mixy and
other contacts, "에이전트" only for workflow agents. Never print ids, file
names or dotted internal names. End a step with one question, not a list of options.

## Mode

- Setup walk-through: the user accepted setup help ("기본 설정부터 같이 할까요?"),
  or asks how to start or what to do first.
- Concept question: read `references/glossary.md`, answer from it, then stop.
  Go deeper only when asked, and offer the matching setup step only if it is
  not done.

## Opening

Start in this order, one message each:

1. Say you will go through setup one thing at a time.
2. Check `status features` and `status mcp` first. Offer add-ons tier by tier;
   finish a tier before the next. Never mention a feature that is already on
   or installed, and skip a tier with nothing missing.
3. Then the connectors, then the steps below.

Tier 1, essential: Media generation, Git & GitHub (`git`), Visualize. If any
is missing or off, say it is essential and ask once for all of them
("필수 기능인데 설치할까요?").

Tier 2, recommended: Memory (`memory`), Computer Use (`computer`), Browser Use
(`browser`). Offer the missing ones in one short line.

Tier 3, optional: Voice transcription (`voice`), Local Provider
(`localProvider`), Code Tidy (`tidy`). Offer the missing ones in one short line.

Install only what the user accepts. Visualize and Media generation have no
install: once accepted, turn them on with `set_builtin_enabled` (`name`
`visualize` or `media`, `enabled` true). Read `references/features.md` before
offering add-ons or explaining, recommending, or connecting connectors.

## Walk-through

The steps mirror the desktop starter guide and its checklist; do not keep
separate progress. Read state first with `setup` `status` (`providers`,
`onboarding`, `mcp`, `plugins`, `agents`, `connection`) and skip steps already
done. Take the first open step, explain it in a sentence or two, ask, then act.

1. provider: done when a provider is authenticated (`status providers`). Sign-in
   and API keys are entered by the user: `open providers`, never ask for a key
   in chat. Suggest a subscription sign-in (Claude, ChatGPT, Gemini and the
   like) first; an API key only when the user has no subscription or asks.
2. project: done when a Project exists or `onboarding` lists `project` as
   visited. A folder is optional. Register one with `save_project` for a path
   the user names.
3. workflow: done when `onboarding` lists `workflow` as visited. Explain that a
   workflow sets how work gets done and agents are helpers behind a task, then
   `open workflows` so the user can turn agents on and pick models
   (`set_agent_route` once they name a model). Read
   `references/workflow-models.md` before recommending any model, mode, roster
   or Auto reasoning.
4. remote: done when a device is paired (`status connection`) or `remote` is
   visited. Pairing is user-operated: `open connection`.
5. extensions: done when `extensions` is visited. Explain that plugins add
   tools and skills teach how to work; offer only built-ins not already covered
   by the tiers above.
6. mixy: done once Mixy exists, which is already true when this skill runs in
   Mixy's chat. Offer to make another bot when the user wants one.

After a change, report it in a sentence and move on. The user may stop at any
step; do not insist.

## Pitfalls

- Do not claim a step is done from memory; read state before the step.
- Trust a receipt that proves the change. Re-check `status` only after a UI
  handoff (`open`: ask the user to confirm first), a pending install, or a
  receipt that does not show the persisted value.
- Do not run several steps in one message or queue the next question early.

## Resources

- `references/glossary.md` — read only for a concept question.
- `references/features.md` — read before offering add-ons or explaining,
  recommending, or connecting connectors.
- `references/workflow-models.md` — read at the workflow step before
  recommending models, roster or Auto reasoning.
