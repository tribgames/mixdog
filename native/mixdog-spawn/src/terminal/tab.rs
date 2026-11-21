use super::*;
use crate::manager::OutputFilter;

pub(super) struct TabState {
    pub(super) buffer: ReplayBuffer,
    /// Present only when the shell runs Mixdog's integration.
    pub(super) scanner: Option<MarkerScanner>,
    pub(super) decoder: Utf8Decoder,
    pub(super) activity: ActivityTracker,
    pub(super) exited: bool,
    /// Connections that hold the producer paused (their ids are the `client` keys of `connection_closed`): the PTY reader is one
    /// per tab, so it runs only while no connection holds it. One connection's resume cannot release another's pause.
    pub(super) paused_by: BTreeSet<String>,
    pub(super) size: (u16, u16),
    /// Bytes of output the feed has admitted so far (its absolute output offset).
    pub(super) emitted: u64,
    /// Set once the tab's relay feed pumps its output (see [`RelayOrder`]).
    pub(super) order: Option<RelayOrder>,
    /// Chunks the filter has taken: a held-back tail is flushed only if no chunk came after the one that held it ([`Tab::flush_held`]).
    pub(super) held_gen: u64,
    /// The armed release of the held tail: cancelled when a chunk, the end or the exit supersedes it, so a stale deadline never wakes.
    pub(super) held_timer: Option<mixdog_rt::TimerHandle>,
    /// A flush has taken the held tail and not yet put it into the feed: the next chunk waits for it ([`Tab::wait_flush`]).
    pub(super) flushing: bool,
}

/// The order of a tab's activity changes against its output on the relay feed. Node, for each chunk its PTY read: appended the text and
/// called the output listeners at once (terminal-manager.ts:347-350, `emit`), the relay pushing it into its 16 ms buffer
/// (remote-relay-push-lanes.ts:89,101); then applied the chunk's markers (terminal-manager.ts:368-370), whose change the activity
/// listener broadcast at once (terminal-manager.ts:341, remote-relay-push-lanes.ts:148). A paused PTY read nothing (`pty.pause()`,
/// terminal-manager.ts:499-505), so no text and no marker of it went anywhere. So a change follows its text's insertion into the relay
/// buffer, never its transmission, and nothing waits on a paused consumer.
///
/// The core's rule from that: a chunk is read when its feed admits it ([`TabFilter::admitted`], under the feed's flow gate, Node's
/// pause), and only then are its markers applied; the relay buffer lives in the feed's pump, so the change waits here until the pump has
/// taken the output admitted before it, and then goes. Every waiting change is thus for output already in the feed, which the pump
/// reads whether or not the producer is paused. `emitted` and `taken` are both the feed's absolute output offset (the pump starts
/// counting at its first event's offset).
///
/// The shell's end is the one change that waits for the pump to reach its exit line rather than for output to be taken: Node ran its
/// exit handler (terminal-manager.ts:378-384) on its own event, never inside a call such as a claim's resize-and-announce
/// (terminal-manager.ts:485-488), so the end followed whatever that call published, and the exit line followed the end. The pump reaches
/// the exit line only once a claim's hold lets it (the line is an event of its own, after the hold's cut), so the end goes then.
#[derive(Default)]
pub(super) struct RelayOrder {
    /// The feed's output offset the pump has taken up to.
    pub(super) taken: u64,
    /// Changes waiting, each with the output it follows.
    pub(super) waiting: VecDeque<(u64, Option<ActivityState>)>,
    /// The shell's end, with the offset where its exit line starts.
    pub(super) end: Option<(u64, Option<ActivityState>)>,
    /// A change went at once (it followed no output the pump had not taken): the next output waits to see it published before it enters
    /// the relay buffer, as Node's later output always followed its synchronous broadcast.
    pub(super) unpublished: bool,
}

/// Where the relay feed's pump is, as it tells a terminal tab (see [`RelayOrder`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PumpPoint {
    /// About to put the output event starting at this offset into the relay buffer (no hold keeps it back any more).
    Reaching(u64),
    /// Has put the output up to this offset into the relay buffer (`u64::MAX`: the pump ended).
    Taken(u64),
}

