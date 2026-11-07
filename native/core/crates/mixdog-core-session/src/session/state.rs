//! The session state and its one fold. The same [`SessionState::apply`] builds the state of an
//! opened log (checkpoint + tail), the projected state (applied when work is accepted, used to
//! validate later work) and the acked state (applied when work is released at its ack, the
//! source of the view and the feed). Projected and acked differ only by the unacked suffix, so
//! a barrier failure resets projected to a clone of acked (RL §6.1).

use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::sync::Arc;

use mixdog_app_protocol::v2::thread::ThreadRoute;
use mixdog_app_protocol::v2::thread::ThreadRuntime;
use mixdog_app_protocol::v2::thread::ThreadState;
use mixdog_app_protocol::v2::thread::StorageState;
use mixdog_core_api::ids::ItemId;
use mixdog_core_ports::ports::threads::Section;
use mixdog_core_api::ids::TurnId;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::MaybeBlob;
use mixdog_protocol::ThreadItem;
use mixdog_protocol::ToolApprovalResult;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::record::ApprovalPhase;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::QueueAction;
use mixdog_store::schema::record::Record;
use mixdog_store::schema::record::RunPhase;
use serde_json::Value;

use super::prompt_history;
use super::seams::Shown;
use super::seams::merge_update;

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
    Record { record: Arc<Record>, display: Display },
    Section(Section),
    /// `item/started`: an in-progress item (not persisted; deltas extend it).
    ItemStarted { turn: TurnId, item: ThreadItem },
    /// An `item/agentMessage/delta` (not persisted).
    Delta { item: ItemId, text: String },
    /// The session part of the prompt history, recomputed over the remaining lineage after a
    /// history mutation. `publish: false` (rewind) keeps the published list: today's rewind
    /// only drops the restored prompt from it (`replaceItems(.., {preserveSpill})`), and the
    /// next merge sees the remaining rows.
    PromptSession { session: Vec<String>, publish: bool },
    /// The persisted prompt history of the thread's cwd (oldest → newest).
    PromptPersisted(Vec<String>),
    /// A prompt handed back to the composer leaves the published list.
    PromptWithout(String),
    /// No change: its effects run once every earlier record is durable.
    Barrier,
    /// A live completion card (not persisted): a new item at the end of the view, or the item
    /// with its id replaced.
    Card(ThreadItem),
    /// A run's live-only row (not persisted): before the row `before` when it is in view,
    /// else at the end.
    Shown { item: ThreadItem, before: Option<ItemId> },
}

#[derive(Clone, Debug)]
pub(crate) struct WindowItem {
    /// `None` until the record is acked (projected state only).
    pub ordinal: Option<u64>,
    pub item: Arc<ThreadItem>,
    /// The record's `prompt` fact: the text a rewind to this row hands back.
    pub prompt: Option<String>,
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

#[derive(Clone, Debug)]
pub(crate) struct PendingApprovalRow {
    pub rid: String,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct SessionState {
    pub header: Header,
    pub history_rev: u64,
    pub lineage_start: u64,
    /// Runs started without a terminal phase.
    pub runs: BTreeMap<String, ()>,
    pub approvals: BTreeMap<String, PendingApprovalRow>,
    pub queue: Vec<Queued>,
    pub window: VecDeque<WindowItem>,
    pub has_older: bool,
    pub live: Vec<LiveItem>,
    pub sections: ThreadState,
    pub view_items: usize,
    /// Prompt history (`prompt_history`): session part, persisted part, published list.
    pub prompt_session: Vec<String>,
    pub prompt_persisted: Vec<String>,
    pub prompt_history: Vec<String>,
}

impl SessionState {
    pub fn new(view_items: usize) -> Self {
        Self {
            view_items,
            ..Self::default()
        }
    }

