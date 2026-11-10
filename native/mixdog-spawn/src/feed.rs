//! The output feed of one process: a replay ring with dense sequence numbers, pull
//! subscriptions, and the flow gate that lets a slow consumer stall only its own process's reader.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::MutexGuard;

use async_trait::async_trait;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::process::OutputStream;
use mixdog_core_api::domain::process::ProcessError;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessExit;
use tokio::sync::Notify;

/// Output events grow to this size by merging while no subscriber has taken them yet.
const MERGE_LIMIT: usize = 64 * 1024;

struct Entry {
    event: ProcessEvent,
    /// Output bytes pushed up to and including this event.
    end: u64,
}

struct Consumer {
    id: u64,
    /// Output bytes this subscriber has taken.
    taken: u64,
}

struct State {
    events: VecDeque<Entry>,
    /// Sequence number of `events[0]`.
    first_seq: u64,
    next_seq: u64,
    /// Output bytes pushed in total, and the offset where `events[0]` starts.
    pushed: u64,
    base: u64,
    stored: usize,
    /// Events below this sequence number were handed to a subscriber (or lie before a [`Feed::mark`]) and are never merged into.
    handed_seq: u64,
    paused: bool,
    /// Tests only: the reader is parked at the gate, waiting for a consumer to catch up or for the feed to be resumed.
    #[cfg(feature = "core-test")]
    blocked: bool,
    /// The process was killed or ended: the reader no longer waits for consumers.
    released: bool,
    done: bool,
    consumers: Vec<Consumer>,
    next_consumer: u64,
}

