//! LLM session titles: `createSessionTitleController` (`runtime-core/session-title.mjs`) and
//! `updateSessionGeneratedTitle` (`session/manager/session-crud.mjs`).
//!
//! A greeting titles a session at once; any other first prompt is titled by the title model
//! beside the turn, and the first three completed exchanges title it once more after the third.
//! The model, the promotion and the log are seams: the host supplies the title completion
//! (`run_host::title_completion`), [`StoredTitles`] reads and writes the stored session.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use futures::future::BoxFuture;
use mixdog_agent::env::Clock;
use mixdog_core_goal::goal::session_title::{SESSION_TITLE_TIMEOUT_MS, compact_session_title, meaningful};
use mixdog_core_ports::ports::memory_source::ThreadMessages;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_js::{JsRegex, js_trim, utf16_len};
use mixdog_rt::{CancellationToken, TaskClass};
use mixdog_store::session_text::{is_session_preview_noise, session_message_text};
use mixdog_store::title::clean_session_preview;
use serde_json::{Map, Value, json};

use mixdog_core_api::ids::ThreadId;
use mixdog_tools::orch::util::PortError;

/// `attemptLimit` default: the sessions each stage remembers having tried.
const ATTEMPT_LIMIT: usize = 2048;

static THINK: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<think>[\s\S]*?</think>\s*", "gi"));
static SPACES: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\s+", "g"));
static NOT_WORD: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[^\p{L}\p{N}]+", "gu"));

/// The attachment envelopes of `session-fallback-title.mjs`: payloads, not prose.
const ATTACHMENT_TAGS: [&str; 6] = ["file", "attachment", "document", "image", "video", "pdf"];

static ATTACHMENT_BLOCK: LazyLock<regex::Regex> = LazyLock::new(|| {
    // One branch per tag stands for the source's `<(tag)\b[^>]*>[\s\S]*?<\/\1\s*>` backreference.
    let branches: Vec<String> = ATTACHMENT_TAGS.iter().map(|tag| format!(r"<{tag}\b[^>]*>.*?</{tag}\s*>")).collect();
    regex::Regex::new(&format!("(?is){}", branches.join("|"))).expect("attachment block pattern")
});
static ATTACHMENT_SELF_CLOSING: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(&format!(r"(?i)<(?:{})\b[^>]*/>", ATTACHMENT_TAGS.join("|"))).expect("self-closing pattern"));
static ATTACHMENT_UNTERMINATED: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(&format!(r"(?is)<(?:{})\b[^>]*>.*$", ATTACHMENT_TAGS.join("|"))).expect("unterminated pattern"));
static MEDIA_MARKER: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)\[(?:Image|Video|File)(?:\s*#?\d+)?(?::[^\]\r\n]*)?\]").expect("media marker pattern"));
static MEDIA_PLACEHOLDER: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)^\[(?:image|video|file)\]$").expect("media placeholder pattern"));
static UNTITLED_PLACEHOLDER: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)^untitled(?:\s+session)?$").expect("untitled pattern"));
static REFERENCE_FILES: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"(?i)^\s*reference files:").expect("reference files pattern"));

/// JavaScript truthiness of a stored value: `null`, `false`, `""`, `0` and `-0` are falsy; anything else is truthy.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `isUsableTitle` (`session-fallback-title.mjs`).
fn is_usable_title(title: &str) -> bool {
    let text = js_trim(title);
    !text.is_empty() && !UNTITLED_PLACEHOLDER.is_match(text)
}

/// `fallbackTitleFromText(content)`: a bounded single-line title from user-authored text; empty when
/// nothing is usable.
fn fallback_title_from_text(content: &Value) -> String {
    let raw = session_message_text(content);
    if raw.is_empty() || REFERENCE_FILES.is_match(&raw) {
        return String::new();
    }
    let prose = ATTACHMENT_BLOCK.replace_all(&raw, " ");
    let prose = ATTACHMENT_SELF_CLOSING.replace_all(&prose, " ");
    let prose = ATTACHMENT_UNTERMINATED.replace(&prose, " ");
    let prose = MEDIA_MARKER.replace_all(&prose, " ");
    if is_session_preview_noise(&prose) {
        return String::new();
    }
    let title = compact_session_title(&clean_session_preview(&prose, 4_000));
    if is_usable_title(&title) && !MEDIA_PLACEHOLDER.is_match(&title) { title } else { String::new() }
}

/// `isHumanAuthoredTurn`: a turn the human typed. Provenance lives in `meta` (`source` of an injected goal,
/// notification or compaction turn, `synthetic`), never on the message root.
fn is_human_authored_turn(message: &Value) -> bool {
    if message.get("role").and_then(Value::as_str) != Some("user")
        || message.get("internal") == Some(&Value::Bool(true))
        || message.get("synthetic") == Some(&Value::Bool(true))
    {
        return false;
    }
    if let Some(meta @ (Value::Object(_) | Value::Array(_))) = message.get("meta") {
        if meta.get("synthetic") == Some(&Value::Bool(true)) {
            return false;
        }
        // `IMPORTED_MESSAGE_SOURCE`: an imported turn was typed by a human elsewhere.
        if meta.get("source").is_some_and(|source| js_truthy(source) && source.as_str() != Some("import")) {
            return false;
        }
    }
    mixdog_store::user_message_kind::is_actual_user_instruction_message(message)
}

