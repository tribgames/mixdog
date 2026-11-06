//! `apply_patch`: V4A patches (`*** Begin Patch` … `*** End Patch`) over one
//! or more files, validated in full before any file is written.

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
use super::hints::compact_preview;
use super::hints::nearest_line;

const PATCH_SPEC: &str = include_str!("specs/apply_patch.json");
const EXCERPT_MAX_LINES: usize = 14;
const EXCERPT_MAX_CHARS: usize = 1000;

pub struct ApplyPatchTool {
    spec: ToolSpec,
}

impl ApplyPatchTool {
    pub fn new() -> Self {
        Self {
            spec: spec(PATCH_SPEC, "Apply a V4A patch to one or more files.", false, Some("fs-write")),
        }
    }
}

impl Default for ApplyPatchTool {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Default)]
struct Hunk {
    anchors: Vec<String>,
    old: Vec<String>,
    new: Vec<String>,
    removed: usize,
    added: usize,
    eof: bool,
}

impl Hunk {
    fn has_body(&self) -> bool {
        !self.old.is_empty() || !self.new.is_empty() || self.eof
    }
}

enum Section {
    Add { path: String, lines: Vec<String> },
    Delete { path: String },
    Update { path: String, move_to: Option<String>, hunks: Vec<Hunk> },
}

fn parse_error(message: impl Into<String>) -> ToolError {
    invalid(
        "patch",
        "parse",
        format!("Error: apply_patch: V4A parse failed — {}", message.into()),
    )
}

fn parse(patch: &str) -> Result<Vec<Section>, ToolError> {
    let text = patch.replace("\r\n", "\n");
    let mut lines = text.split('\n').peekable();
    loop {
        match lines.next() {
            Some(l) if l.trim() == "*** Begin Patch" => break,
            Some(_) => {}
            None => return Err(parse_error("missing *** Begin Patch")),
        }
    }
    let header = |l: &str, key: &str| l.strip_prefix(key).map(|p| p.trim().to_owned());
    let mut sections = Vec::new();
    while let Some(line) = lines.next() {
        if line.trim() == "*** End Patch" {
            return Ok(sections);
        }
        if line.trim().is_empty() {
            continue;
        }
        if let Some(path) = header(line, "*** Add File:") {
            let mut body = Vec::new();
            while let Some(next) = lines.peek() {
                if next.starts_with("*** ") {
                    break;
                }
                body.push(next.strip_prefix('+').unwrap_or(next).to_owned());
                lines.next();
            }
            while body.last().is_some_and(|l| l.is_empty()) && body.len() > 1 {
                body.pop();
            }
            sections.push(Section::Add { path, lines: body });
        } else if let Some(path) = header(line, "*** Delete File:") {
            sections.push(Section::Delete { path });
        } else if let Some(path) = header(line, "*** Update File:") {
            let mut move_to = None;
            if let Some(next) = lines.peek() {
                if let Some(dest) = header(next, "*** Move to:") {
                    move_to = Some(dest);
                    lines.next();
                }
            }
            let mut hunks: Vec<Hunk> = Vec::new();
            let mut cur = Hunk::default();
            while let Some(next) = lines.peek().copied() {
                if next.starts_with("*** ") && next.trim() != "*** End of File" {
                    break;
                }
                lines.next();
                if next.trim() == "*** End of File" {
                    cur.eof = true;
                } else if let Some(anchor) = next.strip_prefix("@@") {
                    if cur.has_body() {
                        hunks.push(std::mem::take(&mut cur));
                    }
                    let anchor = anchor.trim();
                    if !anchor.is_empty() {
                        cur.anchors.push(anchor.to_owned());
                    }
                } else if let Some(rest) = next.strip_prefix('-') {
                    cur.old.push(rest.to_owned());
                    cur.removed += 1;
                } else if let Some(rest) = next.strip_prefix('+') {
                    cur.new.push(rest.to_owned());
                    cur.added += 1;
                } else {
                    let ctx = next.strip_prefix(' ').unwrap_or(next).to_owned();
                    cur.old.push(ctx.clone());
                    cur.new.push(ctx);
                }
            }
            if cur.has_body() {
                hunks.push(cur);
            }
            // Blank context lines the splitter saw after the last hunk are not content.
            if hunks.is_empty() && move_to.is_none() {
                return Err(parse_error(format!("V4A section {path} has no hunks")));
            }
            sections.push(Section::Update { path, move_to, hunks });
        } else {
            return Err(parse_error(format!("unexpected line {:?}", compact_preview(line, 80))));
        }
    }
    Ok(sections)
}

