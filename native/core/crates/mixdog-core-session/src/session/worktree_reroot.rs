//! The session's pending workspace re-root, as pure reads over a header and the two system
//! messages that carry the prompt: Node's `stageWorkspaceReroot` state (`session.workspaceReroot`),
//! `applyPendingWorkspaceReroot` and the `# Session` block rebuild `refreshSessionBp3Environment`
//! (`prompt-utils.mjs`), as `updateSessionRoute` runs them on a route change
//! (`session-lifecycle.mjs:517-518`), and the in-place re-root of a session without a
//! conversation (`refreshSessionWorkspaceContext`). The reads are pure; [`PromptReroot`] is the one
//! writer, landing the in-place re-root with its undo.

use std::sync::Arc;

use mixdog_core_api::ids::ThreadId;
use mixdog_core_ports::ports::threads::ThreadState;
use mixdog_core_prompt::prompt::blocks::SystemBlocks;
use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use mixdog_scm::error::ScmFailure;
use mixdog_store::schema::record::Header;
use mixdog_store::schema::record::HeaderChange;
use serde_json::Map;
use serde_json::Value;

use crate::session::SessionDirectory;
use super::worktree_host::Undo;
use super::worktree_host_impl::WorkspaceContext;
use super::worktree_host_impl::port;
use super::worktree_state::plain;

const SEPARATOR: &str = "\n\n---\n\n";
const CORE_MEMORY_HEADING: &str = "# Core Memory\n";
const INSTRUCTION_FILES_HEADING: &str = "# Instruction Files";

/// `session.workspaceReroot`: the workspace change staged on a session that has a conversation.
#[derive(Debug, Clone, PartialEq)]
pub struct PendingReroot {
    pub revision: u64,
    /// The Cwd the system prompt stays rooted at until the change is applied.
    pub root_cwd: Option<String>,
    /// What the model has been told.
    pub seen: Value,
    /// The current workspace, applied to the prompt at the next re-root.
    pub target: Value,
}

/// The prompt as stored: the header, and the content of the `tier3` and `env` system messages
/// (`None` when the message does not exist).
#[derive(Debug, Clone, Copy)]
pub struct PromptView<'a> {
    pub header: &'a Header,
    pub tier3: Option<&'a str>,
    pub env: Option<&'a str>,
}

/// What a re-root changes: the header change, and the new content of each system message that
/// differs (an `env` message that did not exist is created with it).
#[derive(Debug, Clone, PartialEq)]
pub struct PromptRewrite {
    pub change: HeaderChange,
    pub tier3: Option<String>,
    pub env: Option<String>,
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ => true,
    }
}

/// `session.workspaceReroot`, or `None` when no change is staged.
pub fn pending_workspace_reroot(header: &Header) -> Option<PendingReroot> {
    let pending = header.get("workspaceReroot").filter(|value| truthy(value))?;
    let field = |key: &str| pending.get(key).cloned().unwrap_or(Value::Null);
    Some(PendingReroot {
        revision: pending.get("revision").and_then(Value::as_u64).unwrap_or(0),
        root_cwd: pending.get("rootCwd").and_then(Value::as_str).map(str::to_owned),
        seen: field("seen"),
        target: field("target"),
    })
}

fn joined(parts: &[&str]) -> String {
    parts.iter().filter(|part| !js_trim(part).is_empty()).copied().collect::<Vec<_>>().join(SEPARATOR)
}

/// `joinBp3Parts`: each part trimmed.
fn joined_trimmed(parts: &[&str]) -> String {
    parts.iter().map(|part| js_trim(part)).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(SEPARATOR)
}

/// Where a heading-led slice starts in a BP3 join: `(cut, start)`.
fn slice_at(text: &str, heading: &str) -> Option<(usize, usize)> {
    if text.starts_with(heading) {
        return Some((0, 0));
    }
    let at = text.find(&format!("{SEPARATOR}{heading}"))?;
    Some((at, at + SEPARATOR.len()))
}

