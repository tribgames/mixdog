//! The session state and its one fold. The same [`SessionState::apply`] builds the state of an
//! opened log (checkpoint + tail), the projected state (applied when work is accepted, used to
//! validate later work) and the acked state (applied when work is released at its ack, the
//! source of the view and the feed). Projected and acked differ only by the unacked suffix, so
//! a barrier failure resets projected to a clone of acked (RL §6.1).

use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::sync::Arc;

use mixdog_app_protocol::v2::thread::StorageState;
use mixdog_app_protocol::v2::thread::ThreadContext;
use mixdog_app_protocol::v2::thread::ThreadRoute;
use mixdog_app_protocol::v2::thread::ThreadRuntime;
use mixdog_app_protocol::v2::thread::ThreadState;
use mixdog_app_protocol::v2::thread::ThreadWorkflow;
use mixdog_core_api::ids::ItemId;
use mixdog_core_api::ids::TurnId;
use mixdog_core_ports::ports::threads::Section;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::MaybeBlob;
use mixdog_protocol::OrchestrationMode;
use mixdog_protocol::ThreadItem;
use mixdog_protocol::ToolApprovalResult;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::record::ApprovalPhase;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::ItemRecord;
use mixdog_store::schema::record::MetaRecord;
use mixdog_store::schema::record::ModelSwitchRecord;
use mixdog_store::schema::record::QueueAction;
use mixdog_store::schema::record::QueueRecord;
use mixdog_store::schema::record::Record;
use mixdog_store::schema::record::RunPhase;
use mixdog_store::schema::record::RunRecord;
use serde_json::Value;

use super::prompt_history;
use super::seams::Shown;
use super::seams::merge_update;
use super::seams::updates;

/// What a record shows besides itself.
#[derive(Clone, Debug)]
pub(crate) enum Display {
    None,
    /// The display items of an `item`/`amend` record.
    Items(Vec<Shown>),
    /// A durable row that shows nothing live: a completion its card already stands for
    /// (Node's `suppressDisplay`); a reopen shows it where its turn took it in.
    Suppressed,
    /// The `queued` row of a `queue{enqueue}` record.
    Queued(Value),
}

