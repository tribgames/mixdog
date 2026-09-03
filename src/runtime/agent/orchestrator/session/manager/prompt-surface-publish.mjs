// prompt-surface-publish.mjs — hands the memory service the exact prompt
// surface a Lead session receives (stable rule blocks + tool descriptions) so
// its cycles can recognise memories that merely restate something the model
// already sees every turn. Fire-and-forget: a write failure never touches
// session creation, and identical surfaces are skipped in-process before the
// file layer's own hash check runs.

import { resolvePluginData } from '../../../../shared/plugin-paths.mjs';
import {
    buildPromptSurfaceSnapshot,
    promptSurfaceHash,
    writePromptSurfaceSnapshot,
} from '../../../../memory/lib/prompt-surface-file.mjs';

let _lastHash = null;
let _inFlight = null;

export function publishPromptSurface({ rules, tools, dataDir = null } = {}) {
    const snapshot = buildPromptSurfaceSnapshot({ rules, tools });
    if (snapshot.rules.length === 0 && snapshot.tools.length === 0) return;
    const hash = promptSurfaceHash(snapshot);
    if (hash === _lastHash) return;
    _lastHash = hash;
    const dir = dataDir || resolvePluginData();
    // Serialize writes so two session starts racing each other cannot
    // interleave; the last snapshot wins.
    _inFlight = (_inFlight || Promise.resolve())
        .then(() => writePromptSurfaceSnapshot(dir, snapshot))
        .catch((err) => {
            _lastHash = null;
            if (process.env.MIXDOG_DEBUG_SESSION_LOG) {
                process.stderr.write(`[session] prompt-surface publish failed: ${err?.message || err}\n`);
            }
        });
}

export function _resetPromptSurfacePublisherForTests() {
    _lastHash = null;
    _inFlight = null;
}
