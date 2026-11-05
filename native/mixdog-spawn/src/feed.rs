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
    /// Events below this sequence number were handed to a subscriber and are never merged into.
    handed_seq: u64,
    paused: bool,
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
                released: false,
                done: false,
                consumers: Vec::new(),
                next_consumer: 0,
            }),
            changed: Notify::new(),
            gate: Condvar::new(),
            cap,
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Appends output, first waiting while the feed is paused or a subscriber trails by the ring
    /// bound. Runs on the process's own reader thread, so the wait stalls that process only.
    pub(crate) fn push_output(&self, stream: OutputStream, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        let mut state = self.lock();
        loop {
            if state.released || state.done {
                break;
            }
            let slowest = state.consumers.iter().map(|c| c.taken).min();
            let trailing = slowest.map_or(0, |taken| state.pushed - taken);
            let over = trailing > 0 && trailing as usize + bytes.len() > self.cap;
            if !state.paused && !over {
                break;
            }
            state = self.gate.wait(state).unwrap_or_else(|e| e.into_inner());
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

    /// Output bytes pushed so far.
    pub(crate) fn pushed(&self) -> u64 {
        self.lock().pushed
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
        let mut state = self.lock();
        let (next_seq, taken) = match from_seq {
            None => (state.next_seq, state.pushed),
            Some(seq) if seq >= state.next_seq => (state.next_seq, state.pushed),
            Some(seq) if seq < state.first_seq => {
                return Err(ProcessError::ReplayUnavailable {
                    oldest: state.first_seq,
                });
            }
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
        Ok(Subscription {
            feed: Arc::clone(self),
            id,
            next_seq,
        })
    }
}

pub(crate) struct Subscription {
    feed: Arc<Feed>,
    id: u64,
    next_seq: u64,
}

impl Subscription {
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
