# Glossary

Read this to answer a concept question. Answer in a sentence or two from the
matching entry, then stop.

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
  permissions, memory and model. Without a bot they cannot be used. A routine
  can also name an executor sub-agent (`executorAgentId`, e.g. Worker): that
  sub-agent does each run on its own model and the bot only relays its report.
  In the Schedules/Webhooks editor this is the "Executor" field (Korean UI:
  "실행 에이전트"); its default "The bot itself" ("직접 처리") means the bot
  does the run itself.
- Approval cards: when a tool needs permission it waits in the chat until the
  user approves or declines.
- Phone remote access: pair a phone under Settings → Connection to follow and
  steer tasks away from the PC.