/// `backfillFallbackSessionTitle(session, [...history, this prompt])` (`precommitUserTurn`): the header change
/// that names a titleless session from the earliest human turn in its history, else from this turn's prompt
/// (`prompt` is `None` for a runtime-injected turn, which never names it). `None` when the session already has a
/// usable title, a locked or generated one, or nothing in the transcript is usable.
pub fn fallback_title_change(
    header: &Map<String, Value>,
    history: &[Value],
    prompt: Option<&Value>,
    now: i64,
) -> Option<mixdog_store::schema::record::HeaderChange> {
    // `isUsableTitle(session.title)`: `String(title || '')`, so a stored number is its text.
    if header.get("title").is_some_and(|title| js_truthy(title) && is_usable_title(&mixdog_js::value_to_string(title))) {
        return None;
    }
    if header.get("titleLocked") == Some(&Value::Bool(true)) || header.get("generatedTitleStage").is_some_and(js_truthy) {
        return None;
    }
    let title = history
        .iter()
        .chain(prompt)
        .filter(|message| is_human_authored_turn(message))
        .map(|message| fallback_title_from_text(message.get("content").unwrap_or(&Value::Null)))
        .find(|title| !title.is_empty())?;
    let mut set = Map::new();
    set.insert("title".to_owned(), json!(title));
    set.insert("titleUpdatedAt".to_owned(), json!(now));
    Some(mixdog_store::schema::record::HeaderChange { set, unset: Vec::new(), patch: Default::default() })
}

/// Why a title could not be made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TitleError {
    /// `MAINTENANCE_ROUTE_UNRESOLVED`: no title route is configured, so model titles are off.
    RouteUnresolved,
    /// Any other failure, as the text Node logs (`error.stack`).
    Failed(String),
}

/// `generateSessionTitle(source, { sessionId, signal, locale })`.
#[async_trait]
pub trait TitleModel: Send + Sync {
    /// Whether a title route is configured now: a model with none is not asked, nor is anything read for it.
    fn routed(&self) -> bool {
        true
    }

    async fn generate(&self, source: &str, session_id: &str, locale: &str, cancel: &CancellationToken) -> Result<String, TitleError>;
}

/// `promoteGeneratedTitle(sessionId, title, stage)`: `true` when the session took the title.
#[async_trait]
pub trait TitlePromote: Send + Sync {
    async fn promote(&self, session_id: &str, title: &str, stage: &str) -> Result<bool, String>;
}

/// The `llm-title` diagnostics, one line without its `[mixdog] llm-title ` prefix.
pub trait TitleLog: Send + Sync {
    fn line(&self, line: &str);
}

/// [`TitleLog`] over a line sink (the core's log), each line under the `[mixdog] llm-title ` prefix.
pub struct LineTitleLog(pub Arc<dyn Fn(&str) + Send + Sync>);

impl TitleLog for LineTitleLog {
    fn line(&self, line: &str) {
        (self.0)(&format!("[mixdog] llm-title {line}"));
    }
}

/// Whether a session is titled at all: a Lead's conversation, not an agent's worker session.
pub fn titled(header: &Map<String, Value>) -> bool {
    !super::close::is_worker(header)
}

/// What the controller reads of a session.
#[derive(Clone, Debug, Default)]
pub struct TitleSession {
    pub id: String,
    pub title_locked: bool,
    /// `generatedTitleStage`.
    pub stage: Option<String>,
    pub messages: Vec<Value>,
}

pub struct TitleDeps {
    pub model: Arc<dyn TitleModel>,
    pub promote: Arc<dyn TitlePromote>,
    pub log: Arc<dyn TitleLog>,
    /// `Intl.DateTimeFormat().resolvedOptions().locale`.
    pub locale: Arc<dyn Fn() -> String + Send + Sync>,
    /// `SESSION_TITLE_TIMEOUT_MS` unless a test shortens it.
    pub timeout_ms: u64,
}

impl TitleDeps {
    pub fn new(model: Arc<dyn TitleModel>, promote: Arc<dyn TitlePromote>, log: Arc<dyn TitleLog>, locale: Arc<dyn Fn() -> String + Send + Sync>) -> Self {
        Self { model, promote, log, locale, timeout_ms: SESSION_TITLE_TIMEOUT_MS }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    First,
    Third,
}

impl Stage {
    fn name(self) -> &'static str {
        match self {
            Self::First => "first",
            Self::Third => "third",
        }
    }
}

#[derive(Default)]
struct State {
    first: VecDeque<String>,
    third: VecDeque<String>,
    /// Every session's title work ends with this token ([`SessionTitles::dispose_all`]).
    root: CancellationToken,
    /// The token each session's title work, waiting or running, ends with ([`SessionTitles::dispose_session`]).
    sessions: HashMap<String, CancellationToken>,
    disposed: bool,
    /// The sessions the "no route" line was written for.
    said_unrouted: HashSet<String>,
}

impl State {
    fn attempts(&mut self, stage: Stage) -> &mut VecDeque<String> {
        match stage {
            Stage::First => &mut self.first,
            Stage::Third => &mut self.third,
        }
    }

    fn remember(&mut self, stage: Stage, id: &str) {
        let attempts = self.attempts(stage);
        attempts.retain(|seen| seen != id);
        attempts.push_back(id.to_owned());
        while attempts.len() > ATTEMPT_LIMIT {
            attempts.pop_front();
        }
    }

    fn forget(&mut self, stage: Stage, id: &str) {
        self.attempts(stage).retain(|seen| seen != id);
    }

    fn session(&mut self, id: &str) -> CancellationToken {
        let root = &self.root;
        self.sessions.entry(id.to_owned()).or_insert_with(|| root.child_token()).clone()
    }
}

/// The shared title controller of every lead surface.
pub struct SessionTitles {
    deps: TitleDeps,
    state: Mutex<State>,
}

fn has_text(value: &str) -> bool {
    meaningful(value)
}

fn strip_think(text: &str) -> String {
    THINK.replace_all_with(text, |_| String::new())
}

/// `titleMessageText(message, role)`.
fn message_text(message: &Value, role: &str) -> String {
    let Some(object) = message.as_object() else { return String::new() };
    if object.get("internal") == Some(&Value::Bool(true)) || object.get("synthetic") == Some(&Value::Bool(true)) {
        return String::new();
    }
    let content = object.get("content").filter(|v| !v.is_null()).or_else(|| object.get("text")).unwrap_or(&Value::Null);
    let raw = session_message_text(content);
    if raw.is_empty() || (role == "user" && is_session_preview_noise(&raw)) {
        return String::new();
    }
    let visible = clean_session_preview(&strip_think(&raw), 4_000);
    if has_text(&visible) { visible } else { String::new() }
}

