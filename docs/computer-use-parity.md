# Computer Use parity and recovery boundaries

This is a source/fixture comparison, not a claim of production-product parity.
The reference sources inspected were the local Cua Windows driver, OpenAI's
computer-use sample application, and Anthropic's public computer-use demo and
best-practices quickstart. Public samples do not expose every production control.

## Contracts and remaining gaps

| Area | Current implementation and evidence | Remaining boundary |
| --- | --- | --- |
| Window capture | Electron window capture, exact-HWND `PrintWindow`, then bounded Windows Graphics Capture (WGC) when those pixels are unavailable/unusable. Native paths share identity/geometry guards; zoom retains its original backend. `backend/window-graphics-capture.electron.test.mjs` verifies repeated real WGC captures of a covered fixture, known pixels, unchanged foreground and geometry rejection. | WGC requires OS support and a working graphics device. The fully off-screen fixture returned black pixels; quality checks still reject unusable frames. Source/fixture coverage does not establish acceptance for every GPU/DirectComposition application, including Unity. |
| Coordinates | A bounded final image size is registered before the frame becomes actionable. Root `capture-size.test.mjs` checks encoder budgets and that provider preparation preserves the registered dimensions. | Other display/DPI combinations and installed application behavior still need independent acceptance. |
| Input planning | `host/input-preflight.ts` shares the dispatch key grammar and app-owned text eligibility. Native refs are not incorrectly exempted from preflight. The native worker checks the addressed child rather than treating the outer window's class as proof about every child. | A valid preflight is not proof of delivery; target and authority are checked again at dispatch. The supported toolkit/action matrix remains narrower than a complete Windows desktop matrix. |
| Partial execution | Native and app-owned typing retain the preparatory click's delivery evidence when text fails. Uncertain sequence steps stop all continuation and remain in diagnostics. | Neither transport acknowledgment nor an accessibility echo proves the user's complete task succeeded. |
| Session release | Concurrent releases share one acknowledgment; a new command waits for the previous release and can be cancelled without sending input. Shutdown waiting retains its own deadline. | An unconfirmed release is not permission to dispatch the waiting command. |
| Capture deadlines | WGC preparation, frame acquisition, GPU copy and encoding share a 1500 ms work budget within the existing 2000 ms worker deadline. Async timeout requests cancellation and checks settlement; uncertain cancellation/cleanup removes the worker from reuse before resolving its original error receipt. | Synchronous driver calls can still require the outer process deadline. Other OCR consumers retain their existing caller-owned deadlines. |
| Capture evidence | `capture-sources.ts` owns transport selection separately from frame/coordinate registration. Bounded attempt records preserve each backend's outcome, code, elapsed time and cleanup, including successful fallback and owner scope. Replies, run history and saved failure bundles retain only category fields. | No private pixels, titles or raw provider errors enter the attempt ledger. A timeout remains failure even if an operation completes during cancellation. |
| Observation failure | Completed input and failed observation remain separate. Recovery asks for fresh observation, never repetition of completed input. | A failed observation cannot be promoted to goal success. |
| Stop control | The hit target stays fixed during takeover/status changes. An Electron fixture uses Windows hit-testing and window-targeted mouse messages through the sandboxed preload, without moving the cursor or activating the overlay. Repeated Stop requests share their completion. Native cleanup proceeds independently of bounded daemon cancellation; either failure keeps input paused. An unresponsive control renderer triggers a safety pause. | Fixture input does not establish installed-build acceptance. OS-wide physical input and the current user's active application are not exercised by this test. |
| Cleanup | Worker exit and global input release are independent gates. The action catalogue distinguishes press/release lifetimes from semantic operations and plain character messages, avoiding fictitious held-input failures. Global key release cannot clear missing target-local message-release evidence. | Unconfirmed background release requires user recovery. Restarting the host does not prove the application received a release. |
| Browser routing | Native delivery errors retain the user-selected external window/session. Mixdog browser work stays with Browser Use. | Cua's browser-page escalation is not transferable to a browser tool that cannot attach to the selected external window. |
| Verification | Fast behavior tests, native compilation, dedicated fixture pixels, source bundles, and privacy checks cover the changed boundaries. | Full app/toolkit × action × delivery matrices, actual human interruption, and installed-build acceptance remain separate checks. |

## Policy decisions

- Use supported background input by default. Known no-input refusals permit
  choosing another supported route only within the user's approved scope.
- Do not force a failed background attempt when unsupported behavior is already
  established, and do not infer support or failure from the app name alone.
- A no-input refusal for one action does not erase earlier completed steps.
- Preserve the selected browser session. Do not use another tool, shell input
  host, or another browser to bypass a refusal, user stop, CAPTCHA, or consent.
- Usable pixels remain usable when OCR is unavailable. Do not repeatedly call a
  missing recognizer or silently install language packs.
- Never replace window-owned capture with a crop of the shared desktop. A
  covering application's pixels are not evidence of the requested window.
- WGC keeps the OS capture indicator and never restores or focuses a window.
  Denial, minimization, cloaking or changing geometry stops native fallback.
  No borderless capture permission, SDK installation or graphics-device
  reconfiguration is requested.
- Keep stricter safety contracts where samples assume a disposable, exclusively
  controlled desktop. Do not adopt arbitrary code execution or silent delivery
  switching merely to increase apparent action coverage.

## Skill review scenarios

The prior built-in skill is preserved by Git blob
`752f7ea0e0c8647bf4f6532cd46f7ce33dd2d1b1`. These are instruction/contract review
scenarios, not a live-model A/B benchmark:

| Scenario | Required decision |
| --- | --- |
| Read and click a native editor with empty accessibility and unavailable OCR, but usable pixels | Continue with the fresh image/frame; no recognizer retry or package installation. |
| Save in an external signed-in browser after a definite unsupported background chord | Keep that browser; use explicit foreground only if in scope. |
| A preparatory click completed, then typing failed | Inspect the resulting state; do not retry the whole operation or call it unexecuted. |
| Input completed but its final screenshot failed | Recover observation only; preserve completed progress. |
| A strict background-only request needs foreground input | Ask for the material scope change, not an automatic escalation. |
| Work in Mixdog's own browser | Use Browser Use, not native desktop fallback. |

## Reference paths

- `C:/Project/refs/cua/libs/cua-driver/rust/crates/platform-windows/src/capture.rs`
- `C:/Project/refs/cua/libs/cua-driver/rust/crates/platform-windows/src/wgc.rs`
- `C:/Project/refs/cua/libs/cua-driver/rust/crates/platform-windows/src/input/keyboard.rs`
- `C:/Project/refs/cua/libs/cua-driver/rust/crates/cua-driver-core/src/action_record.rs`
- `C:/Project/refs/cua/libs/cua-driver/docs/action-support.md`
- `C:/Project/refs/openai-cua-sample-app/python-app/app/desktop/worker.py`
- <https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-best-practices>
