// manager/session-id.mjs
// Monotonic session-id minting extracted from manager.mjs. The counter is a
// module-level singleton shared by createSession (spawn) and
// clearSessionMessages (clear-fork), matching the original single `nextId`.
import { randomBytes } from 'crypto';
let nextId = Date.now();
export function mintSessionId() {
    return `sess_${process.pid}_${nextId++}_${Date.now()}_${randomBytes(16).toString('hex')}`;
}