/// `firstTurnTitleSource(prompt)`.
fn first_source(prompt: &Value) -> String {
    let raw = session_message_text(prompt);
    if raw.is_empty() || is_session_preview_noise(&raw) {
        return String::new();
    }
    let visible = clean_session_preview(&raw, 4_000);
    if has_text(&visible) { visible } else { String::new() }
}

/// Whether `messages` hold a user turn with text: the session is past its first prompt.
fn has_user_turn(messages: &[Value]) -> bool {
    messages.iter().any(|m| m.get("role") == Some(&json!("user")) && !message_text(m, "user").is_empty())
}

/// `thirdTurnTitleSource(messages)`: the first three completed human exchanges.
fn third_source(messages: &[Value]) -> String {
    let mut turns: Vec<(String, String)> = Vec::new();
    let mut current: Option<(String, String)> = None;
    for message in messages {
        let role = match message.get("role") {
            None | Some(Value::Null) => String::new(),
            Some(other) => mixdog_js::value_to_string(other).to_lowercase(),
        };
        if role != "user" && role != "assistant" {
            continue;
        }
        let text = message_text(message, &role);
        if text.is_empty() {
            continue;
        }
        if role == "user" {
            turns.extend(current.take());
            current = Some((text, String::new()));
        } else if let Some(turn) = current.as_mut() {
            turn.1 = text;
        }
    }
    turns.extend(current);
    let completed: Vec<_> = turns.into_iter().filter(|(user, assistant)| !user.is_empty() && !assistant.is_empty()).collect();
    if completed.len() < 3 {
        return String::new();
    }
    completed.iter().take(3).flat_map(|(user, assistant)| [format!("User: {user}"), format!("Assistant: {assistant}")]).collect::<Vec<_>>().join("\n")
}

/// `greetingTitle(source)`.
fn greeting_title(source: &str) -> &'static str {
    let normalized = NOT_WORD.replace_all_with(&source.to_lowercase(), |_| String::new());
    match normalized.as_str() {
        "ㅎㅇ" | "하이" | "안녕" | "안녕하세요" | "헬로" | "반가워" | "반갑습니다" => "인사",
        "hi" | "hello" | "hey" => "Greeting",
        _ => "",
    }
}

