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
use mixdog_js::js_trim;
use mixdog_protocol::JsonValue;

use super::common::*;
use super::edit_plan::SAME_STRINGS;
use super::edit_plan::apply;
use super::edit_plan::dialect;

const EDIT_SPEC: &str = include_str!("specs/edit.json");

const STALE_DURING_EDIT: &str = "changed on disk during the edit; read it again";

pub struct EditTool {
    spec: ToolSpec,
}

impl EditTool {
    pub fn new() -> Self {
        Self {
            spec: spec(EDIT_SPEC, "Replace exact text in one file.", false, Some("fs-write")),
        }
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
        let raw = arg_str(&args, "file_path").or_else(|| arg_str(&args, "path")).ok_or_else(|| {
            invalid(
                "file_path",
                "required",
                "Error: unknown builtin tool \"edit\" — use `apply_patch` with a `*** Update File:` V4A section.",
            )
        })?;
        let abs = if js_trim(raw).is_empty() { ctx.cwd.clone() } else { resolve_path(&ctx.cwd, raw)? };
        let shown = display_path(abs.as_path(), &ctx.cwd);
        let full = abs.as_path().display().to_string();

        let _locked = lock_write_paths(ctx, &[&abs]).await?;
        let existing = guarded(ctx, "edit", ctx.files.read(ctx.io.interactive, abs.clone(), ReadRange::default())).await?;
        let bytes = match existing {
            Ok(b) => b.bytes,
            Err(e) if e.kind == FsErrorKind::NotFound && old.is_empty() => {
                return create(ctx, &abs, &shown, &full, new).await;
            }
            Err(e) if e.kind == FsErrorKind::NotFound => {
                return Err(unreadable(&full, "target is missing or inaccessible"));
            }
            Err(e) if e.kind == FsErrorKind::IsADirectory => {
                return Err(unreadable(&full, "EISDIR: illegal operation on a directory, read"));
            }
            Err(e) if e.kind == FsErrorKind::PermissionDenied => {
                return Err(unreadable(&full, &format!("EACCES: permission denied, open '{full}'")));
            }
            Err(e) => return Err(fs_failure(&e, &shown)),
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
            write_checked(ctx, &abs, &full, encode_text(new, codec), WritePrecondition::ContentEquals(bytes)).await?;
            return Ok(text_output(format!("Updated {shown} (filled empty file)")));
        }
        let (old, new) = dialect(&content, is_markdown(&abs), old.to_owned(), new.to_owned(), replace_all);
        if old == new {
            return Err(invalid("new_string", "same_as_old", SAME_STRINGS));
        }
        let (next, applied) = apply(&content, &old, &new, replace_all, codec.encoding == Encoding::Utf8)?;
        write_checked(ctx, &abs, &full, encode_text(&next, codec), WritePrecondition::ContentEquals(bytes)).await?;
        Ok(text_output(format!(
            "Updated {shown} ({applied} replacement{})",
            if applied == 1 { "" } else { "s" }
        )))
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
        Err(e) => Err(fs_failure(&e, full)),
    }
}

async fn create(ctx: &ToolContext, abs: &AbsPath, shown: &str, full: &str, new: &str) -> ToolOutcome {
    if let Some(parent) = abs.as_path().parent().and_then(|p| AbsPath::new(p.to_path_buf())) {
        if let Err(e) = guarded(ctx, "edit", ctx.files.create_dir(ctx.io.durability, parent, true)).await? {
            return Err(fs_failure(&e, full));
        }
    }
    write_checked(ctx, abs, full, new.as_bytes().to_vec(), WritePrecondition::Absent).await?;
    Ok(text_output(format!("Created {shown} ({} bytes)", new.len())))
}
