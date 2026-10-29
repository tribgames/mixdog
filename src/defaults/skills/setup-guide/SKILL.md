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
- Concept question: answer it from the glossary below, then stop. Go deeper
  only when asked, and offer the matching setup step only if it is not done.

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

Install only what the user accepts. How each is done:

- `install_builtin` with the name for git, memory, autoEffort, computer,
  browser, voice, localProvider and tidy. Git installs system Git through the
  Desktop when this chat is open there. Auto reasoning can be unsupported on
  a machine: report that instead of retrying. Computer Use and Browser Use
  need the Desktop, and the user approves OS permission dialogs. Local
  Provider only prepares the runtime; models belong to `local-provider`.
- Memory is install-only; its later on/off is `set_memory_enabled`.
- Visualize has no install: `set_builtin_enabled` turns it on.
- Media generation has no setup action: `open plugins` and let the user turn
  it on there, then re-check `status features`.

Connectors come after the tiers. First explain in a sentence or two: a
connector links an outside service so bots and agents can read and act in it,
and anything that sends or posts asks first through an approval card. Then
suggest by what the user does, only these: Gmail (with a Google app password;
it needs 2-Step Verification on the Google account, and the connect window
opens the app-password page in the browser), Google Calendar, Google Drive
(both with the Google sign-in), Notion, Linear or Jira. GitHub is
not a connector; it is the signed-in GitHub CLI of Git & GitHub. Connect one with
`connect_connector`; it only leaves a card, so tell the user to press it and
confirm with `status mcp`.

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
3. workflow: done when `onboarding` lists `workflow` as visited. Explain
   workflows and agents, `open workflows` so the user can turn agents on and
   pick models (`set_agent_route` once they name a model). Recommend models
   from `${MIXDOG_SKILL_DIR}/model-recommendations.json`, role by role, only
   among providers the user is signed in to (`status providers`) and only a
   model the provider's model list actually offers; picks are an ordered list
   of any length, so recommend the first one that qualifies and otherwise take
   the next. A subscription sign-in always comes first: when the user has one,
   take the first qualifying pick it offers before any pick that would bill an
   API key, and only fall back to API-key providers when no subscription
   offers one. If `asOf` is older than `staleAfterDays`, say the list may be out of
   date. Never print ids or file names. Roles with
   `preferOtherProviderThan` (Reviewer, Advisor) work best with the opposite
   tendency from the model doing the work: pick the first qualifying model whose
   provider differs from the chosen Lead's and Heavy Worker's providers, and
   fall back to the plain first pick only when the user has a single signed-in
   provider. Give the reason in one line: a different model family catches what
   the main one misses. Suggest turning on the Maintainer with
   a cheap model at the lowest effort; it also decides turns in group rooms.
   Offer Explore the same way, from its own picks: a cheap model that
   searches code for the Lead in separate parallel sessions.
   A pick may carry `plans`: when the Lead provider's plan (`plan` in
   `status providers`) is listed there, recommend that model instead. A null or
   unlisted plan keeps the pick as is; never fail on an unknown plan.
   Delegation and roster come from `delegation` in the data file. First ask
   once how the user likes to work: one agent doing everything, or splitting
   work across agents. Say plainly that Solo is a good choice at any plan: it
   is the most efficient, and with a strong model its quality is often not much
   lower; delegation trades more usage for speed and parallel work. Then suggest
   the mode whose `plans` lists the Lead provider's plan (the default
   suggestion), but the user's preference overrides it. Ask once; set it with
   `set_orchestration_mode`, and say it can be changed later in settings. The
   roster follows the chosen mode: turn on only `baseRoster` plus that mode's
   `agents`, using `set_agent_route` with `route.disabled` set false for what
   the user accepts and true for the rest; do not enable others. Offer
   `leanReview` for Solo or focused as a cost saver: the Lead reviews its own
   work, Reviewer stays off, Advisor is on but used rarely (only when stuck).
   Advisor in balanced or swarm is a light, occasional second opinion from a
   different model family at key decision points, not on every task. Say in
   one line that more agents can be turned on later on the Workflows page.
   Right after the models are picked, explain Auto reasoning: it adjusts
   reasoning depth per message around a medium baseline, so hard work may
   come out slightly lower in quality but cost is much lower. The Lead runs
   the main coding work, where stability matters most, so also recommend
   fixing the Lead's effort at High or above in the model picker (choosing an
   effort there turns Auto off for that model). Ask whether to turn Auto on
   (`install_builtin` `autoEffort`). If declined, say in one line that it can
   be turned on later by choosing Auto at the top of the model picker's
   reasoning effort list.
4. remote: done when a device is paired (`status connection`) or `remote` is
   visited. Pairing is user-operated: `open connection`.
5. extensions: done when `extensions` is visited. Explain plugins and skills;
   offer only built-ins not already covered by the tiers above.
6. mixy: done once Mixy exists, which is already true when this skill runs in
   Mixy's chat. Offer to make another bot when the user wants one.

After a change, report it in a sentence and move on. The user may stop at any
step; do not insist.

## Glossary

- Bot (봇): a contact you chat with in bot mode (봇 모드). Mixy is the representative
  bot; the user can have it make others, such as a GitHub Watcher.
- Agent (에이전트): a workflow sub-agent such as Worker or Reviewer that
  does part of a task. Users add their own on the Workflows page with the
  "에이전트 +" button. Bots are people-facing; agents work behind a task.
- Default agents (기본 에이전트): built-in helpers listed on Workflows, such as
  Web Search (runs the web search tool), the Maintainer (memory upkeep and
  session titles) and Explore (code search for the Lead). They need a model
  route to work.
- Agent mode (에이전트 모드): a coding work session run by Lead and agents.
  A session a bot starts for a job is an agent task session (에이전트 작업
  세션); others are just sessions (세션).
- Sessions and projects: an agent-mode session runs in a Project, a folder whose
  instructions and memories it loads.
- Workflows and work rules: a workflow sets how a request gets done; work
  rules are the instructions it applies.
- Connectors and extensions: connectors are MCP services such as Notion or
  Linear (`connect_connector`, the user presses the card); extensions are
  plugins that add tools and skills that teach how to work.
- Group rooms (그룹 대화방): one chat with several bots. `@name` or "봇 부르기"
  addresses one bot; otherwise the Maintainer decides who answers next.
- Schedules and webhooks: a timed or incoming-event trigger (`save_automation`).
  Each run is one turn in its bot's own chat, with that bot's persona, rules,
  permissions, memory and model. Without a bot they cannot be used.
- Approval cards: when a tool needs permission it waits in the chat until the
  user approves or declines.
- Phone remote access: pair a phone under Settings → Connection to follow and
  steer tasks away from the PC.

## Pitfalls

- Do not claim a step is done from memory; re-read state after acting.
- A UI handoff (`open`) is not completion; ask the user to confirm, then
  re-check the status.
- Do not run several steps in one message or queue the next question early.
