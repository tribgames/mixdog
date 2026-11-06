//! The session state and its one fold. The same [`SessionState::apply`] builds the state of an
//! opened log (checkpoint + tail), the projected state (applied when work is accepted, used to
//! validate later work) and the acked state (applied when work is released at its ack, the
//! source of the view and the feed). Projected and acked differ only by the unacked suffix, so
//! a barrier failure resets projected to a clone of acked (RL §6.1).

use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::sync::Arc;

use mixdog_app_protocol::v2::thread::ThreadAgents;
use mixdog_app_protocol::v2::thread::ThreadApprovals;
use mixdog_app_protocol::v2::thread::ThreadContext;
use mixdog_app_protocol::v2::thread::ThreadRoute;
use mixdog_app_protocol::v2::thread::ThreadRuntime;
use mixdog_app_protocol::v2::thread::ThreadState;
use mixdog_app_protocol::v2::thread::ThreadWorkflow;
use mixdog_app_protocol::v2::thread::PromptRestore;
use mixdog_app_protocol::v2::thread::ProviderAccountChange;
use mixdog_app_protocol::v2::thread::StorageState;
use mixdog_core_api::ids::ItemId;
use mixdog_core_api::ids::TurnId;
use mixdog_protocol::ApprovalResolution;
use mixdog_protocol::MaybeBlob;
use mixdog_protocol::QuotaResume;
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

/// One typed section of the thread projection, set by its producer (the run, or the domain
/// that owns the value) and published in order on the thread feed (P §5.1). Sections are view
/// state: a producer that needs a value to survive a reload also writes it to the header.
#[derive(Clone, Debug, PartialEq)]
pub enum Section {
    Runtime(ThreadRuntime),
    Route(ThreadRoute),
    Context(ThreadContext),
    Todo(Option<Value>),
    Goal(Option<Value>),
    QuotaResume(Option<QuotaResume>),
    Agents(ThreadAgents),
    ShellJobs(Value),
    Workflow(ThreadWorkflow),
    Workspace(Option<Value>),
    /// `handoffQuestions`, and `toolApprovalResult` when the producer clears it.
    Approvals(ThreadApprovals),
    PromptRestore(Option<PromptRestore>),
    ProviderAccount(ProviderAccountChange),
    Remote(bool),
}

/// What a record shows besides itself.
#[derive(Clone, Debug)]
pub(crate) enum Display {
    None,
    /// The display items of an `item`/`amend` record.
    Items(Vec<Shown>),
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

#[derive(Clone, Debug)]
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
            Change::Delta { item, text } => {
                if let Some(live) = self.live.iter_mut().find(|live| live.item.id() == item)
                    && let ThreadItem::AgentMessage {
                        text: MaybeBlob::Inline(body),
                        ..
                    } = &mut live.item
                {
                    body.push_str(text);
                }
            }
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
                        self.header.remove(key);
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
                QueueAction::Dequeue => self.queue.retain(|q| q.qid != queue.qid.as_str()),
            },
            Record::Compacted(_) | Record::Op(_) | Record::Checkpoint(_) => {}
        }
    }

    fn apply_section(&mut self, section: Section) {
        let s = &mut self.sections;
        match section {
            Section::Runtime(value) => s.runtime = Some(value),
            Section::Route(value) => s.route = Some(value),
            Section::Context(value) => s.context = Some(value),
            Section::Todo(value) => s.todo = value,
            Section::Goal(value) => s.goal = value,
            Section::QuotaResume(value) => s.quota_resume = value,
            Section::Agents(value) => s.agents = Some(value),
            Section::ShellJobs(value) => s.shell_jobs = Some(value),
            Section::Workflow(value) => s.workflow = Some(value),
            Section::Workspace(value) => s.workspace = value,
            Section::Approvals(value) => s.approvals = Some(value),
            Section::PromptRestore(value) => s.prompt_restore = value,
            Section::ProviderAccount(value) => s.provider_account_change = Some(value),
            Section::Remote(value) => s.remote_enabled = Some(value),
        }
    }

    /// The `ThreadState` the view and snapshots show.
    pub fn thread_state(&self, storage: StorageState) -> ThreadState {
        let mut state = self.sections.clone();
        state.queued = Some(self.queue.iter().map(|q| q.display.clone()).collect());
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