impl SessionTitles {
    pub fn new(deps: TitleDeps) -> Arc<Self> {
        Arc::new(Self { deps, state: Mutex::new(State::default()) })
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn log(&self, line: &str) {
        self.deps.log.line(line);
    }

    /// The promotion, unless the session's title work was dropped (`session`) or the title is empty.
    async fn promote(&self, id: &str, title: &str, stage: Stage, session: &CancellationToken) -> Result<bool, String> {
        if session.is_cancelled() || title.is_empty() {
            return Ok(false);
        }
        self.deps.promote.promote(id, title, stage.name()).await
    }

    /// The title work of a session that left the runtime ends here, whatever it came to.
    fn dropped(&self, id: &str, stage: Stage) {
        self.log(&format!("dropped id={id} stage={} (the session was closed)", stage.name()));
    }

    /// The model's title promoted: `Ok(false)` when the session's work was dropped before it was written.
    async fn generate(&self, id: &str, source: &str, stage: Stage, session: &CancellationToken) -> Result<bool, TitleError> {
        let locale = (self.deps.locale)();
        let cancel = session.child_token();
        let call = mixdog_rt::time::timeout(Duration::from_millis(self.deps.timeout_ms), self.deps.model.generate(source, id, &locale, &cancel));
        let raw = tokio::select! {
            biased;
            () = session.cancelled() => return Ok(false),
            timed = call => match timed {
                Ok(result) => result?,
                Err(_) => {
                    cancel.cancel();
                    return Err(TitleError::Failed("Error: Session title generation timed out.".into()));
                }
            },
        };
        if session.is_cancelled() {
            return Ok(false);
        }
        let title = compact_session_title(&raw);
        self.log(&format!("generated id={id} stage={} title={}", stage.name(), serde_json::to_string(&title).unwrap_or_default()));
        if !title.is_empty() {
            self.promote(id, &title, stage, session).await.map_err(TitleError::Failed)?;
        }
        Ok(!session.is_cancelled())
    }

    /// Whether a title route is configured; the first time a session finds none, the core's log says so.
    fn routed(&self, id: &str, stage: Stage) -> bool {
        if self.deps.model.routed() {
            return true;
        }
        self.say_unrouted(id, stage);
        false
    }

    fn say_unrouted(&self, id: &str, stage: Stage) {
        if self.state().said_unrouted.insert(id.to_owned()) {
            self.log(&format!("disabled id={id} stage={} (maintenance route unresolved; llm titling off)", stage.name()));
        }
    }

    fn run(self: &Arc<Self>, id: &str, source: String, stage: Stage, session: CancellationToken) {
        if session.is_cancelled() {
            self.state().forget(stage, id);
            self.dropped(id, stage);
            return;
        }
        if !self.routed(id, stage) {
            // The route is asked again when title work is next due.
            self.state().forget(stage, id);
            return;
        }
        self.log(&format!("start id={id} stage={} chars={}", stage.name(), utf16_len(&source)));
        let (titles, id) = (self.clone(), id.to_owned());
        mixdog_rt::spawn("session-title", TaskClass::Work, async move {
            match titles.generate(&id, &source, stage, &session).await {
                Ok(true) => {}
                Ok(false) => {
                    titles.state().forget(stage, &id);
                    titles.dropped(&id, stage);
                }
                Err(_) if session.is_cancelled() => {
                    titles.state().forget(stage, &id);
                    titles.dropped(&id, stage);
                }
                Err(TitleError::RouteUnresolved) => {
                    titles.state().forget(stage, &id);
                    titles.say_unrouted(&id, stage);
                }
                Err(TitleError::Failed(text)) => {
                    // A timed-out or failed generation may retry on the next trigger.
                    titles.state().forget(stage, &id);
                    titles.log(&format!("failed id={id} stage={} error={text}", stage.name()));
                }
            }
        });
    }

    fn first_source_of(&self, session: &TitleSession, prompt: &Value) -> Option<String> {
        let id = session.id.as_str();
        {
            let state = self.state();
            if state.disposed
                || id.is_empty()
                || state.first.iter().any(|seen| seen == id)
                || session.title_locked
                || matches!(session.stage.as_deref(), Some("first" | "third"))
            {
                return None;
            }
        }
        if has_user_turn(&session.messages) {
            return None;
        }
        let source = first_source(prompt);
        (!source.is_empty()).then_some(source)
    }

    fn promote_greeting(self: &Arc<Self>, id: &str, greeting: &'static str, session: CancellationToken) {
        self.log(&format!("generated id={id} stage=first title={} deterministic=greeting", serde_json::to_string(greeting).unwrap_or_default()));
        let (titles, id) = (self.clone(), id.to_owned());
        mixdog_rt::spawn("session-title", TaskClass::Work, async move {
            if let Err(error) = titles.promote(&id, greeting, Stage::First, &session).await {
                titles.state().forget(Stage::First, &id);
                titles.log(&format!("failed id={id} stage=first error={error}"));
            }
        });
    }

    /// `scheduleFirst(session, prompt, { after })`: whether a first title was started. `after`
    /// holds the model call back until the turn shows its first output (a failed release drops it).
    pub fn schedule_first(self: &Arc<Self>, session: &TitleSession, prompt: &Value, after: Option<BoxFuture<'static, Result<(), ()>>>) -> bool {
        let id = session.id.as_str();
        let Some(source) = self.first_source_of(session, prompt) else {
            return false;
        };
        let token = {
            let mut state = self.state();
            state.remember(Stage::First, id);
            state.session(id)
        };
        let greeting = greeting_title(&source);
        if !greeting.is_empty() {
            self.promote_greeting(id, greeting, token);
            return true;
        }
        let Some(released) = after else {
            self.run(id, source, Stage::First, token);
            return true;
        };
        let (titles, id) = (self.clone(), id.to_owned());
        mixdog_rt::spawn("session-title", TaskClass::Work, async move {
            let released = tokio::select! {
                biased;
                () = token.cancelled() => {
                    titles.state().forget(Stage::First, &id);
                    titles.dropped(&id, Stage::First);
                    return;
                }
                released = released => released,
            };
            match released {
                Ok(()) => titles.run(&id, source, Stage::First, token),
                Err(()) => titles.state().forget(Stage::First, &id),
            }
        });
        true
    }

    /// Whether a third title could still be made for `session` (its messages unread): it is not titled from its
    /// exchanges yet, nor locked, and a title route is configured.
    pub fn third_due(&self, session: &TitleSession) -> bool {
        let id = session.id.as_str();
        {
            let state = self.state();
            if state.disposed || id.is_empty() || state.third.iter().any(|seen| seen == id) || session.title_locked || session.stage.as_deref() == Some("third")
            {
                return false;
            }
        }
        self.routed(id, Stage::Third)
    }

    /// `observeThird(session)`: whether a third title was started.
    pub fn observe_third(self: &Arc<Self>, session: &TitleSession) -> bool {
        if !self.third_due(session) {
            return false;
        }
        let id = session.id.as_str();
        let source = third_source(&session.messages);
        if source.is_empty() {
            return false;
        }
        let token = {
            let mut state = self.state();
            state.remember(Stage::Third, id);
            state.session(id)
        };
        self.run(id, source, Stage::Third, token);
        true
    }

    /// `disposeAll()`: nothing is titled again and the title work waiting or running is dropped.
    pub fn dispose_all(&self) {
        let mut state = self.state();
        state.disposed = true;
        state.root.cancel();
        state.sessions.clear();
        state.first.clear();
        state.third.clear();
        state.said_unrouted.clear();
    }

    /// A session left the runtime (closed or deleted): its title work, waiting or running, is dropped, and nothing of it
    /// is written. Work the session is given afterwards (it is opened again) starts afresh.
    pub fn dispose_session(&self, id: &str) {
        let mut state = self.state();
        state.said_unrouted.remove(id);
        if let Some(token) = state.sessions.remove(id) {
            token.cancel();
        }
    }
}

/// The rows the third title is read from, gathered page by page into `held`: the user and assistant messages with text,
/// up to the user turn after the third answered exchange (the third exchange's answer may run on until then). `true`
/// once enough is held.
pub fn gather_exchanges(held: &mut Vec<Value>, rows: impl IntoIterator<Item = Value>) -> bool {
    // An exchange is complete once its user turn has an answer; an unanswered user turn completes none.
    fn step(role: &str, completed: &mut usize, open: &mut bool) {
        if role == "user" {
            *open = true;
        } else if std::mem::take(open) {
            *completed += 1;
        }
    }
    let (mut completed, mut open) = (0usize, false);
    for message in held.iter() {
        step(message.get("role").and_then(Value::as_str).unwrap_or_default(), &mut completed, &mut open);
    }
    for row in rows {
        let role = match row.get("role") {
            None | Some(Value::Null) => continue,
            Some(other) => mixdog_js::value_to_string(other).to_lowercase(),
        };
        if (role != "user" && role != "assistant") || message_text(&row, &role).is_empty() {
            continue;
        }
        if role == "user" && completed >= 3 {
            return true;
        }
        step(&role, &mut completed, &mut open);
        let mut row = row;
        if let Some(object) = row.as_object_mut() {
            object.insert("role".to_owned(), json!(role));
        }
        held.push(row);
    }
    false
}

/// `normalizeSessionTitle`.
pub(super) fn normalize_title(title: &str) -> String {
    let squeezed = SPACES.replace_all_with(title, |_| " ".to_owned());
    let trimmed = js_trim(&squeezed);
    let units: Vec<u16> = trimmed.encode_utf16().take(100).collect();
    String::from_utf16_lossy(&units)
}

fn port(error: PortError) -> String {
    format!("{error:?}")
}

/// What `updateSessionAiTitle` answered (`{ok, reason, title}`).
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum AiTitle {
    Set(String),
    /// `not-found`: no such session, or it is closed.
    NotFound,
    /// `empty-title`.
    Empty,
    /// `user-title`.
    UserTitle,
}

/// The stored sessions behind the controller: what it reads of one, and the promotion.
pub struct StoredTitles {
    threads: Arc<dyn ThreadState>,
    messages: Arc<dyn ThreadMessages>,
    clock: Arc<dyn Clock>,
}

impl StoredTitles {
    pub fn new(threads: Arc<dyn ThreadState>, messages: Arc<dyn ThreadMessages>, clock: Arc<dyn Clock>) -> Self {
        Self { threads, messages, clock }
    }