// ---- matching ----

type Norm = fn(&str) -> String;

fn norm_exact(s: &str) -> String {
    s.to_owned()
}
fn norm_end(s: &str) -> String {
    s.trim_end().to_owned()
}
fn norm_trim(s: &str) -> String {
    s.trim().to_owned()
}

fn starts(lines: &[String], needle: &[String], from: usize, norm: Norm, cap: usize) -> Vec<usize> {
    let want: Vec<String> = needle.iter().map(|l| norm(l)).collect();
    let mut out = Vec::new();
    if needle.len() > lines.len() {
        return out;
    }
    for i in from..=lines.len() - needle.len() {
        if want.iter().enumerate().all(|(k, w)| norm(&lines[i + k]) == *w) {
            out.push(i);
            if out.len() >= cap {
                break;
            }
        }
    }
    out
}

fn find_sequence(lines: &[String], needle: &[String], from: usize, eof: bool, fuzzy: bool) -> Option<usize> {
    let mut min_start = from;
    if eof && needle.len() <= lines.len() {
        min_start = min_start.max(lines.len() - needle.len());
    }
    let tiers: &[Norm] = if fuzzy { &[norm_exact, norm_end, norm_trim] } else { &[norm_exact] };
    for (tier, norm) in tiers.iter().enumerate() {
        let found = starts(lines, needle, min_start, *norm, usize::MAX);
        if found.is_empty() || (tier > 0 && found.len() != 1) {
            continue;
        }
        return found.first().copied();
    }
    if fuzzy && !eof && min_start > 0 {
        let found = starts(lines, needle, 0, norm_exact, 2);
        if found.len() == 1 {
            return found.first().copied();
        }
    }
    None
}

fn source_excerpt(lines: &[String], center: usize, span: usize) -> String {
    if lines.is_empty() {
        return String::new();
    }
    let want = (span + 4).clamp(6, EXCERPT_MAX_LINES);
    let before = 3.min(want / 3);
    let start = center.saturating_sub(before).min(lines.len().saturating_sub(want));
    let end = lines.len().min(start + want);
    let mut out = Vec::new();
    let mut chars = 0;
    for (i, line) in lines.iter().enumerate().take(end).skip(start) {
        let text = format!("{:>5}| {}", i + 1, compact_preview(line, 120));
        chars += text.chars().count() + 1;
        if chars > EXCERPT_MAX_CHARS {
            out.push("     | …".to_owned());
            break;
        }
        out.push(text);
    }
    format!(
        "\ncurrent file lines {}-{} (verbatim — build the retry from these):\n{}",
        start + 1,
        start + out.len(),
        out.join("\n")
    )
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

fn context_miss(path: &str, hunk: &Hunk, lines: &[String], preferred: usize) -> ToolError {
    let locator = if hunk.anchors.is_empty() { "(no anchor)".to_owned() } else { hunk.anchors.join(" > ") };
    let mut parts = Vec::new();
    let mut center = None;
    if let Some(expected) = hunk.old.iter().find(|l| !l.trim().is_empty()) {
        parts.push(format!("expected first old line: {}", json_str(&compact_preview(expected, 140))));
        if let Some(i) = nearest_line(lines, expected, preferred) {
            parts.push(format!("nearest line {}: {}", i + 1, json_str(&compact_preview(&lines[i], 140))));
            center = Some(i);
        }
    }
    parts.push("use exact current context or a broader @@ anchor; no stubs.".to_owned());
    let center = center.or((preferred > 0).then_some(preferred)).unwrap_or(0);
    let center = if lines.is_empty() { 0 } else { center };
    parse_error(format!(
        "V4A hunk {path}: context not found: {locator}; {} Copy the context lines verbatim from the excerpt below — do not retype them from memory.{}",
        parts.join("; "),
        source_excerpt(lines, center, hunk.old.len())
    ))
}

struct Applied {
    text: String,
    added: usize,
    removed: usize,
}

fn apply_update(path: &str, content: &str, hunks: &[Hunk], fuzzy: bool) -> Result<Applied, ToolError> {
    let crlf = content.contains("\r\n");
    let trailing = content.ends_with('\n');
    let mut lines: Vec<String> = content
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_owned())
        .collect();
    if trailing {
        lines.pop();
    }
    let (mut cursor, mut added, mut removed) = (0usize, 0usize, 0usize);
    for hunk in hunks {
        let mut anchor_line = 0;
        for anchor in &hunk.anchors {
            let want = anchor.trim();
            let at = (cursor..lines.len())
                .find(|i| lines[*i].trim() == want)
                .or_else(|| (cursor..lines.len()).find(|i| lines[*i].contains(want)));
            let Some(at) = at else {
                return Err(parse_error(format!(
                    "V4A hunk {path}: anchor not found: {}; use an existing @@ anchor from the current file or add exact context lines; no stubs.{}",
                    json_str(anchor),
                    source_excerpt(&lines, cursor.min(lines.len().saturating_sub(1)), 1)
                )));
            };
            cursor = at + 1;
            anchor_line = at;
        }
        let start = if hunk.old.is_empty() {
            if hunk.anchors.is_empty() || hunk.eof { lines.len() } else { cursor }
        } else {
            match find_sequence(&lines, &hunk.old, cursor, hunk.eof, fuzzy) {
                Some(i) => i,
                None => return Err(context_miss(path, hunk, &lines, anchor_line)),
            }
        };
        lines.splice(start..start + hunk.old.len(), hunk.new.iter().cloned());
        cursor = start + hunk.new.len();
        added += hunk.added;
        removed += hunk.removed;
    }
    let eol = if crlf { "\r\n" } else { "\n" };
    let mut text = lines.join(eol);
    if trailing || content.is_empty() {
        text.push_str(eol);
    }
    Ok(Applied { text, added, removed })
}

