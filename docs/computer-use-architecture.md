# Computer Use module boundaries

This layout preserves the existing public tool schema and native host protocol.

- `observation/capture.ts` sequences a capture and owns its semantic baseline.
  `capture-pixels.ts` acquires window-owned pixels and zooms; `capture-ocr.ts`
  budgets and merges OCR; `capture-result.ts` shapes the observation;
  `capture-after.ts` preserves post-action capture preferences and recovery.
- `host/command-router.ts` owns ordering, target resolution, leases, invalidation
  and transitions. `input-dispatch.ts` authorizes immediately before delivery;
  `action-reply.ts` interprets evidence and attaches the resulting observation.
- `src/runtime/computer-bridge/actions.mjs` is the shared action catalogue.
  Public replay safety, native read-only status, reference retention, foreground
  serialization, observation requirements and policy names are distinct flags.
  Unknown actions never acquire read/replay privileges.
- `backend/sources/` holds editable C# and PowerShell originals. Tiny TypeScript
  adapters render only named placeholders. Source execution reads these files;
  `scripts/computer-source-assets.mjs` embeds them in both Vite desktop builds
  and esbuild harness bundles. Installed execution needs no loose source files.

## Tests

Fast behavior/contract tests use `*.test.mjs`. Worker process lifecycle, native
compilation and Windows fixture execution use `*.slow.test.mjs`. Native fixtures
live under `host/fixtures/`, separate from assertion code.

`clipboard.live.test.mjs` is opt-in and additionally requires
`MIXDOG_COMPUTER_LIVE_CLIPBOARD=1`. Do not enable it as part of an isolated check.
It accesses the real clipboard and attempts to restore its original contents.

`backend/source-bundle.test.mjs` executes Vite and esbuild outputs from a
temporary directory without adjacent source assets, and compares the generated
host program to source execution. This catches missing build-plugin wiring
without launching the desktop app or interacting with a user window.
