//! Node's frame publication of a session's state (`frame-batched-store.mjs` `createFrameBatchedStorePublisher`, driven by
//! `draft-store.mjs` `set`): a change waits for the frame timer, an immediate boundary publishes once the current synchronous
//! chain is over, and `structureRevision` goes up once per published frame that carried a structure change.
//!
//! The thread feed keeps publishing every change as it happens (the desktop reads it unchanged); at each of Node's
//! publications the actor adds `thread/frame` (`{ structureChanged }`), which only the phone's fold reads. The feed carries no
//! time and none of Node's immediate moments, so the fold cannot find those boundaries itself.

use tokio::time::Duration;
use tokio::time::Instant;

/// `TUI_FRAME_MS` (`render-timing.mjs`: `Math.ceil(1000 / TUI_RENDER_FPS)`, 120 fps). A daemon has no render source, so
/// `scheduleRenderAlignedStoreFlush` waits the whole frame (`renderFrameDelay` with no frame painted yet).
pub(crate) const FRAME: Duration = Duration::from_millis(9);

/// What a published change asks of the frame (`set`'s effects on the publisher).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Mark {
    /// `markStructureChange` (a `structureRevision` patch: `pushItem`, `appendItems`, `replaceItems`).
    pub structure: bool,
    /// `flushImmediate`: published once the current synchronous chain is over.
    pub immediate: bool,
    /// `flushEmit` (`settleTurn`): published at once, before anything the chain changes next.
    pub now: bool,
}

/// The publisher's pending state (`emitPending`, `structureChangePending`, `immediatePending`, the frame timer).
#[derive(Debug, Default)]
pub(crate) struct Frames {
    pending: bool,
    structure: bool,
    immediate: bool,
    due: Option<Instant>,
}

impl Frames {
    /// `emit` (+ `markStructureChange` / `flushImmediate`). Returns the frame to publish now (`flushEmit`), if any.
    pub fn mark(&mut self, mark: Mark, now: Instant) -> Option<bool> {
        self.pending = true;
        self.structure |= mark.structure;
        if self.due.is_none() {
            self.due = Some(now + FRAME);
        }
        if mark.now {
            return self.flush();
        }
        self.immediate |= mark.immediate;
        None
    }

    /// The frame timer's deadline.
    pub fn due(&self) -> Option<Instant> {
        self.due
    }

    /// The end of the synchronous chain (the microtask `flushImmediate` queued).
    pub fn chain_end(&mut self) -> Option<bool> {
        if self.immediate { self.flush() } else { None }
    }

    /// `flush`: `Some(structureChanged)` when a publication is due.
    pub fn flush(&mut self) -> Option<bool> {
        self.due = None;
        self.immediate = false;
        if !std::mem::take(&mut self.pending) {
            return None;
        }
        Some(std::mem::take(&mut self.structure))
    }
}

/// What a feed notification was in Node's store: the `set` behind it and its boundary. `None`: not a change of the
/// session's state (a snapshot, or the frame announcement itself).
pub(crate) fn mark_of(note: &super::frames::Note) -> Option<Mark> {
    let params = || serde_json::from_slice::<serde_json::Value>(&note.params).unwrap_or_default();
    let mark = match note.method {
        "thread/snapshot" | "thread/frame" => return None,
        // `pushItem` (`transcript-store.mjs:58-79`): a structure change; a user row also flushes immediately (`:75`). A
        // streaming assistant row is the live tail, not a row yet (the fold's `item/started` of an `agentMessage`).
        "item/started" => match params()["item"]["type"].as_str() {
            Some("userMessage") => Mark { structure: true, immediate: true, now: false },
            Some("agentMessage") => Mark::default(),
            _ => Mark { structure: true, ..Mark::default() },
        },
        // A user row the core publishes whole (no `item/started` before it) is the same `pushItem`.
        "item/completed" => Mark { structure: true, immediate: params()["item"]["type"] == "userMessage", now: false },
        "thread/historyReset" => Mark { structure: true, ..Mark::default() },
        // An editable queued entry (`drain-enqueue.mjs:64`) or a prioritized one (`queue.mjs:104`).
        "thread/queue/changed" => Mark { immediate: true, ..Mark::default() },
        // `set({ commandStatus })` flushes immediately (`draft-store.mjs:69-71`).
        "thread/runtime/updated" => Mark { immediate: !params()["value"]["commandStatus"].is_null(), ..Mark::default() },
        // `settleTurn`: `ctx.flushEmit()` (`turn.mjs:673`).
        "turn/completed" => Mark { now: true, ..Mark::default() },
        _ => Mark::default(),
    };
    Some(mark)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changes_wait_for_the_frame_and_an_immediate_one_ends_with_its_chain() {
        let t = Instant::now();
        let mut frames = Frames::default();
        assert_eq!(frames.mark(Mark { structure: true, ..Mark::default() }, t), None);
        assert_eq!(frames.mark(Mark::default(), t + Duration::from_millis(5)), None);
        // The timer is armed once, by the first change.
        assert_eq!(frames.due(), Some(t + FRAME));
        assert_eq!(frames.chain_end(), None);
        assert_eq!(frames.flush(), Some(true));
        assert_eq!(frames.due(), None);
        assert_eq!(frames.flush(), None, "nothing pending, nothing published");

        assert_eq!(frames.mark(Mark { immediate: true, ..Mark::default() }, t), None);
        assert_eq!(frames.mark(Mark::default(), t), None);
        assert_eq!(frames.chain_end(), Some(false), "the immediate frame carries the whole chain");
        assert_eq!(frames.chain_end(), None);

        assert_eq!(frames.mark(Mark { structure: true, ..Mark::default() }, t), None);
        assert_eq!(frames.mark(Mark { now: true, ..Mark::default() }, t), Some(true), "flushEmit publishes at once");
        assert_eq!(frames.due(), None);
    }
}
