//! `edit`: exact-string replacement in one file, with a verbatim excerpt of the
//! current file when the match fails. The text pipeline lives in `edit_plan`.

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::FsErrorKind;
use mixdog_core_api::domain::fs::ReadRange;
use mixdog_core_api::domain::fs::WritePrecondition;
use mixdog_core_api::domain::fs::WriteRequest;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_js::js_object_keys;
use mixdog_protocol::JsonValue;

use super::common::*;
use super::os_error::read_message;
use super::os_error::write_message;
use crate::orch::util::spec_from_def;
use super::patch_review::committed_edit;
use super::patch_review::note_edit;
use super::read_state::FileVersion;
use super::read_state::ReadState;
use super::edit_plan::SAME_STRINGS;
use super::edit_plan::apply;
use super::edit_plan::dialect;

const EDIT_SPEC: &str = include_str!("specs/edit.json");

/// The tool names of other agent CLIs that `edit` answers to (`external-tool-adapters.mjs` `STR_REPLACE_NAMES`).
const STR_REPLACE_ALIASES: [&str; 4] = ["strreplace", "str_replace", "str_replace_editor", "search_replace"];

const STALE_DURING_EDIT: &str = "changed on disk during the edit; read it again";

pub struct EditTool {
    spec: ToolSpec,
    /// What the session remembers of its files; an edit tells it what it wrote.
    state: Option<std::sync::Arc<ReadState>>,
}

impl EditTool {
    pub fn new() -> Self {
        let mut spec = spec_from_def(EDIT_SPEC, false, &["fs-write"]);
        // The names other agent CLIs give the same string replacement (`STR_REPLACE_NAMES`), in any case.
        spec.aliases = STR_REPLACE_ALIASES.iter().map(|name| (*name).to_owned()).collect();
        Self { spec, state: None }
    }

    /// The read state shared with `read`, keyed by the call's thread.
    #[must_use]
    pub fn with_state(mut self, state: std::sync::Arc<ReadState>) -> Self {
        self.state = Some(state);
        self
    }
}

impl Default for EditTool {
    fn default() -> Self {
        Self::new()
    }
}

