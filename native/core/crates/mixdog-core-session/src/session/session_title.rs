//! LLM session titles: `createSessionTitleController` (`runtime-core/session-title.mjs`) and
//! `updateSessionGeneratedTitle` (`session/manager/session-crud.mjs`).
//!
//! A greeting titles a session at once; any other first prompt is titled by the title model
//! beside the turn, and the first three completed exchanges title it once more after the third.
//! The model, the promotion and the log are seams: the host supplies the title completion
//! (`run_host::title_completion`), [`StoredTitles`] reads and writes the stored session.

use std::collections::{HashMap, VecDeque};
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
    Some(mixdog_store::schema::record::HeaderChange { set, unset: Vec::new() })
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
    active: HashMap<String, (u64, CancellationToken)>,
    next_run: u64,
    disposed: bool,
    /// No title route: model titles stay off for the process (greetings still work).
    route_unavailable: bool,
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

    async fn promote(&self, id: &str, title: &str, stage: Stage) -> Result<bool, String> {
        if self.state().disposed || title.is_empty() {
            return Ok(false);
        }
        self.deps.promote.promote(id, title, stage.name()).await
    }

    async fn generate(&self, id: &str, source: &str, stage: Stage) -> Result<(), TitleError> {
        let cancel = CancellationToken::new();
        let key = format!("{id}:{}", stage.name());
        let run = {
            let mut state = self.state();
            state.next_run += 1;
            let run = state.next_run;
            state.active.insert(key.clone(), (run, cancel.clone()));
            run
        };
        let outcome = self.generate_with(id, source, stage, &cancel).await;
        let mut state = self.state();
        if state.active.get(&key).is_some_and(|(held, _)| *held == run) {
            state.active.remove(&key);
        }
        outcome
    }

    async fn generate_with(&self, id: &str, source: &str, stage: Stage, cancel: &CancellationToken) -> Result<(), TitleError> {
        let locale = (self.deps.locale)();
        let call = async {
            if self.state().disposed {
                return Ok(String::new());
            }
            self.deps.model.generate(source, id, &locale, cancel).await
        };
        let raw = match mixdog_rt::time::timeout(Duration::from_millis(self.deps.timeout_ms), call).await {
            Ok(result) => result?,
            Err(_) => {
                cancel.cancel();
                return Err(TitleError::Failed("Error: Session title generation timed out.".into()));
            }
        };
        let title = compact_session_title(&raw);
        self.log(&format!("generated id={id} stage={} title={}", stage.name(), serde_json::to_string(&title).unwrap_or_default()));
        if !title.is_empty() {
            self.promote(id, &title, stage).await.map_err(TitleError::Failed)?;
        }
        Ok(())
    }

    fn run(self: &Arc<Self>, id: &str, source: String, stage: Stage) {
        if self.state().route_unavailable {
            return;
        }
        self.log(&format!("start id={id} stage={} chars={}", stage.name(), utf16_len(&source)));
        let (titles, id) = (self.clone(), id.to_owned());
        mixdog_rt::spawn("session-title", TaskClass::Work, async move {
            match titles.generate(&id, &source, stage).await {
                Ok(()) => {}
                Err(TitleError::RouteUnresolved) => {
                    let first = !std::mem::replace(&mut titles.state().route_unavailable, true);
                    if first {
                        titles.log(&format!("disabled stage={} (maintenance route unresolved; llm titling off)", stage.name()));
                    }
                }
                Err(TitleError::Failed(text)) => {
                    // A timed-out or failed generation may retry on the next trigger.
                    titles.state().forget(stage, &id);
                    titles.log(&format!("failed id={id} stage={} error={text}", stage.name()));
                }
            }
        });
    }

    /// `scheduleFirst(session, prompt, { after })`: whether a first title was started. `after`
    /// holds the model call back until the turn shows its first output (a failed release drops it).
    pub fn schedule_first(self: &Arc<Self>, session: &TitleSession, prompt: &Value, after: Option<BoxFuture<'static, Result<(), ()>>>) -> bool {
        let id = session.id.as_str();
        {
            let state = self.state();
            if state.disposed
                || id.is_empty()
                || state.first.iter().any(|seen| seen == id)
                || session.title_locked
                || matches!(session.stage.as_deref(), Some("first" | "third"))
            {
                return false;
            }
        }
        if session.messages.iter().any(|m| m.get("role") == Some(&json!("user")) && !message_text(m, "user").is_empty()) {
            return false;
        }
        let source = first_source(prompt);
        if source.is_empty() {
            return false;
        }
        self.state().remember(Stage::First, id);
        let greeting = greeting_title(&source);
        if !greeting.is_empty() {
            self.log(&format!("generated id={id} stage=first title={} deterministic=greeting", serde_json::to_string(greeting).unwrap_or_default()));
            let (titles, id, title) = (self.clone(), id.to_owned(), greeting);
            mixdog_rt::spawn("session-title", TaskClass::Work, async move {
                if let Err(error) = titles.promote(&id, title, Stage::First).await {
                    titles.state().forget(Stage::First, &id);
                    titles.log(&format!("failed id={id} stage=first error={error}"));
                }
            });
            return true;
        }
        let (titles, id) = (self.clone(), id.to_owned());
        let launch = move |titles: Arc<Self>| {
            if titles.state().disposed {
                titles.state().forget(Stage::First, &id);
                return;
            }
            titles.run(&id, source, Stage::First);
        };
        match after {
            Some(released) => {
                let forget = (titles.clone(), session.id.clone());
                mixdog_rt::spawn("session-title", TaskClass::Work, async move {
                    match released.await {
                        Ok(()) => launch(titles),
                        Err(()) => forget.0.state().forget(Stage::First, &forget.1),
                    }
                });
            }
            None => launch(titles),
        }
        true
    }

    /// `observeThird(session)`: whether a third title was started.
    pub fn observe_third(self: &Arc<Self>, session: &TitleSession) -> bool {
        let id = session.id.as_str();
        {
            let state = self.state();
            if state.disposed
                || state.route_unavailable
                || id.is_empty()
                || state.third.iter().any(|seen| seen == id)
                || session.title_locked
                || session.stage.as_deref() == Some("third")
            {
                return false;
            }
        }
        let source = third_source(&session.messages);
        if source.is_empty() {
            return false;
        }
        self.state().remember(Stage::Third, id);
        self.run(id, source, Stage::Third);
        true
    }

    /// `disposeAll()`: nothing is titled again and running generations are aborted.
    pub fn dispose_all(&self) {
        let mut state = self.state();
        state.disposed = true;
        for (_, cancel) in state.active.values() {
            cancel.cancel();
        }
        state.active.clear();
        state.first.clear();
        state.third.clear();
    }
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
    stored: Arc<StoredTitles>,
}

impl TitleHooks {
    pub fn new(titles: Arc<SessionTitles>, stored: Arc<StoredTitles>) -> Self {
        Self { titles, stored }
    }

    /// Turn preparation (`turn-prepare.mjs scheduleFirstTitle`): `after` resolves at the first
    /// visible output or the turn's settlement.
    pub async fn turn_prepared(&self, session_id: &str, prompt: &Value, after: BoxFuture<'static, Result<(), ()>>) -> bool {
        match self.stored.session(session_id).await {
            Some(session) => self.titles.schedule_first(&session, prompt, Some(after)),
            None => false,
        }
    }

    /// Turn completion (`turn-settle.mjs completeTurn`).
    pub async fn turn_completed(&self, session_id: &str) -> bool {
        match self.stored.session(session_id).await {
            Some(session) => self.titles.observe_third(&session),
            None => false,
        }
    }

    pub fn dispose(&self) {
        self.titles.dispose_all();
    }
}

#[cfg(test)]
mod tests {}
