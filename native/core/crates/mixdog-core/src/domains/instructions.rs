//! The `instructions` domain: the eight editable instruction texts (four orchestration modes,
//! four output-style depths) and the instruction-files mode of the tool modules.
//!
//! Each text has a shipped file and a same-named user file in the data dir that replaces it.
//! The state, the revision hash, the checks and every sentence follow
//! `src/session-runtime/workflow-agents-api/instruction-files.mjs` of the 1.4.5 daemon.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_app_protocol::v2::params::InstructionsGetInstructionFileParams;
use mixdog_app_protocol::v2::params::InstructionsResetInstructionFileParams;
use mixdog_app_protocol::v2::params::InstructionsSaveInstructionFileParams;
use mixdog_app_protocol::v2::params::InstructionsSetInstructionFilesParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_js::value_to_string;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneTokens;
use regex::Regex;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest as _;
use sha2::Sha256;

use super::support::OpScopes;
use super::support::coded;
use super::support::decode;
use super::support::failed;
use super::support::holds_no_data;
use super::support::io_failure;
use super::support::is_js_space;
use super::support::js_trim;
use super::support::on_lane;
use super::support::path_lock;
use super::support::remove_file_forced;
use super::support::write_atomic;
use super::support::wrong_method;
use crate::tool_modules::ToolModules;
use crate::tool_modules::ToolModulesError;

const DOMAIN: &str = "instructions";
/// The code (and the message prefix) of a write or reset against a moved-on state.
const CONFLICT: &str = "INSTRUCTION_FILE_CONFLICT";
/// The agent editor's text limit.
const FILE_MAX_BYTES: usize = 256 * 1024;
const MODES: [&str; 4] = ["none", "focused", "balanced", "swarm"];
const STYLES: [(&str, &str); 4] = [
    ("detailed", "Detailed"),
    ("simple", "Simple"),
    ("minimal", "Minimal"),
    ("extreme-minimal", "Extreme Minimal"),
];

/// Where the texts live.
#[derive(Clone, Debug)]
pub struct InstructionPaths {
    /// Shipped `<mode>.md` files (`<install>/orchestration`).
    pub shipped_orchestration: PathBuf,
    /// Shipped `<id>.md` output styles (`<install>/output-styles`).
    pub shipped_output_styles: PathBuf,
    /// The data dir; user files are `orchestration/<mode>.md` and `output-styles/<id>.md` in it.
    pub data_dir: PathBuf,
}

/// What follows a changed text: the prompt-rules and context-status caches are dropped and
/// the agent profile change is published (`announce()` of the Node API).
#[async_trait]
pub trait InstructionsChanged: Send + Sync {
    async fn changed(&self);
}

/// The instruction-files mode of the tool modules (setInstructionFiles).
#[async_trait]
pub trait InstructionFilesMode: Send + Sync {
    async fn set(&self, mode: &str) -> Result<Value, ToolModulesError>;
    /// The current tool-module settings, which a duplicate request answers.
    async fn current(&self) -> Value;
}

#[async_trait]
impl InstructionFilesMode for ToolModules {
    async fn set(&self, mode: &str) -> Result<Value, ToolModulesError> {
        self.set_instruction_files(mode).await
    }

    async fn current(&self) -> Value {
        self.settings().await
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Group {
    Delegation,
    OutputStyle,
}

#[derive(Clone)]
struct Item {
    group: Group,
    id: String,
    label: &'static str,
    shipped: PathBuf,
    user: PathBuf,
}

fn mode_label(mode: &str) -> &'static str {
    match mode {
        "none" => "Solo",
        "focused" => "Focused",
        "balanced" => "Balanced",
        _ => "Swarm",
    }
}

fn frontmatter() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^---[ \t]*\r?\n(?s:.*?)\r?\n---[ \t]*(?:\r?\n|$)").expect("static pattern")
    })
}

fn meta_block() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^---\r?\n((?s:.*?))\r?\n---").expect("static pattern"))
}

fn body_of_style(text: &str) -> String {
    js_trim(&frontmatter().replace(text, "")).to_owned()
}