    /// `updateSessionAiTitle`: a title the model chose (the `session` tool's rename). It never
    /// overwrites a user title (a locked title without `titleSource` counts as the user's); it
    /// locks the title against generated ones but stays replaceable by the model.
    pub async fn update_ai_title(&self, id: &str, title: &str) -> Result<AiTitle, String> {
        let thread = ThreadId::from(id);
        let normalized = normalize_title(title);
        loop {
            let header = match self.threads.header(&thread).await {
                Ok(header) => header,
                Err(PortError::NotFound { .. }) => return Ok(AiTitle::NotFound),
                Err(error) => return Err(port(error)),
            };
            if header.get("closed") == Some(&Value::Bool(true)) {
                return Ok(AiTitle::NotFound);
            }
            if normalized.is_empty() {
                return Ok(AiTitle::Empty);
            }
            if header.get("titleLocked") == Some(&Value::Bool(true)) && header.get("titleSource").and_then(Value::as_str) != Some("ai") {
                return Ok(AiTitle::UserTitle);
            }
            let expect: Map<String, Value> = ["title", "titleLocked", "titleSource", "closed"]
                .iter()
                .map(|key| ((*key).to_owned(), header.get(*key).cloned().unwrap_or(Value::Null)))
                .collect();
            let set = Map::from_iter([
                ("title".to_owned(), json!(normalized)),
                ("titleLocked".to_owned(), json!(true)),
                ("titleSource".to_owned(), json!("ai")),
                ("titleUpdatedAt".to_owned(), json!(self.clock.now_ms())),
            ]);
            match self.threads.patch_header_if(&thread, expect, set, Vec::new()).await {
                Ok(None) => return Ok(AiTitle::Set(normalized)),
                Ok(Some(_)) => continue,
                Err(PortError::NotFound { .. }) => return Ok(AiTitle::NotFound),
                Err(error) => return Err(port(error)),
            }
        }
    }

    /// The session as the controller reads it, `None` when it is unknown.
    pub async fn session(&self, id: &str) -> Option<TitleSession> {
        let thread = ThreadId::from(id);
        let header = self.threads.header(&thread).await.ok()?;
        let messages = self.messages.messages(&thread).await.unwrap_or_default();
        Some(TitleSession {
            id: id.to_owned(),
            title_locked: header.get("titleLocked") == Some(&Value::Bool(true)),
            stage: header.get("generatedTitleStage").and_then(Value::as_str).map(str::to_owned),
            messages,
        })
    }
}

#[async_trait]
impl TitlePromote for StoredTitles {
    /// `updateSessionGeneratedTitle`: a locked session, a closed one or one already past this
    /// stage keeps its title. The write holds only while the keys it was computed from stand.
    async fn promote(&self, session_id: &str, title: &str, stage: &str) -> Result<bool, String> {
        let thread = ThreadId::from(session_id);
        let normalized = normalize_title(title);
        if normalized.is_empty() || !matches!(stage, "first" | "third") {
            return Ok(false);
        }
        loop {
            let header = match self.threads.header(&thread).await {
                Ok(header) => header,
                Err(PortError::NotFound { .. }) => return Ok(false),
                Err(error) => return Err(port(error)),
            };
            let current = header.get("generatedTitleStage").and_then(Value::as_str);
            if header.get("closed") == Some(&Value::Bool(true))
                || header.get("titleLocked") == Some(&Value::Bool(true))
                || current == Some("third")
                || (stage == "first" && current == Some("first"))
                || (header.get("title").and_then(Value::as_str) == Some(normalized.as_str()) && current == Some(stage))
            {
                return Ok(false);
            }
            let expect: Map<String, Value> = ["title", "generatedTitleStage", "titleLocked", "closed"]
                .iter()
                .map(|key| ((*key).to_owned(), header.get(*key).cloned().unwrap_or(Value::Null)))
                .collect();
            let set = Map::from_iter([
                ("title".to_owned(), json!(normalized)),
                ("generatedTitleStage".to_owned(), json!(stage)),
                ("titleUpdatedAt".to_owned(), json!(self.clock.now_ms())),
            ]);
            match self.threads.patch_header_if(&thread, expect, set, Vec::new()).await {
                Ok(None) => return Ok(true),
                Ok(Some(_)) => continue,
                Err(PortError::NotFound { .. }) => return Ok(false),
                Err(error) => return Err(port(error)),
            }
        }
    }
}

/// The turn's two touch points: the prompt about to run and the turn that completed.
pub struct TitleHooks {
    titles: Arc<SessionTitles>,
}

/// What the title controller reads of a session's `header`, its messages not read yet.
fn header_session(session_id: &str, header: &Map<String, Value>) -> TitleSession {
    TitleSession {
        id: session_id.to_owned(),
        title_locked: header.get("titleLocked") == Some(&Value::Bool(true)),
        stage: header.get("generatedTitleStage").and_then(Value::as_str).map(str::to_owned),
        messages: Vec::new(),
    }
}

impl TitleHooks {
    pub fn new(titles: Arc<SessionTitles>) -> Self {
        Self { titles }
    }

