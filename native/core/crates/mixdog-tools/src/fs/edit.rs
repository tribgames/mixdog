//! `edit`: exact-string replacement in one file, with a verbatim excerpt of the
//! current file when the match fails.

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
use mixdog_protocol::JsonValue;

use super::common::*;

const EDIT_SPEC: &str = include_str!("specs/edit.json");

const SAME_STRINGS: &str = "Error: old_string and new_string are exactly the same — no change needed; the file may already contain it, re-read before retrying";

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

// ---- fuzzy line scoring shared with apply_patch ----

pub(crate) fn longest_common_substring(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().take(4000).collect();
    let b: Vec<char> = b.chars().take(4000).collect();
    let mut prev = vec![0usize; b.len() + 1];
    let mut best = 0;
    for x in &a {
        let mut cur = vec![0usize; b.len() + 1];
        for (j, y) in b.iter().enumerate() {
            if x == y {
                cur[j + 1] = prev[j] + 1;
                best = best.max(cur[j + 1]);
            }
        }
        prev = cur;
    }
    best
}

fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn score_similar(candidate: &str, target: &str) -> f64 {
    let cand = squash(candidate);
    let want = squash(target);
    if cand.is_empty() || want.is_empty() {
        return 0.0;
    }
    if cand == want {
        return 100_000.0;
    }
    let mut score = longest_common_substring(&cand, &want) as f64 * 20.0;
    if cand.contains(&want) || want.contains(&cand) {
        score += 5000.0 + cand.chars().count().min(want.chars().count()) as f64;
    }
    let mut seen = std::collections::BTreeSet::new();
    for word in want.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$')) {
        if word.chars().count() > 1 && seen.insert(word) && cand.contains(word) {
            score += ((word.chars().count() * 12) as f64).min(200.0);
        }
    }
    let (lc, lw) = (cand.chars().count(), want.chars().count());
    if lc.max(lw) < 80 {
        score -= lc.abs_diff(lw) as f64;
    }
    score
}

/// Index of the line most like `expected`, nearest `preferred` on ties.
pub(crate) fn nearest_line(lines: &[String], expected: &str, preferred: usize) -> Option<usize> {
    if expected.trim().is_empty() {
        return None;
    }
    let mut best: Option<(f64, usize)> = None;
    for (i, line) in lines.iter().enumerate() {
        let s = score_similar(line, expected) - i.abs_diff(preferred) as f64 * 0.01;
        if best.is_none_or(|(b, _)| s > b) {
            best = Some((s, i));
        }
    }
    best.filter(|(s, _)| *s > 0.0).map(|(_, i)| i)
}

pub(crate) fn compact_preview(line: &str, max: usize) -> String {
    let text = line.replace('\t', "\\t");
    if text.chars().count() > max {
        let head: String = text.chars().take(max - 1).collect();
        format!("{head}…")
    } else {
        text
    }
}

// ---- edit ----

fn excerpt_center(source: &str, lines: &[String], old: &str) -> Option<usize> {
    if !old.is_empty() {
        if let Some(at) = source.find(old) {
            return Some(source[..at].matches('\n').count());
        }
    }
    let mut tokens: Vec<&str> = old.split_whitespace().filter(|t| t.chars().count() >= 4).collect();
    tokens.sort_by_key(|t| std::cmp::Reverse(t.chars().count()));
    for token in tokens.into_iter().take(5) {
        if let Some(hit) = lines.iter().position(|l| l.contains(token)) {
            return Some(hit);
        }
    }
    let wanted = old.split('\n').find(|l| !l.trim().is_empty())?;
    nearest_line(lines, wanted, 0)
}

fn failure_excerpt(content: &str, old: &str) -> String {
    let source = content.replace("\r\n", "\n");
    let lines: Vec<String> = source.split('\n').map(str::to_owned).collect();
    let Some(center) = excerpt_center(&source, &lines, old) else {
        return format!(
            "\ncurrent file has {} line(s) and contains nothing resembling old_string — verify the path and re-read before retrying.",
            lines.len()
        );
    };
    let start = center.saturating_sub(3);
    let end = lines.len().min(start + 10);
    let mut rows: Vec<String> = Vec::new();
    let mut chars = 0;
    for raw in &lines[start..end] {
        let shown = if raw.chars().count() > 240 {
            format!("{}…", raw.chars().take(240).collect::<String>())
        } else {
            raw.clone()
        };
        chars += shown.chars().count() + 1;
        if chars > 3000 {
            rows.push("…".to_owned());
            break;
        }
        rows.push(shown);
    }
    if rows.is_empty() {
        return String::new();
    }
    format!(
        "\ncurrent file excerpt lines {}-{} (use exact current text for retry):\n{}",
        start + 1,
        start + rows.len(),
        rows.join("\n")
    )
}

