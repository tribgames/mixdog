# Computer Use delivery and feedback audit

Date: 2026-09-10. Scope: delivery selection, pointer feedback, focus ownership,
interruption/resume, and failure reporting. This is a source-level audit, not a
claim that the installed app has passed the final live acceptance scenario.

## Delivery contract

| Situation | Route | Required behavior |
| --- | --- | --- |
| Read a native window | Capture/inspect/verify | No input mode or focus change is needed. |
| Supported native actions, including clicks, scrolling and text/value input | Background, the public `act` default | Prefer semantic actions or native window messages; do not equate delivery with success. |
| Known unsupported background route, real-pointer/focus requirement, or demonstration | Explicit foreground | Prepare and validate the exact target, move the one real pointer, then dispatch. |
| Strict no-focus work | Background only unless scope changes | Do not silently escalate or send a known unsupported action merely to confirm it fails. |
| Background semantic provider that can temporarily take focus | Background with a shared focus guard | Serialize against foreground work without changing delivery mode. Never restore focus over intervening user input. |
| User intervention during visible work | Pending | Retain progress, wait for control, obtain fresh observation, then continue intent. Never replay completed or uncertain input. |
| Unsupported route or uncertain result | Inspect first | Do not automatically switch modes. A different route requires evidence that no input was sent and must remain within the user's scope. |
| Web content | Browser Use | Native input is not a workaround for a Browser Use refusal. |

Background is a delivery choice, not a promise that arbitrary application code
cannot create a dialog or change focus. Choose it for known supported work;
preserve user focus when a provider temporarily takes it. A safety pause blocks
background input too.

## Reference comparison

- The local Codex repository exposes Windows application requirements and
  configuration, but did not provide the production cursor renderer inspected
  here. Production Codex visual parity is therefore **unverified**.
- The local CUA cursor documentation separates physical input, a synthetic
  pointer, semantic effects, and authorization. Its separate arrow is not
  adopted: this implementation must retain one real pointer.
- The official OpenAI computer-use sample uses a persistent desktop runtime,
  real mouse input, and explicit result inspection. Its README explicitly says
  that OpenAI products have different runtimes and additional controls.
- Reference material supplied design ideas only. No reference implementation
  was copied or adapted.

## Findings and changes

| Finding | Change | Evidence |
| --- | --- | --- |
| Visible mouse work was incorrectly generalized into a foreground default | Restored background-first selection; real-pointer/focus requirements and demonstrations use explicit foreground | `delivery.test.mjs` |
| Modified background ref clicks lost Ctrl/Shift through semantic invoke | Modified clicks use native pointer messages instead of unmodified semantic invocation | `delivery.test.mjs` |
| A later unsupported key token could follow an already typed prefix | Parse the entire background key sequence before target lookup or dispatch | Native preflight test |
| Partial background delivery could be reported as no input sent | Preserve unknown delivery and `input_may_have_executed`; sequence rows are uncertain and follow-ups stop | Native failure and sequence tests |
| Foreground scrolling could invoke background ScrollPattern | Delivery now controls the branch; foreground scroll glides to the checked target | `foreground-order.test.mjs` |
| Targeted typing jumped the pointer instead of gliding | Shared typing-point preparation re-resolves the target before movement and click | Native program parsing/compilation and guarded pointer path |
| Modifier handling differed between click, drag, and scroll | One modifier lifetime releases every held key, including after partial failure | `pointer-modifiers.test.mjs` |
| A background semantic operation could interfere with another foreground operation | Shared focus-guard serialization, separate from delivery/presentation mode | `command-queue.test.mjs` |
| Cleanup could restore stale focus after user intervention | Restore only under the original input observation, for foreground release and background semantic cleanup | `focus-ownership.test.mjs` |
| A refused input could be mislabeled as failed recovery to an older session focus | Explicit no-dispatch plus unchanged pre-action state closes cleanup without claiming action success | `input-recovery.test.mjs` |
| Recovery guidance encouraged blind mode changes | Focus failures request user assistance; uncertain background effects request fresh evidence | `error-recovery.test.mjs`, `analysis.test.mjs` |
| Cold effect-window startup raced the first gesture | Bounded surface preparation precedes dispatch; initialization failure cleans up the window | Cursor readiness and Electron lifecycle tests |
| Scroll/key/type events were missing from the feedback transport | Explicit event categories are now propagated without input content | `pointer-progress.test.mjs` |
| Style and visible-window flags were mistaken for visual proof | Added actual renderer-pixel checks and current-display placement checks | `cursor-art-electron.test.mjs` |
| Re-intervention between Resume and Capture looked like lost connection | The actual bridge pause response re-enters waiting without re-sending input | `pending-reentry.test.mjs` |
| Read failures discarded pending-work detail | Return retained progress and a fresh-observation requirement | `pending-continuation.test.mjs` |
| Restoration ACK races could produce false cleanup failures | Preserve an outstanding read and confirmed restoration; late ACTIVE does not discard RESTORED | `cursor-protocol.test.mjs` |
| Detached watchdog console creation was unspecified | Use supported WMI hidden-console startup; stop a hung launcher | Harmless detached-launch test; no desktop input |
| Final replies lost native cursor lifecycle evidence | Preserve allowlisted lifecycle booleans through action replies and sequence rows | Native guards, sequence, and diagnostic tests |