    /// Turn preparation (`turn-prepare.mjs scheduleFirstTitle`) over the session's `header` and the `history` before
    /// the turn's input: `prompt` is the human's turn (`None` for an injected one, which schedules nothing), and
    /// `after` resolves at the first visible output or the turn's settlement.
    pub fn turn_prepared(
        &self,
        session_id: &str,
        header: &Map<String, Value>,
        history: &[Value],
        prompt: Option<&Value>,
        after: BoxFuture<'static, Result<(), ()>>,
    ) -> bool {
        let Some(prompt) = prompt.filter(|prompt| is_human_authored_turn(prompt)) else { return false };
        if !titled(header) || has_user_turn(history) {
            return false;
        }
        self.titles.schedule_first(&header_session(session_id, header), prompt.get("content").unwrap_or(&Value::Null), Some(after))
    }

    /// Turn completion (`turn-settle.mjs completeTurn`), decided on the session's `header` before anything is read: the
    /// session whose third title is still to be made, `None` for one whose title work is done (titled from its
    /// exchanges, locked, an agent's worker, no title route). Its messages are read ([`gather_exchanges`]) for
    /// [`Self::turn_completed`].
    pub fn third_due(&self, session_id: &str, header: &Map<String, Value>) -> Option<TitleSession> {
        let session = header_session(session_id, header);
        (titled(header) && self.titles.third_due(&session)).then_some(session)
    }

    /// The third title of `session` ([`Self::third_due`]) from the messages read for it.
    pub fn turn_completed(&self, session: TitleSession) -> bool {
        self.titles.observe_third(&session)
    }

    /// The session was closed or deleted.
    pub fn session_disposed(&self, session_id: &str) {
        self.titles.dispose_session(session_id);
    }

    pub fn dispose(&self) {
        self.titles.dispose_all();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use mixdog_core_ports::ports::threads::{FencedPatch, HeaderStored, HeaderWrite, RunFence};
    use tokio::sync::oneshot;

    use super::*;

    const ID: &str = "sess_1";

    /// One stored session's header, written as the actor writes it: a patch lands only while its `expect` holds.
    /// `rename_once`: the user renames the session just before the next conditional write lands.
    #[derive(Default)]
    struct Store {
        header: Mutex<Map<String, Value>>,
        rename_once: AtomicBool,
    }

    impl Store {
        fn field(&self, key: &str) -> Value {
            self.header.lock().unwrap().get(key).cloned().unwrap_or(Value::Null)
        }
    }

    #[async_trait]
    impl ThreadState for Store {
        async fn header(&self, _: &ThreadId) -> Result<Map<String, Value>, PortError> {
            Ok(self.header.lock().unwrap().clone())
        }
        async fn patch_header(&self, _: &ThreadId, set: Map<String, Value>, _: Vec<String>) -> Result<(), PortError> {
            self.header.lock().unwrap().extend(set);
            Ok(())
        }
        async fn patch_header_at(
            &self,
            thread: &ThreadId,
            at: &RunFence,
            expect: Map<String, Value>,
            set: Map<String, Value>,
            unset: Vec<String>,
        ) -> Result<FencedPatch, PortError> {
            mixdog_core_ports::ports::threads::patch_at_rest(self, thread, at, expect, set, unset).await
        }
        async fn patch_header_if(
            &self,
            _: &ThreadId,
            expect: Map<String, Value>,
            set: Map<String, Value>,
            _: Vec<String>,
        ) -> Result<Option<Map<String, Value>>, PortError> {
            let mut header = self.header.lock().unwrap();
            if self.rename_once.swap(false, Ordering::SeqCst) {
                header.extend(Map::from_iter([
                    ("title".to_owned(), json!("My title")),
                    ("titleLocked".to_owned(), json!(true)),
                    ("titleSource".to_owned(), json!("user")),
                ]));
            }
            let now: Map<String, Value> = expect.keys().map(|key| (key.clone(), header.get(key).cloned().unwrap_or(Value::Null))).collect();
            if now != expect {
                return Ok(Some(now));
            }
            header.extend(set);
            Ok(None)
        }
        async fn store_header(&self, thread: &ThreadId, write: HeaderWrite) -> HeaderStored {
            HeaderStored::of_patch(self.patch_header(thread, write.set, write.unset).await)
        }
        async fn publish(&self, _: &ThreadId, _: mixdog_core_ports::ports::threads::Section) -> Result<(), PortError> {
            Ok(())
        }
        fn log_identity(&self, _: &ThreadId) -> Option<String> {
            None
        }
        async fn held_fields(&self, thread: &ThreadId, keys: &'static [&'static str]) -> Result<Map<String, Value>, PortError> {
            Ok(mixdog_core_ports::ports::threads::held_of(&self.header(thread).await?, keys))
        }
    }

    #[async_trait]
    impl ThreadMessages for Store {
        async fn messages(&self, _: &ThreadId) -> Result<Vec<Value>, PortError> {
            Ok(Vec::new())
        }
    }

    struct Now;

    impl Clock for Now {
        fn now_ms(&self) -> i64 {
            1_000
        }
    }

    /// The title model: every request answers `answer`. `routed`: whether a title route is configured. `released`: the
    /// turn's release of the first title was sent; `early` counts the requests made before it.
    struct Model {
        answer: Result<String, TitleError>,
        asked: AtomicUsize,
        early: AtomicUsize,
        routed: AtomicBool,
        released: AtomicBool,
    }

    #[async_trait]
    impl TitleModel for Model {
        fn routed(&self) -> bool {
            self.routed.load(Ordering::SeqCst)
        }

        async fn generate(&self, _: &str, _: &str, _: &str, _: &CancellationToken) -> Result<String, TitleError> {
            self.asked.fetch_add(1, Ordering::SeqCst);
            if !self.released.load(Ordering::SeqCst) {
                self.early.fetch_add(1, Ordering::SeqCst);
            }
            self.answer.clone()
        }
    }