fn strip_trailing_blanks(text: &str) -> String {
    text.split('\n')
        .map(|seg| match seg.strip_suffix('\r') {
            Some(body) => format!("{}\r", body.trim_end_matches([' ', '\t'])),
            None => seg.trim_end_matches([' ', '\t']).to_owned(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn conflict(matches: u32, text: String) -> ToolError {
    fail(ToolErrorCode::Conflict { matches }, text)
}

/// The edited text and replacement count, or the model-facing failure.
fn plan_edit(
    content: &str,
    old: &str,
    new: &str,
    markdown: bool,
    replace_all: bool,
) -> Result<(String, usize), ToolError> {
    let (mut old, mut new) = (old.to_owned(), new.to_owned());
    if content.contains("\r\n") && !old.contains('\r') {
        old = old.replace('\n', "\r\n");
        new = new.replace("\r\n", "\n").replace('\n', "\r\n");
    }
    if !markdown {
        new = strip_trailing_blanks(&new);
    }
    if new.is_empty() && !old.ends_with('\n') {
        for tail in ["\r\n", "\n"] {
            if content.contains(&format!("{old}{tail}")) {
                old.push_str(tail);
                break;
            }
        }
    }
    let positions: Vec<usize> = content.match_indices(&old).map(|(i, _)| i).collect();
    let excerpt = |msg: &str| format!("Error: edit failed ({msg}){}", failure_excerpt(content, &old));
    match positions.len() {
        0 => return Err(conflict(0, excerpt("old_string not found"))),
        n if n > 1 && !replace_all => {
            let mut at: Vec<String> = positions
                .iter()
                .take(8)
                .map(|p| (content[..*p].matches('\n').count() + 1).to_string())
                .collect();
            if n > 8 {
                at.push("…".to_owned());
            }
            return Err(conflict(
                n as u32,
                format!(
                    "Error: edit failed (old_string found {n} times at lines {}; pass replace_all:true or extend old_string){}",
                    at.join(", "),
                    failure_excerpt(content, &old)
                ),
            ));
        }
        _ => {}
    }
    let applied = if replace_all { positions.len() } else { 1 };
    let out = if replace_all {
        content.replace(&old, &new)
    } else {
        content.replacen(&old, &new, 1)
    };
    Ok((out, applied))
}

fn stale_text(shown: &str) -> String {
    format!("Error: {shown} changed on disk during the edit; read it again")
}

#[async_trait]
impl Tool for EditTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let raw = arg_str(&args, "file_path")
            .or_else(|| arg_str(&args, "path"))
            .ok_or_else(|| invalid("file_path", "required", "Error: edit requires file_path"))?;
        let old = arg_str(&args, "old_string").unwrap_or("");
        let new = arg_str(&args, "new_string")
            .ok_or_else(|| invalid("new_string", "required", "Error: edit requires new_string"))?;
        if old == new {
            return Err(invalid("new_string", "same_as_old", SAME_STRINGS));
        }
        let abs = resolve_path(&ctx.cwd, raw)?;
        let shown = display_path(abs.as_path(), &ctx.cwd);
        let replace_all = arg_bool(&args, "replace_all");

        let _locked = lock_write_paths(ctx, &[&abs]).await?;
        let existing = guarded(ctx, "edit", ctx.files.read(ctx.io.interactive, abs.clone(), ReadRange::default())).await?;
        let bytes = match existing {
            Ok(b) => b.bytes,
            Err(e) if e.kind == FsErrorKind::NotFound && old.is_empty() => {
                return create(ctx, &abs, &shown, new).await;
            }
            Err(e) => return Err(fs_failure(&e, &shown)),
        };
        let (content, codec) = decode_text(&bytes).map_err(|reason| {
            fail(
                ToolErrorCode::NotText { reason },
                format!(
                    "Error: cannot edit {shown}: its bytes are not decidable text (invalid UTF-8, malformed UTF-16 with an odd trailing byte, or NUL bytes without a consistent UTF-16 pattern), so any edit would alter bytes outside the replacement. Convert the encoding first."
                ),
            )
        })?;
        let (next, applied) = if old.is_empty() {
            if !content.is_empty() {
                return Err(conflict(
                    0,
                    "Error: edit failed (old_string is empty but the file is not empty; empty old_string only creates a missing file or fills an empty one)".to_owned(),
                ));
            }
            (new.to_owned(), 1)
        } else {
            let md = abs.as_path().extension().is_some_and(|e| {
                e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("mdx")
            });
            plan_edit(&content, old, new, md, replace_all)?
        };
        write_checked(ctx, &abs, &shown, encode_text(&next, codec), WritePrecondition::ContentEquals(bytes)).await?;
        Ok(text_output(format!(
            "Updated {shown} ({applied} replacement{})",
            if applied == 1 { "" } else { "s" }
        )))
    }
}

pub(crate) async fn write_checked(
    ctx: &ToolContext,
    abs: &AbsPath,
    shown: &str,
    content: Vec<u8>,
    precondition: WritePrecondition,
) -> Result<(), ToolError> {
    let request = WriteRequest { path: abs.clone(), content, precondition };
    match guarded(ctx, "edit", ctx.files.write(ctx.io.durability, request)).await? {
        Ok(_) => Ok(()),
        Err(e) if matches!(e.kind, FsErrorKind::PreconditionFailed { .. }) => Err(fail(
            ToolErrorCode::Stale { expected: shown.to_owned(), actual: "changed".to_owned() },
            stale_text(shown),
        )),
        Err(e) => Err(fs_failure(&e, shown)),
    }
}

async fn create(ctx: &ToolContext, abs: &AbsPath, shown: &str, new: &str) -> ToolOutcome {
    if let Some(parent) = abs.as_path().parent().and_then(|p| AbsPath::new(p.to_path_buf())) {
        match guarded(ctx, "edit", ctx.files.create_dir(ctx.io.durability, parent, true)).await? {
            Ok(()) => {}
            Err(e) => return Err(fs_failure(&e, shown)),
        }
    }
    write_checked(ctx, abs, shown, new.as_bytes().to_vec(), WritePrecondition::Absent).await?;
    Ok(text_output(format!("Created {shown} ({} bytes)", new.len())))
}
