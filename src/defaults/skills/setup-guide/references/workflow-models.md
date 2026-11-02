# Workflow step: models, delegation and Auto reasoning

Read this at the workflow step, before recommending any model or roster.

## Model picks

Recommend from `${MIXDOG_SKILL_DIR}/model-recommendations.json`, role by role.

- Use only providers the user is signed in to (`status providers`) and only a
  model the provider's model list actually offers.
- Picks are an ordered list of any length: recommend the first one that
  qualifies, otherwise take the next.
- A subscription sign-in comes first: when the user has one, take the first
  qualifying pick it offers before any pick that would bill an API key; fall
  back to API-key providers only when no subscription offers one.
- A pick may carry `plans`: when the Lead provider's plan (`plan` in
  `status providers`) is listed there, recommend that model instead. A null or
  unlisted plan keeps the pick as is; never fail on an unknown plan.
- Roles with `preferOtherProviderThan` (Reviewer, Advisor) work best with the
  opposite tendency from the model doing the work: pick the first qualifying
  model whose provider differs from the chosen Lead's and Heavy Worker's
  providers, and fall back to the plain first pick only when the user has a
  single signed-in provider. Give the reason in one line: a different model
  family catches what the main one misses.
- If `asOf` is older than `staleAfterDays`, say the list may be out of date.
- Never print ids or file names.
- Suggest turning on the Maintainer with a cheap model at the lowest effort; it
  also decides turns in group rooms.
- Offer Explore the same way, from its own picks: a cheap model that searches
  code for the Lead in separate parallel sessions.

## Delegation and roster

Delegation and roster come from `delegation` in the data file.

1. Ask once how the user likes to work: one agent doing everything, or
   splitting work across agents. Say plainly that Solo is a good choice at any
   plan: it is the most efficient, and with a strong model its quality is often
   not much lower; delegation trades more usage for speed and parallel work.
2. Suggest the mode whose `plans` lists the Lead provider's plan (the default
   suggestion); the user's preference overrides it. Ask once, set it with
   `set_orchestration_mode`, and say it can be changed later in settings.
3. The roster follows the chosen mode: turn on only `baseRoster` plus that
   mode's `agents`, using `set_agent_route` with `route.disabled` false for
   what the user accepts and true for the rest; do not enable others.
4. Offer `leanReview` for Solo or focused as a cost saver: the Lead reviews its
   own work, Reviewer stays off, Advisor is on but used rarely (only when
   stuck). Advisor in balanced or swarm is a light, occasional second opinion
   from a different model family at key decision points, not on every task.
5. Say in one line that more agents can be turned on later on the Workflows
   page.

## Auto reasoning

Right after the models are picked, explain it: Auto adjusts reasoning depth per
message around a medium baseline, so hard work may come out slightly lower in
quality but cost is much lower. The Lead runs the main coding work, where
stability matters most, so also recommend fixing the Lead's effort at High or
above in the model picker (choosing an effort there turns Auto off for that
model). Ask whether to turn Auto on (`install_builtin` `autoEffort`). If
declined, say in one line that it can be turned on later by choosing Auto at the
top of the model picker's reasoning effort list.