/// `normalizeOutputStyleId`.
pub(crate) fn style_slug(value: &str) -> String {
    let lowered = js_trim(value).to_lowercase();
    let mut slug = String::new();
    let mut in_separator = false;
    for c in lowered.chars() {
        if c == '_' || is_js_space(c) {
            if !in_separator {
                slug.push('-');
            }
            in_separator = true;
        } else {
            slug.push(c);
            in_separator = false;
        }
    }
    let slug = slug.trim_matches('-');
    if !slug.is_empty()
        && slug
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-'))
    {
        slug.to_owned()
    } else {
        String::new()
    }
}

/// The id `outputStyleMetaFromMarkdown(text, "<file_id>.md")` assigns, `None` where it
/// yields no style (the shared partial or an unusable id).
fn style_id_of(markdown: &str, file_id: &str) -> Option<String> {
    let mut meta: Map<String, Value> = Map::new();
    if let Some(block) = meta_block().captures(markdown) {
        for line in block[1].split(['\n']) {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let Some((key, value)) = line.split_once(':') else {
                continue;
            };
            if key.is_empty()
                || !key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            {
                continue;
            }
            let value = js_trim(value);
            let value = value.strip_prefix(['\'', '"']).unwrap_or(value);
            let value = value.strip_suffix(['\'', '"']).unwrap_or(value);
            meta.insert(key.to_owned(), Value::String(js_trim(value).to_owned()));
        }
    }
    let file_id = style_slug(file_id);
    let partial = meta
        .get("partial")
        .and_then(Value::as_str)
        .is_some_and(|raw| {
            matches!(
                js_trim(raw).to_lowercase().as_str(),
                "true" | "1" | "yes" | "on"
            )
        });
    if file_id == "common" || partial {
        return None;
    }
    let named = meta
        .get("name")
        .and_then(Value::as_str)
        .map(style_slug)
        .unwrap_or_default();
    let id = if named.is_empty() { file_id } else { named };
    (!id.is_empty()).then_some(id)
}

/// `normalizeText`: LF line ends, no trailing blanks on a line or at the end.
fn normalize_text(text: &str) -> String {
    let lf = text.replace("\r\n", "\n");
    let lines: Vec<&str> = lf
        .split('\n')
        .map(|line| line.trim_end_matches(is_js_space))
        .collect();
    lines.join("\n").trim_end_matches(is_js_space).to_owned()
}

/// `decodeInstructionFile`: the text, or why the bytes cannot serve.
pub(crate) fn decode_file(bytes: &[u8]) -> Result<String, &'static str> {
    if bytes.len() > FILE_MAX_BYTES {
        return Err("too-large");
    }
    if holds_no_data(bytes) {
        return Err("empty");
    }
    if bytes.contains(&0) {
        return Err("not-text");
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "not-text")?;
    Ok(text.strip_prefix('\u{feff}').unwrap_or(text).to_owned())
}

/// What `readInstructionFile` finds.
enum Found {
    Absent,
    Problem(&'static str),
    Text(String),
}

#[allow(clippy::disallowed_methods, reason = "body of the lane jobs that read an item's state")]
fn read_instruction_file(path: &Path) -> Found {
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            return Found::Absent;
        }
        Err(_) => return Found::Problem("unreadable"),
    };
    if !meta.is_file() {
        return Found::Problem("unreadable");
    }
    let Ok(bytes) = std::fs::read(path) else {
        return Found::Problem("unreadable");
    };
    match decode_file(&bytes) {
        Ok(text) => Found::Text(
            text.replace("\r\n", "\n")
                .trim_end_matches(is_js_space)
                .to_owned(),
        ),
        Err(problem) => Found::Problem(problem),
    }
}

impl Item {
    fn body(&self, text: &str) -> String {
        match self.group {
            Group::Delegation => text.to_owned(),
            Group::OutputStyle => body_of_style(text),
        }
    }

    fn accepts(&self, text: &str) -> bool {
        match self.group {
            Group::Delegation => true,
            Group::OutputStyle => style_id_of(text, &self.id).as_deref() == Some(self.id.as_str()),
        }
    }

    /// The bytes written for `body`: the shipped front matter is kept for a style.
    fn file(&self, body: &str, shipped_text: &str) -> String {
        match self.group {
            Group::Delegation => format!("{body}\n"),
            Group::OutputStyle => {
                let head = frontmatter().find(shipped_text).map_or("", |m| m.as_str());
                format!("{}\n\n{body}\n", head.trim_end_matches(is_js_space))
            }
        }
    }

