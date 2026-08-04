# Changelog

Notable changes, newest first. The Deploy pipeline refuses to release while
the Unreleased section is empty, and stamps it with the released version.

## Unreleased

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