/// `old_string` / `new_string`, each also accepted as `old_str` / `new_str` when the canonical
/// key is absent; both present with different values is ambiguous.
fn string_args(args: &JsonValue) -> Result<(&str, &str), ToolError> {
    let mut chosen: [Option<&JsonValue>; 2] = [None, None];
    for (slot, (canonical, alias)) in [("old_string", "old_str"), ("new_string", "new_str")].into_iter().enumerate() {
        let (c, a) = (args.get(canonical), args.get(alias));
        if let (Some(c), Some(a)) = (c, a) {
            if c != a {
                return Err(invalid(
                    canonical,
                    "ambiguous",
                    format!("Error: edit received both {canonical} and {alias} with different values; pass only {canonical}"),
                ));
            }
        }
        chosen[slot] = c.or(a);
    }
    match chosen {
        [Some(JsonValue::String(old)), Some(JsonValue::String(new))] => Ok((old, new)),
        _ => {
            let keys = args.as_object().map(|m| js_object_keys(m).into_iter().map(String::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default();
            Err(invalid("old_string", "required", format!("Error: edit requires string old_string and new_string (got keys: {keys})")))
        }
    }
}

fn replace_all_arg(args: &JsonValue) -> bool {
    match args.get("replace_all") {
        Some(JsonValue::Bool(b)) => *b,
        Some(JsonValue::String(s)) => s.to_lowercase() == "true",
        _ => false,
    }
}

fn is_markdown(path: &AbsPath) -> bool {
    let name = path.as_path().to_string_lossy().to_ascii_lowercase();
    name.ends_with(".md") || name.ends_with(".mdx")
}

#[async_trait]
impl Tool for EditTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let (old, new) = string_args(&args)?;
        if old == new {
            return Err(invalid("new_string", "same_as_old", SAME_STRINGS));
        }
        let replace_all = replace_all_arg(&args);
        // An empty target is no target (Node tests the argument's truthiness).
        let raw = arg_str(&args, "file_path").filter(|p| !p.is_empty()).or_else(|| arg_str(&args, "path").filter(|p| !p.is_empty())).ok_or_else(|| {
            invalid("file_path", "required", crate::foreign::refusal(ctx.options.called_as.as_deref().unwrap_or(&self.spec.name)))
        })?;
        let abs = resolve_write_target(ctx, raw).await?;
        let shown = display_path(abs.as_path(), &ctx.cwd);
        let full = abs.as_path().display().to_string();

        // `withEditTargetLock` asks `existsSync` before it locks anything: a target that cannot be stat'ed at all (a
        // missing file, an over-long name, a denied parent) is missing or inaccessible, whatever the cause.
        if !old.is_empty() && ctx.files.stat(ctx.io.interactive, abs.clone()).await.is_err() {
            return Err(unreadable(&full, "target is missing or inaccessible"));
        }
        let _locked = lock_edit_target(ctx, &abs).await?;
        let pre = match &self.state {
            Some(_) => ctx.files.stat(ctx.io.interactive, abs.clone()).await.ok().and_then(|s| FileVersion::of(&s)),
            None => None,
        };
        let existing = guarded(ctx, "edit", ctx.files.read(ctx.io.interactive, abs.clone(), ReadRange::default())).await?;
        let bytes = match existing {
            Ok(b) => b.bytes,
            Err(e) if e.kind == FsErrorKind::NotFound && old.is_empty() => {
                return create(ctx, self.state.as_deref(), &abs, &shown, &full, new).await;
            }
            Err(e) if e.kind == FsErrorKind::NotFound => {
                return Err(unreadable(&full, "target is missing or inaccessible"));
            }
            Err(e) if e.kind == FsErrorKind::IsADirectory => {
                return Err(unreadable(&full, "EISDIR: illegal operation on a directory, read"));
            }
            // Node `readEditTarget`: the failed read's own message (a file held open without sharing is EBUSY;
            // a denied read is EPERM on Windows, as libuv names ERROR_ACCESS_DENIED, and EACCES elsewhere).
            Err(e) => return Err(unreadable(&full, &read_message(&e, abs.as_path()))),
        };
        let (content, codec) = decode_text(&bytes).map_err(|reason| {
            fail(
                ToolErrorCode::NotText { reason },
                format!(
                    "Error: cannot edit {}: its bytes are not decidable text (invalid UTF-8, malformed UTF-16 with an odd trailing byte, or NUL bytes without a consistent UTF-16 pattern), so any edit would alter bytes outside the replacement. Convert the encoding first.",
                    fwd(abs.as_path())
                ),
            )
        })?;
        if old.is_empty() {
            if !content.is_empty() {
                return Err(fail(
                    ToolErrorCode::Conflict { matches: 0 },
                    format!("Error: cannot create {full}: file exists: to replace it entirely pass its current content as old_string (read it first); to change part, pass that part as old_string with the replacement as new_string"),
                ));
            }
            let after = encode_text(new, codec);
            write_checked(ctx, &abs, &full, after.clone(), WritePrecondition::ContentEquals(bytes.clone())).await?;
            if let Some(state) = &self.state {
                note_edit(ctx, state, &abs, pre, &after).await;
            }
            return Ok(committed_edit(ctx, &abs, Some(bytes), after, text_output(format!("Updated {shown} (filled empty file)"))).await);
        }
        // Dialect normalization is skipped for a same-anchor batch member: its occurrence count is bound to the original
        // old_string (`adaptStrReplace`).
        let occupation = ctx.options.edit_occurrence.map(|o| o.expected);
        let (old, new) = match occupation {
            Some(_) => (old.to_owned(), new.to_owned()),
            None => dialect(&content, is_markdown(&abs), old.to_owned(), new.to_owned(), replace_all),
        };
        if old == new {
            return Err(invalid("new_string", "same_as_old", SAME_STRINGS));
        }
        let (next, applied) = apply(&content, &old, &new, replace_all, codec.encoding == Encoding::Utf8, occupation)?;
        let after = encode_text(&next, codec);
        write_checked(ctx, &abs, &full, after.clone(), WritePrecondition::ContentEquals(bytes.clone())).await?;
        if let Some(state) = &self.state {
            note_edit(ctx, state, &abs, pre, &after).await;
        }
        let text = text_output(format!("Updated {shown} ({applied} replacement{})", if applied == 1 { "" } else { "s" }));
        Ok(committed_edit(ctx, &abs, Some(bytes), after, text).await)
    }
}

fn unreadable(full: &str, why: &str) -> ToolError {
    fail(ToolErrorCode::Io { os_code: None }, format!("Error: cannot read {full} ({why})"))
}

async fn write_checked(
    ctx: &ToolContext,
    abs: &AbsPath,
    full: &str,
    content: Vec<u8>,
    precondition: WritePrecondition,
) -> Result<(), ToolError> {
    let created = matches!(precondition, WritePrecondition::Absent);
    let request = WriteRequest { path: abs.clone(), content, precondition };
    match guarded(ctx, "edit", ctx.files.write(ctx.io.durability, request)).await? {
        Ok(_) => Ok(()),
        Err(e) if matches!(e.kind, FsErrorKind::PreconditionFailed { .. }) => {
            let why = if created { "was created concurrently; read it before editing" } else { STALE_DURING_EDIT };
            Err(fail(
                ToolErrorCode::Stale { expected: full.to_owned(), actual: "changed".to_owned() },
                format!("Error: {full} {why}"),
            ))
        }
        // Node `createEditTarget` writes with the in-process `atomicWrite`, whose message the adapter
        // wraps as `edit failed (…)` (`tryExecuteExternalToolAdapter`).
        Err(e) if created => Err(fs_failure_worded(&e, full, format!("Error: edit failed ({})", write_message(&e, abs.as_path())))),
        Err(e) => Err(fs_failure(&e, full)),
    }
}

