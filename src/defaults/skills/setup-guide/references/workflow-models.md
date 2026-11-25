# Workflow step: models, delegation and Auto reasoning

Read this at the workflow step, before recommending any model or roster.

## Model picks

Model lineups change too fast to name models here. Pick from what the user's
providers offer now: the models and effort levels each signed-in provider
lists (`status providers`), judged by where a model stands in that provider's
own lineup.

- Use only providers the user is signed in to, and only models their lists
  offer. A subscription sign-in comes first; fall back to a provider billed by
  API key only when no subscription offers a fitting model.
- Lead, Bot default, Heavy Worker and Front Worker: the provider's most capable
  coding model, at medium effort (Heavy Worker high). On a plan whose usage of
  that model is tight, its next tier down serves these roles.
- Worker and Writer: the provider's middle tier at medium effort.
- Reviewer and Advisor: high effort, the Advisor the highest the model offers.
  Take them from a provider other than the Lead's and Heavy Worker's when the
  user has more than one: a different model family catches what the main one
  misses. Say so in one line.
- Web Search: a fast model at low effort.
- Maintainer: the cheapest fast model at the lowest effort; it also decides
  turns in group rooms.
- Explore: a fast model at low effort that searches code for the Lead in
  separate parallel sessions. In Mixdog's measurements the smallest budget
  models missed about half the key locations, so leave Explore off when the
  user has nothing above that tier.
- Never print ids or file names.

## Delegation and roster

Modes and the agents each turns on:

- Solo (`none`): no agents.
- Focused (`focused`): Worker, Reviewer.
- Balanced (`balanced`): Worker, Reviewer, Heavy Worker, Advisor.
- Swarm (`swarm`): Worker, Reviewer, Heavy Worker, Advisor, Writer, Front
  Worker.

Maintainer and Web Search are on in every mode. The default suggestion follows
the Lead provider's plan (`plan` in `status providers`): no subscription or a
free tier (Anthropic `none`; OpenAI `free`, `none`; Google `free-tier`) Solo;
Anthropic `pro`, OpenAI `plus`, Google `standard-tier`, `legacy-tier` Focused;
Anthropic `team`, `enterprise`, OpenAI `team`, `business`, `enterprise`, Google
`g1-pro-tier` Balanced; Anthropic `max`, OpenAI `pro`, Google `g1-ultra-tier`
Swarm. For a plan not listed, ask which plan the user has; if they do not
know, suggest Focused.

1. Ask once how the user likes to work: one agent doing everything, or
   splitting work across agents. Say plainly that Solo is a good choice at any
   plan: it is the most efficient, and with a strong model its quality is often
   not much lower; delegation trades more usage for speed and parallel work.
2. Suggest the mode the plan points to (the default suggestion); the user's
   preference overrides it. Ask once, set it with `set_orchestration_mode`, and
   say it can be changed later in settings.
3. The roster follows the chosen mode: turn on only Maintainer, Web Search and
   that mode's agents, using `set_agent_route` with `route.disabled` false for
   what the user accepts and true for the rest; do not enable others.
4. For Solo or Focused, offer lean review as a cost saver: the Lead reviews its
   own work, Reviewer stays off, Advisor is on but used rarely (only when
   stuck). Advisor in Balanced or Swarm is a light, occasional second opinion
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