/// A BP3 core's `(head, instructionFiles, memory)`, each empty when absent.
fn split_core(core: &str) -> (String, String, String) {
    let mut head = core.to_owned();
    let mut memory = String::new();
    if let Some((cut, start)) = slice_at(&head, CORE_MEMORY_HEADING) {
        memory = head[start..].to_owned();
        head.truncate(cut);
        if let Some(legacy) = memory.find(&format!("{SEPARATOR}{INSTRUCTION_FILES_HEADING}")) {
            let instructions = memory[legacy + SEPARATOR.len()..].to_owned();
            memory.truncate(legacy);
            head = if head.is_empty() { instructions } else { format!("{head}{SEPARATOR}{instructions}") };
        }
    }
    let mut instruction_files = String::new();
    if let Some((cut, start)) = slice_at(&head, INSTRUCTION_FILES_HEADING) {
        instruction_files = head[start..].to_owned();
        head.truncate(cut);
    }
    (head, instruction_files, memory)
}

/// `replaceWorkspaceCoreSlices`: `None` keeps a slice, an empty string drops it.
fn replace_core_slices(core: &str, memory_slice: Option<&str>, instruction_slice: Option<&str>) -> String {
    let (head, mut instruction_files, mut memory) = split_core(core);
    if let Some(value) = memory_slice {
        let value = js_trim(value);
        memory = if value.is_empty() { String::new() } else { format!("{CORE_MEMORY_HEADING}{value}") };
    }
    if let Some(value) = instruction_slice {
        instruction_files = js_trim(value).to_owned();
    }
    joined(&[&head, &instruction_files, &memory])
}

/// `replaceWorkspaceEnvironment`: the facts that lead the environment tail; `None` keeps them.
fn replace_environment(tail: &str, facts: Option<&str>) -> String {
    let Some(facts) = facts else { return tail.to_owned() };
    let mut parts: Vec<String> = if tail.is_empty() { Vec::new() } else { tail.split(SEPARATOR).map(str::to_owned).collect() };
    let facts = js_trim(facts).to_owned();
    match parts.first_mut() {
        Some(first) if first.starts_with("- ") => *first = facts,
        _ => parts.insert(0, facts),
    }
    parts.iter().filter(|part| !js_trim(part).is_empty()).cloned().collect::<Vec<_>>().join(SEPARATOR)
}

/// `sessionModelDisplay`.
fn model_display(model: &str) -> String {
    let text = js_trim(model);
    if text.is_empty() {
        return String::new();
    }
    // `-\d{4}-\d{2}-\d{2}$`
    let bytes = text.as_bytes();
    let dated = bytes.len() >= 11 && {
        let tail = &bytes[bytes.len() - 11..];
        tail.iter().enumerate().all(|(i, b)| if matches!(i, 0 | 5 | 8) { *b == b'-' } else { b.is_ascii_digit() })
    };
    let text = if dated { &text[..text.len() - 11] } else { text };
    let text = match text.get(..4) {
        Some(prefix) if prefix.eq_ignore_ascii_case("gpt-") => format!("GPT-{}", &text[4..]),
        _ => text.to_owned(),
    };
    // `(?:^|-)([a-z])` upper-cased, globally.
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut at = 0;
    while at < chars.len() {
        if at == 0 && chars[0].is_ascii_lowercase() {
            out.push(chars[0].to_ascii_uppercase());
            at = 1;
        } else if chars[at] == '-' && chars.get(at + 1).is_some_and(char::is_ascii_lowercase) {
            out.push('-');
            out.push(chars[at + 1].to_ascii_uppercase());
            at += 2;
        } else {
            out.push(chars[at]);
            at += 1;
        }
    }
    out
}

fn text_of<'a>(header: &'a Header, key: &str) -> &'a str {
    header.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// `buildSessionStartBlock(session, cwd)`.
fn session_start_block(header: &Header, cwd: &str) -> String {
    if text_of(header, "owner") == "agent" {
        return String::new();
    }
    let session_cwd = header.get("cwd").filter(|v| truthy(v)).map(value_to_string).unwrap_or_default();
    let effective = js_trim(if cwd.is_empty() { &session_cwd } else { cwd }).to_owned();
    let mut lines = vec!["# Session".to_owned()];
    if !effective.is_empty() {
        lines.push(format!("Cwd: {effective}"));
    }
    let model = model_display(header.get("model").filter(|v| truthy(v)).map(value_to_string).as_deref().unwrap_or_default());
    if !model.is_empty() {
        lines.push(format!("Model: {model}"));
    }
    if lines.len() > 1 { lines.join("\n") } else { String::new() }
}