/// One state change: a durable record, or a view-only change published in order with them.
#[derive(Clone, Debug)]
pub(crate) enum Change {
    Record {
        record: Arc<Record>,
        display: Display,
    },
    Section(Section),
    /// `item/started`: an in-progress item (not persisted; deltas extend it).
    ItemStarted {
        turn: TurnId,
        item: ThreadItem,
    },
    /// An `item/agentMessage/delta` (not persisted).
    Delta {
        item: ItemId,
        text: String,
    },
    /// The session part of the prompt history, recomputed over the remaining lineage after a
    /// history mutation. `publish: false` (rewind) keeps the published list: today's rewind
    /// only drops the restored prompt from it (`replaceItems(.., {preserveSpill})`), and the
    /// next merge sees the remaining rows.
    PromptSession {
        session: Vec<String>,
        publish: bool,
    },
    /// The persisted prompt history of the thread's cwd (oldest → newest).
    PromptPersisted(Vec<String>),
    /// A prompt handed back to the composer leaves the published list.
    PromptWithout(String),
    /// No change: its effects run once every earlier record is durable.
    Barrier,
    /// The records (by ordinal) whose rows in view a compaction took out of the model context: the rows show `archived`,
    /// as a reopened window shows them (`fold_opened`). Not persisted: a reopen reads it from the index.
    Archived(Vec<u64>),
    /// A card in view as it now reads (a tool card closed by an early result, a completion's card extended): the row
    /// with its id is replaced where it stands, and nothing when it is gone, never a new row.
    Card(ThreadItem),
    /// The detail of a row in view (a compaction divider's figures, which its pass's event delivers after the record):
    /// nothing when the row is gone, never a new row. Not persisted.
    Detail {
        item: ItemId,
        detail: String,
    },
    /// A call's result before its row is committed (`onToolResult`, not persisted): `update` closes the call's card. The actor
    /// resolves it at its show against what is shown then (the card shown, not yet, or already given its committed result), so
    /// the fold itself changes nothing.
    EarlyResult {
        row: Box<mixdog_store::schema::record::ItemRecord>,
        update: ThreadItem,
    },
    /// A run's live-only row (not persisted): before the row `before` when it is in view,
    /// else at the end.
    Shown {
        item: ThreadItem,
        before: Option<ItemId>,
    },
    /// A streamed text segment settled (a tool call began after it): shown as a live-only row at the end, unless a row of the
    /// same item is in view when it is shown (its reply's committed row, shown first). Decided at its show, in accept order, so a
    /// settle accepted behind its reply's commit waits for that commit's row or its failure. `turn` names the turn its note tells.
    Settled {
        turn: mixdog_core_api::ids::TurnId,
        item: ThreadItem,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct WindowItem {
    /// `None` until the record is acked (projected state only).
    pub ordinal: Option<u64>,
    pub item: Arc<ThreadItem>,
    /// The model-history messages this row stands for, with the model records after it that show no row of their own.
    pub messages: u32,
}

#[derive(Clone, Debug)]
pub(crate) struct LiveItem {
    pub turn: TurnId,
    pub item: ThreadItem,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Queued {
    pub qid: String,
    pub entry: Value,
    pub display: Value,
}

/// `queuePriorityValue` (`queue-helpers.mjs`): `now` (0) before `next` (1) before `later` (2); an entry naming none is `next`.
pub(crate) fn priority_rank(entry: &Value) -> u8 {
    match entry.get("priority").and_then(Value::as_str) {
        Some("now") => 0,
        Some("later") => 2,
        _ => 1,
    }
}

#[derive(Clone, Debug)]
pub(crate) struct PendingApprovalRow {
    pub rid: String,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct SessionState {
    /// One allocation shared by the session's two states and its published live header while they say the same; a change
    /// copies it for the state it changes (`Arc::make_mut`), and the states meet again once both have folded it.
    pub header: Arc<Header>,
    pub history_rev: u64,
    pub lineage_start: u64,
    /// Runs started without a terminal phase, with their drafts (`draft` records).
    pub runs: BTreeMap<String, super::turn_draft::RunDraft>,
    /// The input row of the run whose `run{started}` is next: `(rid, iid)`.
    pub next_input: Option<(String, String)>,
    pub approvals: BTreeMap<String, PendingApprovalRow>,
    pub queue: Vec<Queued>,
    pub window: VecDeque<WindowItem>,
    pub has_older: bool,
    /// The newest acked user row that shows no row (a kickoff): its iid and ordinal, so its turn's own rewind finds it.
    pub hidden_prompt: Option<(String, u64)>,
    pub live: Vec<LiveItem>,
    pub sections: ThreadState,
    pub view_items: usize,
    /// Prompt history (`prompt_history`): session part, persisted part, published list.
    pub prompt_session: Vec<String>,
    pub prompt_persisted: Vec<String>,
    /// Replaced whole when it changes, so a reader holds the list it took without a copy.
    pub prompt_history: Arc<Vec<String>>,
    /// A thread created here, before its first status pass (a status signal tells no listener before it).
    pub status_pending: bool,
}

/// A route section update over the held one: a field the update states replaces it (the section is published whole, so
/// a producer that knows one field leaves the others).
fn merge_route(held: ThreadRoute, new: ThreadRoute) -> ThreadRoute {
    ThreadRoute {
        session_provider: new.session_provider.or(held.session_provider),
        session_model: new.session_model.or(held.session_model),
        fast: new.fast.or(held.fast),
        fast_capable: new.fast_capable.or(held.fast_capable),
        auto_effort: new.auto_effort.or(held.auto_effort),
        model_parameters: new.model_parameters.or(held.model_parameters),
        selected_context_window: new.selected_context_window.or(held.selected_context_window),
        effort: new.effort.or(held.effort),
        provider: new.provider.or(held.provider),
        model: new.model.or(held.model),
        turn_effort: new.turn_effort.or(held.turn_effort),
        effort_options: new.effort_options.or(held.effort_options),
        cwd: new.cwd.or(held.cwd),
        session_forked_from: new.session_forked_from.or(held.session_forked_from),
        system_shell: new.system_shell.or(held.system_shell),
        web_search_route: new.web_search_route.or(held.web_search_route),
        auto_clear: new.auto_clear.or(held.auto_clear),
    }
}

/// A context section update over the held one: a figure the update states replaces it.
fn merge_context(held: ThreadContext, new: ThreadContext) -> ThreadContext {
    ThreadContext {
        context_percent: new.context_percent.or(held.context_percent),
        context_tokens: new.context_tokens.or(held.context_tokens),
        context_default_percent: new.context_default_percent.or(held.context_default_percent),
        context_window: new.context_window.or(held.context_window),
        display_context_window: new.display_context_window.or(held.display_context_window),
        auto_compact_token_limit: new.auto_compact_token_limit.or(held.auto_compact_token_limit),
        stats: new.stats.or(held.stats),
        raw_context_window: new.raw_context_window.or(held.raw_context_window),
        effective_context_window_percent: new.effective_context_window_percent.or(held.effective_context_window_percent),
        compact_boundary_tokens: new.compact_boundary_tokens.or(held.compact_boundary_tokens),
    }
}

/// The thread state's `title`: the name the user gave. Node's session state never carries a title (the
/// desktop names a session from its catalog row, which has the fallback and generated titles), so only a
/// locked title whose source is not the model's (a locked one without a source is the user's, as in
/// `update_ai_title`) is published here and in `thread/name/updated`.
pub(crate) fn title_of(header: &Header) -> Option<String> {
    if header.get("titleLocked") != Some(&Value::Bool(true)) || header.get("titleSource").and_then(Value::as_str) == Some("ai") {
        return None;
    }
    header.get("title").and_then(Value::as_str).map(str::to_owned)
}

/// The completion a record settles: the receipt of a model item's tool result, or the delivered dequeue of a completion.
fn completion_receipt_of(record: &Record) -> Option<String> {
    match record {
        Record::Item(item) if item.model => match &item.body {
            Slot::Inline(body) => mixdog_store::completion_receipts::tool_receipt(body),
            _ => None,
        },
        Record::Queue(queue)
            if queue.action == QueueAction::Dequeue
                && queue.reason == Some(mixdog_store::schema::record::DequeueReason::Delivered)
                && queue.qid.as_str().starts_with("completion_") =>
        {
            Some(queue.qid.as_str().to_owned())
        }
        _ => None,
    }
}
/// Today's `toolApprovalResult` for a resolution.
pub(crate) fn approval_result(aid: &str, resolution: &ApprovalResolution) -> ToolApprovalResult {
    let mut result = ToolApprovalResult {
        // The id the card showed (`room_approval::card_id`), as Node's result named its card's.
        id: super::room_approval::card_id(aid),
        approved: false,
        device: String::new(),
        at: 0,
        expired: None,
        withdrawn: None,
        interrupted: None,
    };
    match resolution {
        ApprovalResolution::Decided { decision, device, at, .. } => {
            result.approved = decision.approved;
            result.device = device.clone();
            result.at = *at;
        }
        ApprovalResolution::TimedOut { at } => {
            result.at = *at;
            result.expired = Some(true);
        }
        ApprovalResolution::Interrupted { at } | ApprovalResolution::Cancelled { at } => {
            result.at = *at;
            result.interrupted = Some(true);
        }
        ApprovalResolution::Withdrawn { at } => {
            result.at = *at;
            result.withdrawn = Some(true);
        }
        // Never persisted: the actor answers it without a request.
        ApprovalResolution::Unavailable { at } => result.at = *at,
    }
    result
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn header(fields: Value) -> Header {
        fields.as_object().cloned().expect("object")
    }

    /// Node's session state carries no title: the fallback and the model's titles stay in the header, and only
    /// the user's rename is published.
    #[test]
    fn only_a_title_the_user_gave_is_published_in_the_thread_state() {
        assert_eq!(title_of(&header(json!({ "title": "Read hello.txt…", "titleUpdatedAt": 1 }))), None);
        assert_eq!(title_of(&header(json!({ "title": "Haiku", "titleLocked": true, "titleSource": "ai" }))), None);
        assert_eq!(title_of(&header(json!({ "title": "Mine", "titleLocked": true, "titleSource": "user" }))).as_deref(), Some("Mine"));
        assert_eq!(title_of(&header(json!({ "title": "Old", "titleLocked": true }))).as_deref(), Some("Old"));
    }

    /// A hint is the runtime section's `progressHint` only: publishing one must not reset what else
    /// the section holds (the whole-section `Runtime` replaces it).
    #[test]
    fn a_progress_hint_changes_only_the_hint_of_the_runtime_section() {
        let mut state = SessionState::new(10);
        let held = ThreadRuntime { busy: true, spinner: Some(json!("working")), ..ThreadRuntime::default() };
        state.apply(&Change::Section(Section::Runtime(held.clone())), None);

        state.apply(&Change::Section(Section::ProgressHint(Some(json!({ "text": "downloading" })))), None);
        let shown = state.sections.runtime.clone().unwrap();
        assert_eq!(shown, ThreadRuntime { progress_hint: Some(json!({ "text": "downloading" })), ..held.clone() });

        state.apply(&Change::Section(Section::ProgressHint(None)), None);
        assert_eq!(state.sections.runtime, Some(held));
    }

    /// A running command's status has one owner, its own start and end (`Command`): a turn's end and a producer's whole runtime
    /// section leave it.
    #[test]
    fn a_command_status_survives_a_turns_end_and_ends_with_its_command() {
        let mut state = SessionState::new(10);
        let status = json!({ "active": true, "verb": "Compacting conversation", "startedAt": 7, "mode": "compacting" });
        state.apply(&Change::Section(Section::Command(Some(status.clone()))), None);
        state.apply(&Change::Section(Section::Runtime(ThreadRuntime { busy: true, ..ThreadRuntime::default() })), None);
        let runtime = state.sections.runtime.clone().unwrap();
        assert_eq!((runtime.busy, runtime.command_busy, runtime.command_status), (true, true, Some(status.clone())));
        let ended = mixdog_store::schema::record::RunRecord {
            rid: mixdog_store::schema::bounded::Text::try_from("r1").expect("a short id"),
            phase: RunPhase::Completed,
            attribution: None,
            attempt: None,
            at: None,
            op: None,
            detail: None,
        };
        state.apply_record(&Record::Run(ended), &Display::None, None);
        let runtime = state.sections.runtime.clone().unwrap();
        assert_eq!((runtime.busy, runtime.command_busy, runtime.command_status), (false, true, Some(status)), "the turn ended; the command did not");
        state.apply(&Change::Section(Section::Command(None)), None);
        let runtime = state.sections.runtime.unwrap();
        assert_eq!((runtime.command_busy, runtime.command_status), (false, None));
    }

    /// The toast queue is the session's own: a producer's whole runtime section leaves it, and the queue
    /// publishes as Node's `{ id, text, tone, owner? }` toasts (`notice-surface.mjs` `pushToast`).
    #[test]
    fn a_runtime_section_leaves_the_toast_queue() {
        let mut state = SessionState::new(10);
        let toast = json!({ "id": "t1", "text": "boom happened", "tone": "error", "owner": "transcript" });
        state.apply(&Change::Section(Section::Toasts(vec![toast.clone()])), None);
        state.apply(&Change::Section(Section::Runtime(ThreadRuntime { busy: true, ..ThreadRuntime::default() })), None);
        let runtime = state.sections.runtime.clone().unwrap();
        assert!(runtime.busy);
        assert_eq!(runtime.toasts, vec![toast]);
        state.apply(&Change::Section(Section::Toasts(Vec::new())), None);
        assert_eq!(state.sections.runtime.clone().unwrap().toasts, Vec::<serde_json::Value>::new());
        assert!(state.sections.runtime.unwrap().busy, "the queue's expiry leaves the rest of the section");
    }

    /// The running tools are the session's own like the toasts: a producer's whole runtime section leaves them, and their section
    /// clears both fields at once (`clearActiveToolSummary`).
    #[test]
    fn the_running_tools_publish_apart_from_the_runtime_section() {
        let mut state = SessionState::new(10);
        let tools = json!({ "shell": { "count": 1, "startedAt": 100 } });
        state.apply(&Change::Section(Section::ActiveTools(Some(("1:100:0:0:0:0".into(), tools.clone())))), None);
        state.apply(&Change::Section(Section::Runtime(ThreadRuntime { busy: true, ..ThreadRuntime::default() })), None);
        let runtime = state.sections.runtime.clone().unwrap();
        assert_eq!((runtime.active_tool_summary.as_deref(), runtime.active_tools), (Some("1:100:0:0:0:0"), Some(tools)));
        state.apply(&Change::Section(Section::ActiveTools(None)), None);
        let runtime = state.sections.runtime.unwrap();
        assert_eq!((runtime.active_tool_summary, runtime.active_tools, runtime.busy), (None, None, true));
    }

    /// The session-state fields Node's `baseRouteState` and `initial-state.mjs` hold besides the sections' producers: the working folder,
    /// the model window figures and the tool mode follow the header (`real-turn-harness` `session-state`: cwd, rawContextWindow,
    /// effectiveContextWindowPercent, compactBoundaryTokens 0 until the first sync, toolMode).
    #[test]
    fn the_header_states_the_cwd_the_window_and_the_tool_mode() {
        let mut state = SessionState::new(10);
        assert_eq!(state.runtime(StorageState::Ok).tool_mode.as_deref(), Some("full"));
        Arc::make_mut(&mut state.header).insert("cwd".into(), json!("/work"));
        Arc::make_mut(&mut state.header).insert("rawContextWindow".into(), json!(128000));
        Arc::make_mut(&mut state.header).insert("effectiveContextWindowPercent".into(), json!(100));
        Arc::make_mut(&mut state.header).insert("toolMode".into(), json!("readonly"));
        let (route, context, runtime) = (state.route(), state.context(), state.runtime(StorageState::Ok));
        assert_eq!((route.cwd.as_deref(), route.session_forked_from), (Some("/work"), None));
        assert_eq!((context.raw_context_window, context.effective_context_window_percent, context.compact_boundary_tokens), (Some(128000), Some(100), Some(0)));
        assert_eq!(runtime.tool_mode.as_deref(), Some("readonly"));
        state.apply(&Change::Section(Section::Context(ThreadContext { compact_boundary_tokens: Some(128000), ..Default::default() })), None);
        assert_eq!(state.context().compact_boundary_tokens, Some(128000));
    }

    /// `setupChanged` (notification-router.mjs `{ action, seq, at }`) is the session's own too: a producer's whole runtime section leaves it.
    #[test]
    fn a_runtime_section_leaves_the_setup_change() {
        let mut state = SessionState::new(10);
        let change = json!({ "action": "settings_changed", "seq": 1, "at": 5 });
        state.apply(&Change::Section(Section::SetupChanged(change.clone())), None);
        state.apply(&Change::Section(Section::Runtime(ThreadRuntime { busy: true, ..ThreadRuntime::default() })), None);
        assert_eq!(state.sections.runtime.unwrap().setup_changed, Some(change));
    }

    /// A pick held for the next turn shows the effort its route is on, not the one asked for: `ultra` clamped to `high` reads `high`
    /// (`runtime-facade.mjs` `effort`: the effective effort first), so a reply, `thread/read` and a live frame say the same.
    #[test]
    fn a_held_pick_reads_back_its_effective_effort() {
        let mut state = SessionState::new(10);
        let route = json!({ "provider": "p", "model": "m", "effort": "ultra", "effectiveEffort": "high" });
        let pick = mixdog_core_ports::ports::route::held_route_pick(route.as_object().unwrap());
        Arc::make_mut(&mut state.header).insert("pendingRoute".into(), Value::Object(pick));
        assert_eq!(state.route().effort.as_deref(), Some("high"));
        let asked = json!({ "provider": "p", "model": "m", "effort": "ultra" });
        let pick = mixdog_core_ports::ports::route::held_route_pick(asked.as_object().unwrap());
        Arc::make_mut(&mut state.header).insert("pendingRoute".into(), Value::Object(pick));
        assert_eq!(state.route().effort.as_deref(), Some("ultra"), "no clamp, the asked effort");
    }

    /// `runtime.turnEffort` (`currentTurnEffort`): the run's value replaces the held one, a turn
    /// without one clears it, and a producer's whole route section leaves it.
    #[test]
    fn the_turn_effort_is_the_runs_and_a_route_section_leaves_it() {
        let mut state = SessionState::new(10);
        assert_eq!(state.route().turn_effort, None);
        state.apply(&Change::Section(Section::TurnEffort(Some("medium".into()))), None);
        state.apply(&Change::Section(Section::Route(ThreadRoute { effort: Some("high".into()), ..ThreadRoute::default() })), None);
        assert_eq!((state.route().turn_effort.as_deref(), state.route().effort.as_deref()), (Some("medium"), Some("high")));
        state.apply(&Change::Section(Section::TurnEffort(None)), None);
        assert_eq!(state.route().turn_effort, None);
    }
}

impl SessionState {
    pub fn new(view_items: usize) -> Self {
        Self { view_items, ..Self::default() }
    }

    /// A shown row of no record of its own (a restored compaction divider and its boundaries),
    /// at the end of the window; it lives and goes with `ordinal` (the `compacted` frame's).
    pub fn push_shown(&mut self, ordinal: u64, item: ThreadItem) {
        self.window.push_back(WindowItem { ordinal: Some(ordinal), item: Arc::new(item), messages: 0 });
        self.trim_window();
    }

    fn trim_window(&mut self) {
        while self.window.len() > self.view_items {
            self.window.pop_front();
            self.has_older = true;
        }
    }

    /// The one fold. `ordinal` is the record's ordinal once acked (`None` in projected state).
    pub fn apply(&mut self, change: &Change, ordinal: Option<u64>) {
        match change {
            Change::Record { record, display } => self.apply_record(record, display, ordinal),
            Change::Section(section) => self.apply_section(section.clone()),
            Change::ItemStarted { turn, item } => {
                self.live.retain(|live| live.item.id() != item.id());
                self.live.push(LiveItem { turn: turn.clone(), item: item.clone() });
            }
            Change::Delta { item, text } => match self.live.iter_mut().find(|live| live.item.id() == item).map(|live| &mut live.item) {
                Some(ThreadItem::AgentMessage { text: MaybeBlob::Inline(body), .. }) => body.push_str(text),
                // The thinking text is one growing part (Node's `thinkingText`).
                Some(ThreadItem::Reasoning { content, .. }) => match content.last_mut() {
                    Some(part) => part.push_str(text),
                    None => content.push(text.clone()),
                },
                _ => {}
            },
            Change::PromptSession { session, publish } => {
                self.prompt_session = session.clone();
                if *publish {
                    self.remerge_prompts();
                }
            }
            Change::PromptPersisted(persisted) => {
                self.prompt_persisted = persisted.clone();
                self.remerge_prompts();
            }
            Change::PromptWithout(text) => {
                self.prompt_history = Arc::new(prompt_history::without(&self.prompt_history, text));
            }
            Change::Barrier | Change::EarlyResult { .. } => {}
            Change::Archived(ordinals) => {
                for row in self.window.iter_mut().filter(|row| row.ordinal.is_some_and(|ordinal| ordinals.contains(&ordinal))) {
                    super::view::meta_mut(Arc::make_mut(&mut row.item)).ext.insert("archived".into(), Value::Bool(true));
                }
            }
            Change::Shown { item, before } => {
                // A live item shown complete (a finished `Reasoning` item) becomes its row.
                self.live.retain(|live| live.item.id() != item.id());
                let at = before.as_ref().and_then(|before| self.window.iter().position(|row| row.item.id() == before)).unwrap_or(self.window.len());
                self.window.insert(at, WindowItem { ordinal: None, item: Arc::new(item.clone()), messages: 0 });
                self.trim_window();
            }
            Change::Settled { item, .. } => {
                if !self.window.iter().any(|row| row.item.id() == item.id()) {
                    self.apply(&Change::Shown { item: item.clone(), before: None }, ordinal);
                }
            }
            Change::Detail { item, detail } => {
                if let Some(row) = self.window.iter_mut().find(|row| row.item.id() == item) {
                    super::view::meta_mut(Arc::make_mut(&mut row.item)).detail = Some(detail.clone());
                }
            }
            Change::Card(card) => {
                if let Some(row) = self.window.iter_mut().find(|row| row.item.id() == card.id()) {
                    row.item = Arc::new(card.clone());
                }
            }
        }
    }

    /// Applies an update to the item in view with its id (`merge_update`).
    fn merge(&mut self, update: &ThreadItem) {
        if let Some(row) = self.window.iter_mut().find(|row| updates(&row.item, update)) {
            row.item = Arc::new(merge_update(&row.item, update));
        }
    }

    /// The item in view that `update` is for.
    pub fn shown_for(&self, update: &ThreadItem) -> Option<Arc<ThreadItem>> {
        self.window.iter().find(|row| updates(&row.item, update)).map(|row| row.item.clone())
    }

    fn remerge_prompts(&mut self) {
        self.prompt_history = Arc::new(prompt_history::merge(&self.prompt_session, &self.prompt_persisted));
    }

    fn apply_record(&mut self, record: &Record, display: &Display, ordinal: Option<u64>) {
        if let Some(qid) = completion_receipt_of(record) {
            mixdog_store::completion_receipts::record(Arc::make_mut(&mut self.header), &qid);
            self.queue.retain(|q| q.qid != qid);
        }
        match record {
            Record::Session(session) => {
                if let Slot::Inline(header) = &session.header {
                    self.header = Arc::new(header.clone());
                }
                if let Some(ordinal) = ordinal {
                    self.lineage_start = ordinal + 1;
                }
                self.sections.title = title_of(&self.header);
            }
            Record::Meta(meta) => self.apply_meta(meta),
            Record::Item(item) => self.apply_item(item, display, ordinal),
            Record::Amend(_) => {
                if let Display::Items(shown) = display {
                    for shown in shown {
                        let (Shown::Item(new) | Shown::Update(new)) = shown;
                        self.merge(new);
                    }
                }
            }
            Record::Rewind(rewind) => {
                self.history_rev += 1;
                // The rows from the first one at or after `to_ordinal` go. A live row (a turn's end, shown without an ordinal) before
                // it stays, as in Node, where the end of an earlier turn is not part of the rewound one. With no such row in view, the
                // rows still unacked follow every acked row, so they are behind `to_ordinal` too.
                let cut = self
                    .window
                    .iter()
                    .position(|row| row.ordinal.is_some_and(|o| o >= rewind.to_ordinal))
                    .unwrap_or_else(|| self.window.iter().rposition(|row| row.ordinal.is_some()).map_or(0, |last| last + 1));
                self.window.truncate(cut);
            }
            Record::Run(run) => self.apply_run(run),
            Record::Approval(approval) => match approval.phase {
                ApprovalPhase::Requested => {
                    self.approvals.insert(approval.aid.as_str().to_owned(), PendingApprovalRow { rid: approval.rid.as_str().to_owned() });
                }
                ApprovalPhase::Decided | ApprovalPhase::Expired => {
                    self.approvals.remove(approval.aid.as_str());
                    if let Some(Slot::Inline(body)) = &approval.body
                        && let Ok(resolution) = serde_json::from_value::<ApprovalResolution>(body.clone())
                    {
                        let approvals = self.sections.approvals.get_or_insert_with(Default::default);
                        approvals.tool_approval_result = Some(approval_result(approval.aid.as_str(), &resolution));
                    }
                }
            },
            Record::Queue(queue) => self.apply_queue(queue, display),
            Record::ModelSwitch(switch) => self.apply_model_switch(switch, display),
            Record::Compacted(_) => self.apply_compacted(display, ordinal),
            Record::Draft(draft) => {
                if let (Some(run), Slot::Inline(body)) = (self.runs.get_mut(draft.rid.as_str()), &draft.body) {
                    run.apply(body);
                }
            }
            Record::WorkStop(stop) => {
                let body = match &stop.body {
                    Some(Slot::Inline(body)) => Some(body),
                    _ => None,
                };
                let gone = mixdog_store::work_stops::apply(Arc::make_mut(&mut self.header), stop.sid.as_str(), stop.phase, body);
                self.queue.retain(|q| !gone.contains(&q.qid));
            }
            Record::Op(_) | Record::Checkpoint(_) => {}
        }
    }

    fn apply_meta(&mut self, meta: &MetaRecord) {
        let Slot::Inline(change) = &meta.change else { return };
        let hop = change.set.contains_key("routeFallbackIndex") && change.set.contains_key("routeFallbackFailures");
        let pick_held =
            hop && self.header.contains_key("pendingRoute") && !change.set.contains_key("pendingRoute") && !change.unset.iter().any(|u| u == "pendingRoute");
        if !pick_held
            && ["model", "provider", "effort", "pendingRoute"].iter().any(|k| change.set.contains_key(*k) || change.unset.iter().any(|u| u == k))
            && let Some(route) = self.sections.route.as_mut()
        {
            route.effort = None;
        }
        if hop && let Some(route) = self.sections.route.as_mut() {
            route.session_provider = None;
            route.session_model = None;
            route.provider = None;
            route.model = None;
            route.fast = None;
            route.fast_capable = None;
            route.auto_effort = None;
            route.model_parameters = None;
            route.selected_context_window = None;
            if !pick_held {
                route.effort_options = None;
            }
            route.turn_effort = None;
        }
        let header = Arc::make_mut(&mut self.header);
        for key in &change.unset {
            header.shift_remove(key);
        }
        for (key, value) in &change.set {
            header.insert(key.clone(), value.clone());
        }
        mixdog_store::header_patch::apply_patches(header, &change.patch);
        self.sections.title = title_of(&self.header);
    }

    fn apply_item(&mut self, item: &ItemRecord, display: &Display, ordinal: Option<u64>) {
        if let Some(turn) = item.turn.as_ref() {
            match (item.role.as_ref().map(|role| role.as_str()), self.runs.get_mut(turn.as_str())) {
                (Some("assistant"), Some(draft)) => draft.message_committed(),
                (Some("user"), Some(draft)) if draft.input.is_none() => draft.input = Some(item.iid.as_str().to_owned()),
                // A run's input row precedes its `run{started}`.
                (Some("user"), None) => self.next_input = Some((turn.as_str().to_owned(), item.iid.as_str().to_owned())),
                _ => {}
            }
        }
        if let Some(prompt) = item.prompt_text() {
            prompt_history::push_session(&mut self.prompt_session, prompt);
            self.remerge_prompts();
        }
        let mut messages = u32::from(item.model);
        if item.role.as_ref().is_some_and(|role| role.as_str() == "user")
            && (!item.visible || !matches!(display, Display::Items(shown) if shown.iter().any(|shown| matches!(shown, Shown::Item(_)))))
            && let Some(ordinal) = ordinal
        {
            self.hidden_prompt = Some((item.iid.as_str().to_owned(), ordinal));
        }
        let Display::Items(shown) = display else {
            if let Some(last) = self.window.back_mut() {
                last.messages += messages;
            }
            return;
        };
        if !shown.iter().any(|shown| matches!(shown, Shown::Item(_))) || !item.visible {
            if let Some(last) = self.window.back_mut() {
                last.messages += messages;
            }
            messages = 0;
        }
        for shown in shown {
            match shown {
                Shown::Item(new) => {
                    self.live.retain(|live| live.item.id() != new.id());
                    if !item.visible {
                        continue;
                    }
                    let row = WindowItem { ordinal, item: Arc::new(new.clone()), messages: std::mem::take(&mut messages) };
                    // A live-only row of the same item (the text settled before a tool call) becomes the record's row,
                    // where it was shown.
                    if let Some(shown) = self.window.iter_mut().find(|shown| shown.ordinal.is_none() && shown.item.id() == new.id()) {
                        *shown = row;
                        continue;
                    }
                    self.window.push_back(row);
                    self.trim_window();
                }
                Shown::Update(update) => self.merge(update),
            }
        }
    }

    fn apply_run(&mut self, run: &RunRecord) {
        match run.phase {
            RunPhase::Started => {
                let input = self.next_input.take().filter(|(rid, _)| rid == run.rid.as_str()).map(|(_, iid)| iid);
                self.runs.insert(run.rid.as_str().to_owned(), super::turn_draft::RunDraft { input, ..Default::default() });
                let runtime = self.sections.runtime.get_or_insert_with(ThreadRuntime::default);
                runtime.busy = true;
                if let Some(at) = run.at {
                    let turns = self.context().stats.as_ref().and_then(|stats| stats.get("turns")).and_then(Value::as_u64).unwrap_or(0);
                    let runtime = self.sections.runtime.get_or_insert_with(ThreadRuntime::default);
                    runtime.spinner = Some(super::spinner::started(turns, at));
                }
            }
            RunPhase::Attempt => {}
            RunPhase::Completed | RunPhase::Failed | RunPhase::Interrupted => {
                self.runs.remove(run.rid.as_str());
                self.live.retain(|live| live.turn.as_str() != run.rid.as_str());
                self.sections.runtime = self.sections.runtime.take().map(|held| ThreadRuntime {
                    toasts: held.toasts,
                    setup_changed: held.setup_changed,
                    command_busy: held.command_busy,
                    command_status: held.command_status,
                    ..Default::default()
                });
            }
        }
    }

    fn apply_queue(&mut self, queue: &QueueRecord, display: &Display) {
        match queue.action {
            QueueAction::Enqueue => {
                let entry = match &queue.entry {
                    Some(Slot::Inline(entry)) => entry.clone(),
                    _ => Value::Null,
                };
                let display = match display {
                    Display::Queued(row) => row.clone(),
                    _ => Value::Null,
                };
                self.queue.push(Queued { qid: queue.qid.as_str().to_owned(), entry, display });
            }
            QueueAction::Update => {
                if let (Some(queued), Some(Slot::Inline(entry))) = (self.queue.iter_mut().find(|q| q.qid == queue.qid.as_str()), &queue.entry) {
                    queued.entry = entry.clone();
                }
            }
            QueueAction::Prioritize => {
                if let (Some(at), Some(Slot::Inline(entry))) = (self.queue.iter().position(|q| q.qid == queue.qid.as_str()), &queue.entry) {
                    let mut queued = self.queue.remove(at);
                    queued.entry = entry.clone();
                    self.queue.insert(0, queued);
                }
            }
            QueueAction::Dequeue => self.queue.retain(|q| q.qid != queue.qid.as_str()),
        }
    }

    /// The boundary row follows its anchor's rows (and the anchor's earlier boundaries) while the anchor is in view; it lives and
    /// goes with the anchor's ordinal.
    fn apply_model_switch(&mut self, switch: &ModelSwitchRecord, display: &Display) {
        let Display::Items(shown) = display else { return };
        let anchor = Some(switch.anchor.ordinal);
        let Some(last) = self.window.iter().rposition(|row| row.ordinal == anchor) else { return };
        for (at, shown) in shown.iter().enumerate() {
            let Shown::Item(new) = shown else { continue };
            self.window.insert(last + 1 + at, WindowItem { ordinal: anchor, item: Arc::new(new.clone()), messages: 0 });
        }
        self.trim_window();
    }

    /// A live compaction shows its divider at the end of the window; it lives and goes with the `compacted` record's ordinal, as a
    /// restored one does.
    fn apply_compacted(&mut self, display: &Display, ordinal: Option<u64>) {
        let Display::Items(shown) = display else { return };
        for shown in shown {
            if let Shown::Item(new) = shown {
                self.window.push_back(WindowItem { ordinal, item: Arc::new(new.clone()), messages: 0 });
            }
        }
        self.trim_window();
    }
    fn apply_section(&mut self, section: Section) {
        let s = &mut self.sections;
        match section {
            // The queue is the session's own (Toasts): a producer's whole runtime section leaves it.
            Section::Runtime(mut value) => {
                let held = s.runtime.take().unwrap_or_default();
                value.toasts = held.toasts;
                // The running tools are the session's own too (`ActiveTools`).
                value.active_tool_summary = held.active_tool_summary;
                value.active_tools = held.active_tools;
                value.setup_changed = held.setup_changed;
                // A running command's status is the session's own too (`Command`).
                value.command_busy = held.command_busy;
                value.command_status = held.command_status;
                s.runtime = Some(value);
            }
            Section::SetupChanged(change) => s.runtime.get_or_insert_with(ThreadRuntime::default).setup_changed = Some(change),
            Section::ActiveTools(active) => {
                let runtime = s.runtime.get_or_insert_with(ThreadRuntime::default);
                let (summary, tools) = active.unzip();
                runtime.active_tool_summary = summary;
                runtime.active_tools = tools;
            }
            Section::Toasts(toasts) => s.runtime.get_or_insert_with(ThreadRuntime::default).toasts = toasts,
            Section::ProgressHint(hint) => s.runtime.get_or_insert_with(ThreadRuntime::default).progress_hint = hint,
            Section::Command(status) => {
                let runtime = s.runtime.get_or_insert_with(ThreadRuntime::default);
                runtime.command_busy = status.is_some();
                runtime.command_status = status;
            }
            Section::Spinner(fields) => {
                if let Some(Value::Object(spinner)) = s.runtime.as_mut().and_then(|runtime| runtime.spinner.as_mut()) {
                    spinner.extend(fields);
                    // The retry fields live as long as the `reconnecting` mode: whichever phase sets another mode ends them.
                    super::spinner::end_retry(spinner);
                }
            }
            // `turn-quiet.mjs`: no spinner (the turn has ended) takes no quiet state.
            Section::SpinnerQuiet(quiet) => {
                if let Some(Value::Object(spinner)) = s.runtime.as_mut().and_then(|runtime| runtime.spinner.as_mut()) {
                    spinner.insert("quiet".into(), quiet.unwrap_or(Value::Null));
                }
            }
            Section::Route(value) => s.route = Some(merge_route(s.route.take().unwrap_or_default(), value)),
            Section::TurnEffort(effort) => s.route.get_or_insert_with(ThreadRoute::default).turn_effort = effort,
            Section::Context(value) => s.context = Some(merge_context(s.context.take().unwrap_or_default(), value)),
            Section::Todo(value) => s.todo = value,
            Section::Goal(value) => s.goal = value,
            Section::QuotaResume(value) => s.quota_resume = value,
            Section::Agents(value) => s.agents = Some(value),
            Section::ShellJobs(value) => s.shell_jobs = Some(value),
            Section::Workspace(value) => s.workspace = value,
            // The decision result is the actor's; a producer of `handoffQuestions` publishes only those.
            Section::Approvals(mut value) => {
                let kept = s.approvals.take().and_then(|held| held.tool_approval_result);
                value.tool_approval_result = value.tool_approval_result.or(kept);
                s.approvals = Some(value);
            }
            Section::PromptRestore(value) => s.prompt_restore = value,
            Section::ProviderAccount(value) => s.provider_account_change = Some(value),
            Section::Remote(value) => s.remote_enabled = Some(value),
            Section::SetupUiRequest(value) => s.setup_ui_request = value,
            Section::RoomView(value) => s.room_view = value,
        }
    }

    /// The queued prompts the composer shows; a queued completion is runtime input, not one, nor is a kickoff put back by a stop
    /// (`isMeta`, `isQueuedEntryVisible`, queue-helpers.mjs).
    pub fn queued_rows(&self) -> Vec<Value> {
        self.queue
            .iter()
            .filter(|q| !super::completions::is_notification(&q.entry))
            .filter(|q| q.entry.pointer("/options/kickoff") != Some(&Value::Bool(true)))
            .map(|q| q.display.clone())
            .collect()
    }

    /// The route section as clients hold it: the session's route (`baseRouteState`) under what producers published.
    pub fn route(&self) -> ThreadRoute {
        let header_text = |key: &str| self.header.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
        // A pick held for the next turn (`pendingRoute`) is the runtime's route already (Node's `getRoute()`): the state shows its
        // provider, model and effort while the session still runs on its own (`sessionProvider` / `sessionModel`).
        let held_text = |key: &str| self.held_pick().and_then(|pick| pick.get(key)).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
        let selected = self.held_pick().unwrap_or(&self.header);
        // `runtime.fast`, `runtime.modelParameters || {}` and the selected window: the selected route's, as its provider and model are.
        let model_parameters = selected.get("modelParameters").and_then(|parameters| serde_json::from_value(parameters.clone()).ok()).unwrap_or_default();
        let selected_window = selected.get("selectedContextWindow").and_then(Value::as_f64).filter(|n| n.is_finite() && *n > 0.0).map(|n| n as i64);
        let initial = ThreadRoute {
            session_provider: header_text("provider"),
            session_model: header_text("model"),
            fast: Some(selected.get("fast") == Some(&Value::Bool(true))),
            fast_capable: Some(false),
            auto_effort: Some(selected.get("autoEffort") != Some(&Value::Bool(false))),
            model_parameters: Some(model_parameters),
            selected_context_window: selected_window,
            effort: mixdog_core_ports::ports::route::facade_effort(selected).and_then(Value::as_str).map(str::to_owned),
            provider: held_text("provider").or_else(|| header_text("provider")),
            model: held_text("model").or_else(|| header_text("model")),
            effort_options: Some(Vec::new()),
            cwd: header_text("cwd"),
            session_forked_from: header_text("forkedFrom"),
            ..Default::default()
        };
        merge_route(initial, self.sections.route.clone().unwrap_or_default())
    }

    /// The context section as clients hold it: the engine's initial figures (initial-state.mjs: display window and compaction limit 0, no window,
    /// stats of a session that has made no call) under what producers published.
    pub fn context(&self) -> ThreadContext {
        let header_number = |key: &str| self.header.get(key).and_then(Value::as_f64).filter(|n| n.is_finite() && *n > 0.0).map(|n| n as i64);
        let selected = self.held_pick().unwrap_or(&self.header);
        let positive = |value: Option<&Value>| value.and_then(Value::as_f64).filter(|n| n.is_finite() && *n > 0.0);
        // `state.route?.contextPercent ?? state.session?.contextPercent ?? null` (runtime-facade.mjs): a held pick that states
        // no percent shows the session's.
        fn stated(source: &serde_json::Map<String, Value>) -> Option<&Value> {
            source.get("contextPercent").filter(|percent| !percent.is_null())
        }
        let percent = self.held_pick().and_then(stated).or_else(|| stated(&self.header));
        let initial = ThreadContext {
            // The display window and the compaction limits Node fills on its first status pass (`syncContextDisplayFields`) are the
            // session's seated route figures its header records: the core shows the settled values from the start.
            display_context_window: Some(header_number("contextWindow").unwrap_or(0)),
            auto_compact_token_limit: Some(header_number("autoCompactTokenLimit").unwrap_or(0)),
            compact_boundary_tokens: Some(header_number("compactBoundaryTokens").unwrap_or(0)),
            context_percent: positive(percent),
            // `state.route ? state.route.contextTokens || null : ...`: the exact window is the selected route's alone (a held
            // pick's once one is held, else the seated route's), never the session's under a pick.
            context_tokens: positive(selected.get("contextTokens")).map(|n| n as i64),
            // `runtime.contextWindow` (baseRouteState), the session's window as its header holds it: Node publishes it on the first
            // status pass, the core holds it from the start.
            context_window: header_number("contextWindow"),
            raw_context_window: header_number("rawContextWindow"),
            effective_context_window_percent: header_number("effectiveContextWindowPercent"),
            stats: Some(super::stats::SessionStats::opened(self.header.get("usageReadout")).json(0)),
            ..Default::default()
        };
        merge_context(initial, self.sections.context.clone().unwrap_or_default())
    }

    /// The route pick held for the next turn (`pendingRoute`, Node's `heldRoutePick`).
    fn held_pick(&self) -> Option<&serde_json::Map<String, Value>> {
        self.header.get("pendingRoute").and_then(Value::as_object)
    }

    /// The workflow section as clients hold it (`routeState`, `tui/session/context-state.mjs`), read from the header the
    /// switches write: the session's workflow meta (`toSessionWorkflowMeta`: `id`, `name`, `description`, `source`,
    /// `delegatesAgents`) and orchestration mode (`sessionOrchestrationMode`: a record with none derives it from its
    /// workflow). A choice made while a turn runs shows at once, marked pending until the next turn start applies it
    /// (`getOrchestrationMode`: `pendingOrchestrationMode ??` the session's; `currentWorkflow` of `boot/facade.mjs` resolves the
    /// staged workflow, whose meta the header keeps beside its id).
    pub fn workflow(&self) -> ThreadWorkflow {
        let staged_workflow = self.header.get("pendingWorkflowId");
        let staged_mode = self.header.get("pendingOrchestrationMode");
        let staged_meta = self.header.get("pendingWorkflow").filter(|meta| staged_workflow.is_some_and(|id| meta.get("id") == Some(id)));
        let mode = staged_mode.cloned().unwrap_or_else(|| Value::String(super::thread_switches::current_mode(&self.header)));
        ThreadWorkflow {
            workflow: staged_meta.or_else(|| self.header.get("workflow").filter(|workflow| workflow.is_object())).cloned(),
            orchestration_mode: Some(serde_json::from_value(mode).unwrap_or(OrchestrationMode::Balanced)),
            pending_workflow_switch: Some(staged_workflow.is_some()),
            pending_orchestration_mode_switch: Some(staged_mode.is_some()),
        }
    }

    /// The `ThreadState` the view and snapshots show.
    pub fn thread_state(&self, storage: StorageState) -> ThreadState {
        let mut state = self.sections.clone();
        // Sections no producer has published yet hold the engine's initial values (`initial-state.mjs`,
        // `baseRouteState`): the session's route, an idle composer, no agents, no approval result.
        state.route = Some(self.route());
        state.workflow = Some(self.workflow());
        state.runtime = Some(self.runtime(StorageState::Ok));
        state.context = Some(self.context());
        state.agents.get_or_insert_with(Default::default);
        state.approvals.get_or_insert_with(Default::default);
        state.queued = Some(self.queued_rows());
        state.prompt_history_list = Some(self.prompt_history.to_vec());
        if storage != StorageState::Ok {
            state.runtime.get_or_insert_with(ThreadRuntime::default).storage = Some(storage);
        }
        state
    }

    /// The runtime section as published (`storage` only when not `ok`).
    pub fn runtime(&self, storage: StorageState) -> ThreadRuntime {
        let mut runtime = self.sections.runtime.clone().unwrap_or_default();
        runtime.storage = (storage != StorageState::Ok).then_some(storage);
        // A retrying spinner shows the wait left now, from the deadline the state retains.
        if let Some(spinner) = runtime.spinner.as_mut() {
            super::spinner::project_retry(spinner, super::spinner::core_now_ms());
        }
        // Node's runtime.clientHostPid: this process hosts the session runtime.
        runtime.client_host_pid = Some(std::process::id());
        // Node's runtime.toolMode: the thread's tool mode (`thread/setToolMode` keeps it in the header).
        runtime.tool_mode = Some(self.header.get("toolMode").and_then(Value::as_str).filter(|mode| !mode.is_empty()).unwrap_or("full").to_owned());
        runtime
    }
}