fn summary(kind: &str, shown: &str, added: usize, removed: usize) -> String {
    let mut parts = Vec::new();
    if added > 0 {
        parts.push(format!("+{added}"));
    }
    if removed > 0 {
        parts.push(format!("-{removed}"));
    }
    if parts.is_empty() {
        format!("  OK {kind} {shown}")
    } else {
        format!("  OK {kind} {shown} — {}", parts.join("/"))
    }
}

struct Plan {
    writes: Vec<WriteRequest>,
    removes: Vec<AbsPath>,
    report: Vec<String>,
}

async fn read_text(ctx: &ToolContext, abs: &AbsPath, shown: &str) -> Result<(Vec<u8>, String, Codec), ToolError> {
    let bytes = match guarded(ctx, "apply_patch", ctx.files.read(ctx.io.interactive, abs.clone(), ReadRange::default())).await? {
        Ok(b) => b.bytes,
        Err(e) if e.kind == FsErrorKind::NotFound => {
            return Err(parse_error(format!("V4A hunk {shown}: file does not exist (ENOENT)")));
        }
        Err(e) => return Err(fs_failure(&e, shown)),
    };
    let (text, codec) = decode_text(&bytes).map_err(|reason| {
        fail(
            ToolErrorCode::NotText { reason },
            format!("Error: apply_patch: {shown} is not decidable text; convert the encoding first."),
        )
    })?;
    Ok((bytes, text, codec))
}