    struct Rig {
        hooks: TitleHooks,
        store: Arc<Store>,
        model: Arc<Model>,
        lines: Arc<Mutex<Vec<String>>>,
    }

    /// The release of a scheduled first title (the turn's first output).
    struct Release(Arc<Model>, oneshot::Sender<()>);

    impl Release {
        fn send(self) {
            self.0.released.store(true, Ordering::SeqCst);
            let _ = self.1.send(());
        }
    }

    impl Rig {
        fn new(answer: Result<&str, TitleError>, header: Value) -> Self {
            // The title work is spawned on the runtime's executors.
            let _ = mixdog_rt::testing::tokens();
            let store = Arc::new(Store::default());
            *store.header.lock().unwrap() = header.as_object().cloned().unwrap();
            let model = Arc::new(Model {
                answer: answer.map(str::to_owned),
                asked: AtomicUsize::new(0),
                early: AtomicUsize::new(0),
                routed: AtomicBool::new(true),
                released: AtomicBool::new(false),
            });
            let lines: Arc<Mutex<Vec<String>>> = Arc::default();
            let sink = lines.clone();
            let log = LineTitleLog(Arc::new(move |line: &str| sink.lock().unwrap().push(line.to_owned())));
            let stored = Arc::new(StoredTitles::new(store.clone(), store.clone(), Arc::new(Now)));
            let deps = TitleDeps::new(model.clone(), stored, Arc::new(log), Arc::new(|| "en-US".to_owned()));
            Self { hooks: TitleHooks::new(SessionTitles::new(deps)), store, model, lines }
        }

        fn header(&self) -> Map<String, Value> {
            self.store.header.lock().unwrap().clone()
        }

        /// The turn's first prompt, and the release of its title.
        fn prompt(&self, prompt: Option<&Value>) -> (bool, Release) {
            let (release, released) = oneshot::channel::<()>();
            let scheduled = self.hooks.turn_prepared(ID, &self.header(), &[], prompt, Box::pin(async move { released.await.map_err(drop) }));
            (scheduled, Release(self.model.clone(), release))
        }

        /// A completed turn's end over the session's `messages`: whether the third title was started, `None` when the end
        /// read nothing.
        fn turn_end(&self, messages: Vec<Value>) -> Option<bool> {
            let session = self.hooks.third_due(ID, &self.header())?;
            let mut held = Vec::new();
            gather_exchanges(&mut held, messages);
            Some(self.hooks.turn_completed(TitleSession { messages: held, ..session }))
        }

        fn asked(&self) -> usize {
            self.model.asked.load(Ordering::SeqCst)
        }

        fn lines(&self, part: &str) -> Vec<String> {
            self.lines.lock().unwrap().iter().filter(|line| line.contains(part)).cloned().collect()
        }

        async fn until(&self, what: &str, done: impl Fn(&Self) -> bool) {
            for _ in 0..500 {
                if done(self) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("{what} did not happen: {:?}", self.lines.lock().unwrap());
        }
    }

    fn user(text: &str) -> Value {
        json!({ "role": "user", "content": text })
    }

    fn exchanges(count: usize) -> Vec<Value> {
        (0..count)
            .flat_map(|n| [user(&format!("Question number {n} about the parser")), json!({ "role": "assistant", "content": format!("Answer number {n}") })])
            .collect()
    }

    #[tokio::test]
    async fn a_first_prompt_is_titled_by_the_model_once_the_turn_shows_output() {
        let rig = Rig::new(Ok("Parser crash fix"), json!({ "title": "Why does the parser crash on empty input" }));
        let (scheduled, release) = rig.prompt(Some(&user("Why does the parser crash on empty input")));
        assert!(scheduled);
        release.send();
        rig.until("the first title", |rig| rig.store.field("title") == json!("Parser crash fix")).await;
        assert_eq!(rig.store.field("generatedTitleStage"), json!("first"));
        assert_eq!(rig.asked(), 1);
        assert_eq!(rig.model.early.load(Ordering::SeqCst), 0, "the model was asked before the turn showed output");
        assert_eq!(rig.lines("[mixdog] llm-title start id=sess_1 stage=first").len(), 1);
        assert_eq!(rig.lines("[mixdog] llm-title generated id=sess_1 stage=first title=\"Parser crash fix\"").len(), 1);
    }

    #[tokio::test]
    async fn a_greeting_takes_its_title_without_asking_the_model() {
        let rig = Rig::new(Ok("unused"), json!({}));
        let (scheduled, _release) = rig.prompt(Some(&user("ㅎㅇ")));
        assert!(scheduled);
        rig.until("the greeting's title", |rig| rig.store.field("title") == json!("인사")).await;
        assert_eq!(rig.store.field("generatedTitleStage"), json!("first"));
        assert_eq!(rig.asked(), 0);
        assert_eq!(rig.lines("deterministic=greeting").len(), 1);
    }

    #[tokio::test]
    async fn the_third_completed_exchange_titles_the_session_again() {
        let rig = Rig::new(Ok("Parser edge cases"), json!({ "title": "Parser crash fix", "generatedTitleStage": "first" }));
        assert_eq!(rig.turn_end(exchanges(2)), Some(false), "two exchanges title nothing");

        assert_eq!(rig.turn_end(exchanges(3)), Some(true));
        rig.until("the third title", |rig| rig.store.field("title") == json!("Parser edge cases")).await;
        assert_eq!(rig.store.field("generatedTitleStage"), json!("third"));
        assert_eq!(rig.turn_end(exchanges(4)), None, "a session titled from its exchanges reads nothing at a turn's end");
        assert_eq!(rig.asked(), 1);
    }

    #[test]
    fn the_exchanges_are_read_only_up_to_the_third() {
        let mut held = Vec::new();
        assert!(!gather_exchanges(&mut held, exchanges(2)), "two exchanges ask for more");
        let mut rest = exchanges(5).split_off(4);
        rest.insert(1, json!({ "role": "tool", "content": "a tool's result" }));
        assert!(gather_exchanges(&mut held, rest), "the fourth user turn ends the read");
        assert_eq!(held, exchanges(3));
        assert!(third_source(&held).contains("Answer number 2"));
    }