    /// `stateOf`.
    fn state(&self) -> Value {
        let shipped_text = match read_instruction_file(&self.shipped) {
            Found::Text(text) => text,
            _ => String::new(),
        };
        let default_body = self.body(&shipped_text);
        let user = read_instruction_file(&self.user);
        let user_text = match &user {
            Found::Text(text) if !text.is_empty() => Some(text.as_str()),
            _ => None,
        };
        let accepted = user_text.is_some_and(|text| self.accepts(text));
        let user_body = match user_text {
            Some(text) if accepted => self.body(text),
            _ => String::new(),
        };
        let usable = !user_body.is_empty();
        let problem: Option<&str> = match (&user, usable) {
            (Found::Absent, _) | (_, true) => None,
            (Found::Problem(problem), false) => Some(problem),
            (Found::Text(_), false) => Some(if accepted { "empty" } else { "invalid" }),
        };
        let body = if usable {
            user_body.clone()
        } else {
            default_body.clone()
        };
        let digest = Sha256::digest(
            format!(
                "{}\0{}\0{body}",
                if usable { "user" } else { "default" },
                problem.unwrap_or("")
            )
            .as_bytes(),
        );
        let revision: String = digest
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()[..24]
            .to_owned();
        let mut state = Map::new();
        state.insert("group".into(), json!(self.group_name()));
        state.insert("id".into(), json!(self.id));
        state.insert("label".into(), json!(self.label));
        state.insert("body".into(), json!(body));
        state.insert("defaultBody".into(), json!(default_body));
        state.insert("userOverride".into(), json!(!matches!(user, Found::Absent)));
        state.insert(
            "modified".into(),
            json!(usable && normalize_text(&user_body) != normalize_text(&default_body)),
        );
        if let Some(problem) = problem {
            state.insert("problem".into(), json!(problem));
        }
        if !matches!(user, Found::Absent) {
            state.insert("path".into(), json!(self.user.to_string_lossy()));
        }
        state.insert("revision".into(), json!(revision));
        Value::Object(state)
    }

    fn group_name(&self) -> &'static str {
        match self.group {
            Group::Delegation => "delegation",
            Group::OutputStyle => "outputStyle",
        }
    }
}

/// `String(payload.field ?? '')`.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        other => value_to_string(other),
    }
}

/// Runs `job` while holding the lock of `path`.
fn locked<T>(path: &Path, job: impl FnOnce() -> T) -> T {
    let lock = path_lock(path);
    let _held = lock.lock().unwrap_or_else(PoisonError::into_inner);
    job()
}

fn bad_argument(message: String) -> CoreError {
    failed(DOMAIN, message)
}

pub struct InstructionsService {
    paths: InstructionPaths,
    mode: Arc<dyn InstructionFilesMode>,
    changed: Arc<dyn InstructionsChanged>,
    ops: OpScopes,
    interactive: InteractiveIo,
    durability: DurabilityIo,
}

impl InstructionsService {
    pub fn new(
        paths: InstructionPaths,
        mode: Arc<dyn InstructionFilesMode>,
        changed: Arc<dyn InstructionsChanged>,
        ops: OpScopes,
        tokens: &LaneTokens,
    ) -> Arc<Self> {
        Arc::new(Self {
            paths,
            mode,
            changed,
            ops,
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
        })
    }

    /// `itemFor`.
    fn item(&self, group: &str, id: &str) -> Result<Item, CoreError> {
        match group {
            "delegation" => {
                if !MODES.contains(&id) {
                    return Err(bad_argument(format!(
                        "orchestration mode must be one of {}",
                        MODES.join(", ")
                    )));
                }
                Ok(Item {
                    group: Group::Delegation,
                    id: id.to_owned(),
                    label: mode_label(id),
                    shipped: self.paths.shipped_orchestration.join(format!("{id}.md")),
                    user: self
                        .paths
                        .data_dir
                        .join("orchestration")
                        .join(format!("{id}.md")),
                })
            }
            "outputStyle" => {
                let Some((_, label)) = STYLES.iter().find(|(style, _)| *style == id) else {
                    let ids: Vec<&str> = STYLES.iter().map(|(style, _)| *style).collect();
                    return Err(bad_argument(format!(
                        "output style must be one of {}",
                        ids.join(", ")
                    )));
                };
                Ok(Item {
                    group: Group::OutputStyle,
                    id: id.to_owned(),
                    label,
                    shipped: self.paths.shipped_output_styles.join(format!("{id}.md")),
                    user: self
                        .paths
                        .data_dir
                        .join("output-styles")
                        .join(format!("{id}.md")),
                })
            }
            _ => Err(bad_argument(
                "instruction group must be one of delegation, outputStyle".into(),
            )),
        }
    }

