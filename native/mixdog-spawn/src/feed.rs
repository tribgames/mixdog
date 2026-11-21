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
    /// The subscriber whose output its caller promises in full (the one a spawn made with its reader, or a claimed shell's job):
    /// it holds the reader until it has taken the output or is dropped, past the root's end, a kill and a shutdown too. Every
    /// such subscriber reads to the exit. Any other holds the reader only while the process runs, and may be overtaken after.
    holds: bool,
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
    /// The last event ends where a change waits for the pump (see [`Feed::admit`]): nothing is merged into it.
    sealed: bool,
    paused: bool,
    /// Tests only: the reader is parked at the gate, waiting for a consumer to catch up or for the feed to be resumed.
    #[cfg(feature = "core-test")]
    blocked: bool,
    /// Tests only: how many times a reader has decided at the gate whether to wait.
    #[cfg(feature = "core-test")]
    decisions: u64,
    /// The root ended, or the process was killed or shut down: a pause and the subscribers that do not hold the reader no
    /// longer hold it.
    released: bool,
    /// Readers waiting at the gate now, since when, and how long readers waited there before.
    parked: usize,
    parked_since: Option<std::time::Instant>,
    parked_before: std::time::Duration,
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
    /// See [`Feed::replay_after_exit`].
    replays_after_exit: std::sync::atomic::AtomicBool,
    /// See [`Feed::owned_by_its_reader`].
    owned: std::sync::atomic::AtomicBool,
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
                sealed: false,
                paused: false,
                #[cfg(feature = "core-test")]
                blocked: false,
                #[cfg(feature = "core-test")]
                decisions: 0,
                released: false,
                parked: 0,
                parked_since: None,
                parked_before: std::time::Duration::ZERO,
                done: false,
                consumers: Vec::new(),
                next_consumer: 0,
            }),
            changed: Notify::new(),
            gate: Condvar::new(),
            cap,
            replays_after_exit: std::sync::atomic::AtomicBool::new(false),
            owned: std::sync::atomic::AtomicBool::new(false),
            #[cfg(all(test, feature = "core-test"))]
            refused: Mutex::new(None),
        })
    }

    /// The output stays in the ring after the process ended and its readers left, for a subscriber that comes later (a
    /// terminal tab's client). Without it, the output of an ended process leaves the feed with the last reader that took it to
    /// the exit: the exited processes the manager keeps listed do not each keep a ring of output that was already read.
    pub(crate) fn replay_after_exit(&self) {
        self.replays_after_exit.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    fn replays(&self) -> bool {
        self.replays_after_exit.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// The process was started with its reader ([`crate::manager::LocalProcessManager::spawn_subscribed`]): the output is that
    /// reader's from the first byte, and what every subscriber has taken leaves the feed at once instead of filling the ring
    /// for as long as the process runs.
    pub(crate) fn owned_by_its_reader(&self) {
        self.owned.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    fn owned(&self) -> bool {
        self.owned.load(std::sync::atomic::Ordering::Relaxed) && !self.replays()
    }

    /// The last reader of an ended process left, having taken its exit: the output goes, unless the feed replays it. The exit
    /// stays, for a subscriber that asks how the process ended.
    fn release_read_to_the_exit(&self, state: &mut State) {
        if self.replays() || !state.done || !state.consumers.is_empty() {
            return;
        }
        while let Some(Entry { event: ProcessEvent::Output { bytes, .. }, end }) = state.events.front() {
            state.stored -= bytes.len();
            state.base = *end;
            state.first_seq += 1;
            state.events.pop_front();
        }
    }

    /// Drops the output every subscriber has taken, of a feed its reader owns.
    fn release_taken(&self, state: &mut State) {
        if !self.owned() {
            return;
        }
        let Some(taken) = state.consumers.iter().map(|c| c.taken).min() else {
            return;
        };
        while let Some(Entry { event: ProcessEvent::Output { bytes, .. }, end }) = state.events.front() {
            if *end > taken {
                break;
            }
            state.stored -= bytes.len();
            state.base = *end;
            state.first_seq += 1;
            state.events.pop_front();
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Appends output, first waiting while the feed is paused or a subscriber trails by the ring
    /// bound. Runs on the process's own reader thread, so the wait stalls that process only.
    /// Output that arrives after the exit event (a descendant holding the pipe past the drain
    /// bound) is dropped: the exit is the last event.
    pub(crate) fn push_output(&self, stream: OutputStream, bytes: &[u8]) {
        self.admit(stream, bytes, || false);
    }

    /// [`Self::push_output`] for a chunk a filter made: `admitted` runs once the gate lets the chunk in, under the feed's lock and before
    /// the chunk is appended, so what it does (a terminal tab applies the chunk's markers) happens exactly when the bytes enter the feed:
    /// never for a chunk the gate holds back or that comes after the exit. A chunk with no bytes (only markers) passes the gate too.
    /// When `admitted` says a change now waits for the pump to take this chunk, the chunk is an event of its own, merged neither into
    /// the event before it nor with the output after it: Node took each PTY read on its own (the text into its 16 ms relay buffer, then
    /// the read's markers, terminal-manager.ts `pty.onData`), so a read before a marker's could be sent alone, and output after the
    /// marker's read never went before its change; a merged event would take them all at once and send the change after them.
    pub(crate) fn admit(&self, stream: OutputStream, bytes: &[u8], admitted: impl FnOnce() -> bool) {
        let mut state = self.lock();
        loop {
            if state.done {
                return;
            }
            let released = state.released;
            let slowest = state.consumers.iter().filter(|c| c.holds || !released).map(|c| c.taken).min();
            let trailing = slowest.map_or(0, |taken| state.pushed - taken);
            let over = trailing > 0 && trailing as usize + bytes.len() > self.cap;
            let pass = !(state.paused && !released) && !over;
            #[cfg(feature = "core-test")]
            {
                state.decisions += 1;
                state.blocked = !pass;
                self.changed.notify_waiters();
            }
            if pass {
                break;
            }
            if state.parked == 0 {
                state.parked_since = Some(std::time::Instant::now());
            }
            state.parked += 1;
            state = self.gate.wait(state).unwrap_or_else(|e| e.into_inner());
            state.parked -= 1;
            if state.parked == 0 {
                if let Some(since) = state.parked_since.take() {
                    state.parked_before += since.elapsed();
                }
            }
            #[cfg(feature = "core-test")]
            {
                state.blocked = false;
            }
        }
        let alone = admitted();
        self.append(state, stream, bytes, alone);
    }

    /// Appends `bytes` (admitted) to the feed, merged into the last event when no subscriber has taken it and neither that event nor
    /// these bytes stand `alone` (see [`Self::admit`]), and wakes the subscribers.
    fn append(&self, mut state: MutexGuard<'_, State>, stream: OutputStream, bytes: &[u8], alone: bool) {
        if bytes.is_empty() {
            // Only markers: their change waits at the end of the last event.
            state.sealed |= alone;
            return;
        }
        let mergeable = !alone && !state.sealed;
        state.sealed = alone;
        state.pushed += bytes.len() as u64;
        state.stored += bytes.len();
        let end = state.pushed;
        let handed = state.handed_seq;
        let merged = match state.events.back_mut() {
            Some(Entry { event: ProcessEvent::Output { seq, stream: last_stream, bytes: last }, end: last_end })
                if mergeable && *seq >= handed && *last_stream == stream && last.len() + bytes.len() <= MERGE_LIMIT =>
            {
                last.extend_from_slice(bytes);
                *last_end = end;
                true
            }
            _ => false,
        };
        if !merged {
            let seq = state.next_seq;
            state.next_seq += 1;
            state.events.push_back(Entry { event: ProcessEvent::Output { seq, stream, bytes: bytes.to_vec() }, end });
        }
        self.evict(&mut state);
        drop(state);
        self.changed.notify_waiters();
    }

    /// Drops the oldest events past the ring bound, never one a subscriber that holds the reader has not taken: that subscriber
    /// gates the reader, so what it has not taken stays within the bound and one read.
    fn evict(&self, state: &mut State) {
        let held = state.consumers.iter().filter(|c| c.holds).map(|c| c.taken).min();
        while state.stored > self.cap && state.events.len() > 1 {
            if held.is_some_and(|taken| state.events[0].end > taken) {
                break;
            }
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
        state.events.push_back(Entry { event: ProcessEvent::Exited { seq, exit }, end });
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
        self.append(state, stream, &bytes, false);
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

    /// How many times a reader has decided at the gate whether to wait. Tests only.
    #[cfg(all(test, feature = "core-test"))]
    pub(crate) fn decisions(&self) -> u64 {
        self.lock().decisions
    }

    /// Whether the reader waits, as it decided at the gate after the first `seen` decisions. Tests only.
    #[cfg(all(test, feature = "core-test"))]
    pub(crate) async fn decided_after(&self, seen: u64) -> bool {
        loop {
            let changed = self.changed.notified();
            let mut changed = std::pin::pin!(changed);
            changed.as_mut().enable();
            {
                let state = self.lock();
                if state.decisions > seen {
                    return state.blocked;
                }
            }
            changed.await;
        }
    }

    /// How long readers have waited at the gate in all, a wait under way included.
    pub(crate) fn parked_time(&self) -> std::time::Duration {
        let state = self.lock();
        state.parked_before + state.parked_since.map_or(std::time::Duration::ZERO, |since| since.elapsed())
    }

    /// The root ended or the process was killed or shut down: a pause, and every subscriber that does not hold the reader, stop
    /// holding it, so a stalled consumer cannot keep the reader from reaching its end. A subscriber that holds it still does.
    pub(crate) fn release_reader(&self) {
        self.lock().released = true;
        self.gate.notify_all();
    }

    /// A subscription from `from_seq` (replayed from the ring) or from the next event.
    pub(crate) fn subscribe(self: &Arc<Self>, from_seq: Option<u64>) -> Result<Subscription, ProcessError> {
        self.subscribe_as(from_seq, false)
    }

    /// [`Self::subscribe`] for the subscriber whose output its caller promises in full (see `Consumer::holds`).
    pub(crate) fn subscribe_holding(self: &Arc<Self>, from_seq: Option<u64>) -> Result<Subscription, ProcessError> {
        self.subscribe_as(from_seq, true)
    }

    fn subscribe_as(self: &Arc<Self>, from_seq: Option<u64>, holds: bool) -> Result<Subscription, ProcessError> {
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
        Ok(self.subscribe_locked(state, from_seq, holds))
    }

    /// A subscription from the oldest event the ring holds, in one step with reading where that is: a start the ring drops meanwhile
    /// cannot refuse it.
    pub(crate) fn subscribe_oldest(self: &Arc<Self>) -> Subscription {
        let state = self.lock();
        let oldest = state.first_seq;
        self.subscribe_locked(state, Some(oldest), false)
    }

    /// [`Self::subscribe_oldest`] for the subscription a spawn makes with its reader (see `Consumer::holds`).
    pub(crate) fn subscribe_holder(self: &Arc<Self>) -> Subscription {
        let state = self.lock();
        let oldest = state.first_seq;
        self.subscribe_locked(state, Some(oldest), true)
    }

    fn subscribe_locked(self: &Arc<Self>, mut state: MutexGuard<'_, State>, from_seq: Option<u64>, holds: bool) -> Subscription {
        let (next_seq, taken) = match from_seq {
            None => (state.next_seq, state.pushed),
            Some(seq) if seq >= state.next_seq => (state.next_seq, state.pushed),
            Some(seq) => {
                let index = (seq - state.first_seq) as usize;
                let start = if index == 0 { state.base } else { state.events[index - 1].end };
                (seq, start)
            }
        };
        // Output after a subscription from here on is an event of its own: merged into the event before it, it would be in
        // an event the subscription starts after.
        if next_seq == state.next_seq {
            state.handed_seq = state.handed_seq.max(next_seq);
        }
        let id = state.next_consumer;
        state.next_consumer += 1;
        state.consumers.push(Consumer { id, taken, holds });
        Subscription { feed: Arc::clone(self), id, next_seq, start: taken }
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

    /// The output offset where the events this subscription has taken end (where the next starts, unless the ring overtook it).
    pub(crate) fn taken(&self) -> u64 {
        self.feed.lock().consumers.iter().find(|c| c.id == self.id).map_or(self.start, |c| c.taken)
    }

    /// The next event if there is one now; `Err(())` once the exit was taken. A subscription the ring overtook (one that does not
    /// hold the reader, after the reader was released) goes on from the oldest event the ring holds: the gap in the sequence
    /// numbers is the output it lost, and the exit, which the ring never drops, still reaches it.
    fn poll(&mut self) -> Result<Option<ProcessEvent>, ()> {
        let mut state = self.feed.lock();
        if self.next_seq < state.first_seq {
            self.next_seq = state.first_seq;
        }
        let index = (self.next_seq - state.first_seq) as usize;
        let Some(entry) = state.events.get(index) else {
            return if state.done { Err(()) } else { Ok(None) };
        };
        // The only reader of output nobody replays takes the event itself, not a copy of it.
        let sole = index == 0 && state.consumers.len() == 1 && matches!(entry.event, ProcessEvent::Output { .. }) && self.feed.owned();
        let (event, end) = if sole {
            let entry = state.events.pop_front().expect("the event was just seen");
            if let ProcessEvent::Output { bytes, .. } = &entry.event {
                state.stored -= bytes.len();
            }
            state.base = entry.end;
            state.first_seq += 1;
            (entry.event, entry.end)
        } else {
            (entry.event.clone(), entry.end)
        };
        self.next_seq += 1;
        state.handed_seq = state.handed_seq.max(self.next_seq);
        if let Some(consumer) = state.consumers.iter_mut().find(|c| c.id == self.id) {
            consumer.taken = end;
        }
        if !sole {
            self.feed.release_taken(&mut state);
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
        self.feed.release_taken(&mut state);
        if self.next_seq >= state.next_seq {
            self.feed.release_read_to_the_exit(&mut state);
        }
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

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::process::ExitStatus;

    use super::*;

    fn output(event: Option<ProcessEvent>) -> Vec<u8> {
        match event {
            Some(ProcessEvent::Output { bytes, .. }) => bytes,
            other => panic!("not output: {other:?}"),
        }
    }

    fn stored(feed: &Feed) -> usize {
        feed.lock().stored
    }

    /// Output its readers have all taken leaves the feed; a reader that trails keeps what it has not taken, and the exit stays
    /// for a subscriber that comes after the readers left.
    #[test]
    fn output_every_reader_took_leaves_the_feed() {
        let feed = Feed::new(1 << 20);
        feed.owned_by_its_reader();
        let mut first = feed.subscribe_oldest();
        feed.push_output(OutputStream::Stdout, b"one");
        assert_eq!(output(first.poll().unwrap()), b"one");
        assert_eq!(stored(&feed), 0, "its only reader took it");

        let mut second = feed.subscribe(None).unwrap();
        feed.push_output(OutputStream::Stdout, b"two");
        assert_eq!(output(first.poll().unwrap()), b"two");
        assert_eq!(stored(&feed), 3, "the second reader has not taken it");
        assert_eq!(output(second.poll().unwrap()), b"two");
        assert_eq!(stored(&feed), 0);

        feed.push_output(OutputStream::Stdout, b"three");
        feed.push_exit(ProcessExit { status: ExitStatus::Code(0), killed: None });
        drop(second);
        assert_eq!(output(first.poll().unwrap()), b"three");
        assert!(matches!(first.poll(), Ok(Some(ProcessEvent::Exited { .. }))));
        drop(first);
        assert_eq!(stored(&feed), 0);
        let mut late = feed.subscribe(None).unwrap();
        assert!(first_seq_is_the_exit(&feed));
        assert!(late.poll().is_err(), "nothing follows the exit");
        let mut asks = feed.subscribe_oldest();
        assert!(matches!(asks.poll(), Ok(Some(ProcessEvent::Exited { .. }))));
    }

    fn first_seq_is_the_exit(feed: &Feed) -> bool {
        let state = feed.lock();
        state.events.len() == 1 && matches!(state.events[0].event, ProcessEvent::Exited { .. })
    }

    /// A process started without its reader replays to each reader while it runs; once it ended and a reader took the exit
    /// and left, its output is gone and the exit stays.
    #[test]
    fn the_output_of_an_ended_process_leaves_with_the_reader_that_took_its_exit() {
        let feed = Feed::new(1 << 20);
        feed.push_output(OutputStream::Stdout, b"line");
        let mut early = feed.subscribe(Some(0)).unwrap();
        assert_eq!(output(early.poll().unwrap()), b"line");
        drop(early);
        assert_eq!(stored(&feed), 4, "the process still runs: the next reader replays it");
        feed.push_exit(ProcessExit { status: ExitStatus::Code(0), killed: None });
        let mut reader = feed.subscribe(Some(0)).unwrap();
        assert_eq!(output(reader.poll().unwrap()), b"line");
        drop(reader);
        assert_eq!(stored(&feed), 4, "it left before the exit");
        let mut reader = feed.subscribe(Some(0)).unwrap();
        assert_eq!(output(reader.poll().unwrap()), b"line");
        assert!(matches!(reader.poll(), Ok(Some(ProcessEvent::Exited { .. }))));
        drop(reader);
        assert_eq!(stored(&feed), 0);
        assert!(first_seq_is_the_exit(&feed));
    }

    /// The reader is released (the root's end, a kill) while it waits behind the subscriber that holds it, which trails by the
    /// ring bound: woken, it decides to wait again, so nothing that subscriber has not taken leaves the ring, and it takes all of
    /// the output, then the exit.
    #[cfg(feature = "core-test")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_released_reader_still_waits_for_the_subscriber_that_holds_it() {
        let feed = Feed::new(4);
        feed.owned_by_its_reader();
        let mut holder = feed.subscribe_holder();
        feed.push_output(OutputStream::Stdout, b"first");
        let reader = Arc::clone(&feed);
        let parked = std::thread::spawn(move || reader.push_output(OutputStream::Stdout, b"second"));
        feed.blocked_pushed().await;
        let seen = feed.decisions();
        feed.release_reader();
        assert!(feed.decided_after(seen).await, "the released reader waits for the holder again");
        assert_eq!(output(holder.poll().unwrap()), b"first");
        parked.join().unwrap();
        assert_eq!(output(holder.poll().unwrap()), b"second");
        feed.push_exit(ProcessExit { status: ExitStatus::Code(0), killed: None });
        assert!(matches!(holder.poll(), Ok(Some(ProcessEvent::Exited { .. }))));
    }

    /// A released reader passes a subscriber that does not hold it, and the ring drops what it had not taken: it goes on from the
    /// oldest event left, the sequence numbers showing the gap, and takes the exit.
    #[test]
    fn a_subscriber_the_ring_overtook_learns_its_gap_and_takes_the_exit() {
        let feed = Feed::new(4);
        let mut observer = feed.subscribe(None).unwrap();
        feed.push_output(OutputStream::Stdout, b"first");
        feed.release_reader();
        feed.push_output(OutputStream::Stderr, b"second");
        feed.push_exit(ProcessExit { status: ExitStatus::Code(0), killed: Some(mixdog_core_api::domain::process::KillReason::Requested) });
        match observer.poll() {
            Ok(Some(ProcessEvent::Output { seq: 1, bytes, .. })) => assert_eq!(bytes, b"second"),
            other => panic!("not the event after the gap: {other:?}"),
        }
        assert!(matches!(observer.poll(), Ok(Some(ProcessEvent::Exited { seq: 2, .. }))));
    }

    /// A feed that replays keeps the output its reader took, for the next subscriber.
    #[test]
    fn a_replaying_feed_keeps_what_was_taken() {
        let feed = Feed::new(1 << 20);
        feed.replay_after_exit();
        let mut first = feed.subscribe_oldest();
        feed.push_output(OutputStream::Stdout, b"kept");
        assert_eq!(output(first.poll().unwrap()), b"kept");
        drop(first);
        let mut again = feed.subscribe(Some(0)).unwrap();
        assert_eq!(output(again.poll().unwrap()), b"kept");
    }

    /// Output that follows a subscription from the feed's end reaches it, though the event before it was still open to merging.
    #[test]
    fn a_subscription_from_the_end_gets_the_output_after_it() {
        let feed = Feed::new(1 << 20);
        feed.replay_after_exit();
        feed.push_output(OutputStream::Stdout, b"before");
        let mut from_end = feed.subscribe(None).unwrap();
        feed.push_output(OutputStream::Stdout, b"after");
        assert_eq!(output(from_end.poll().unwrap()), b"after");
    }
}
