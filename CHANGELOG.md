# Changelog

Notable changes, newest first. The Deploy pipeline refuses to release while
the Unreleased section is empty, and stamps it with the released version.

## Unreleased

## v0.9.94 - 2026-08-05

- Desktop tab strip follows Chromium's `tab_strip_layout`: tabs shrink
  together toward the active/inactive floors with every tab visible instead
  of scrolling, and touch shells collapse to a title + count switcher list.
- Streaming markdown heals the live tail (unclosed `**`, `` ` ``, `~~`) and
  scopes the fenced-code geometry lock to its own chunk, so headings, lists,
  and bold format while the model is still typing.
- Turn review moved into the scrolled timeline (OpenCode `session-turn-diffs`
  parity), ending the composer-stack shift on session entry; warn-tone
  notices now use the amber status pair instead of the neutral one.
- Native caption band is transparent so the DOM titlebar and dialog scrims
  dim it directly; the ◀ ▶ pane-cycle pair is retired (Alt+Left/Right keeps
  the focus cycle) and project dialogs hold the titlebar dim claim.
- Desktop UI capture drives New task and Settings through Ctrl+N / Ctrl+,,
  pins the capture language, and asserts the 360px narrow settings layout.
- TUI transcript window and jitter harness refinements, plus desktop
  session-selection race probes.

## v0.9.93 - 2026-08-04

- Dependency audit to zero across core and desktop: `npm audit fix` for
  fast-uri, ip-address, hono/@hono/node-server, root undici, and
  brace-expansion; discord.js nested undici override raised to 6.28.0;
  desktop `dompurify` override `^3.4.12` clears the Monaco XSS batch.
- README feature audit: desktop workbench section, memory subsystem detail,
  QR relay pairing, quiet-hours cron and local Whisper transcription,
  parallel pane sessions, onboarding wizard.
- Discord: removed the last registered slash command (`/stop`); startup still
  clears stale global/guild command sets.
- Terminal-Bench 2.1: corrected results, replacement comparison charts, and
  reproduction/verification scripts.
- CI: Deploy is now the single release entry point (token supply chain folded
  in, tag-push side doors removed) with a changelog release gate.
- Unified package versions at 0.9.92 (mobile/relay aligned) and squashed the
  repository history to a clean root.

## v0.9.92 - 2026-08-02

- Baseline release: npm package, desktop installers, and native supply-chain
  assets (runtime, patch, graph, token, voice runtime).