pub(crate) struct Feed {
    state: Mutex<State>,
    changed: Notify,
    /// Wakes a reader waiting at the gate.
    gate: Condvar,
    /// Replay ring bound and the most a consumer may trail the reader.
    cap: usize,
    /// Tests only: see [`Feed::on_refused`].
    #[cfg(all(test, feature = "core-test"))]
    refused: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Feed {
    pub(crate) fn new(cap: usize) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                events: VecDeque::new(),
                first_seq: 0,
                next_seq: 0,
                pushed: 0,
                base: 0,
                stored: 0,
                handed_seq: 0,
                paused: false,
                #[cfg(feature = "core-test")]
                blocked: false,
                released: false,
                done: false,
                consumers: Vec::new(),
                next_consumer: 0,
            }),
            changed: Notify::new(),
            gate: Condvar::new(),
            cap,
            #[cfg(all(test, feature = "core-test"))]
            refused: Mutex::new(None),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Appends output, first waiting while the feed is paused or a subscriber trails by the ring
    /// bound. Runs on the process's own reader thread, so the wait stalls that process only.
    /// Output that arrives after the exit event (a descendant holding the pipe past the drain
    /// bound) is dropped: the exit is the last event.
    pub(crate) fn push_output(&self, stream: OutputStream, bytes: &[u8]) {
        self.admit(stream, bytes, || ());
    }

    /// [`Self::push_output`] for a chunk a filter made: `admitted` runs once the gate lets the chunk in, under the feed's lock and before
    /// the chunk is appended, so what it does (a terminal tab applies the chunk's markers) happens exactly when the bytes enter the feed:
    /// never for a chunk the gate holds back or that comes after the exit. A chunk with no bytes (only markers) passes the gate too.
    pub(crate) fn admit(&self, stream: OutputStream, bytes: &[u8], admitted: impl FnOnce()) {
        let mut state = self.lock();
        loop {
            if state.done {
                return;
            }
            if state.released {
                break;
            }
            let slowest = state.consumers.iter().map(|c| c.taken).min();
            let trailing = slowest.map_or(0, |taken| state.pushed - taken);
            let over = trailing > 0 && trailing as usize + bytes.len() > self.cap;
            if !state.paused && !over {
                break;
            }
            #[cfg(feature = "core-test")]
            {
                state.blocked = true;
                self.changed.notify_waiters();
            }
            state = self.gate.wait(state).unwrap_or_else(|e| e.into_inner());
            #[cfg(feature = "core-test")]
            {
                state.blocked = false;
            }
        }
        admitted();
        self.append(state, stream, bytes);
    }

    /// Appends `bytes` (admitted) to the feed, merged into the last event when no subscriber has taken it, and wakes the subscribers.
    fn append(&self, mut state: MutexGuard<'_, State>, stream: OutputStream, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        state.pushed += bytes.len() as u64;
        state.stored += bytes.len();
        let end = state.pushed;
        let handed = state.handed_seq;
        let merged = match state.events.back_mut() {
            Some(Entry {
                event:
                    ProcessEvent::Output {
                        seq,
                        stream: last_stream,
                        bytes: last,
                    },
                end: last_end,
            }) if *seq >= handed && *last_stream == stream && last.len() + bytes.len() <= MERGE_LIMIT => {
                last.extend_from_slice(bytes);
                *last_end = end;
                true
            }
            _ => false,
        };
        if !merged {
            let seq = state.next_seq;
            state.next_seq += 1;
            state.events.push_back(Entry {
                event: ProcessEvent::Output {
                    seq,
                    stream,
                    bytes: bytes.to_vec(),
                },
                end,
            });
        }
        self.evict(&mut state);
        drop(state);
        self.changed.notify_waiters();
    }

    fn evict(&self, state: &mut State) {
        while state.stored > self.cap && state.events.len() > 1 {
            let Some(front) = state.events.pop_front() else {
                break;
            };
            if let ProcessEvent::Output { bytes, .. } = &front.event {
                state.stored -= bytes.len();
            }
            state.base = front.end;
            state.first_seq += 1;
        }
    }

    /// The last event of the feed.
    pub(crate) fn push_exit(&self, exit: ProcessExit) {
        let mut state = self.lock();
        let seq = state.next_seq;
        state.next_seq += 1;
        let end = state.pushed;
        state.events.push_back(Entry {
            event: ProcessEvent::Exited { seq, exit },
            end,
        });
        state.done = true;
        drop(state);
        self.gate.notify_all();
        self.changed.notify_waiters();
    }

    /// Notified on every change of the feed (output, the exit).
    pub(crate) fn changed(&self) -> &Notify {
        &self.changed
    }

    /// Output bytes pushed so far.
    pub(crate) fn pushed(&self) -> u64 {
        self.lock().pushed
    }

    /// The bytes pushed so far, with a cut there: later output starts an event of its own, so no event holds output from both sides.
    /// `then` runs with that offset under the feed's lock, so no output enters the feed between the cut and what `then` does.
    pub(crate) fn mark_then<T>(&self, then: impl FnOnce(u64) -> T) -> T {
        let mut state = self.lock();
        state.handed_seq = state.next_seq;
        then(state.pushed)
    }

    /// The process's last output (a terminal's exit line), made by `make` under the feed's lock and after a cut: it is an event of its
    /// own, never merged into output a subscriber has not taken yet, so a consumer takes the output before it first and can act between
    /// the two (a tab's end goes after the output before the exit and before the exit line). Output after the exit is dropped.
    pub(crate) fn push_last_output(&self, stream: OutputStream, make: impl FnOnce() -> Vec<u8>) {
        let mut state = self.lock();
        if state.done {
            return;
        }
        state.handed_seq = state.next_seq;
        let bytes = make();
        self.append(state, stream, &bytes);
    }

    /// Resolves once the exit is in the feed. Tests only.
    #[cfg(all(test, feature = "core-test"))]
    pub(crate) async fn ended(&self) {
        loop {
            let changed = self.changed.notified();
            let mut changed = std::pin::pin!(changed);
            changed.as_mut().enable();
            if self.lock().done {
                return;
            }
            changed.await;
        }
    }

    /// The next subscription refused for a start the ring dropped runs `seam` (after the feed's lock is released). Tests only.
    #[cfg(all(test, feature = "core-test"))]
    pub(crate) fn on_refused(&self, seam: impl FnOnce() + Send + 'static) {
        *self.refused.lock().unwrap_or_else(|e| e.into_inner()) = Some(Box::new(seam));
    }

    /// Returns the bytes pushed once the reader is parked at the gate (a consumer trails by the ring bound, or the feed is paused): the
    /// reader's own signal that it is held back, which no quiet period stands in for. Tests only.
    #[cfg(feature = "core-test")]
    pub(crate) async fn blocked_pushed(&self) -> u64 {
        loop {
            let changed = self.changed.notified();
            let mut changed = std::pin::pin!(changed);
            // Registered before the check, so a reader that parks between check and await still wakes it.
            changed.as_mut().enable();
            {
                let state = self.lock();
                if state.blocked {
                    return state.pushed;
                }
            }
            changed.await;
        }
    }

    pub(crate) fn set_paused(&self, paused: bool) {
        self.lock().paused = paused;
        self.gate.notify_all();
    }

    /// The process was killed: its reader must not wait for consumers any more.
    pub(crate) fn release_reader(&self) {
        self.lock().released = true;
        self.gate.notify_all();
    }

    /// A subscription from `from_seq` (replayed from the ring) or from the next event.
    pub(crate) fn subscribe(
        self: &Arc<Self>,
        from_seq: Option<u64>,
    ) -> Result<Subscription, ProcessError> {
        let state = self.lock();
        if from_seq.is_some_and(|seq| seq < state.first_seq) {
            let oldest = state.first_seq;
            drop(state);
            #[cfg(all(test, feature = "core-test"))]
            let seam = self.refused.lock().unwrap_or_else(|e| e.into_inner()).take();
            #[cfg(all(test, feature = "core-test"))]
            if let Some(seam) = seam {
                seam();
            }
            return Err(ProcessError::ReplayUnavailable { oldest });
        }
        Ok(self.subscribe_locked(state, from_seq))
    }

    /// A subscription from the oldest event the ring holds, in one step with reading where that is: a start the ring drops meanwhile
    /// cannot refuse it.
    pub(crate) fn subscribe_oldest(self: &Arc<Self>) -> Subscription {
        let state = self.lock();
        let oldest = state.first_seq;
        self.subscribe_locked(state, Some(oldest))
    }

    fn subscribe_locked(self: &Arc<Self>, mut state: MutexGuard<'_, State>, from_seq: Option<u64>) -> Subscription {
        let (next_seq, taken) = match from_seq {
            None => (state.next_seq, state.pushed),
            Some(seq) if seq >= state.next_seq => (state.next_seq, state.pushed),
            Some(seq) => {
                let index = (seq - state.first_seq) as usize;
                let start = if index == 0 {
                    state.base
                } else {
                    state.events[index - 1].end
                };
                (seq, start)
            }
        };
        let id = state.next_consumer;
        state.next_consumer += 1;
        state.consumers.push(Consumer { id, taken });
        Subscription {
            feed: Arc::clone(self),
            id,
            next_seq,
            start: taken,
        }
    }
}