    /// A write or reset made against a state that has moved on is refused. Only an absent
    /// revision is exempt: `null` is `String(null)`, which matches no revision.
    fn assert_current(expected: Option<&Value>, before: &Value, id: &str) -> Result<(), CoreError> {
        let Some(expected) = expected else {
            return Ok(());
        };
        if value_to_string(expected) == before["revision"].as_str().unwrap_or_default() {
            return Ok(());
        }
        Err(coded(
            DOMAIN,
            CONFLICT,
            format!("{CONFLICT}: \"{id}\" changed since it was loaded"),
        ))
    }

    async fn state(&self, req: &CoreRequest, item: Item) -> Result<Value, CoreError> {
        on_lane(self.interactive, &req.ctx.cancel, move |_| item.state()).await
    }

    async fn list(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let mut items = Vec::new();
        for mode in MODES {
            items.push(self.item("delegation", mode)?);
        }
        for (style, _) in STYLES {
            items.push(self.item("outputStyle", style)?);
        }
        on_lane(self.interactive, &req.ctx.cancel, move |_| {
            Value::Array(items.iter().map(Item::state).collect())
        })
        .await
    }

    async fn get(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let params: InstructionsGetInstructionFileParams = decode(req)?;
        let item = self.item(&params.group, &params.id)?;
        self.state(req, item).await
    }

    async fn save(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let params: InstructionsSaveInstructionFileParams = decode(req)?;
        let input = &params.input;
        let group = js_string(&input["group"]);
        let id = js_string(&input["id"]);
        let item = self.item(&group, &id)?;
        let body = js_trim(&js_string(&input["body"]).replace("\r\n", "\n")).to_owned();
        if body.is_empty() {
            return Err(bad_argument("instruction text must not be empty".into()));
        }
        if body.contains('\0') {
            return Err(bad_argument("instruction text must be plain text".into()));
        }
        let expected = input.get("expectedRevision").cloned();
        let write = {
            let item = item.clone();
            move |lane: &mixdog_rt::InLane<mixdog_rt::DurabilityIo>| -> Result<(), CoreError> {
                locked(&item.user, || {
                    let before = item.state();
                    Self::assert_current(expected.as_ref(), &before, &item.id)?;
                    let default_body = before["defaultBody"].as_str().unwrap_or_default();
                    if normalize_text(&body) == normalize_text(default_body) {
                        // Equal to the shipped text: no copy is kept, so it follows the shipped version.
                        return remove_file_forced(&item.user).map_err(|e| io_failure(DOMAIN, &e));
                    }
                    let shipped_text = match read_instruction_file(&item.shipped) {
                        Found::Text(text) => text,
                        _ => String::new(),
                    };
                    // The bytes that reach the disk, front matter and newline included, must pass
                    // the reader's check, or the saved file would be ignored.
                    let bytes = item.file(&body, &shipped_text).into_bytes();
                    if bytes.len() > FILE_MAX_BYTES {
                        return Err(bad_argument(
                            "instruction text is larger than 256 KB".into(),
                        ));
                    }
                    if let Err(problem) = decode_file(&bytes) {
                        return Err(bad_argument(format!(
                            "instruction text cannot be saved ({problem})"
                        )));
                    }
                    write_atomic(lane, &item.user, &bytes, true).map_err(|e| io_failure(DOMAIN, &e))
                })
            }
        };
        let changed = self.changed.clone();
        let durability = self.durability;
        let cancel = req.ctx.cancel.clone();
        let replay_cancel = req.ctx.cancel.clone();
        let again = item.clone();
        let interactive = self.interactive;
        let state_item = item.clone();
        self.ops_run(
            req,
            move || async move {
                on_lane(durability, &cancel, write).await??;
                changed.changed().await;
                on_lane(interactive, &cancel, move |_| state_item.state()).await
            },
            // A duplicate whose result was too large to store reads the files again, on the
            // lane like the first execution.
            move || async move { on_lane(interactive, &replay_cancel, move |_| again.state()).await },
        )
        .await
    }