async fn build_plan(ctx: &ToolContext, base: &AbsPath, sections: &[Section], fuzzy: bool) -> Result<Plan, ToolError> {
    let mut plan = Plan { writes: Vec::new(), removes: Vec::new(), report: Vec::new() };
    let shown_of = |abs: &AbsPath| display_path(abs.as_path(), &ctx.cwd);
    for section in sections {
        match section {
            Section::Add { path, lines } => {
                let abs = resolve_path(base, path)?;
                let shown = shown_of(&abs);
                let mut text = lines.join("\n");
                text.push('\n');
                plan.report.push(summary("Add", &shown, lines.len(), 0));
                plan.writes.push(WriteRequest {
                    path: abs,
                    content: text.into_bytes(),
                    precondition: WritePrecondition::Absent,
                });
            }
            Section::Delete { path } => {
                let abs = resolve_path(base, path)?;
                let shown = shown_of(&abs);
                let (_, text, _) = read_text(ctx, &abs, &shown).await?;
                plan.report.push(summary("Delete", &shown, 0, text.lines().count()));
                plan.removes.push(abs);
            }
            Section::Update { path, move_to, hunks } => {
                let abs = resolve_path(base, path)?;
                let shown = shown_of(&abs);
                let (bytes, text, codec) = read_text(ctx, &abs, &shown).await?;
                let applied = apply_update(&shown, &text, hunks, fuzzy)?;
                let content = encode_text(&applied.text, codec);
                match move_to {
                    Some(dest) => {
                        let to = resolve_path(base, dest)?;
                        plan.report.push(summary("Move", &format!("{shown} → {}", shown_of(&to)), applied.added, applied.removed));
                        plan.writes.push(WriteRequest { path: to, content, precondition: WritePrecondition::Absent });
                        plan.removes.push(abs);
                    }
                    None => {
                        plan.report.push(summary("Modify", &shown, applied.added, applied.removed));
                        plan.writes.push(WriteRequest {
                            path: abs,
                            content,
                            precondition: WritePrecondition::ContentEquals(bytes),
                        });
                    }
                }
            }
        }
    }
    Ok(plan)
}

#[async_trait]
impl Tool for ApplyPatchTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let patch = arg_str(&args, "patch")
            .filter(|p| !p.is_empty())
            .ok_or_else(|| invalid("patch", "required", "Error: apply_patch requires patch"))?;
        let dry_run = arg_bool(&args, "dry_run");
        let fuzzy = args.get("fuzzy").and_then(JsonValue::as_bool).unwrap_or(true);
        let base = match arg_str(&args, "base_path").filter(|b| !b.trim().is_empty()) {
            Some(b) => resolve_path(&ctx.cwd, b)?,
            None => ctx.cwd.clone(),
        };
        let sections = parse(patch)?;
        let mut touched: Vec<AbsPath> = Vec::new();
        for section in &sections {
            match section {
                Section::Add { path, .. } | Section::Delete { path } => touched.push(resolve_path(&base, path)?),
                Section::Update { path, move_to, .. } => {
                    touched.push(resolve_path(&base, path)?);
                    if let Some(dest) = move_to {
                        touched.push(resolve_path(&base, dest)?);
                    }
                }
            }
        }
        let _locked = if dry_run {
            None
        } else {
            Some(lock_write_paths(ctx, &touched.iter().collect::<Vec<_>>()).await?)
        };
        let plan = build_plan(ctx, &base, &sections, fuzzy).await?;
        let mut text = plan.report.join("\n");
        if dry_run {
            text.push_str("\n(dry_run: validated, nothing written)");
            return Ok(text_output(text));
        }
        for w in &plan.writes {
            if let Some(parent) = w.path.as_path().parent().and_then(|p| AbsPath::new(p.to_path_buf())) {
                let shown = display_path(w.path.as_path(), &ctx.cwd);
                if let Err(e) = guarded(ctx, "apply_patch", ctx.files.create_dir(ctx.io.durability, parent, true)).await? {
                    return Err(fs_failure(&e, &shown));
                }
            }
        }
        match guarded(ctx, "apply_patch", ctx.files.write_batch(ctx.io.durability, plan.writes.clone())).await? {
            Ok(_) => {}
            Err(e) => {
                let shown = e.path.as_ref().map_or_else(String::new, |p| display_path(p.as_path(), &ctx.cwd));
                return Err(match e.kind {
                    FsErrorKind::PreconditionFailed { .. } => fail(
                        ToolErrorCode::Stale { expected: shown.clone(), actual: "changed".to_owned() },
                        format!("Error: apply_patch: {shown} changed on disk (or already exists); read it again"),
                    ),
                    _ => fs_failure(&e, &shown),
                });
            }
        }
        for path in plan.removes {
            let shown = display_path(path.as_path(), &ctx.cwd);
            if let Err(e) = guarded(ctx, "apply_patch", ctx.files.remove(ctx.io.durability, path, false)).await? {
                return Err(fs_failure(&e, &shown));
            }
        }
        Ok(text_output(text))
    }
}