pub(crate) struct Subscription {
    feed: Arc<Feed>,
    id: u64,
    next_seq: u64,
    /// The output offset (bytes pushed before it) where the subscription's first event starts.
    start: u64,
}

impl Subscription {
    pub(crate) fn start(&self) -> u64 {
        self.start
    }

    /// The next event if there is one now; `Err(())` when the subscription can never get another.
    fn poll(&mut self) -> Result<Option<ProcessEvent>, ()> {
        let mut state = self.feed.lock();
        if self.next_seq < state.first_seq {
            return Err(());
        }
        let index = (self.next_seq - state.first_seq) as usize;
        let Some(entry) = state.events.get(index) else {
            return if state.done { Err(()) } else { Ok(None) };
        };
        let event = entry.event.clone();
        let end = entry.end;
        self.next_seq += 1;
        state.handed_seq = state.handed_seq.max(self.next_seq);
        if let Some(consumer) = state.consumers.iter_mut().find(|c| c.id == self.id) {
            consumer.taken = end;
        }
        drop(state);
        self.feed.gate.notify_all();
        Ok(Some(event))
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let mut state = self.feed.lock();
        state.consumers.retain(|c| c.id != self.id);
        drop(state);
        self.feed.gate.notify_all();
    }
}

#[async_trait]
impl EventSource<ProcessEvent> for Subscription {
    async fn next(&mut self) -> Option<ProcessEvent> {
        let feed = Arc::clone(&self.feed);
        loop {
            let mut notified = std::pin::pin!(feed.changed.notified());
            // Registered before the state is read, so a push in between is not missed.
            notified.as_mut().enable();
            match self.poll() {
                Ok(Some(event)) => return Some(event),
                Err(()) => return None,
                Ok(None) => {}
            }
            notified.await;
        }
    }
}