    /// A shown row of no record of its own (a restored compaction divider and its boundaries),
    /// at the end of the window; it lives and goes with `ordinal` (the `compacted` frame's).
    pub fn push_shown(&mut self, ordinal: u64, item: ThreadItem) {
        self.window.push_back(WindowItem { ordinal: Some(ordinal), item: Arc::new(item), prompt: None });
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
                self.live.push(LiveItem {
                    turn: turn.clone(),
                    item: item.clone(),
                });
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
                self.prompt_history = prompt_history::without(&self.prompt_history, text);
            }
            Change::Barrier => {}
            Change::Shown { item, before } => {
                // A live item shown complete (a finished `Reasoning` item) becomes its row.
                self.live.retain(|live| live.item.id() != item.id());
                let at = before
                    .as_ref()
                    .and_then(|before| self.window.iter().position(|row| row.item.id() == before))
                    .unwrap_or(self.window.len());
                self.window.insert(at, WindowItem { ordinal: None, item: Arc::new(item.clone()), prompt: None });
                while self.window.len() > self.view_items {
                    self.window.pop_front();
                    self.has_older = true;
                }
            }
            Change::Card(card) => {
                if let Some(row) = self.window.iter_mut().find(|row| row.item.id() == card.id()) {
                    row.item = Arc::new(card.clone());
                } else {
                    self.window.push_back(WindowItem { ordinal: None, item: Arc::new(card.clone()), prompt: None });
                    while self.window.len() > self.view_items {
                        self.window.pop_front();
                        self.has_older = true;
                    }
                }
            }
        }
    }

    /// Applies an update to the item in view with its id (`merge_update`).
    fn merge(&mut self, update: &ThreadItem) {
        if let Some(row) = self
            .window
            .iter_mut()
            .find(|row| row.item.id() == update.id())
        {
            row.item = Arc::new(merge_update(&row.item, update));
        }
    }

    /// The item in view with `id`.
    pub fn shown(&self, id: &ItemId) -> Option<Arc<ThreadItem>> {
        self.window
            .iter()
            .find(|row| row.item.id() == id)
            .map(|row| row.item.clone())
    }

    fn remerge_prompts(&mut self) {
        self.prompt_history = prompt_history::merge(&self.prompt_session, &self.prompt_persisted);
    }