/// The prompt while it is rewritten: the header fields and the two system messages.
struct Working {
    environment: Option<String>,
    core: Option<String>,
    tier3: Option<String>,
    env: Option<String>,
    split: bool,
    change: HeaderChange,
    injected: bool,
}

impl Working {
    fn new(view: &PromptView) -> Self {
        let string = |key: &str| view.header.get(key).and_then(Value::as_str).map(str::to_owned);
        Self {
            environment: string("bp3EnvironmentContext"),
            core: string("bp3CoreContext"),
            tier3: view.tier3.map(str::to_owned),
            env: view.env.map(str::to_owned),
            split: view.header.get("bp3EnvSplit") == Some(&Value::Bool(true)),
            change: HeaderChange { set: Map::new(), unset: Vec::new() },
            injected: false,
        }
    }

    /// `rerootSessionWorkspace` without its trailing refresh.
    fn reroot(&mut self, target: &Value) {
        let slice = |key: &str| target.get(key).map(|v| js_trim(&value_to_string(v)).to_owned());
        if let Some(environment) = &self.environment {
            self.environment = Some(replace_environment(environment, slice("environmentContext").as_deref()));
        }
        let (memory, instructions) = (slice("coreMemoryContext"), slice("instructionFilesContext"));
        if self.split {
            if let Some(tier3) = &self.tier3 {
                let next = replace_core_slices(tier3, memory.as_deref(), instructions.as_deref());
                self.tier3 = Some(next.clone());
                self.core = Some(next);
            }
        } else if let Some(core) = &self.core {
            self.core = Some(replace_core_slices(core, memory.as_deref(), instructions.as_deref()));
        }
    }

    /// `refreshSessionBp3Environment(session, requestedCwd)`.
    fn refresh(&mut self, header: &Header, cwd: &str) {
        if self.split {
            let Some(environment) = &self.environment else { return };
            let block = session_start_block(header, cwd);
            let content = joined_trimmed(&[&block, environment]);
            if self.env.is_some() || !content.is_empty() {
                self.env = Some(content);
            }
        } else {
            let (Some(_), Some(core)) = (&self.tier3, &self.core) else { return };
            let block = session_start_block(header, cwd);
            let environment = self.environment.clone().unwrap_or_default();
            self.tier3 = Some(joined_trimmed(&[core, &block, &environment]));
        }
        self.injected = true;
    }

    fn finish(mut self, view: &PromptView, dropped_pending: bool) -> PromptRewrite {
        let mut set = |key: &str, value: Option<String>| {
            if let Some(value) = value.filter(|v| view.header.get(key).and_then(Value::as_str) != Some(v)) {
                self.change.set.insert(key.to_owned(), Value::String(value));
            }
        };
        let (environment, core) = (self.environment.clone(), self.core.clone());
        set("bp3EnvironmentContext", environment);
        set("bp3CoreContext", core);
        if self.injected && view.header.get("sessionStartMetaInjected") != Some(&Value::Bool(true)) {
            self.change.set.insert("sessionStartMetaInjected".to_owned(), Value::Bool(true));
        }
        if dropped_pending {
            self.change.unset.push("workspaceReroot".to_owned());
        }
        let differs = |new: &Option<String>, old: Option<&str>| new.as_deref().filter(|n| Some(*n) != old).map(str::to_owned);
        PromptRewrite { tier3: differs(&self.tier3, view.tier3), env: differs(&self.env, view.env), change: self.change }
    }
}

/// What `updateSessionRoute` does to the prompt: when the route changed (`route_changed`) a staged
/// workspace change is applied first (a new route starts a cold cache), then the `# Session` block
/// is rebuilt for the session's cwd. A staged change that stays keeps the prompt rooted at its
/// `rootCwd`.
pub fn route_prompt_refresh(view: &PromptView, route_changed: bool) -> PromptRewrite {
    let mut working = Working::new(view);
    let pending = pending_workspace_reroot(view.header);
    let applied = route_changed && pending.is_some();
    if let (true, Some(pending)) = (applied, &pending) {
        working.reroot(&pending.target);
    }
    let session_cwd = view.header.get("cwd").filter(|v| truthy(v)).map(value_to_string).unwrap_or_default();
    let cwd = match (&pending, applied) {
        (Some(pending), false) => pending.root_cwd.clone().filter(|c| !c.is_empty()).unwrap_or(session_cwd),
        _ => session_cwd,
    };
    working.refresh(view.header, &cwd);
    working.finish(view, applied)
}