    async fn reset(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let params: InstructionsResetInstructionFileParams = decode(req)?;
        let item = self.item(&params.group, &params.id)?;
        // Read raw: the typed field folds `null` into absent, which Node tells apart.
        let expected = req.params.get("expectedRevision").cloned();
        #[allow(clippy::disallowed_methods, reason = "body of a durability-io lane job")]
        let remove = {
            let item = item.clone();
            move || -> Result<(), CoreError> {
                locked(&item.user, || {
                    if !item.user.exists() {
                        return Err(bad_argument(format!(
                            "\"{}\" has no user override to reset",
                            item.id
                        )));
                    }
                    Self::assert_current(expected.as_ref(), &item.state(), &item.id)?;
                    remove_file_forced(&item.user).map_err(|e| io_failure(DOMAIN, &e))?;
                    let mut backup = item.user.as_os_str().to_owned();
                    backup.push(".bak");
                    remove_file_forced(Path::new(&backup)).map_err(|e| io_failure(DOMAIN, &e))
                })
            }
        };
        let changed = self.changed.clone();
        let durability = self.durability;
        let interactive = self.interactive;
        let cancel = req.ctx.cancel.clone();
        let replay_cancel = req.ctx.cancel.clone();
        let again = item.clone();
        let state_item = item.clone();
        self.ops_run(
            req,
            move || async move {
                on_lane(durability, &cancel, move |_| remove()).await??;
                changed.changed().await;
                on_lane(interactive, &cancel, move |_| state_item.state()).await
            },
            move || async move { on_lane(interactive, &replay_cancel, move |_| again.state()).await },
        )
        .await
    }

    async fn set_files(&self, req: &CoreRequest) -> Result<Value, CoreError> {
        let params: InstructionsSetInstructionFilesParams = decode(req)?;
        let modules = self.mode.clone();
        let again = self.mode.clone();
        let mode = params.mode;
        self.ops_run(
            req,
            move || async move {
                modules.set(&mode).await.map_err(|error| match error {
                    ToolModulesError::InvalidArgument(message) => bad_argument(message),
                    other => failed(DOMAIN, other.to_string()),
                })
            },
            move || async move { Ok(again.current().await) },
        )
        .await
    }

    async fn ops_run<E, EF, R, RF>(
        &self,
        req: &CoreRequest,
        execute: E,
        reproduce: R,
    ) -> Result<Value, CoreError>
    where
        E: FnOnce() -> EF,
        EF: std::future::Future<Output = Result<Value, CoreError>>,
        R: FnOnce() -> RF,
        RF: std::future::Future<Output = Result<Value, CoreError>>,
    {
        match self.ops.run(req, None, execute, reproduce).await? {
            Reply::Value(value) => Ok(value),
            Reply::Subscribe(_) => Err(CoreError::Internal {
                incident_id: "instructions-subscribe".into(),
            }),
        }
    }
}

#[async_trait]
impl DomainService for InstructionsService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let value = match req.method.as_str() {
            "instructions/listInstructionFiles" => self.list(&req).await?,
            "instructions/getInstructionFile" => self.get(&req).await?,
            "instructions/saveInstructionFile" => self.save(&req).await?,
            "instructions/resetInstructionFile" => self.reset(&req).await?,
            "instructions/setInstructionFiles" => self.set_files(&req).await?,
            other => return Err(wrong_method(DOMAIN, other)),
        };
        Ok(Reply::Value(value))
    }

    fn methods(&self) -> &'static [&'static str] {
        &[
            "instructions/listInstructionFiles",
            "instructions/getInstructionFile",
            "instructions/saveInstructionFile",
            "instructions/resetInstructionFile",
            "instructions/setInstructionFiles",
        ]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests;
