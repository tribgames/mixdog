// Shell layout derivation. Pure render-phase math:
// given the terminal size and every surface that reserves rows (panels,
// prompt box, queued band, welcome banner, hints), compute the transcript
// viewport height and the whole bottom-cluster row budget. Runs once per
// render; the few ref writes mirror the previous inline behavior.
//
// The transcript must live in a box with an EXPLICIT numeric height +
// overflow:hidden so ink's renderer actually clips off-screen rows
// (render-node-to-output.js → output.clip uses the box's computed height). An
// unbounded negative-margin column inside a flexGrow box let stale rows
// overprint newer ones across incremental redraws. We reserve the rows the
// bottom cluster needs and give the transcript everything above it:
//
//   viewportHeight = rows
//                  − welcome header  (empty transcript only)
//                  − live status     (thinking / spinner / TurnDone)
//                  − queued prompts  (marginTop 1 + N rows, only when queued)
//                  − prompt meta     (spinner / transient message / queued)
//                  − input box       (2 border + wrapped content)
//                  − statusline      (reserved L1 + L2 + outer gap; total 3 rows)
//
// Every sibling outside the viewport must be accounted for here; otherwise
// the total tree height exceeds the terminal and the input box gets pushed.
import { deriveSurfaces, deriveLiveHints } from './shell-layout/surfaces.mjs';
import { computeRowBudgets } from './shell-layout/row-budgets.mjs';
import { resolvePanelTransition } from './shell-layout/panel-transition.mjs';
import { carveViewport, hintWidths } from './shell-layout/viewport.mjs';

export function computeShellLayout(input) {
  const surfaces = deriveSurfaces(input);
  const hints = deriveLiveHints(input);
  const budgets = computeRowBudgets({ ...input, surfaces, hints });
  const transition = resolvePanelTransition({ ...input, budgets, hints });
  const viewport = carveViewport({ ...input, surfaces, hints, budgets, transition });
  const widths = hintWidths({
    frameColumns: input.frameColumns,
    inputHint: hints.inputHint,
    liveSpinner: hints.liveSpinner,
  });
  return { ...surfaces, ...hints, ...budgets, ...transition, ...viewport, ...widths };
}
