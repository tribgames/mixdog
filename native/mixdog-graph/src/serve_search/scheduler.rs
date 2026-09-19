// Admission and dispatch: request classes, the bounded queues with an
// interactive reserve, AIMD bulk throttling and telemetry.
use super::*;

/// Scopes a request id to the client that issued it. Cancellation and
/// completion both look up through this key, so two clients using the same id
/// can never cancel or answer each other's search.
pub(super) type RequestKey = (u64, u64);

/// Reserved for the single client of the stdio transport.
pub(super) const STDIO_CLIENT_ID: u64 = 0;

pub(super) fn search_pool(threads: usize) -> ThreadPool {
    ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(|index| format!("mixdog-search-{index}"))
        .build()
        .expect("mixdog search worker pool")
}

pub(super) fn bulk_search_pool(threads: usize) -> ThreadPool {
    ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(|index| format!("mixdog-search-bulk-{index}"))
        .build()
        .expect("mixdog bulk search worker pool")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum SearchClass {
    Interactive,
    Fuzzy,
    Bulk,
}

pub(super) fn search_class(req: &ServeRequest) -> SearchClass {
    if req.fuzzy.is_some() {
        SearchClass::Fuzzy
    } else if req.bulk_hint || req.args.iter().any(|arg| arg == "--files") {
        SearchClass::Bulk
    } else {
        SearchClass::Interactive
    }
}

pub(super) struct ScheduledSearch {
    pub(super) req: ServeRequest,
    pub(super) cancelled: Arc<AtomicBool>,
    pub(super) queued_at: Instant,
    pub(super) client_id: u64,
    pub(super) sink: ClientSink,
}

pub(super) struct SchedulerState {
    pub(super) interactive: VecDeque<ScheduledSearch>,
    pub(super) fuzzy: VecDeque<ScheduledSearch>,
    pub(super) bulk: VecDeque<ScheduledSearch>,
    pub(super) interactive_inflight: usize,
    pub(super) fuzzy_inflight: usize,
    pub(super) bulk_inflight: usize,
    pub(super) bulk_window: usize,
    pub(super) queue_ewma_us: u64,
    pub(super) handler_ewma_us: u64,
    pub(super) healthy_completions: usize,
    pub(super) saturation_count: u64,
    pub(super) closed: bool,
}

impl SchedulerState {
    pub(super) fn new(bulk_limit: usize) -> Self {
        Self {
            interactive: VecDeque::new(),
            fuzzy: VecDeque::new(),
            bulk: VecDeque::new(),
            interactive_inflight: 0,
            fuzzy_inflight: 0,
            bulk_inflight: 0,
            bulk_window: bulk_limit.max(1),
            queue_ewma_us: 0,
            handler_ewma_us: 0,
            healthy_completions: 0,
            saturation_count: 0,
            closed: false,
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct SchedulerTelemetry {
    pub(super) queue_depth: usize,
    pub(super) inflight: usize,
    pub(super) bulk_window: usize,
    pub(super) bulk_limit: usize,
    pub(super) queue_capacity: usize,
    pub(super) priority_queue_reserve: usize,
    pub(super) saturation_count: u64,
    pub(super) queue_ewma_ms: u64,
    pub(super) handler_ewma_ms: u64,
}

pub(super) fn scheduler_telemetry(
    inner: &SchedulerInner,
    state: &SchedulerState,
) -> SchedulerTelemetry {
    SchedulerTelemetry {
        queue_depth: state
            .interactive
            .len()
            .saturating_add(state.fuzzy.len())
            .saturating_add(state.bulk.len()),
        inflight: state
            .interactive_inflight
            .saturating_add(state.fuzzy_inflight)
            .saturating_add(state.bulk_inflight),
        bulk_window: state.bulk_window,
        bulk_limit: inner.bulk_limit,
        queue_capacity: inner.queue_capacity,
        priority_queue_reserve: inner.priority_queue_reserve,
        saturation_count: state.saturation_count,
        queue_ewma_ms: state.queue_ewma_us / 1_000,
        handler_ewma_ms: state.handler_ewma_us / 1_000,
    }
}

pub(super) fn telemetry_json(telemetry: SchedulerTelemetry) -> serde_json::Value {
    serde_json::json!({
        "queueDepth": telemetry.queue_depth,
        "inflight": telemetry.inflight,
        "bulkWindow": telemetry.bulk_window,
        "bulkLimit": telemetry.bulk_limit,
        "queueCapacity": telemetry.queue_capacity,
        "priorityQueueReserve": telemetry.priority_queue_reserve,
        "saturationCount": telemetry.saturation_count,
        "queueEwmaMs": telemetry.queue_ewma_ms,
        "handlerEwmaMs": telemetry.handler_ewma_ms,
    })
}

pub(super) struct SchedulerInner {
    pub(super) state: Mutex<SchedulerState>,
    pub(super) changed: Condvar,
    pub(super) interactive_pool: Arc<ThreadPool>,
    pub(super) fuzzy_pool: Arc<ThreadPool>,
    pub(super) bulk_pool: Arc<ThreadPool>,
    pub(super) interactive_limit: usize,
    pub(super) fuzzy_limit: usize,
    pub(super) bulk_limit: usize,
    pub(super) total_limit: usize,
    pub(super) interactive_reserve: usize,
    pub(super) queue_capacity: usize,
    pub(super) priority_queue_reserve: usize,
    pub(super) file_lists: Arc<FileListStore>,
    pub(super) cancellations: Arc<Mutex<HashMap<RequestKey, Arc<AtomicBool>>>>,
}

pub(super) struct SearchScheduler {
    pub(super) inner: Arc<SchedulerInner>,
    pub(super) dispatcher: Option<JoinHandle<()>>,
}

impl SearchScheduler {
    pub(super) fn new(
        file_lists: Arc<FileListStore>,
        cancellations: Arc<Mutex<HashMap<RequestKey, Arc<AtomicBool>>>>,
    ) -> Self {
        let total_limit = server_parallelism();
        let interactive_reserve = interactive_reserve(total_limit);
        let interactive_limit = total_limit.saturating_add(interactive_reserve);
        let fuzzy_limit = total_limit;
        let bulk_limit = bulk_parallelism();
        let queue_capacity = queue_capacity();
        let inner = Arc::new(SchedulerInner {
            state: Mutex::new(SchedulerState::new(bulk_limit)),
            changed: Condvar::new(),
            interactive_pool: Arc::new(search_pool(interactive_limit)),
            fuzzy_pool: Arc::new(search_pool(fuzzy_limit)),
            bulk_pool: Arc::new(bulk_search_pool(bulk_limit)),
            interactive_limit,
            fuzzy_limit,
            bulk_limit,
            total_limit,
            interactive_reserve,
            queue_capacity,
            priority_queue_reserve: priority_queue_reserve(queue_capacity),
            file_lists,
            cancellations,
        });
        let dispatch_inner = Arc::clone(&inner);
        let dispatcher = std::thread::Builder::new()
            .name("mixdog-search-dispatch".to_string())
            .spawn(move || dispatch_searches(dispatch_inner))
            .expect("mixdog search dispatcher");
        Self {
            inner,
            dispatcher: Some(dispatcher),
        }
    }

    pub(super) fn enqueue(&self, search: ScheduledSearch) -> Result<(), ScheduledSearch> {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed {
            return Err(search);
        }
        let class = search_class(&search.req);
        let queue_depth = state
            .interactive
            .len()
            .saturating_add(state.fuzzy.len())
            .saturating_add(state.bulk.len());
        let admission_capacity = queue_admission_capacity(
            class,
            self.inner.queue_capacity,
            self.inner.priority_queue_reserve,
        );
        if queue_depth >= admission_capacity {
            state.saturation_count = state.saturation_count.saturating_add(1);
            return Err(search);
        }
        match class {
            SearchClass::Interactive => state.interactive.push_back(search),
            SearchClass::Fuzzy => state.fuzzy.push_back(search),
            SearchClass::Bulk => state.bulk.push_back(search),
        }
        self.inner.changed.notify_one();
        Ok(())
    }

    pub(super) fn cancel_queued(&self, client_id: u64, id: u64) -> bool {
        let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        let before = state.interactive.len() + state.fuzzy.len() + state.bulk.len();
        // Ids repeat across clients, so a queued search only matches when BOTH
        // the issuing client and the id line up.
        let mine = |search: &ScheduledSearch| search.client_id == client_id && search.req.id == id;
        state.interactive.retain(|search| !mine(search));
        state.fuzzy.retain(|search| !mine(search));
        state.bulk.retain(|search| !mine(search));
        let removed = before != state.interactive.len() + state.fuzzy.len() + state.bulk.len();
        if removed {
            self.inner.changed.notify_all();
        }
        removed
    }

    pub(super) fn telemetry(&self) -> SchedulerTelemetry {
        let state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
        scheduler_telemetry(&self.inner, &state)
    }

    pub(super) fn shutdown(mut self) {
        {
            let mut state = self.inner.state.lock().unwrap_or_else(|e| e.into_inner());
            state.closed = true;
            self.inner.changed.notify_all();
        }
        if let Some(dispatcher) = self.dispatcher.take() {
            let _ = dispatcher.join();
        }
    }
}

pub(super) fn interactive_dispatch_ceiling(
    total_limit: usize,
    reserve: usize,
    has_pending_interactive: bool,
) -> usize {
    total_limit.saturating_add(if has_pending_interactive { reserve } else { 0 })
}

pub(super) fn adaptive_bulk_limit(configured: usize, state: &SchedulerState) -> usize {
    let adaptive = configured.min(state.bulk_window.max(1));
    if state.interactive_inflight > 0 || !state.interactive.is_empty() {
        adaptive.min(1)
    } else {
        adaptive
    }
}

pub(super) fn update_ewma(current: u64, sample: u64) -> u64 {
    if current == 0 {
        sample
    } else {
        current
            .saturating_mul(7)
            .saturating_add(sample)
            .saturating_div(8)
    }
}

pub(super) fn duration_micros(duration: Duration) -> u64 {
    duration.as_micros().min(u128::from(u64::MAX)) as u64
}

pub(super) fn observe_scheduler_latency(
    state: &mut SchedulerState,
    queue_elapsed: Duration,
    handler_elapsed: Duration,
    configured_bulk_limit: usize,
) {
    let queue_us = duration_micros(queue_elapsed);
    let handler_us = duration_micros(handler_elapsed);
    state.queue_ewma_us = update_ewma(state.queue_ewma_us, queue_us);
    state.handler_ewma_us = update_ewma(state.handler_ewma_us, handler_us);
    let target = aimd_target();
    if queue_elapsed > target || handler_elapsed > target {
        state.bulk_window = state.bulk_window.max(1).div_ceil(2);
        state.healthy_completions = 0;
        return;
    }
    if queue_elapsed <= target / 4
        && handler_elapsed <= target
        && state.interactive.is_empty()
        && state.bulk_window < configured_bulk_limit
    {
        state.healthy_completions = state.healthy_completions.saturating_add(1);
        if state.healthy_completions >= aimd_increase_every() {
            state.bulk_window = state
                .bulk_window
                .saturating_add(1)
                .min(configured_bulk_limit);
            state.healthy_completions = 0;
        }
    } else {
        state.healthy_completions = 0;
    }
}

pub(super) fn dispatch_searches(inner: Arc<SchedulerInner>) {
    loop {
        let ready = {
            let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                let mut ready = Vec::new();
                let mut total_inflight = state
                    .interactive_inflight
                    .saturating_add(state.fuzzy_inflight)
                    .saturating_add(state.bulk_inflight);
                let interactive_ceiling = interactive_dispatch_ceiling(
                    inner.total_limit,
                    inner.interactive_reserve,
                    !state.interactive.is_empty(),
                );
                while state.interactive_inflight < inner.interactive_limit
                    && total_inflight < interactive_ceiling
                {
                    let Some(search) = state.interactive.pop_front() else {
                        break;
                    };
                    state.interactive_inflight += 1;
                    total_inflight += 1;
                    ready.push((SearchClass::Interactive, search));
                }
                while state.fuzzy_inflight < inner.fuzzy_limit && total_inflight < inner.total_limit
                {
                    let Some(search) = state.fuzzy.pop_front() else {
                        break;
                    };
                    state.fuzzy_inflight += 1;
                    total_inflight += 1;
                    ready.push((SearchClass::Fuzzy, search));
                }
                let current_bulk_limit = adaptive_bulk_limit(inner.bulk_limit, &state);
                while state.bulk_inflight < current_bulk_limit && total_inflight < inner.total_limit
                {
                    let Some(search) = state.bulk.pop_front() else {
                        break;
                    };
                    state.bulk_inflight += 1;
                    total_inflight += 1;
                    ready.push((SearchClass::Bulk, search));
                }
                if !ready.is_empty() {
                    break ready;
                }
                if state.closed
                    && state.interactive.is_empty()
                    && state.fuzzy.is_empty()
                    && state.bulk.is_empty()
                    && state.interactive_inflight == 0
                    && state.fuzzy_inflight == 0
                    && state.bulk_inflight == 0
                {
                    return;
                }
                state = inner.changed.wait(state).unwrap_or_else(|e| e.into_inner());
            }
        };

        for (class, search) in ready {
            let task_inner = Arc::clone(&inner);
            let pool = match class {
                SearchClass::Interactive => Arc::clone(&inner.interactive_pool),
                SearchClass::Fuzzy => Arc::clone(&inner.fuzzy_pool),
                SearchClass::Bulk => Arc::clone(&inner.bulk_pool),
            };
            pool.spawn(move || execute_scheduled_search(task_inner, class, search));
        }
    }
}

pub(super) fn response_for_handler_result(
    id: u64,
    result: Result<serde_json::Value, String>,
    request_cancelled: bool,
) -> Option<serde_json::Value> {
    if request_cancelled {
        return None;
    }
    match result {
        Ok(value) => Some(value),
        Err(reason) if reason == CANCELLED => Some(serde_json::json!({
            "id": id,
            "error": "native inventory abandoned without request cancellation",
        })),
        Err(reason) => Some(serde_json::json!({ "id": id, "unsupported": reason })),
    }
}

pub(super) fn execute_scheduled_search(
    inner: Arc<SchedulerInner>,
    class: SearchClass,
    search: ScheduledSearch,
) {
    let ScheduledSearch {
        req,
        cancelled,
        queued_at,
        client_id,
        sink,
    } = search;
    let id = req.id;
    let queue_elapsed = queued_at.elapsed();
    let queue_ms = queue_elapsed.as_millis();
    let handler_started = Instant::now();
    let mut response = if cancelled.load(Ordering::Relaxed) {
        None
    } else {
        let deadline_at = req
            .deadline_ms
            .map(|deadline_ms| queued_at + Duration::from_millis(deadline_ms));
        let handled = contain_search_panic("native search handler", || {
            handle(&req, &cancelled, &inner.file_lists, deadline_at)
        });
        response_for_handler_result(req.id, handled, cancelled.load(Ordering::Relaxed))
    };
    let handler_elapsed = handler_started.elapsed();
    let handler_ms = handler_elapsed.as_millis();
    let telemetry = {
        let mut state = inner.state.lock().unwrap_or_else(|e| e.into_inner());
        match class {
            SearchClass::Interactive => {
                state.interactive_inflight = state.interactive_inflight.saturating_sub(1);
            }
            SearchClass::Fuzzy => {
                state.fuzzy_inflight = state.fuzzy_inflight.saturating_sub(1);
            }
            SearchClass::Bulk => {
                state.bulk_inflight = state.bulk_inflight.saturating_sub(1);
            }
        }
        observe_scheduler_latency(&mut state, queue_elapsed, handler_elapsed, inner.bulk_limit);
        let telemetry = scheduler_telemetry(&inner, &state);
        inner.changed.notify_all();
        telemetry
    };
    if let Some(value) = response.as_mut().and_then(serde_json::Value::as_object_mut) {
        value.insert("queueMs".to_string(), serde_json::json!(queue_ms));
        value.insert("handlerMs".to_string(), serde_json::json!(handler_ms));
        value.insert(
            "class".to_string(),
            serde_json::json!(match class {
                SearchClass::Interactive => "interactive",
                SearchClass::Fuzzy => "fuzzy",
                SearchClass::Bulk => "bulk",
            }),
        );
        value.insert("scheduler".to_string(), telemetry_json(telemetry));
    }
    if let Ok(mut map) = inner.cancellations.lock() {
        map.remove(&(client_id, id));
    }
    if cancelled.load(Ordering::Relaxed) {
        sink.write_cancelled(id);
    } else {
        if let Some(response) = response {
            sink.write(&response);
        }
    }
}