pub(super) struct Tab {
    pub(super) id: String,
    /// Creation order, kept by a respawn of the same id (Node's `terminals` map keeps the key's place).
    pub(super) seq: u64,
    pub(super) handle: ProcessHandle,
    pub(super) shell: String,
    pub(super) cwd: Option<String>,
    /// Lock order, outermost first: `TerminalTabs::tabs`, `TerminalTabs::cursor_floors`,
    /// `Tab::pty_gate`, the process feed's state (the reader admitting a chunk, [`TabFilter::admitted`]), `Tab::state`. No code holds
    /// `state` while calling the process manager or taking an earlier lock: it copies what it needs out and drops the guard first.
    pub(super) state: Mutex<TabState>,
    /// Serializes the calls that push `state` to the PTY (resize, flow control) so they land in
    /// the order the state changed; each re-reads the latest state under it. A call that blocks
    /// in the PTY holds this gate only, never `state`.
    pub(super) pty_gate: Mutex<()>,
    /// Signalled when a held-tail flush has entered the feed (waited on with `state`).
    pub(super) flushed: Condvar,
    pub(super) events: Arc<dyn TerminalEvents>,
    pub(super) manager: LocalProcessManager,
}

impl Tab {
    pub(super) fn lock(&self) -> MutexGuard<'_, TabState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(super) fn gate(&self) -> MutexGuard<'_, ()> {
        self.pty_gate.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The state, once no held-tail flush is between taking its text and putting it into the feed: a chunk read meanwhile would otherwise
    /// enter the feed before the text that came first.
    pub(super) fn wait_flush(&self) -> MutexGuard<'_, TabState> {
        let mut state = self.lock();
        while state.flushing {
            state = self.flushed.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        state
    }

    /// Arms the release of the marker text chunk number `held_gen` left held back (`HELD_OUTPUT_FLUSH_MS` / `flushHeld`): a chunk that comes
    /// sooner makes it stale. The flush waits for the feed, so it runs on a thread of its own, never on the ticker.
    pub(super) fn arm_flush(
        self: &Arc<Self>,
        ticker: &mixdog_rt::Ticker,
        held_gen: u64,
        dispatch: impl FnOnce(Arc<Self>, u64) + Send + 'static,
    ) -> mixdog_rt::TimerHandle {
        let tab = Arc::downgrade(self);
        ticker.register(std::time::Instant::now() + HELD_FLUSH, move || {
            let Some(tab) = tab.upgrade() else { return };
            // Cancellation may lose to a dequeued callback: judge it before dispatch creates an OS thread, not only after it starts.
            if !tab.flush_ready(held_gen) {
                return;
            }
            dispatch(tab, held_gen);
        })
    }

    /// The tail chunk number `generation` left held back is still the current one and nothing is flushing or over.
    pub(super) fn flush_ready(&self, generation: u64) -> bool {
        let state = self.lock();
        !state.exited && !state.flushing && state.held_gen == generation && state.scanner.as_ref().is_some_and(MarkerScanner::is_holding)
    }

    pub(super) fn dispatch_flush(tab: Arc<Self>, held_gen: u64) {
        let _ = std::thread::Builder::new().name("terminal-held-flush".to_owned()).spawn(move || {
            if let Ok(feed) = tab.manager.feed_of(&tab.handle) {
                tab.flush_held(&feed, held_gen);
            }
        });
    }

    /// Puts the held-back marker text into `feed` as output, unless a chunk came after chunk number `held_gen` (it decides the text itself).
    pub(super) fn flush_held(&self, feed: &Feed, held_gen: u64) {
        let text = {
            let mut state = self.lock();
            if state.exited || state.held_gen != held_gen || state.flushing {
                return;
            }
            let Some(scanner) = state.scanner.as_mut() else { return };
            let text = scanner.flush();
            if text.is_empty() {
                return;
            }
            state.flushing = true;
            text
        };
        feed.admit(OutputStream::Stdout, text.as_bytes(), || {
            let mut state = self.lock();
            state.buffer.append(&text);
            Tab::emitted(&mut state, text.len());
            false
        });
        self.lock().flushing = false;
        self.flushed.notify_all();
    }

    /// Publishes a change now, after the changes still waiting for the pump (see [`RelayOrder`]).
    pub(super) fn publish(&self, state: &mut TabState, change: Option<Option<ActivityState>>) {
        if let Some(order) = state.order.as_mut() {
            for (_, waiting) in order.waiting.drain(..) {
                self.events.activity(&self.id, waiting);
                order.unpublished = true;
            }
        }
        if let Some(activity) = change {
            self.events.activity(&self.id, activity);
            if let Some(order) = state.order.as_mut() {
                order.unpublished = true;
            }
        }
    }

    /// Publishes a change the output or input caused once the pump has taken the output written before it (see [`RelayOrder`]).
    pub(super) fn publish_after_output(&self, state: &mut TabState, change: Option<Option<ActivityState>>) {
        let Some(activity) = change else { return };
        let emitted = state.emitted;
        match state.order.as_mut() {
            Some(order) if order.taken < emitted || !order.waiting.is_empty() => order.waiting.push_back((emitted, activity)),
            Some(order) => {
                self.events.activity(&self.id, activity);
                order.unpublished = true;
            }
            None => self.events.activity(&self.id, activity),
        }
    }

    /// Counts output the feed admitted.
    pub(super) fn emitted(state: &mut TabState, bytes: usize) {
        state.emitted += bytes as u64;
    }

    /// The shell ended (the process manager's exit hook): as Node's exit handler (terminal-manager.ts:378-384), the held marker text is
    /// out already (the reader's `finish`), the tab's end follows the output before it (as any change the output causes, see
    /// [`RelayOrder`]), and the exit line is the last output. Returns that line.
    pub(super) fn exited(&self, exit: &ProcessExit) -> Vec<u8> {
        let code = match exit.status {
            ExitStatus::Code(code) => code,
            ExitStatus::Signal(signal) => 128 + signal,
        };
        let line = format!("\r\n[process exited with code {code}]\r\n");
        let mut state = self.lock();
        state.exited = true;
        if let Some(timer) = state.held_timer.take() {
            timer.cancel();
        }
        state.paused_by.clear();
        let change = state.activity.exit();
        let emitted = state.emitted;
        match (change, state.order.as_mut()) {
            (Some(activity), Some(order)) => order.end = Some((emitted, activity)),
            (change, _) => self.publish_after_output(&mut state, change),
        }
        state.buffer.append(&line);
        Tab::emitted(&mut state, line.len());
        line.into_bytes()
    }

    /// Where the relay feed's pump is: the changes that follow no more output than it has taken go, and the shell's end once the pump
    /// reaches its exit line (or ends). The end is published before the pump goes on with the exit line: Node broadcast
    /// `activity.exit()` and then emitted the line (terminal-manager.ts:378-384), so a client never got the line first. A change that
    /// goes once the pump has taken its chunk's text also reaches the clients before the relay buffer sends that text: Node applied the
    /// marker synchronously after emitting the chunk into its 16 ms buffer, so the buffer's flush always came after the change. The
    /// returned publication (of whatever went here) is what the pump waits for.
    pub(super) fn pumped(&self, at: PumpPoint) -> Option<Published> {
        let mut state = self.lock();
        let order = state.order.as_mut()?;
        let (taken, reached) = match at {
            PumpPoint::Reaching(offset) => (order.taken.max(offset), offset),
            PumpPoint::Taken(taken) => (taken, if taken == u64::MAX { u64::MAX } else { 0 }),
        };
        order.taken = taken;
        // Output about to enter the relay buffer follows every change that already went at once.
        let mut went = matches!(at, PumpPoint::Reaching(_)) && std::mem::take(&mut order.unpublished);
        while order.waiting.front().is_some_and(|(after, _)| *after <= taken) {
            let (_, activity) = order.waiting.pop_front().expect("a waiting change");
            self.events.activity(&self.id, activity);
            went = true;
        }
        if order.waiting.is_empty() && order.end.is_some_and(|(line, _)| line <= reached) {
            let (_, activity) = order.end.take().expect("the end waits");
            self.events.activity(&self.id, activity);
            went = true;
        }
        if went { self.events.published() } else { None }
    }

    /// The pump has taken `taken` bytes of output (tests name it so).
    #[cfg(test)]
    pub(super) fn taken(&self, taken: u64) {
        let _ = self.pumped(PumpPoint::Taken(taken));
    }

    /// Applies the tab's current size to its PTY. Called without the state lock.
    pub(super) fn sync_size(&self) {
        let _gate = self.gate();
        let ((cols, rows), exited) = {
            let state = self.lock();
            (state.size, state.exited)
        };
        if !exited {
            // A racing exit is not an error.
            let _ = self.manager.resize_pty(&self.handle, PtySize { cols, rows });
        }
    }

    /// Applies the tab's current output pause to its reader. Called without the state lock.
    pub(super) fn sync_pause(&self) {
        let _gate = self.gate();
        let paused = !self.lock().paused_by.is_empty();
        let _ = self.manager.set_output_paused(&self.handle, paused);
    }

    pub(super) fn running(&self) -> bool {
        !self.lock().exited
    }
}

/// Runs on the PTY's reader thread: markers out, bytes decoded to text; once the feed admits the text, text into the replay window and
/// the markers applied (see [`RelayOrder`]). What it returns is what the feed carries, so feed events are always whole UTF-8.
pub(super) struct TabFilter {
    pub(super) tab: Arc<Tab>,
    /// The chunk the last `filter` or `finish` returned, and its markers: applied to the tab when the feed admits it.
    pub(super) text: String,
    pub(super) markers: Vec<Marker>,
}

impl TabFilter {
    pub(super) fn new(tab: Arc<Tab>) -> Self {
        Self { tab, text: String::new(), markers: Vec::new() }
    }

