# Feature installs and connectors

Read this before offering add-ons or explaining, recommending, or connecting
connectors. Visualize and Media generation are toggles and are handled in
`SKILL.md`.

## Installing add-ons

Use `install_builtin` with the name for git, memory, autoEffort, computer,
browser, voice, localProvider and tidy.

- Git installs system Git through the Desktop when this chat is open there.
- Auto reasoning can be unsupported on a machine: report that instead of
  retrying.
- Computer Use and Browser Use need the Desktop, and the user approves OS
  permission dialogs.
- Local Provider only prepares the runtime; models belong to `local-provider`.
- Memory is install-only; its later on/off is `set_memory_enabled`.

## Connectors

Explain first, in a sentence or two: a connector links an outside service so
bots and agents can read and act in it, and anything that sends or posts asks
first through an approval card. Then suggest by what the user does, only
these:

- Gmail: needs a Google app password, which needs 2-Step Verification on the
  Google account; the connect window opens the app-password page in the
  browser.
- Google Calendar and Google Drive: both use the Google sign-in.
- Notion, Linear or Jira.

GitHub is not a connector; it is the signed-in GitHub CLI of Git & GitHub.

Connect one with `connect_connector`. It only leaves a card: tell the user to
press it, then confirm with `status mcp`.