    /// A user turn left unanswered (a failed or stopped turn) completes no exchange: the read goes on to the third answered one.
    #[test]
    fn an_unanswered_user_turn_does_not_end_the_read() {
        let mut messages = exchanges(2);
        messages.push(user("A question whose turn failed"));
        messages.extend(exchanges(4).split_off(4));
        let mut held = Vec::new();
        assert!(gather_exchanges(&mut held, messages.clone()), "the fourth answered exchange's user turn ends the read");
        assert_eq!(held, messages[..messages.len() - 2]);
        assert_eq!(third_source(&held).matches("User: ").count(), 3, "{}", third_source(&held));
    }

    #[tokio::test]
    async fn a_title_the_user_set_is_kept() {
        let rig = Rig::new(Ok("Generated"), json!({ "title": "My title", "titleLocked": true, "titleSource": "user" }));
        let (scheduled, _release) = rig.prompt(Some(&user("Why does the parser crash on empty input")));
        assert!(!scheduled);
        assert_eq!(rig.turn_end(exchanges(3)), None, "a locked session reads nothing at a turn's end");
        let refused = StoredTitles::new(rig.store.clone(), rig.store.clone(), Arc::new(Now)).promote(ID, "Generated", "third").await;
        assert_eq!(refused, Ok(false));
        assert_eq!(rig.store.field("title"), json!("My title"));
        assert_eq!(rig.asked(), 0);
    }

    #[tokio::test]
    async fn a_rename_between_the_title_read_and_its_write_keeps_the_users_title() {
        let rig = Rig::new(Ok("unused"), json!({ "title": "Why does the parser crash" }));
        rig.store.rename_once.store(true, Ordering::SeqCst);
        let promoted = StoredTitles::new(rig.store.clone(), rig.store.clone(), Arc::new(Now)).promote(ID, "Parser crash fix", "first").await;
        assert_eq!(promoted, Ok(false));
        assert!(!rig.store.rename_once.load(Ordering::SeqCst), "the rename landed under the write");
        assert_eq!(rig.store.field("title"), json!("My title"));
        assert_eq!(rig.store.field("generatedTitleStage"), Value::Null);
    }

    #[tokio::test]
    async fn a_worker_session_schedules_nothing() {
        let rig = Rig::new(Ok("Generated"), json!({ "owner": "agent" }));
        let (scheduled, _release) = rig.prompt(Some(&user("Why does the parser crash on empty input")));
        assert!(!scheduled);
        assert_eq!(rig.turn_end(exchanges(3)), None, "a worker's turn end reads nothing");
        assert!(rig.lines("").is_empty());
    }

    #[tokio::test]
    async fn an_injected_turn_schedules_nothing() {
        let rig = Rig::new(Ok("Generated"), json!({}));
        assert!(!rig.prompt(None).0);
        let notice = json!({ "role": "user", "content": "The goal continues", "meta": { "source": "goal-continuation" } });
        assert!(!rig.prompt(Some(&notice)).0);
        assert!(rig.lines("").is_empty());
        assert_eq!(rig.asked(), 0);
    }

    #[tokio::test]
    async fn a_failing_title_model_leaves_the_fallback_title_and_logs_one_failure() {
        let rig = Rig::new(Err(TitleError::Failed("Error: refused by the provider".into())), json!({ "title": "Why does the parser crash" }));
        let (_, release) = rig.prompt(Some(&user("Why does the parser crash on empty input")));
        release.send();
        rig.until("the failure", |rig| !rig.lines("failed").is_empty()).await;
        assert_eq!(rig.lines("failed").as_slice(), ["[mixdog] llm-title failed id=sess_1 stage=first error=Error: refused by the provider"]);
        assert_eq!(rig.store.field("title"), json!("Why does the parser crash"));
        assert_eq!(rig.store.field("generatedTitleStage"), Value::Null);
    }

    #[tokio::test]
    async fn a_session_with_no_title_route_says_so_once_and_asks_the_route_again_when_titles_are_due() {
        let rig = Rig::new(Ok("Parser edge cases"), json!({ "title": "Why does the parser crash" }));
        rig.model.routed.store(false, Ordering::SeqCst);
        let (scheduled, release) = rig.prompt(Some(&user("Why does the parser crash on empty input")));
        assert!(scheduled);
        release.send();
        rig.until("the disabled line", |rig| !rig.lines("disabled").is_empty()).await;
        assert_eq!(rig.turn_end(exchanges(3)), None, "no route: the turn's end reads nothing");
        assert_eq!(rig.lines("disabled").as_slice(), ["[mixdog] llm-title disabled id=sess_1 stage=first (maintenance route unresolved; llm titling off)"]);
        assert_eq!(rig.asked(), 0);
        assert_eq!(rig.store.field("title"), json!("Why does the parser crash"));

        // The user configures the Maintainer's route: the next turn's end titles the session.
        rig.model.routed.store(true, Ordering::SeqCst);
        assert_eq!(rig.turn_end(exchanges(3)), Some(true));
        rig.until("the third title", |rig| rig.store.field("title") == json!("Parser edge cases")).await;
        assert_eq!(rig.lines("disabled").len(), 1);
    }

    #[tokio::test]
    async fn a_disposed_session_drops_its_waiting_title() {
        let rig = Rig::new(Ok("Generated"), json!({}));
        let (scheduled, release) = rig.prompt(Some(&user("Why does the parser crash on empty input")));
        assert!(scheduled);
        rig.hooks.session_disposed(ID);
        rig.until("the dropped line", |rig| !rig.lines("dropped id=sess_1 stage=first").is_empty()).await;
        release.send();
        assert_eq!(rig.asked(), 0);
        assert_eq!(rig.store.field("title"), Value::Null);
    }
}
