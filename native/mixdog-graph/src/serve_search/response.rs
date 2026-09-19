// Outbound transport: the bounded response queue with its writer thread,
// the process-wide route for unsolicited events, and the per-client sink.
use super::*;

pub(super) struct ResponseQueueState {
    pub(super) control: VecDeque<String>,
    pub(super) normal: VecDeque<String>,
    pub(super) writing: bool,
    pub(super) closed: bool,
}

pub(super) struct ResponseQueue {
    pub(super) state: Mutex<ResponseQueueState>,
    pub(super) changed: Condvar,
    pub(super) space: Condvar,
    pub(super) drained: Condvar,
    pub(super) capacity: usize,
}

impl ResponseQueue {
    pub(super) fn new(capacity: usize) -> Self {
        Self {
            state: Mutex::new(ResponseQueueState {
                control: VecDeque::new(),
                normal: VecDeque::new(),
                writing: false,
                closed: false,
            }),
            changed: Condvar::new(),
            space: Condvar::new(),
            drained: Condvar::new(),
            capacity,
        }
    }

    pub(super) fn push(&self, line: String, control: bool) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while !state.closed
            && state.control.len().saturating_add(state.normal.len()) >= self.capacity
        {
            state = self.space.wait(state).unwrap_or_else(|e| e.into_inner());
        }
        if state.closed {
            return;
        }
        if control {
            state.control.push_back(line);
        } else {
            state.normal.push_back(line);
        }
        self.changed.notify_one();
    }

    // Generic over the sink so one queue type serves both transports: the
    // stdio server writes to stdout, and a shared pipe server gives every
    // accepted connection its own queue + writer thread. Responses must never
    // cross connections, so ownership of the writer belongs to the queue.
    pub(super) fn run<W: Write>(&self, writer: W) {
        let mut out = BufWriter::new(writer);
        loop {
            let line = {
                let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
                while !state.closed && state.control.is_empty() && state.normal.is_empty() {
                    state = self.changed.wait(state).unwrap_or_else(|e| e.into_inner());
                }
                if state.closed && state.control.is_empty() && state.normal.is_empty() {
                    return;
                }
                let line = state
                    .control
                    .pop_front()
                    .or_else(|| state.normal.pop_front())
                    .expect("response queue line");
                state.writing = true;
                self.space.notify_all();
                line
            };
            let failed = writeln!(out, "{line}").and_then(|_| out.flush()).is_err();
            let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
            state.writing = false;
            if failed {
                state.closed = true;
                state.control.clear();
                state.normal.clear();
                self.changed.notify_all();
                self.space.notify_all();
            }
            if state.control.is_empty() && state.normal.is_empty() {
                self.drained.notify_all();
            }
            if failed {
                return;
            }
        }
    }

    pub(super) fn flush(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while !state.closed
            && (state.writing || !state.control.is_empty() || !state.normal.is_empty())
        {
            state = self.drained.wait(state).unwrap_or_else(|e| e.into_inner());
        }
    }

    /// Release the writer thread. Queued lines are dropped rather than
    /// written: a caller reaching teardown has already flushed whatever it
    /// still cared about, and blocking shutdown behind a writer whose consumer
    /// may itself be gone is how a hung teardown starts.
    pub(super) fn close(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.closed = true;
        state.control.clear();
        state.normal.clear();
        self.changed.notify_all();
        self.space.notify_all();
        self.drained.notify_all();
    }
}

/// The process-wide outbound route for UNSOLICITED events.
///
/// Watcher invalidations are emitted deep inside the engine with no request in
/// hand, so they cannot travel through a per-request sink. That route is
/// installable rather than hard-wired to stdout: the in-process addon shares
/// its host's stdout, and writing JSONL there would corrupt whatever the host
/// is printing. The addon therefore installs its own queue before the engine
/// can emit anything; an empty slot means the standalone process, which owns
/// stdout outright.
pub(super) static RESPONSE_QUEUE: RwLock<Option<Arc<ResponseQueue>>> = RwLock::new(None);

pub(super) fn response_queue() -> Arc<ResponseQueue> {
    if let Some(queue) = RESPONSE_QUEUE
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        return Arc::clone(queue);
    }
    let mut slot = RESPONSE_QUEUE.write().unwrap_or_else(|e| e.into_inner());
    // Another thread may have installed one while this thread upgraded the
    // lock; a second stdout writer would interleave half-lines.
    if let Some(queue) = slot.as_ref() {
        return Arc::clone(queue);
    }
    let queue = Arc::new(ResponseQueue::new(response_queue_capacity()));
    let writer_queue = Arc::clone(&queue);
    std::thread::Builder::new()
        .name("mixdog-search-response-writer".to_string())
        .spawn(move || writer_queue.run(std::io::stdout()))
        .expect("mixdog response writer");
    *slot = Some(Arc::clone(&queue));
    queue
}

/// Redirect unsolicited events, returning the route that was replaced.
pub(super) fn install_response_queue(
    queue: Option<Arc<ResponseQueue>>,
) -> Option<Arc<ResponseQueue>> {
    let mut slot = RESPONSE_QUEUE.write().unwrap_or_else(|e| e.into_inner());
    std::mem::replace(&mut *slot, queue)
}

pub(super) fn enqueue_response(response: &serde_json::Value, control: bool) {
    note_serve_search_activity();
    response_queue().push(response.to_string(), control);
}

pub(super) fn write_response(response: &serde_json::Value) {
    enqueue_response(response, false);
}

pub(super) fn flush_responses() {
    response_queue().flush();
}

/// One connected client's outbound channel.
///
/// The stdio server has exactly one of these (wrapping the process-wide stdout
/// queue); a shared server hands every accepted connection its own queue and
/// writer thread. Request ids are only unique WITHIN a client — each JS client
/// starts its sequence at 1 — so a response must travel back through the sink
/// that carried its request, never through a global.
#[derive(Clone)]
pub(super) struct ClientSink {
    pub(super) queue: Arc<ResponseQueue>,
}

impl ClientSink {
    pub(super) fn enqueue(&self, response: &serde_json::Value, control: bool) {
        note_serve_search_activity();
        self.queue.push(response.to_string(), control);
    }

    pub(super) fn write(&self, response: &serde_json::Value) {
        self.enqueue(response, false);
    }

    pub(super) fn write_control(&self, response: &serde_json::Value) {
        self.enqueue(response, true);
    }

    pub(super) fn write_cancelled(&self, id: u64) {
        self.write_control(&serde_json::json!({ "id": id, "event": "cancelled" }));
    }

    pub(super) fn flush(&self) {
        self.queue.flush();
    }
}

pub(super) fn stdio_sink() -> ClientSink {
    ClientSink {
        queue: response_queue(),
    }
}