/// `presentedWorkspace(session)`: the workspace the prompt presents now, read back from the
/// blocks: `{cwd, environmentContext, coreMemoryContext, instructionFilesContext}`. The core is
/// the `tier3` message in the split layout and `bp3CoreContext` in the combined one; the Cwd is
/// the `# Session` block's, else the environment facts'. Pure.
pub fn presented_workspace(view: &PromptView) -> Value {
    static SESSION_CWD: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static WORKER_CWD: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let session_cwd = SESSION_CWD.get_or_init(|| regex::Regex::new(r"(?:^|\n)# Session\nCwd: ([^\n]+)").expect("static regex"));
    let worker_cwd = WORKER_CWD.get_or_init(|| regex::Regex::new(r"(?:^|\n)- Cwd: ([^\n]+?) — the active Project root").expect("static regex"));

    let split = view.header.get("bp3EnvSplit") == Some(&Value::Bool(true));
    let core = if split { view.tier3.unwrap_or_default() } else { text_of(view.header, "bp3CoreContext") };
    let (_, instruction_files, memory) = split_core(core);
    let facts = text_of(view.header, "bp3EnvironmentContext").split(SEPARATOR).next().unwrap_or_default();
    let prompt_text = [view.env.unwrap_or_default(), view.tier3.unwrap_or_default()].join("\n");
    let cwd = session_cwd
        .captures(&prompt_text)
        .or_else(|| worker_cwd.captures(facts))
        .map(|found| js_trim(&found[1]).to_owned());
    let mut presented = Map::new();
    presented.insert("cwd".into(), cwd.map_or(Value::Null, Value::String));
    presented.insert("environmentContext".into(), Value::String(if facts.starts_with("- ") { js_trim(facts).to_owned() } else { String::new() }));
    presented.insert("coreMemoryContext".into(), Value::String(if memory.is_empty() { String::new() } else { js_trim(&memory[CORE_MEMORY_HEADING.len()..]).to_owned() }));
    presented.insert("instructionFilesContext".into(), Value::String(js_trim(&instruction_files).to_owned()));
    Value::Object(presented)
}

/// `refreshSessionWorkspaceContext(session, context)` for a session without a user conversation:
/// a staged change is applied first (`applyPendingWorkspaceReroot`, which drops it), then the
/// prompt is re-rooted at `cwd` in place (`rerootSessionWorkspace`): environment facts, project
/// memory and instruction files are replaced (`None` keeps a slice, an empty one drops it) and the
/// `# Session` block is rebuilt for `cwd`. The intermediate `# Session` refresh of the staged
/// change is not kept: the final one rebuilds the same blocks from the same fields.
pub fn in_place_reroot(view: &PromptView, cwd: &str, context: &WorkspaceContext) -> PromptRewrite {
    let mut working = Working::new(view);
    let pending = pending_workspace_reroot(view.header);
    if let Some(pending) = &pending {
        working.reroot(&pending.target);
    }
    let mut target = Map::new();
    for (key, slice) in [
        ("environmentContext", &context.environment_context),
        ("coreMemoryContext", &context.core_memory_context),
        ("instructionFilesContext", &context.instruction_files_context),
    ] {
        if let Some(slice) = slice {
            target.insert(key.to_owned(), Value::String(slice.clone()));
        }
    }
    working.reroot(&Value::Object(target));
    working.refresh(view.header, cwd);
    working.finish(view, pending.is_some())
}