async fn create(ctx: &ToolContext, state: Option<&ReadState>, abs: &AbsPath, shown: &str, full: &str, new: &str) -> ToolOutcome {
    if let Some(parent) = abs.as_path().parent().and_then(|p| AbsPath::new(p.to_path_buf())) {
        // Node `createEditTarget`: a parent that cannot be made is surfaced by the write.
        let _ = guarded(ctx, "edit", ctx.files.create_dir(ctx.io.durability, parent, true)).await?;
    }
    write_checked(ctx, abs, full, new.as_bytes().to_vec(), WritePrecondition::Absent).await?;
    if let Some(state) = state {
        note_edit(ctx, state, abs, None, new.as_bytes()).await;
    }
    Ok(committed_edit(ctx, abs, None, new.as_bytes().to_vec(), text_output(format!("Created {shown} ({} bytes)", new.len()))).await)
}

/// The tool names of other agent CLIs that [`WriteTool`] answers to (`WRITE_NAMES`).
const WRITE_ALIASES: [&str; 2] = ["create_file", "createfile"];

/// `write` and its foreign spellings (`adaptWrite`): the whole content of a file, written where it is or created. It is not in
/// any tool list: a model trained on another CLI calls it by that CLI's name, and Node's executor answers the call.
pub struct WriteTool {
    spec: ToolSpec,
    state: Option<std::sync::Arc<ReadState>>,
}

impl WriteTool {
    pub fn new() -> Self {
        let spec = ToolSpec {
            name: "write".to_owned(),
            title: None,
            aliases: WRITE_ALIASES.iter().map(|name| (*name).to_owned()).collect(),
            description: "Write the whole content of one file, creating it when it is missing.".to_owned(),
            trigger: None,
            public: false,
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "file_path": { "type": "string" },
                    "contents": { "type": "string" },
                    "content": { "type": "string" },
                    "file_text": { "type": "string" }
                }
            }),
            annotations: mixdog_core_api::domain::tool::ToolAnnotations {
                read_only_hint: Some(false),
                destructive_hint: Some(true),
                idempotent_hint: Some(false),
                open_world_hint: Some(false),
                ..Default::default()
            },
            parallel_safe: false,
            exclusive_with: vec![mixdog_core_api::domain::tool::ToolGroup("fs-write".to_owned())],
        };
        Self { spec, state: None }
    }

    /// The read state shared with `read`, keyed by the call's thread.
    #[must_use]
    pub fn with_state(mut self, state: std::sync::Arc<ReadState>) -> Self {
        self.state = Some(state);
        self
    }
}

impl Default for WriteTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for WriteTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let not_adapted = || invalid("path", "required", crate::foreign::refusal(ctx.options.called_as.as_deref().unwrap_or(&self.spec.name)));
        let contents = ["contents", "content", "file_text"]
            .iter()
            .find_map(|key| args.get(*key).filter(|v| !v.is_null()))
            .and_then(JsonValue::as_str)
            .ok_or_else(not_adapted)?;
        let raw = args
            .get("path")
            .filter(|v| !v.is_null())
            .or_else(|| args.get("file_path"))
            .and_then(JsonValue::as_str)
            .filter(|p| !p.is_empty())
            .ok_or_else(not_adapted)?;
        let abs = resolve_write_target(ctx, raw).await?;
        let full = abs.as_path().display().to_string();
        let _locked = lock_edit_target(ctx, &abs).await?;
        let stat = ctx.files.stat(ctx.io.interactive, abs.clone()).await.ok();
        // Node tests existence (existsSync), not readability: a target that cannot be read is still "Updated".
        let existed = stat.is_some();
        let pre = match &self.state {
            Some(_) => stat.and_then(|s| FileVersion::of(&s)),
            None => None,
        };
        let before = ctx.files.read(ctx.io.interactive, abs.clone(), ReadRange::default()).await.ok().map(|read| read.bytes);
        if let Some(parent) = abs.as_path().parent().and_then(|p| AbsPath::new(p.to_path_buf())) {
            let _ = guarded(ctx, "write", ctx.files.create_dir(ctx.io.durability, parent, true)).await?;
        }
        let request = WriteRequest { path: abs.clone(), content: contents.as_bytes().to_vec(), precondition: WritePrecondition::Unconditional };
        match guarded(ctx, "write", ctx.files.write(ctx.io.durability, request)).await? {
            Ok(_) => {}
            Err(e) => {
                return Err(fs_failure_worded(&e, &full, format!("Error: write failed ({})", write_message(&e, abs.as_path()))));
            }
        }
        if let Some(state) = &self.state {
            note_edit(ctx, state, &abs, pre, contents.as_bytes()).await;
        }
        let text = format!("{} {full} ({} bytes)", if existed { "Updated" } else { "Created" }, contents.len());
        Ok(committed_edit(ctx, &abs, before, contents.as_bytes().to_vec(), text_output(text)).await)
    }
}