`system_theme_applied`, `system_theme_restored`, and `pointer_moved` are lifecycle
evidence. They do not prove that a person saw the cursor or that the requested
application task succeeded. Diagnostics exclude input text, screenshots,
clipboard contents, and cursor coordinates.

## Verification boundaries

Completed automated checks include C# compilation, PowerShell parsing,
JavaScript/TypeScript behavior tests, real named-pipe protocol tests with a
non-input peer, harmless watchdog process creation, renderer-pixel checks,
current-display overlay positioning, bundle completeness, compressed elevated
transport, node type checking, and skill validation. Tests were memory-bounded
and run without a full application build or broad React renderer suite.

The fixture renderer tests do not establish installed-app end-to-end behavior.
Mock input and protocol tests do not establish actual human intervention.
Current displays were checked; other DPI combinations were not changed or
claimed verified.

## Open parity gaps from the follow-up review

These findings are not fixed by the earlier parser, modifier, or uncertainty
changes. They remain open rather than being counted as completed parity.

| Priority | Source evidence | Required next change |
| --- | --- | --- |
| High: background gesture release | `BackgroundDrag` sends button-up only after the movement loop. `MouseClick` and `BackgroundVirtualKey` also put release after press without exception-safe cleanup. | Bind one bounded release attempt to the original target after known or possible press delivery. Do not replay the gesture, retry an uncertain release, or substitute foreground/global input. Preserve cleanup uncertainty if release cannot be confirmed. |
| High: background feedback can cover unrelated work | Background cursor presentations are retained, while `cursor-overlay.ts` creates every effect window as global screen-saver-level always-on-top. | Keep foreground real-pointer effects. Background feedback must stay with its target, or be omitted when safe target-relative placement cannot be established; do not draw through another foreground window. |
| Acceptance gap: whole desktop behavior | Renderer-pixel and current-display tests do not establish target-relative z-order, live pointer/focus noninterference, or installed-app interruption recovery. | Verify pixels, focus, pointer position, and stacking independently on a disposable target plus an unrelated foreground window. Keep installed-app verification pending until approved deployment and user-controlled recovery. |

The local CUA Windows test explicitly describes a targeted overlay below an
independent foreground window and checks separate pixel, focus, cursor, and
z-order outcomes. The inspected test is ignored by default; it was read, not
executed here. The official OpenAI sample separately attempts bounded input
release and requires acknowledgment. Those are design/acceptance references,
not proof that Mixdog has passed the same cases.

Implementation of these new release/placement changes requires approval of
the follow-up scope. Background-first selection and the no-replay contract
remain unchanged.

## Remaining live acceptance

1. Obtain approval for this revision's local update/restart.
2. Honor the existing safety pause; the model must not clear it itself.
3. In the installed app, observe an exact test window and perform separate
   foreground move/click actions. Check pointer motion, cursor appearance,
   preparation/click effects, and returned lifecycle evidence independently.
4. Exercise scroll and modifier-held gestures on a suitable disposable target.
5. Have the user intervene, stop input, and observe pending/resume with fresh
   state. Repeat intervention during recovery. Confirm no input is duplicated.
6. Check explicit background delivery separately: user pointer/focus protection
   and application effect are separate acceptance conditions.
7. Verify theme restoration after ordinary completion and cancellation on the
   deployed revision. Earlier live restoration results are not a substitute
   for acceptance after the watchdog changes.

Do not repeat a failed gesture, clear the safety guard, run a new input host
around a refusal, or report production Codex parity to make this list pass.