/// The in-place re-root of the prompt stored in `header` as one header change (the rewritten
/// fields and the `tier3` / `env` blocks that differ, under the [`SystemBlocks`] keys), and the
/// change that puts back every key it touches as `header` had it (Node's `snapshotPrompt`).
pub fn in_place_reroot_patch(header: &Header, cwd: &str, context: &WorkspaceContext) -> (HeaderChange, HeaderChange) {
    let blocks = SystemBlocks::from_header(header);
    let rewrite = in_place_reroot(&PromptView { header, tier3: blocks.core.as_deref(), env: blocks.env.as_deref() }, cwd, context);
    let mut next = blocks.clone();
    if let Some(core) = rewrite.tier3 {
        next.core = Some(core);
    }
    if let Some(env) = rewrite.env {
        next.env = Some(env);
    }
    let mut change = rewrite.change;
    let written = next.change_from(&blocks);
    change.set.extend(written.set);
    for key in written.unset {
        if !change.unset.contains(&key) {
            change.unset.push(key);
        }
    }
    let mut undo = HeaderChange { set: Map::new(), unset: Vec::new() };
    for key in change.set.keys().chain(change.unset.iter()) {
        match header.get(key) {
            Some(value) => {
                undo.set.insert(key.clone(), value.clone());
            }
            None if !undo.unset.contains(key) => undo.unset.push(key.clone()),
            None => {}
        }
    }
    (change, undo)
}

/// `HostRuntime::reroot_prompt`: the in-place re-root of a loaded session's prompt, landed in one
/// durable header patch; the undo is one patch putting the touched keys back.
pub struct PromptReroot {
    directory: Arc<SessionDirectory>,
    threads: Arc<dyn ThreadState>,
    surface: mixdog_core_base::surface::SurfaceGeneration,
}

impl PromptReroot {
    pub fn new(directory: Arc<SessionDirectory>, threads: Arc<dyn ThreadState>) -> Self {
        Self { directory, threads, surface: mixdog_core_base::surface::SurfaceGeneration::default() }
    }

    /// The surface generation a workspace transition moves (`invalidateCaches()`: the transition's commit and its
    /// undo both end in it, `transition-steps.mjs:166,180,215,229`).
    pub fn with_surface(mut self, surface: mixdog_core_base::surface::SurfaceGeneration) -> Self {
        self.surface = surface;
        self
    }