    fn apply_record(&mut self, record: &Record, display: &Display, ordinal: Option<u64>) {
        match record {
            Record::Session(session) => {
                if let Slot::Inline(header) = &session.header {
                    self.header = header.clone();
                }
                if let Some(ordinal) = ordinal {
                    self.lineage_start = ordinal + 1;
                }
                self.sections.title = title_of(&self.header);
            }
            Record::Meta(meta) => {
                if let Slot::Inline(change) = &meta.change {
                    for key in &change.unset {
                        self.header.shift_remove(key);
                    }
                    for (key, value) in &change.set {
                        self.header.insert(key.clone(), value.clone());
                    }
                    self.sections.title = title_of(&self.header);
                }
            }
            Record::Item(item) => {
                if let Some(prompt) = item.prompt_text() {
                    prompt_history::push_session(&mut self.prompt_session, prompt);
                    self.remerge_prompts();
                }
                let Display::Items(shown) = display else {
                    return;
                };
                for shown in shown {
                    match shown {
                        Shown::Item(new) => {
                            self.live.retain(|live| live.item.id() != new.id());
                            if !item.visible {
                                continue;
                            }
                            // The prompt fact belongs to the row's user item, its first.
                            let prompt = matches!(new, ThreadItem::UserMessage { .. })
                                .then(|| item.prompt_text().map(str::to_owned))
                                .flatten();
                            self.window.push_back(WindowItem {
                                ordinal,
                                item: Arc::new(new.clone()),
                                prompt,
                            });
                            while self.window.len() > self.view_items {
                                self.window.pop_front();
                                self.has_older = true;
                            }
                        }
                        Shown::Update(update) => self.merge(update),
                    }
                }
            }
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
                // Rows still unacked follow every acked row, so they are behind `to_ordinal`.
                self.window
                    .retain(|row| row.ordinal.is_some_and(|o| o < rewind.to_ordinal));
            }
            Record::Run(run) => match run.phase {
                RunPhase::Started => {
                    self.runs.insert(run.rid.as_str().to_owned(), ());
                }
                RunPhase::Attempt => {}
                RunPhase::Completed | RunPhase::Failed | RunPhase::Interrupted => {
                    self.runs.remove(run.rid.as_str());
                    self.live.retain(|live| live.turn.as_str() != run.rid.as_str());
                    // Runtime hints belong to the run that set them.
                    self.sections.runtime = None;
                }
            },
            Record::Approval(approval) => match approval.phase {
                ApprovalPhase::Requested => {
                    self.approvals.insert(
                        approval.aid.as_str().to_owned(),
                        PendingApprovalRow {
                            rid: approval.rid.as_str().to_owned(),
                        },
                    );
                }
                ApprovalPhase::Decided | ApprovalPhase::Expired => {
                    self.approvals.remove(approval.aid.as_str());
                    if let Some(Slot::Inline(body)) = &approval.body
                        && let Ok(resolution) =
                            serde_json::from_value::<ApprovalResolution>(body.clone())
                    {
                        let approvals = self.sections.approvals.get_or_insert_with(Default::default);
                        approvals.tool_approval_result =
                            Some(approval_result(approval.aid.as_str(), &resolution));
                    }
                }
            },
            Record::Queue(queue) => match queue.action {
                QueueAction::Enqueue => {
                    let entry = match &queue.entry {
                        Some(Slot::Inline(entry)) => entry.clone(),
                        _ => Value::Null,
                    };
                    let display = match display {
                        Display::Queued(row) => row.clone(),
                        _ => Value::Null,
                    };
                    self.queue.push(Queued {
                        qid: queue.qid.as_str().to_owned(),
                        entry,
                        display,
                    });
                }
                QueueAction::Update => {
                    if let (Some(queued), Some(Slot::Inline(entry))) =
                        (self.queue.iter_mut().find(|q| q.qid == queue.qid.as_str()), &queue.entry)
                    {
                        queued.entry = entry.clone();
                    }
                }
                QueueAction::Dequeue => self.queue.retain(|q| q.qid != queue.qid.as_str()),
            },
            // The boundary row follows its anchor's rows (and the anchor's earlier boundaries)
            // while the anchor is in view; it lives and goes with the anchor's ordinal.
            Record::ModelSwitch(switch) => {
                let Display::Items(shown) = display else {
                    return;
                };
                let anchor = Some(switch.anchor.ordinal);
                let Some(last) = self.window.iter().rposition(|row| row.ordinal == anchor) else {
                    return;
                };
                for (at, shown) in shown.iter().enumerate() {
                    let Shown::Item(new) = shown else { continue };
                    self.window.insert(last + 1 + at, WindowItem { ordinal: anchor, item: Arc::new(new.clone()), prompt: None });
                }
                while self.window.len() > self.view_items {
                    self.window.pop_front();
                    self.has_older = true;
                }
            }
            // A live compaction shows its divider at the end of the window; it lives and goes
            // with the `compacted` record's ordinal, as a restored one does.
            Record::Compacted(_) => {
                let Display::Items(shown) = display else {
                    return;
                };
                for shown in shown {
                    if let Shown::Item(new) = shown {
                        self.window.push_back(WindowItem { ordinal, item: Arc::new(new.clone()), prompt: None });
                    }
                }
                while self.window.len() > self.view_items {
                    self.window.pop_front();
                    self.has_older = true;
                }
            }
            Record::Op(_) | Record::Checkpoint(_) => {}
        }
    }

    fn apply_section(&mut self, section: Section) {
        let s = &mut self.sections;
        match section {
            Section::Runtime(value) => s.runtime = Some(value),
            Section::ProgressHint(hint) => s.runtime.get_or_insert_with(ThreadRuntime::default).progress_hint = hint,
            Section::Route(value) => s.route = Some(value),
            Section::Context(value) => s.context = Some(value),
            Section::Todo(value) => s.todo = value,
            Section::Goal(value) => s.goal = value,
            Section::QuotaResume(value) => s.quota_resume = value,
            Section::Agents(value) => s.agents = Some(value),
            Section::ShellJobs(value) => s.shell_jobs = Some(value),
            Section::Workflow(value) => s.workflow = Some(value),
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

    /// The queued prompts the composer shows; a queued completion is runtime input, not one.
    pub fn queued_rows(&self) -> Vec<Value> {
        self.queue
            .iter()
            .filter(|q| !super::completions::is_notification(&q.entry))
            .map(|q| q.display.clone())
            .collect()
    }

    /// The `ThreadState` the view and snapshots show.
    pub fn thread_state(&self, storage: StorageState) -> ThreadState {
        let mut state = self.sections.clone();
        // Sections no producer has published yet hold the engine's initial values (`initial-state.mjs`,
        // `baseRouteState`): the session's route, an idle composer, no agents, no approval result.
        let header_text = |key: &str| self.header.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
        state.route.get_or_insert_with(|| ThreadRoute {
            session_provider: header_text("provider"),
            session_model: header_text("model"),
            fast: Some(false),
            fast_capable: Some(false),
            auto_effort: Some(true),
            model_parameters: Some(Default::default()),
            ..Default::default()
        });
        state.runtime.get_or_insert_with(Default::default);
        state.context.get_or_insert_with(Default::default);
        state.agents.get_or_insert_with(Default::default);
        state.approvals.get_or_insert_with(Default::default);
        state.queued = Some(self.queued_rows());
        state.prompt_history_list = Some(self.prompt_history.clone());
        if storage != StorageState::Ok {
            state
                .runtime
                .get_or_insert_with(ThreadRuntime::default)
                .storage = Some(storage);
        }
        state
    }

    /// The runtime section as published (`storage` only when not `ok`).
    pub fn runtime(&self, storage: StorageState) -> ThreadRuntime {
        let mut runtime = self.sections.runtime.clone().unwrap_or_default();
        runtime.storage = (storage != StorageState::Ok).then_some(storage);
        runtime
    }
}

fn title_of(header: &Header) -> Option<String> {
    header
        .get("title")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// Today's `toolApprovalResult` for a resolution.
pub(crate) fn approval_result(aid: &str, resolution: &ApprovalResolution) -> ToolApprovalResult {
    let mut result = ToolApprovalResult {
        id: aid.to_owned(),
        approved: false,
        device: String::new(),
        at: 0,
        expired: None,
        withdrawn: None,
        interrupted: None,
    };
    match resolution {
        ApprovalResolution::Decided {
            decision,
            device,
            at,
            ..
        } => {
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

    /// A hint is the runtime section's `progressHint` only: publishing one must not reset what else
    /// the section holds (the whole-section `Runtime` replaces it).
    #[test]
    fn a_progress_hint_changes_only_the_hint_of_the_runtime_section() {
        let mut state = SessionState::new(10);
        let held = ThreadRuntime { busy: true, command_busy: true, spinner: Some(json!("working")), ..ThreadRuntime::default() };
        state.apply(&Change::Section(Section::Runtime(held.clone())), None);

        state.apply(&Change::Section(Section::ProgressHint(Some(json!({ "text": "downloading" })))), None);
        let shown = state.sections.runtime.clone().unwrap();
        assert_eq!(shown, ThreadRuntime { progress_hint: Some(json!({ "text": "downloading" })), ..held.clone() });

        state.apply(&Change::Section(Section::ProgressHint(None)), None);
        assert_eq!(state.sections.runtime, Some(held));
    }
}