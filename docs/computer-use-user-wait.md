# Computer Use user wait and quiet resume

## Contract

- `computer({ action: "wait_for_user", input: { timeout_ms: 60000 } })`
  observes control availability, without input, window capture, or an execution
  queue slot. Its status is `resumed`, `timeout`, or `cancelled`.
- Only `resumed` permits a **new capture**. No interrupted input is replayed.
  A timeout is not permission to send input. Each wait is bounded at 120 seconds;
  duplicate session waits and excess waiters are refused.
- Ordinary input interruptions and manual pause retain requests that have not
  started. Requests keep their per-session order and admission limits. They
  wait outside the desktop lane and the active-operation drain, so cleanup and
  Resume cannot deadlock behind the paused queue. Stop and caller cancellation
  cancel the queued requests, including when pause cleanup is still running.
- After Resume, queued reads run against current state. A queued mutation returns
  a fresh target observation with `computer_resume_recapture_required`; the agent
  reviews it and issues a new action rather than replaying old coordinates,
  refs, or a partially executed input. Queue preservation is not input replay.
- Ordinary `user_input_active` interruptions can resume after five continuous
  quiet seconds. The saved host preference supports 1–60 seconds, or manual
  (0), independently of window/action authorization. The minimal overlay does
  not display a time selector.
- New input, a held key/button, replacement observation, or a changed setting
  resets the quiet period. Cleanup must finish first. The final input sequence
  is checked again after the resume barrier.
- Explicit stop, authorization/environment changes, unknown input observation,
  and failed input cleanup never use the idle path. Existing authorization,
  target freshness and foreground guards still apply to subsequent commands.
- Native sampling returns only readiness, generation/sequence, elapsed idle time
  and a held-input boolean. It does not return keys, text, coordinates or pixels.

## Overlay and execution boundaries

The overlay uses a dedicated sandboxed preload and per-WebContents IPC, rather
than custom-scheme navigation. The handler validates its owning main frame,
action, generation and payload. Requests receive acknowledgements. The visible
surface distinguishes "Mixdog 사용 중", "사용자 조작 중" and "확인 필요", with
quiet-resume, manual-pause or cleanup guidance. Separate pause/resume and Stop
buttons remain available. Pause does not end the agent task; it marks a manual
pause that cannot auto-resume. During a pending resume the toggle can pause
again, cancelling that request; Stop cancels the queued work and ends the
owning agent turns. Failed requests show confirmation guidance, while cleanup
and stale-generation guards remain. Ctrl+Alt+Esc remains an emergency Stop.

The user waiter and parked command requests live outside the active operations
that Resume drains. Old frame/target state is invalidated before control
availability is published. A fresh observation, not the old action, follows.

## References and limits

Local `cua` human completion adapter/server informed the request-state and
bounded-wait separation; they do not themselves implement idle-based consent.
No reference code was copied. Existing Cua/Hermes transport uncertainty and
no-replay principles remain in effect.

The installed overlay was reported to ignore Resume. Source changes alone are
not evidence of an installed fix. A hidden isolated Electron test checks the
actual preload/IPC route without touching user windows. Native compilation and
boundary tests do not establish real multi-monitor hook reliability, nor do
they complete the pending Notepad/Calculator/Excel live acceptance checks.

No deployment or app restart is part of this change.

## Verification — 2026-09-05

- 30 scoped tests passed: quiet-period reset, held input, explicit stop,
  uncertain observation, cleanup, last-moment input, timeout/cancellation,
  duplicate wait rejection, persistence, bridge queue separation, old-target
  invalidation, overlay response/error delivery, and native guards.
- Main/preload TypeScript passed. The main and both preload entries built;
  `out/preload/computer-overlay.js` is emitted separately from the app preload.
- The isolated hidden Electron fixture delivered Resume once, Stop once,
  accepted a 10-second preference, and rejected stale/invalid requests.
  The old custom-scheme navigation also reached its handler in that fixture.
  Therefore it does **not** establish the installed no-response root cause.
- PowerShell parsing and C# compilation passed without driving user windows.
- The built-in skill structure validator passed. Guidance review retained
  normal native-app routing, used bounded waiting for an interruption,
  required fresh capture after resume, refused input after timeout, and kept
  web-page work on Browser Use. This is a contract review, not an agent A/B run.
- The initial test invocation used the repository root, where `tsx` is absent.
  Running from the desktop package resolved that harness error; no dependency
  installation was needed.

Installed real-pointer Resume and the pending Notepad/Calculator/Excel flows
remain unverified until a separately approved deployment and live test.

## Historical minimal overlay revision (superseded)

The single-button design supersedes the earlier text status, separate
Resume/Stop controls and interval selector. Accessibility labels identify
Pause/Resume without introducing additional visible text or hover captions.
The pulse stops while paused and respects reduced-motion preferences.

The revised scope passed 36 tests, main/preload TypeScript and production
builds, and skill validation. The hidden Electron fixture checked the actual
240×70 surface: one button, only the fixed caption, no overflow, and successful
pause/resume IPC. A manual `user_pause` remained paused beyond the quiet interval.
No installed-app deployment, restart or real-pointer acceptance was performed.

## Queue-preserving pause revision

The fixed-caption/single-button surface above is superseded by distinct status
text and a separate Stop button. The hidden Electron fixture checks both
languages, all status/detail layouts, and real pause/resume/Stop preload IPC
without showing a window. Queue tests cover FIFO preservation, native
interruption, foreground-lane cleanup, fresh-target handoff and cancellation.
Deployment and installed-app pointer acceptance remain separate approvals.