    /// Re-roots the prompt of `session_id` at `cwd` with `context`'s slices. Rejects when the
    /// session is not loaded or the save fails (nothing changed then).
    pub async fn reroot(&self, session_id: &str, cwd: &str, context: &WorkspaceContext) -> Result<Undo, ScmFailure> {
        let thread = ThreadId::from(session_id);
        self.surface.bump();
        let header = self.directory.handle(&thread).map(|handle| handle.cell.header.load_full()).ok_or_else(|| plain("session: the session is not loaded"))?;
        let (change, back) = in_place_reroot_patch(&header, cwd, context);
        if change.set.is_empty() && change.unset.is_empty() {
            let nothing: Undo = Box::new(|| Box::pin(async { Ok(()) }));
            return Ok(nothing);
        }
        self.threads.patch_header(&thread, change.set, change.unset).await.map_err(port)?;
        let threads = self.threads.clone();
        let surface = self.surface.clone();
        let undo: Undo = Box::new(move || {
            Box::pin(async move {
                let undone = threads.patch_header(&thread, back.set, back.unset).await.map_err(port);
                surface.bump();
                undone
            })
        });
        Ok(undo)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDENS: &str = include_str!("worktree_goldens/reroot_goldens.json");

    fn header_of(state: &Value) -> Header {
        state["header"].as_object().expect("header").clone()
    }

    fn view<'a>(header: &'a Header, state: &'a Value) -> PromptView<'a> {
        PromptView { header, tier3: state["tier3"].as_str(), env: state["env"].as_str() }
    }

    /// The header and messages a rewrite leaves.
    fn landed(before: &Value, rewrite: &PromptRewrite) -> Value {
        let mut header = header_of(before);
        for key in &rewrite.change.unset {
            header.shift_remove(key);
        }
        for (key, value) in &rewrite.change.set {
            header.insert(key.clone(), value.clone());
        }
        let pick = |new: &Option<String>, old: &Value| new.as_ref().map_or(old.clone(), |n| Value::String(n.clone()));
        serde_json::json!({ "header": header, "tier3": pick(&rewrite.tier3, &before["tier3"]), "env": pick(&rewrite.env, &before["env"]) })
    }

    /// Node's `updateSessionRoute` prompt effect, scenario by scenario, byte for byte.
    #[test]
    fn a_route_change_applies_the_staged_reroot_exactly_as_node_does() {
        let cases: Vec<Value> = serde_json::from_str(GOLDENS).expect("goldens");
        assert_eq!(cases.len(), 6);
        for case in &cases {
            let before = &case["before"];
            let header = header_of(before);
            assert!(pending_workspace_reroot(&header).is_some(), "{}: staged", case["name"]);
            let applied = landed(before, &route_prompt_refresh(&view(&header, before), true));
            assert_eq!(applied, case["applied"], "{}: applied", case["name"]);
            let kept = landed(before, &route_prompt_refresh(&view(&header, before), false));
            assert_eq!(kept, case["kept"], "{}: kept", case["name"]);
        }
    }

    /// Node's prompt state as the header holds it: the fields, the `tier3` message under its block
    /// key (`bp3CoreContext` itself in the split layout, `promptTier3` in the combined one) and
    /// the `env` message as `promptEnv`.
    fn stored(state: &Value) -> Header {
        let mut header = header_of(state);
        let split = header.get("bp3EnvSplit") == Some(&Value::Bool(true));
        if let Some(tier3) = state["tier3"].as_str() {
            if split {
                assert_eq!(header.get("bp3CoreContext").and_then(Value::as_str), Some(tier3), "the split tier3 message is bp3CoreContext");
            } else {
                header.insert("promptTier3".to_owned(), Value::String(tier3.to_owned()));
            }
        }
        if let Some(env) = state["env"].as_str() {
            header.insert("promptEnv".to_owned(), Value::String(env.to_owned()));
        }
        header
    }

    fn patched(header: &Header, change: &HeaderChange) -> Header {
        let mut next = header.clone();
        for key in &change.unset {
            next.shift_remove(key);
        }
        for (key, value) in &change.set {
            next.insert(key.clone(), value.clone());
        }
        next
    }

    /// `refreshWorkspacePrompt`'s context: an absent slice is `undefined` (kept).
    fn context_of(context: &Value) -> WorkspaceContext {
        let slice = |key: &str| context.get(key).and_then(Value::as_str).map(str::to_owned);
        WorkspaceContext {
            environment_context: slice("environmentContext"),
            core_memory_context: slice("coreMemoryContext"),
            instruction_files_context: slice("instructionFilesContext"),
        }
    }

    /// Node's `refreshSessionWorkspaceContext` on a session without a conversation
    /// (`fixtures/prompt-reroot`), case by case, byte for byte; the undo puts every touched key
    /// back (`snapshotPrompt`).
    #[test]
    fn a_session_without_a_conversation_is_rerooted_in_place_exactly_as_node_does() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/prompt-reroot/golden.json")).expect("golden");
        let cases = golden["cases"].as_array().expect("cases");
        assert_eq!(cases.len(), 11);
        for case in cases {
            let name = &case["name"];
            assert_eq!(case["before"]["systemOnly"], Value::Bool(true), "{name}: no conversation");
            let before = stored(&case["before"]);
            let cwd = case["context"]["cwd"].as_str().expect("cwd");
            let (change, undo) = in_place_reroot_patch(&before, cwd, &context_of(&case["context"]));
            let after = patched(&before, &change);
            assert_eq!(after, stored(&case["after"]), "{name}: after");
            assert_eq!(patched(&after, &undo), before, "{name}: the undo restores the prompt");
        }
    }

    #[test]
    fn the_pending_read_reports_the_staged_state_and_none_without_one() {
        let cases: Vec<Value> = serde_json::from_str(GOLDENS).expect("goldens");
        let header = header_of(&cases[0]["before"]);
        let pending = pending_workspace_reroot(&header).expect("staged");
        assert_eq!(pending.revision, 1);
        assert_eq!(pending.root_cwd.as_deref(), Some("C:/repo"));
        assert_eq!(pending.target["cwd"], "C:/data/worktrees-v1/abc/fix");
        assert!(pending_workspace_reroot(&header_of(&cases[0]["applied"])).is_none());
    }

    #[test]
    fn a_model_name_is_displayed_as_nodes_session_block_shows_it() {
        assert_eq!(model_display("gpt-5.4-2026-01-02"), "GPT-5.4");
        assert_eq!(model_display("claude-opus-4-1"), "Claude-Opus-4-1");
        assert_eq!(model_display("  "), "");
    }
}