    /// `admitted` with the ticker and the flush dispatch of the held-tail release given (the tests give theirs).
    pub(super) fn admitted_with(&mut self, ticker: Option<&mixdog_rt::Ticker>, dispatch: impl FnOnce(Arc<Tab>, u64) + Send + 'static) -> bool {
        let mut state = self.tab.lock();
        let text = std::mem::take(&mut self.text);
        state.buffer.append(&text);
        Tab::emitted(&mut state, text.len());
        let mut changed = false;
        for marker in self.markers.drain(..) {
            let change = state.activity.marker(marker);
            changed |= change.is_some();
            self.tab.publish_after_output(&mut state, change);
        }
        if state.scanner.as_ref().is_some_and(MarkerScanner::is_holding) {
            if let Some(timer) = state.held_timer.take() {
                timer.cancel();
            }
            state.held_timer = Some(self.tab.arm_flush(ticker.unwrap_or_else(|| mixdog_rt::ticker()), state.held_gen, dispatch));
        }
        changed
    }
}

impl OutputFilter for TabFilter {
    fn filter(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut state = self.tab.wait_flush();
        if let Some(timer) = state.held_timer.take() {
            timer.cancel();
        }
        state.held_gen += 1;
        let decoded = state.decoder.push(bytes);
        let (text, markers) = match state.scanner.as_mut() {
            Some(scanner) => scanner.scan(&decoded),
            None => (decoded, Vec::new()),
        };
        self.text = text;
        self.markers = markers;
        self.text.as_bytes().to_vec()
    }

    fn finish(&mut self) -> Vec<u8> {
        let mut state = self.tab.wait_flush();
        if let Some(timer) = state.held_timer.take() {
            timer.cancel();
        }
        state.held_gen += 1;
        let mut text = state.scanner.as_mut().map(MarkerScanner::flush).unwrap_or_default();
        text.push_str(&state.decoder.finish());
        self.text = text;
        self.markers.clear();
        self.text.as_bytes().to_vec()
    }

    fn admitted(&mut self) -> bool {
        self.admitted_with(None, Tab::dispatch_flush)
    }
}
