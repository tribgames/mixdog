//! `apply_patch`: V4A patches (`*** Begin Patch` … `*** End Patch`) over one or more files.
//!
//! Two routes, chosen as Node chooses them. A patch over one file, or one holding a rename, is a
//! batch: it is validated in full, then written as one unit, and a failure reports that every
//! touched path was left as it was. A patch over several files is a sequence: each file's section
//! is converted against the disk the earlier sections left behind, and a section that fails is
//! reported while the others stay committed. The text engine is `patch_hunk`.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::EntryKind;
use mixdog_core_api::domain::fs::FsError;
use mixdog_core_api::domain::fs::FsErrorKind;
use mixdog_core_api::domain::fs::ReadRange;
use mixdog_core_api::domain::fs::WritePrecondition;
use mixdog_core_api::domain::fs::WriteRequest;
use mixdog_core_api::domain::tool::Freeform;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_js::js_trim;
use mixdog_protocol::JsonValue;

use super::common::*;
use crate::orch::util::spec_from_def;
use super::patch_guard::Quarantine;
use super::patch_guard::Snapshot;
use super::patch_guard::capture;
use super::patch_guard::content_edit_refusal;
use super::patch_guard::decode_patch_target;
use super::patch_guard::normalize_output_path;
use super::patch_guard::on_lane;
use super::patch_guard::read_for_conversion;
use super::patch_guard::EDIT_MAX_BYTES;
use super::patch_guard::SNAPSHOT_MAX_BYTES;
use super::patch_guard::read_present;
use super::patch_guard::refusal_message;
use super::patch_guard::restore;
use super::patch_hunk::Kind;
use super::patch_hunk::Lines;
use super::patch_hunk::Notices;
use super::patch_hunk::Section;
use super::patch_hunk::apply_hunks;
use super::patch_hunk::unified_update_hunks;
use super::patch_native::NativeEntry;
use super::patch_native::failure_context;
use super::patch_native::failure_path;
use super::patch_native::render;
use super::patch_native::run_engine;
use super::patch_redirect::relative_inside;
use super::patch_native::uses_js_writer;
use super::patch_parse::is_v4a;
use super::patch_hunk::apply_unified_hunks;
use super::patch_hunk::UHunk;
use super::patch_parse::UnifiedAnchors;
use super::patch_parse::is_counted_header;
use super::patch_parse::strip_diff_prefix;
use super::patch_redirect::relocated_header;
use super::patch_review::committed_patch;
use super::patch_review::unit_committed;
use super::read_state::ReadState;
use std::sync::Arc;
use super::os_error::fs_message;
use super::os_error::write_message;
use super::patch_review::with_card_diff;
use super::patch_unified::UFile;
use super::patch_unified::parse_patch;
use super::patch_parse::has_bare_hunk;
use super::patch_parse::parse_unified_as_v4a;
use super::patch_parse::parse_v4a;
use super::patch_parse::salvage_opening;
use super::patch_redirect::redirect_sections;

const PATCH_SPEC: &str = include_str!("specs/apply_patch.json");
const ROLLED_BACK: &str = "--- rolled back: every touched path was restored to its pre-patch state ---";
/// What a patch that names no file gets, V4A or unified.
const NO_HEADER: &str = "Error: apply_patch: a file section header could not be parsed (no target path). Each section must start with a valid header: `*** Update File: <path>` / `*** Add File: <path>` / `*** Delete File: <path>` (V4A), or a `--- a/<path>` + `+++ b/<path>` pair (unified). Wrap multi-hunk V4A edits in a `*** Begin Patch` / `*** End Patch` envelope and pass format:\"v4a\".";
const DRY_SEQUENCE_NOTE: &str =
    "\n(dry_run: each section validated against unchanged disk; a section depending on an earlier section's edits may report a false failure)";
const EXCERPT_MAX_FILES: usize = 3;
const EXCERPT_MAX_LINES: usize = 6;
const EXCERPT_MAX_CHARS: usize = 700;
const SEEN_SCOPES_CAP: usize = 64;
const SEEN_FILES_CAP: usize = 300;

pub struct ApplyPatchTool {
    spec: ToolSpec,
    /// The raw-text form of the definition (`freeformDescription`, `freeform`).
    freeform: Freeform,
    /// Files each thread has patched, for the repeat-gated post-patch excerpt.
    seen: Mutex<Vec<(String, Vec<String>)>>,
    /// What the session remembers of its files; a patch tells it what it wrote.
    state: Option<Arc<ReadState>>,
}

impl ApplyPatchTool {
    pub fn new() -> Self {
        let entry: JsonValue = serde_json::from_str(PATCH_SPEC).expect("embedded tool spec is valid JSON");
        Self {
            spec: spec_from_def(PATCH_SPEC, false, &["fs-write"]),
            freeform: Freeform::from_definition(&entry).expect("the spec's freeform"),
            seen: Mutex::new(Vec::new()),
            state: None,
        }
    }

    /// The read state shared with `read`, keyed by the call's thread.
    #[must_use]
    pub fn with_state(mut self, state: Arc<ReadState>) -> Self {
        self.state = Some(state);
        self
    }
}

impl Default for ApplyPatchTool {
    fn default() -> Self {
        Self::new()
    }
}

/// Why a step stopped: a model-facing failure text, or a cancellation/deadline.
enum Stop {
    Text(String),
    Tool(ToolError),
}

impl From<ToolError> for Stop {
    fn from(e: ToolError) -> Self {
        Stop::Tool(e)
    }
}

type R<T> = Result<T, Stop>;

fn text_err<T>(message: impl Into<String>) -> R<T> {
    Err(Stop::Text(message.into()))
}

fn errno(kind: &FsErrorKind) -> &'static str {
    match kind {
        FsErrorKind::NotFound => "ENOENT",
        FsErrorKind::IsADirectory => "EISDIR",
        FsErrorKind::NotADirectory => "ENOTDIR",
        FsErrorKind::PermissionDenied => "EACCES",
        _ => "EIO",
    }
}

fn path_key(abs: &AbsPath) -> String {
    let s = abs.as_path().to_string_lossy().into_owned();
    if cfg!(windows) { s.to_lowercase() } else { s }
}

fn shown(ctx: &ToolContext, abs: &AbsPath) -> String {
    display_path(abs.as_path(), &ctx.cwd)
}

fn decode_message(reason: &str, display: &str) -> String {
    if reason == "nul_without_utf16_bom" {
        format!("apply_patch: {display} has NUL bytes without a decidable text encoding — refusing to rewrite it, because any codec choice would corrupt the file.")
    } else if reason.starts_with("utf16 body") {
        format!("apply_patch: {display} is malformed UTF-16 (odd payload length) — refusing to rewrite it, because the dangling byte cannot be preserved.")
    } else {
        format!("apply_patch: {display} is neither valid UTF-8 nor BOM-marked UTF-16 — refusing to rewrite it, because the edit would transcode every byte.")
    }
}

async fn read_opt(ctx: &ToolContext, abs: &AbsPath) -> R<Option<Vec<u8>>> {
    let read = guarded(ctx, "apply_patch", ctx.files.read(ctx.io.interactive, abs.clone(), ReadRange::default())).await?;
    match read {
        Ok(b) => Ok(Some(b.bytes)),
        Err(e) if e.kind == FsErrorKind::NotFound => Ok(None),
        Err(e) => Err(Stop::Tool(fs_failure(&e, &shown(ctx, abs)))),
    }
}

async fn stat_opt(ctx: &ToolContext, abs: &AbsPath) -> R<Result<mixdog_core_api::domain::fs::FileStat, FsError>> {
    Ok(guarded(ctx, "apply_patch", ctx.files.stat(ctx.io.interactive, abs.clone())).await?)
}

// ---- section coalescing ----

/// Repeated plain Update sections on one file merge; a Delete then Add of one path collapses into
/// the single end state it describes. Anything else on one path is a conflict.
async fn coalesce(ctx: &ToolContext, base: &AbsPath, sections: Vec<Section>) -> R<Vec<Section>> {
    let mut out: Vec<Section> = Vec::new();
    let mut index: Vec<(String, usize)> = Vec::new();
    for section in sections {
        let abs = resolve_path(base, &section.path)?;
        let key = path_key(&abs);
        let Some(&(_, at)) = index.iter().find(|(k, _)| *k == key) else {
            index.push((key, out.len()));
            out.push(section);
            continue;
        };
        let prior = &out[at];
        if prior.kind == Kind::Delete && section.kind == Kind::Add && prior.move_path.is_none() && section.move_path.is_none() {
            let added = section.lines.clone();
            match read_opt(ctx, &abs).await? {
                None => {
                    out[at] = Section { hunks: Vec::new(), ..section };
                    continue;
                }
                Some(raw) if !raw.contains(&0) => {
                    let current = Lines::split(&String::from_utf8_lossy(&raw)).text;
                    let hunk = super::patch_hunk::Hunk {
                        anchors: Vec::new(),
                        lines: current.iter().map(|l| format!("-{l}")).chain(added.iter().map(|l| format!("+{l}"))).collect(),
                        eof: false,
                    };
                    out[at] = Section { kind: Kind::Update, path: section.path, move_path: None, hunks: vec![hunk], lines: Vec::new() };
                    continue;
                }
                Some(_) => {}
            }
        }
        let prior = &out[at];
        if !(prior.kind == Kind::Update && section.kind == Kind::Update && prior.move_path.is_none() && section.move_path.is_none()) {
            return text_err(format!(
                "apply_patch: conflicting operations target {}; only repeated plain Update File sections can be merged",
                section.path
            ));
        }
        out[at].hunks.extend(section.hunks);
    }
    Ok(out)
}

// ---- planned changes ----

#[derive(Clone, Copy, PartialEq, Eq)]
enum EKind {
    Create,
    Delete,
    Modify,
}

impl EKind {
    fn label(self) -> &'static str {
        match self {
            EKind::Create => "Create",
            EKind::Delete => "Delete",
            EKind::Modify => "Modify",
        }
    }
}

struct Entry {
    kind: EKind,
    abs: AbsPath,
    shown: String,
    added: usize,
    removed: usize,
    content: Vec<u8>,
    before: Option<Vec<u8>>,
    /// Written by the codec-preserving writer: new files, UTF-16 files, paths outside the base.
    js: bool,
    /// Applied by the engine: in-base updates and deletes.
    native: Option<NativeEntry>,
    /// Why the codec-preserving writer cannot apply this entry; reported once the engine ran.
    error: Option<String>,
    /// Why the engine must not be given this target (the file would not round-trip as UTF-8).
    gate: Option<String>,
}

struct RenameOp {
    src: AbsPath,
    dest: AbsPath,
    shown_src: String,
    shown_dest: String,
    content: Vec<u8>,
    /// The source as it was before the rename, to put back if the rename fails.
    original: Vec<u8>,
    dest_before: Option<Vec<u8>>,
    lines_changed: usize,
    /// Source and destination are one file (a case-only rename, or two spellings of it).
    same_file: bool,
    /// ...and the two spellings differ only in case: the file is renamed after the rewrite.
    recase: bool,
}

/// One section as the change it makes to the disk as it is now; `None` when none of its hunks
/// does anything. Errors are the bare messages Node's conversion throws.
async fn convert(ctx: &ToolContext, base: &AbsPath, section: &Section, fuzzy: bool, reject_partial: bool, notices: &mut Notices) -> R<Option<Entry>> {
    let abs = resolve_path(base, &section.path)?;
    let display = section.path.replace('\\', "/");
    let out_of_base = !abs.as_path().starts_with(base.as_path());
    let shown_path = normalize_output_path(&display);
    let full_text = normalize_output_path(&abs.as_path().to_string_lossy());
    match section.kind {
        Kind::Add => {
            let mut content = section.lines.join("\n");
            content.push('\n');
            Ok(Some(Entry {
                kind: EKind::Create,
                abs,
                shown: shown_path,
                added: section.lines.len(),
                removed: 0,
                content: content.into_bytes(),
                before: None,
                js: true,
                native: None,
                error: None,
                gate: None,
            }))
        }
        Kind::Delete => {
            // Only a file that reads as valid UTF-8 text within the snapshot limit has lines to show.
            let bytes = read_present(ctx, &abs, SNAPSHOT_MAX_BYTES, true).await?;
            let deleted_lines: Vec<String> = bytes
                .as_deref()
                .filter(|b| std::str::from_utf8(b).is_ok())
                .and_then(|b| decode_patch_target(b).ok())
                .map(|(text, _)| Lines::split(&text).text)
                .unwrap_or_default();
            let removed = deleted_lines.len();
            let js = uses_js_writer(ctx, base, &abs, true).await?;
            let native = (!js).then(|| NativeEntry::v4a(true, header_of(base, &abs, &display), abs.clone(), Vec::new(), deleted_lines));
            Ok(Some(Entry { kind: EKind::Delete, abs, shown: shown_path, added: 0, removed, content: Vec::new(), before: bytes, js, native, error: None, gate: None }))
        }
        Kind::Update => {
            let bytes = match read_for_conversion(ctx, &abs).await? {
                Ok(Some(bytes)) => bytes,
                Ok(None) => return text_err(format!("V4A update target unreadable: {} (ENOENT).", section.path)),
                Err(why) => return text_err(format!("V4A update target unreadable: {} ({why}).", section.path)),
            };
            let (text, codec) = decode_patch_target(&bytes).map_err(|reason| {
                Stop::Text(format!("V4A update target unreadable: {} ({}).", section.path, decode_message(&reason, &full_text)))
            })?;
            let js = out_of_base || codec.encoding != Encoding::Utf8 || uses_js_writer(ctx, base, &abs, false).await?;
            // The hunks are resolved the same way for both writers; only who applies them differs.
            let hunks = unified_update_hunks(&Lines::split(&text), &section.hunks, fuzzy, &section.path, &display, notices, reject_partial).map_err(Stop::Text)?;
            if hunks.is_empty() {
                return Ok(None);
            }
            let count = |tag: char| hunks.iter().flat_map(|h| &h.lines).filter(|l| l.starts_with(tag)).count();
            let (added, removed) = (count('+'), count('-'));
            if !js {
                let native = NativeEntry::v4a(false, header_of(base, &abs, &display), abs.clone(), hunks, Vec::new());
                return Ok(Some(Entry { kind: EKind::Modify, abs, shown: shown_path, added, removed, content: Vec::new(), before: Some(bytes), js: false, native: Some(native), error: None, gate: None }));
            }
            let fuzz = if fuzzy { 2 } else { 0 };
            let (content, error) = match apply_unified_hunks(&Lines::split(&text), &hunks, fuzz, &shown_path) {
                Ok(applied) => (encode_text(&applied.join(), codec), None),
                Err(message) => (Vec::new(), Some(message)),
            };
            Ok(Some(Entry { kind: EKind::Modify, abs, shown: shown_path, added, removed, content, before: Some(bytes), js: true, native: None, error, gate: None }))
        }
    }
}
// ---- renames ----

/// Node `renameTargetsSamePhysicalFile`: two different spellings whose real paths agree (a junction
/// alias, or a case-only difference on a case-insensitive disk); both must exist.
async fn same_physical_file(ctx: &ToolContext, src: &AbsPath, dest: &AbsPath) -> Result<bool, ToolError> {
    if src == dest {
        return Ok(false);
    }
    let (a, b) = (src.as_path().to_path_buf(), dest.as_path().to_path_buf());
    on_lane(ctx, move || matches!((mixdog_workspace::pathguard::canonical(&a), mixdog_workspace::pathguard::canonical(&b)), (Ok(x), Ok(y)) if x == y)).await
}


async fn validate_rename(ctx: &ToolContext, base: &AbsPath, section: &Section, seen_dest: &mut HashSet<String>) -> R<()> {
    let move_path = section.move_path.as_deref().unwrap_or_default();
    let src = resolve_path(base, &section.path)?;
    let dest = resolve_path(base, move_path)?;
    if src == dest {
        return text_err(format!("apply_patch: V4A rename source and destination are the same path ({})", section.path));
    }
    let case_only = path_key(&src) == path_key(&dest) && src != dest || same_physical_file(ctx, &src, &dest).await?;
    if !seen_dest.insert(path_key(&dest)) {
        return text_err(format!("apply_patch: duplicate V4A rename destination {move_path}"));
    }
    match stat_opt(ctx, &src).await? {
        Ok(st) => match st.kind {
            EntryKind::Special => {
                return text_err(format!("apply_patch: cannot patch special file (FIFO / character / block device / socket): {}", section.path));
            }
            EntryKind::File => {}
            _ => return text_err(format!("apply_patch: V4A rename source is not a regular file: {}", section.path)),
        },
        Err(e) => {
            return text_err(format!("apply_patch: V4A rename source missing or unreadable: {} ({})", section.path, errno(&e.kind)));
        }
    }
    match stat_opt(ctx, &dest).await? {
        Ok(st) => match st.kind {
            EntryKind::Special => {
                return text_err(format!("apply_patch: cannot patch special file (FIFO / character / block device / socket): {move_path}"));
            }
            EntryKind::Dir => return text_err(format!("apply_patch: V4A rename destination is a directory: {move_path}")),
            EntryKind::File => {
                if !case_only {
                    return text_err(format!(
                        "apply_patch: V4A rename destination already exists: {move_path}; delete it first or choose a new name"
                    ));
                }
            }
            _ => return text_err(format!("apply_patch: V4A rename destination is not a regular file: {move_path}")),
        },
        Err(e) if e.kind == FsErrorKind::NotFound => {}
        Err(e) => {
            return text_err(format!("apply_patch: V4A rename destination unreadable: {move_path} ({})", errno(&e.kind)));
        }
    }
    Ok(())
}

/// Checks every rename of the patch against each other and the other sections.
async fn plan_renames(ctx: &ToolContext, base: &AbsPath, renames: &[&Section], rest: &[&Section]) -> R<()> {
    let mut remaining = HashSet::new();
    for s in rest {
        remaining.insert(path_key(&resolve_path(base, &s.path)?));
    }
    let (mut seen_dest, mut seen_src) = (HashSet::new(), HashSet::new());
    for s in renames {
        let src_key = path_key(&resolve_path(base, &s.path)?);
        let move_path = s.move_path.as_deref().unwrap_or_default();
        let dest_key = path_key(&resolve_path(base, move_path)?);
        if !seen_src.insert(src_key.clone()) {
            return text_err(format!("apply_patch: duplicate V4A rename source {}", s.path));
        }
        if remaining.contains(&src_key) || remaining.contains(&dest_key) {
            return text_err(format!(
                "apply_patch: V4A rename {} → {move_path} touches a path another section edits; split into separate patches.",
                s.path
            ));
        }
        validate_rename(ctx, base, s, &mut seen_dest).await?;
    }
    Ok(())
}

/// The rename's new file content, computed from the source as it is now.
async fn build_rename(ctx: &ToolContext, base: &AbsPath, section: &Section, fuzzy: bool) -> R<RenameOp> {
    let move_path = section.move_path.as_deref().unwrap_or_default();
    let src = resolve_path(base, &section.path)?;
    let dest = resolve_path(base, move_path)?;
    let unreadable = |why: String| Stop::Text(format!("apply_patch: V4A rename source unreadable: {} ({why})", section.path));
    let bytes = match read_for_conversion(ctx, &src).await? {
        Ok(Some(b)) => b,
        Ok(None) => return Err(unreadable("ENOENT".to_owned())),
        Err(why) => return Err(unreadable(why)),
    };
    let (text, codec) = decode_patch_target(&bytes).map_err(|reason| unreadable(decode_message(&reason, &normalize_output_path(&src.as_path().to_string_lossy()))))?;
    let applied = apply_hunks(&Lines::split(&text), &section.hunks, fuzzy, None, &section.path, None, "apply_patch", true).map_err(Stop::Text)?;
    let dest_before = read_opt(ctx, &dest).await?;
    Ok(RenameOp {
        shown_src: normalize_output_path(&section.path),
        shown_dest: normalize_output_path(move_path),
        content: encode_text(&applied.lines.join(), codec),
        original: bytes,
        dest_before,
        lines_changed: section.hunks.iter().map(|h| h.lines.len()).sum(),
        same_file: path_key(&src) == path_key(&dest) && src != dest || same_physical_file(ctx, &src, &dest).await?,
        recase: path_key(&src) == path_key(&dest) && src != dest,
        src,
        dest,
    })
}

fn rename_line(op: &RenameOp, dry: bool) -> String {
    let from = if dry { "undefined" } else { op.shown_src.as_str() };
    format!("OK {} (renamed from {from}, ~{} lines touched, engine=v4a-rename)", op.shown_dest, op.lines_changed)
}

// ---- applying ----

fn count_label(count: usize, singular: &str) -> String {
    format!("{count} {singular}{}", if count == 1 { "" } else { "s" })
}

/// What an apply reports for `entries`: a header, then one row per entry.
fn summary(entries: &[&Entry], js: bool, dry: bool) -> String {
    let verb = if dry { "Checked" } else { "Applied" };
    let engine = if js { "JS" } else { "Native" };
    let mut lines = vec![format!("{verb} {} ({engine}){}", count_label(entries.len(), "File"), if dry { " Dry Run" } else { "" })];
    for e in entries {
        let detail = if js {
            let mut parts = Vec::new();
            if e.added > 0 {
                parts.push(format!("+{}", count_label(e.added, "Line")));
            }
            if e.removed > 0 {
                parts.push(format!("-{}", count_label(e.removed, "Line")));
            }
            parts.join(" · ")
        } else {
            let mut parts = Vec::new();
            if e.added > 0 {
                parts.push(format!("+{}", e.added));
            }
            if e.removed > 0 {
                parts.push(format!("-{}", e.removed));
            }
            parts.join("/")
        };
        lines.push(if detail.is_empty() {
            format!("  OK {} {}", e.kind.label(), e.shown)
        } else {
            format!("  OK {} {} — {detail}", e.kind.label(), e.shown)
        });
    }
    lines.join("\n")
}

/// The path a section writes as its patch header: relative to the base when the patch named it
/// absolutely and it lies inside.
fn header_of(base: &AbsPath, abs: &AbsPath, display: &str) -> String {
    if std::path::Path::new(display).is_absolute() {
        if let Some(rel) = relative_inside(base.as_path(), abs.as_path()).filter(|r| !r.as_os_str().is_empty()) {
            return fwd(&rel);
        }
    }
    display.to_owned()
}

/// Node `deleteOnlyPaths`: the targets a patch only deletes, which keep the smaller snapshot limit.
fn delete_only_keys(targets: &[(AbsPath, bool)]) -> HashSet<String> {
    let others: HashSet<String> = targets.iter().filter(|(_, delete)| !delete).map(|(p, _)| skey(p)).collect();
    targets.iter().filter(|(p, delete)| *delete && !others.contains(&skey(p))).map(|(p, _)| skey(p)).collect()
}

fn skey(abs: &AbsPath) -> String {
    mixdog_scm::locks::path_key(abs.as_path())
}

/// The rollback state of one batch (Node `applyCodexBatchWithRollback`); a sequence unit has no
/// snapshots, only the quarantine it commits itself.
struct Tx {
    snapshots: Vec<Snapshot>,
    quarantine: Quarantine,
    owns_commit: bool,
    /// Which of the batch's paths are V4A moves (source, destination), for the turn review.
    renames: Vec<(AbsPath, AbsPath)>,
    /// The session's read state, told what the batch commits.
    state: Option<Arc<ReadState>>,
}

impl Tx {
    fn unit() -> Self {
        Self { snapshots: Vec::new(), quarantine: Quarantine::default(), owns_commit: true, renames: Vec::new(), state: None }
    }
}

/// Snapshots every path the batch touches and refuses an edit whose bytes cannot be captured.
async fn begin_tx(ctx: &ToolContext, entries: &[Entry], renames: &[&Section], base: &AbsPath) -> R<Tx> {
    let mut paths: Vec<AbsPath> = Vec::new();
    let mut seen = HashSet::new();
    let mut rename_sources = HashSet::new();
    let mut extra: Vec<AbsPath> = Vec::new();
    for s in renames {
        let src = resolve_path(base, &s.path)?;
        rename_sources.insert(skey(&src));
        extra.push(src);
        extra.push(resolve_path(base, s.move_path.as_deref().unwrap_or_default())?);
    }
    for abs in entries.iter().map(|e| &e.abs).chain(extra.iter()) {
        if seen.insert(skey(abs)) {
            paths.push(abs.clone());
        }
    }
    let edited: HashSet<String> = entries.iter().filter(|e| e.kind != EKind::Delete).map(|e| skey(&e.abs)).collect();
    let delete_only: HashSet<String> = entries.iter().filter(|e| e.kind == EKind::Delete && !edited.contains(&skey(&e.abs))).map(|e| skey(&e.abs)).collect();
    let snapshots = capture(ctx, &paths, &delete_only).await?.map_err(|m| Stop::Text(format!("Error: {m}")))?;
    let edit_keys: HashSet<String> = entries.iter().filter(|e| e.kind == EKind::Modify).map(|e| skey(&e.abs)).chain(rename_sources).collect();
    if let Some((hit, omitted)) = snapshots.iter().find_map(|s| s.omitted().filter(|_| edit_keys.contains(&skey(&s.path))).map(|o| (s, o))) {
        return text_err(format!("Error: {}", refusal_message(&normalize_output_path(&hit.path.as_path().to_string_lossy()), omitted)));
    }
    let mut quarantine = Quarantine::default();
    quarantine.mark_omitted(&snapshots);
    let moves = renames
        .iter()
        .map(|s| Ok((resolve_path(base, &s.path)?, resolve_path(base, s.move_path.as_deref().unwrap_or_default())?)))
        .collect::<Result<Vec<_>, ToolError>>()?;
    Ok(Tx { snapshots, quarantine, owns_commit: false, renames: moves, state: None })
}

/// Node `withRollback`: undoes the batch and words the outcome, including what could not be undone.
async fn roll_back(ctx: &ToolContext, tx: &mut Tx, outcome: String) -> R<String> {
    let mut errors = tx.quarantine.rollback(ctx).await?;
    let (restore_errors, snapshots) = restore(ctx, std::mem::take(&mut tx.snapshots)).await?;
    errors.extend(restore_errors);
    // What could not be undone stays on disk, so the review lists it.
    if !errors.is_empty() {
        let paths: Vec<AbsPath> = snapshots.iter().map(|s| s.path.clone()).collect();
        committed_patch(ctx, tx.state.as_deref(), &snapshots, &paths, &tx.renames, true).await;
    }
    Ok(if errors.is_empty() { format!("{outcome}\n{ROLLED_BACK}") } else { format!("{outcome}\n--- rollback incomplete ---\n{}", errors.join("\n")) })
}

/// A batch outcome: success commits the quarantine, failure rolls the batch back. `dry` runs
/// change nothing and report as they are.
async fn finish_batch(ctx: &ToolContext, tx: &mut Tx, outcome: R<String>, dry: bool, notices: &mut Notices) -> R<String> {
    match outcome {
        Ok(text) => {
            let tail = notices.rejected_tail();
            let text = wrap(&format!("{text}{tail}"), notices);
            if dry {
                return Ok(text);
            }
            let paths: Vec<AbsPath> = tx.snapshots.iter().map(|s| s.path.clone()).collect();
            committed_patch(ctx, tx.state.as_deref(), &tx.snapshots, &paths, &tx.renames, true).await;
            let leftovers = tx.quarantine.commit(ctx).await?;
            Ok(if leftovers.is_empty() { text } else { format!("{text}\n{}", leftovers.join("\n")) })
        }
        Err(Stop::Text(e)) => {
            let text = wrap(&e, notices);
            if dry { text_err(text) } else { text_err(roll_back(ctx, tx, text).await?) }
        }
        Err(Stop::Tool(e)) => {
            if !dry {
                roll_back(ctx, tx, String::new()).await?;
            }
            Err(Stop::Tool(e))
        }
    }
}

/// Writes the renames and entries as one unit, or only checks them when `dry`. The error text is
/// complete, including its `Error: ` prefix.
async fn apply_ops(ctx: &ToolContext, base: &AbsPath, renames: &[RenameOp], entries: &[Entry], opts: &Options, tx: &mut Tx) -> R<String> {
    let (fuzzy, dry) = (opts.fuzzy, opts.dry);
    // A binary or oversized target is refused before anything is written.
    for e in entries.iter().filter(|e| e.kind == EKind::Modify) {
        if let Some(refusal) = content_edit_refusal(ctx, &e.abs, &e.shown).await? {
            return text_err(format!("Error: {refusal}"));
        }
    }
    for e in entries {
        match e.kind {
            EKind::Create => {
                if stat_opt(ctx, &e.abs).await?.is_ok() {
                    return text_err(format!("Error: apply_patch: Add File target already exists: {}; read it and use Update File instead", e.shown));
                }
            }
            // A native delete of a missing file is reported by the engine in its own words.
            EKind::Delete if e.native.is_none() => {
                if let Err(err) = stat_opt(ctx, &e.abs).await? {
                    if err.kind == FsErrorKind::NotFound {
                        return text_err(format!("Error: ENOENT: no such file or directory, lstat '{}'", e.abs.as_path().display()));
                    }
                    return Err(Stop::Tool(fs_failure(&err, &e.shown)));
                }
            }
            EKind::Delete | EKind::Modify => {}
        }
    }
    // Deletes of files that are never snapshotted run last, as quarantine moves.
    let mut protected: Vec<&Entry> = Vec::new();
    if !dry {
        for e in entries.iter().filter(|e| e.kind == EKind::Delete) {
            if tx.quarantine.needs(ctx, &e.abs).await? {
                protected.push(e);
            }
        }
    }
    let is_protected = |e: &Entry| protected.iter().any(|p| std::ptr::eq(*p, e));
    let native: Vec<&Entry> = entries.iter().filter(|e| e.native.is_some() && !is_protected(e)).collect();
    let js: Vec<&Entry> = entries.iter().filter(|e| (e.kind == EKind::Create || e.js) && !is_protected(e)).collect();
    let mut parts = Vec::new();
    if !native.is_empty() {
        parts.push(summary(&native, false, dry));
    }
    if !js.is_empty() {
        parts.push(summary(&js, true, dry));
    }
    let fuzz = if fuzzy { 2 } else { 0 };
    if !native.is_empty() {
        // The native engine rewrites files as UTF-8: a target it cannot round-trip is refused.
        if let Some(gate) = native.iter().find_map(|e| e.gate.clone()) {
            return text_err(format!("Error: {gate}"));
        }
        let units: Vec<NativeEntry> = native.iter().filter_map(|e| e.native.clone()).collect();
        match run_engine(ctx, base, render(&units), fuzz, opts.reject_partial, dry).await.map_err(Stop::Tool)? {
            Err(message) => {
                let context = failure_context(ctx, &units, &failure_path(&message, &units), fuzz).await;
                return text_err(format!("Error: native patch failed — {message}{context}"));
            }
            Ok(stats) if !stats.failed.is_empty() => {
                // Some files were skipped (`reject_partial: false`); the report is an error.
                let skipped: Vec<(String, String)> = stats.failed.iter().map(|f| (f.descriptor.clone(), f.reason.clone())).collect();
                let skipped_names: Vec<String> = skipped.iter().flat_map(|(path, _)| [path.replace('\\', "/"), strip_diff_prefix(path).replace('\\', "/")]).collect();
                let written: Vec<&Entry> = native.iter().copied().filter(|e| !skipped_names.contains(&e.native.as_ref().map_or_else(String::new, |n| n.header.clone()))).collect();
                let (verb, verb_label) = if dry { ("checked", "Checked") } else { ("applied", "Applied") };
                let mut lines = vec![format!(
                    "Error: Patch Partially {verb_label} ({} {verb} · {} Skipped) (Native)",
                    count_label(written.len(), "File"),
                    count_label(skipped.len(), "File")
                )];
                lines.extend(summary(&written, false, dry).split('\n').skip(1).map(str::to_owned));
                for (path, reason) in &skipped {
                    let context = failure_context(ctx, &units, path, fuzz).await;
                    lines.push(format!("  SKIP {} — {reason}{context}", if path.is_empty() { "(unknown)" } else { path.as_str() }));
                }
                return Err(Stop::Text(lines.join("\n")));
            }
            Ok(_) => {}
        }
    }
    if let Some(message) = js.iter().find_map(|e| e.error.clone()) {
        return text_err(format!("Error: {message}"));
    }
    if dry {
        return Ok(parts.join("\n"));
    }
    write_rest(ctx, renames, &js).await?;
    if !protected.is_empty() {
        let targets: Vec<(AbsPath, String)> = protected.iter().map(|e| (e.abs.clone(), e.shown.clone())).collect();
        tx.quarantine.move_aside(ctx, targets).await?.map_err(|m| Stop::Text(format!("Error: {m}")))?;
        let leftovers = if tx.owns_commit { tx.quarantine.commit(ctx).await? } else { Vec::new() };
        let mut lines = vec![format!("Applied {} (JS)", count_label(protected.len(), "File"))];
        lines.extend(protected.iter().map(|e| format!("  OK Delete {}", normalize_output_path(&e.shown))));
        lines.extend(leftovers);
        parts.push(lines.join("\n"));
    }
    Ok(parts.join("\n"))
}
/// Node `applyV4ARenameSection` past its dry run, for one ordered unit: the destination is
/// written, the source removed (unless both name one file), and a failure of either puts both
/// paths back before the unit reports `V4A rename failed`. The writes are not cancellable half-way.
async fn apply_rename(ctx: &ToolContext, op: &RenameOp) -> R<()> {
    if let Some(parent) = op.dest.as_path().parent().and_then(|p| AbsPath::new(p.to_path_buf())) {
        if let Err(e) = guarded(ctx, "apply_patch", ctx.files.create_dir(ctx.io.durability, parent.clone(), true)).await? {
            return text_err(format!("Error: {}", fs_message(&e, "mkdir", parent.as_path())));
        }
    }
    let (files, lane) = (&ctx.files, ctx.io.durability);
    let write = |path: &AbsPath, content: &[u8]| WriteRequest { path: path.clone(), content: content.to_vec(), precondition: WritePrecondition::Unconditional };
    let attempt = async {
        files.write(lane, write(&op.dest, &op.content)).await.map_err(|e| write_message(&e, op.dest.as_path()))?;
        if !op.same_file {
            files.remove(lane, op.src.clone(), false).await.map_err(|e| fs_message(&e, "unlink", op.src.as_path()))?;
        }
        Ok::<(), String>(())
    };
    if let Err(why) = attempt.await {
        // Best effort, as Node's: whatever cannot be put back stays as it is.
        let _ = match &op.dest_before {
            None => files.remove(lane, op.dest.clone(), false).await,
            Some(before) => files.write(lane, write(&op.dest, before)).await.map(|_| ()),
        };
        if !op.same_file {
            let _ = files.write(lane, write(&op.src, &op.original)).await;
        }
        return text_err(format!("Error: apply_patch: V4A rename failed for {} → {} ({why})", op.shown_src, op.shown_dest));
    }
    Ok(())
}

/// Writes the renames and the codec-preserving entries as one unit.
async fn write_rest(ctx: &ToolContext, renames: &[RenameOp], entries: &[&Entry]) -> R<()> {
    let mut writes: Vec<WriteRequest> = Vec::new();
    let mut removes: Vec<AbsPath> = Vec::new();
    // A case-only rename names one file twice: it is rewritten where it is, then renamed.
    let mut recased: Vec<(AbsPath, AbsPath)> = Vec::new();
    for op in renames {
        match (&op.dest_before, op.same_file) {
            (Some(before), true) => {
                let path = if op.recase { op.src.clone() } else { op.dest.clone() };
                writes.push(WriteRequest { path, content: op.content.clone(), precondition: WritePrecondition::ContentEquals(before.clone()) });
                if op.recase {
                    recased.push((op.src.clone(), op.dest.clone()));
                }
            }
            _ => {
                writes.push(WriteRequest { path: op.dest.clone(), content: op.content.clone(), precondition: WritePrecondition::Absent });
                removes.push(op.src.clone());
            }
        }
    }
    for e in entries.iter().filter(|e| e.native.is_none()) {
        match e.kind {
            EKind::Create => writes.push(WriteRequest { path: e.abs.clone(), content: e.content.clone(), precondition: WritePrecondition::Absent }),
            EKind::Modify => writes.push(WriteRequest {
                path: e.abs.clone(),
                content: e.content.clone(),
                precondition: WritePrecondition::ContentEquals(e.before.clone().unwrap_or_default()),
            }),
            EKind::Delete => removes.push(e.abs.clone()),
        }
    }
    for w in &writes {
        if let Some(parent) = w.path.as_path().parent().and_then(|p| AbsPath::new(p.to_path_buf())) {
            if let Err(e) = guarded(ctx, "apply_patch", ctx.files.create_dir(ctx.io.durability, parent, true)).await? {
                return Err(Stop::Tool(fs_failure(&e, &shown(ctx, &w.path))));
            }
        }
    }
    if let Err(e) = guarded(ctx, "apply_patch", ctx.files.write_batch(ctx.io.durability, writes.clone())).await? {
        let at = e.path.clone().unwrap_or_else(|| writes[0].path.clone());
        let name = shown(ctx, &at);
        if matches!(e.kind, FsErrorKind::PreconditionFailed { .. }) {
            let absent = writes.iter().find(|w| w.path == at).is_some_and(|w| w.precondition == WritePrecondition::Absent);
            let rename = renames.iter().find(|r| r.dest == at);
            return text_err(match (absent, rename) {
                (true, Some(op)) => format!(
                    "Error: apply_patch: V4A rename failed for {} → {} (destination appeared during the rename)",
                    op.shown_src, op.shown_dest
                ),
                (true, None) => format!("Error: apply_patch: Add File target appeared during creation: {name}; read it and use Update File instead"),
                _ => format!("Error: apply_patch: {name} changed on disk during the patch; re-read it and retry"),
            });
        }
        return Err(Stop::Tool(fs_failure(&e, &name)));
    }
    for (from, to) in recased {
        if let Err(e) = guarded(ctx, "apply_patch", ctx.files.rename(ctx.io.durability, from, to.clone(), true)).await? {
            return Err(Stop::Tool(fs_failure(&e, &shown(ctx, &to))));
        }
    }
    for path in removes {
        if let Err(e) = guarded(ctx, "apply_patch", ctx.files.remove(ctx.io.durability, path.clone(), false)).await? {
            // A rename's source is the executor's own step: its failure is the rename's (the batch
            // restores the paths afterwards).
            if let Some(op) = renames.iter().find(|r| r.src == path) {
                let why = fs_message(&e, "unlink", path.as_path());
                return text_err(format!("Error: apply_patch: V4A rename failed for {} → {} ({why})", op.shown_src, op.shown_dest));
            }
            return Err(Stop::Tool(fs_failure(&e, &shown(ctx, &path))));
        }
    }
    Ok(())
}

/// Drops the `Applied N File(s) (Native|JS)` heading that sits directly above the per-file rows,
/// then appends the warnings gathered while locating hunks.
fn wrap(text: &str, notices: &mut Notices) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut kept: Vec<&str> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let heading = line.strip_prefix("Applied ").is_some_and(|rest| {
            let digits = rest.chars().take_while(char::is_ascii_digit).count();
            let after = &rest[digits..];
            digits > 0
                && (after == " File (Native)" || after == " Files (Native)" || after == " File (JS)" || after == " Files (JS)")
        });
        if heading && lines.get(i + 1).is_some_and(|n| n.starts_with("  OK ")) {
            continue;
        }
        kept.push(line);
    }
    let body = kept.join("\n");
    let rows = notices.take_rows();
    if rows.is_empty() { body } else { format!("{body}\n{}", rows.join("\n")) }
}

fn is_error_text(text: &str) -> bool {
    text.trim_start().to_ascii_lowercase().starts_with("error:")
}

fn prepare_failed(stop: Stop) -> Stop {
    match stop {
        Stop::Text(e) => Stop::Text(format!("Error: apply_patch: V4A parse failed — {e}")),
        other => other,
    }
}

fn into_text(r: R<String>) -> Result<String, ToolError> {
    match r {
        Ok(t) => Ok(t),
        Err(Stop::Text(t)) => Ok(t),
        Err(Stop::Tool(e)) => Err(e),
    }
}

// ---- routes ----

async fn run_batch(ctx: &ToolContext, base: &AbsPath, sections: Vec<Section>, opts: &Options, coalesce_sections: bool) -> R<String> {
    let (fuzzy, dry) = (opts.fuzzy, opts.dry);
    let mut notices = Notices::default();
    let sections = if coalesce_sections {
        coalesce(ctx, base, sections).await.map_err(prepare_failed)?
    } else {
        // One operation per target: a repeated path in a converted unified patch is refused.
        let mut seen = HashSet::new();
        for s in &sections {
            if !seen.insert(path_key(&resolve_path(base, &s.path)?)) {
                return text_err(format!("Error: apply_patch: multiple operations target {}", s.path.replace('\\', "/")));
            }
        }
        sections
    };
    let (renames, rest): (Vec<&Section>, Vec<&Section>) = sections.iter().partition(|s| s.kind == Kind::Update && s.move_path.is_some());
    if !renames.is_empty() {
        plan_renames(ctx, base, &renames, &rest).await.map_err(prepare_failed)?;
    }
    let mut entries = Vec::new();
    for s in &rest {
        if let Some(e) = convert(ctx, base, s, fuzzy, opts.reject_partial, &mut notices).await.map_err(prepare_failed)? {
            entries.push(e);
        }
    }
    if renames.is_empty() && entries.is_empty() {
        return text_err(NO_HEADER);
    }
    let rename_only = rest.is_empty();
    // Every path the patch touches is snapshotted, so a failure can be undone.
    let mut tx = if dry { Tx::unit() } else { begin_tx(ctx, &entries, &renames, base).await? };
    tx.state = opts.state.clone();
    let mut ops = Vec::new();
    for s in &renames {
        match build_rename(ctx, base, s, fuzzy).await {
            Ok(op) => ops.push(op),
            // A thrown rename failure takes the same path back out as a returned one.
            Err(Stop::Text(e)) => {
                let text = format!("Error: {e}");
                return text_err(if dry { text } else { roll_back(ctx, &mut tx, text).await? });
            }
            Err(other) => return Err(other),
        }
    }
    let rename_lines: Vec<String> = ops.iter().map(|op| rename_line(op, dry)).collect();
    if rename_only {
        let outcome = apply_ops(ctx, base, &ops, &[], opts, &mut tx).await.map(|_| format!("{}\n", rename_lines.join("\n")));
        return finish_batch(ctx, &mut tx, outcome, dry, &mut notices).await;
    }
    let outcome = apply_ops(ctx, base, &ops, &entries, opts, &mut tx).await.map(|text| {
        if rename_lines.is_empty() { text } else { format!("{}\n{text}", rename_lines.join("\n")) }
    });
    finish_batch(ctx, &mut tx, outcome, dry, &mut notices).await
}
async fn run_sequence(ctx: &ToolContext, base: &AbsPath, sections: Vec<Section>, opts: &Options, mode: Sequence) -> R<String> {
    let (fuzzy, dry) = (opts.fuzzy, opts.dry);
    let mut notices = Notices::default();
    let units = if mode.coalesce { coalesce(ctx, base, sections).await.map_err(prepare_failed)? } else { sections };
    if units.is_empty() {
        return text_err("Error: patch contained no file sections");
    }
    let mut applied: Vec<String> = Vec::new();
    let mut failures: Vec<(usize, String, String)> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    // The review sees the targets of the sections that committed, against their pre-patch state.
    let mut unit_paths: Vec<AbsPath> = Vec::new();
    for unit in &units {
        unit_paths.push(resolve_path(base, &unit.path)?);
        if let Some(dest) = &unit.move_path {
            unit_paths.push(resolve_path(base, dest)?);
        }
    }
    let mut targets = Vec::new();
    for unit in &units {
        targets.push((resolve_path(base, &unit.path)?, unit.kind == Kind::Delete));
    }
    let delete_only = delete_only_keys(&targets);
    let before = if !dry && (ctx.review.is_some() || opts.state.is_some()) { capture(ctx, &unit_paths, &delete_only).await?.unwrap_or_default() } else { Vec::new() };
    let mut mutated: Vec<AbsPath> = Vec::new();
    let outcome: R<()> = async {
    for (i, unit) in units.iter().enumerate() {
        let display = unit.path.replace('\\', "/");
        if !mode.continue_after_failure && !failures.is_empty() {
            skipped.push(display);
            continue;
        }
        if ctx.cancel.is_cancelled() {
            failures.push((i, display, "Error: apply_patch aborted".to_owned()));
            continue;
        }
        // A rename runs as its own unit through the atomic rename executor, against the disk the
        // earlier units left behind.
        if unit.kind == Kind::Update && unit.move_path.is_some() {
            let attempt = async {
                validate_rename(ctx, base, unit, &mut HashSet::new()).await?;
                let op = build_rename(ctx, base, unit, fuzzy).await?;
                if !dry {
                    apply_rename(ctx, &op).await?;
                }
                R::Ok(if dry {
                    format!("(dry-run) would rename {display} → {} (~{} lines touched)", op.shown_dest, op.lines_changed)
                } else {
                    rename_line(&op, false)
                })
            };
            match attempt.await {
                Ok(text) => {
                    applied.push(text);
                    let (from, to) = (resolve_path(base, &unit.path)?, resolve_path(base, unit.move_path.as_deref().unwrap_or_default())?);
                    unit_committed(opts.state.as_deref(), &[&from, &to]).await;
                    mutated.push(from);
                    mutated.push(to);
                }
                Err(Stop::Text(e)) => failures.push((i, display, format!("Error: {}", e.strip_prefix("Error: ").unwrap_or(&e)))),
                Err(other) => return Err(other),
            }
            continue;
        }
        let converted = match convert(ctx, base, unit, fuzzy, opts.reject_partial, &mut notices).await {
            Ok(c) => c,
            Err(Stop::Text(e)) => {
                failures.push((i, display, format!("Error: {e}")));
                continue;
            }
            Err(other) => return Err(other),
        };
        let Some(entry) = converted else {
            applied.push(format!("(no changes) {display}"));
            continue;
        };
        match apply_ops(ctx, base, &[], std::slice::from_ref(&entry), opts, &mut Tx::unit()).await {
            Ok(text) => {
                applied.push(text);
                unit_committed(opts.state.as_deref(), &[&entry.abs]).await;
                mutated.push(entry.abs.clone());
            }
            Err(Stop::Text(e)) => failures.push((i, display, e)),
            Err(other) => return Err(other),
        }
    }
    Ok(())
    }
    .await;
    // Units that committed are reviewed whichever way the run ends.
    if !mutated.is_empty() {
        committed_patch(ctx, opts.state.as_deref(), &before, &mutated, &[], false).await;
    }
    outcome?;
    let report = sequence_report(units.len(), &applied, &failures, &skipped, mode.continue_after_failure, dry);
    let tail = notices.rejected_tail();
    Ok(wrap(&format!("{report}{tail}"), &mut notices))
}

/// The report of a multi-section run: all applied, stopped at the first failure, or file-level partial.
fn sequence_report(count: usize, applied: &[String], failures: &[(usize, String, String)], skipped: &[String], continue_after_failure: bool, dry: bool) -> String {
    let applied_texts = applied.iter().filter(|t| !t.is_empty()).cloned().collect::<Vec<_>>().join("\n");
    let report = if failures.is_empty() {
        let head = format!("apply_patch: {} {} section(s)", if dry { "validated" } else { "applied" }, count);
        if applied_texts.is_empty() { head } else { format!("{head}\n{applied_texts}") }
    } else if !continue_after_failure {
        let (index, failed_display, error) = &failures[0];
        let committed = if dry {
            format!("{} earlier section(s) were validated", applied.len())
        } else {
            format!("{} earlier section(s) were applied to disk (committed) and left in place", applied.len())
        };
        let mut lines = vec![format!(
            "Error: apply_patch sequence stopped at section {}/{} ({failed_display}); {committed}; {} later section(s) were skipped (not attempted).",
            index + 1,
            count,
            skipped.len()
        )];
        if !dry {
            lines.push("Retry only the failed and skipped sections; do not resend committed sections.".to_owned());
        }
        if !applied_texts.is_empty() {
            lines.push(format!("--- {} ---", if dry { "validated" } else { "applied (committed to disk)" }));
            lines.push(applied_texts);
        }
        lines.push(format!("--- failed section: {failed_display} ---"));
        lines.push(strip_error_prefix(error).to_owned());
        if !skipped.is_empty() {
            lines.push(format!("--- skipped (not attempted): {} ---", skipped.join(", ")));
        }
        lines.join("\n")
    } else {
        let phrase = if dry {
            format!("{}/{} file section(s) validated", applied.len(), count)
        } else {
            format!("{}/{} file(s) applied to disk (committed)", applied.len(), count)
        };
        let mut lines = vec![
            format!("Error: apply_patch file-level partial: {phrase}; {} file(s) rejected and left unchanged.", failures.len()),
            "Retry only the rejected files; do not resend committed files.".to_owned(),
        ];
        if !applied_texts.is_empty() {
            lines.push(format!("--- {} ---", if dry { "validated" } else { "applied (committed to disk)" }));
            lines.push(applied_texts);
        }
        for (i, display, error) in failures {
            lines.push(format!("--- rejected file {}/{}: {display} ---", i + 1, count));
            lines.push(strip_error_prefix(error).to_owned());
        }
        lines.join("\n")
    };
    let note = if dry && count > 1 { DRY_SEQUENCE_NOTE } else { "" };
    format!("{report}{note}")
}

fn strip_error_prefix(error: &str) -> &str {
    match error.strip_prefix("Error:") {
        Some(rest) => mixdog_js::js_trim_start(rest),
        None => error,
    }
}

// ---- post-patch excerpt ----

impl ApplyPatchTool {
    /// The changed span of a file this thread patched before, as it is on disk now. The first patch
    /// of a file adds nothing; only a repeat pays for the excerpt.
    async fn append_excerpts(&self, ctx: &ToolContext, base: &AbsPath, patch: &str, output: String) -> String {
        if is_error_text(&output) {
            return output;
        }
        let Ok(sections) = parse_v4a(patch) else { return output };
        let sections: Vec<Section> = sections.into_iter().filter(|s| s.kind == Kind::Update && !s.hunks.is_empty()).collect();
        let mut repeats: Vec<&Section> = Vec::new();
        {
            let mut seen = self.seen.lock().unwrap_or_else(|p| p.into_inner());
            let scope = ctx.thread_id.as_str().to_owned();
            let at = match seen.iter().position(|(s, _)| *s == scope) {
                Some(at) => at,
                None => {
                    seen.push((scope, Vec::new()));
                    while seen.len() > SEEN_SCOPES_CAP {
                        seen.remove(0);
                    }
                    seen.len() - 1
                }
            };
            for section in &sections {
                let target = section.move_path.as_deref().unwrap_or(&section.path);
                let Ok(abs) = resolve_path(base, target) else { continue };
                let key = path_key(&abs);
                if seen[at].1.contains(&key) {
                    repeats.push(section);
                } else {
                    seen[at].1.push(key);
                    while seen[at].1.len() > SEEN_FILES_CAP {
                        seen[at].1.remove(0);
                    }
                }
            }
        }
        if repeats.is_empty() {
            return output;
        }
        let mut chunks: Vec<String> = Vec::new();
        let mut chars = 0usize;
        for section in repeats.into_iter().take(EXCERPT_MAX_FILES) {
            let target = section.move_path.as_deref().unwrap_or(&section.path);
            let Ok(abs) = resolve_path(base, target) else { continue };
            let Ok(Some(bytes)) = read_opt(ctx, &abs).await else { continue };
            let file_lines: Vec<String> = String::from_utf8_lossy(&bytes).replace("\r\n", "\n").split('\n').map(str::to_owned).collect();
            let new_side: Vec<String> = section.hunks[0]
                .lines
                .iter()
                .filter(|l| matches!(l.as_bytes().first(), Some(b' ' | b'+')))
                .map(|l| l[1..].to_owned())
                .collect();
            if new_side.is_empty() {
                continue;
            }
            let Some(at) = (0..file_lines.len().saturating_sub(new_side.len() - 1)).find(|i| file_lines[*i..*i + new_side.len()] == new_side[..]) else {
                continue;
            };
            let shown_n = new_side.len().min(EXCERPT_MAX_LINES);
            let mut rows: Vec<String> = (0..shown_n).map(|i| format!("{:>5}| {}", at + i + 1, file_lines[at + i])).collect();
            if new_side.len() > shown_n {
                rows.push("     | …".to_owned());
            }
            let extra = section.hunks.len() - 1;
            let more = if extra > 0 { format!(" (+{extra} more {})", if extra == 1 { "hunk" } else { "hunks" }) } else { String::new() };
            let block = format!("{} lines {}-{}{more}:\n{}", target.replace('\\', "/"), at + 1, at + shown_n, rows.join("\n"));
            chars += mixdog_js::utf16_len(&block);
            if chars > EXCERPT_MAX_CHARS {
                break;
            }
            chunks.push(block);
        }
        if chunks.is_empty() {
            return output;
        }
        format!("{output}\npost-patch state (verbatim — use for follow-up patches):\n{}", chunks.join("\n"))
    }
}

fn error_code(text: &str) -> ToolErrorCode {
    if text.contains("V4A parse failed") {
        ToolErrorCode::InvalidArgs { field: "patch".to_owned(), reason: "parse".to_owned() }
    } else if text.contains("changed on disk") || text.contains("appeared during") {
        ToolErrorCode::Stale { expected: "unchanged".to_owned(), actual: "changed".to_owned() }
    } else {
        ToolErrorCode::Conflict { matches: 0 }
    }
}

const SCHEMA_KEYS: [&str; 8] = ["patch", "format", "base_path", "dry_run", "reject_partial", "fuzzy", "sequence", "mode"];
/// Patch bodies past this are a runaway blob, not an edit (`APPLY_PATCH_MAX_BYTES`).
const PATCH_MAX_BYTES: usize = 8 * 1024 * 1024;

/// The request flags every route shares.
struct Options {
    fuzzy: bool,
    reject_partial: bool,
    dry: bool,
    state: Option<Arc<ReadState>>,
}

/// How a multi-section patch runs: stop at the first failed section, or keep going past it.
struct Sequence {
    continue_after_failure: bool,
    coalesce: bool,
}

/// A V4A body whose newlines were shattered into stray top-level keys is re-joined in key order;
/// every schema key is kept as it is.
fn salvage_shattered(args: &JsonValue) -> JsonValue {
    let Some(map) = args.as_object() else { return args.clone() };
    let raw = map.get("patch").and_then(JsonValue::as_str).unwrap_or("");
    if !raw.starts_with("*** Begin Patch") || raw.contains('\n') || raw.contains("*** End Patch") {
        return args.clone();
    }
    if map.keys().all(|k| SCHEMA_KEYS.contains(&k.as_str())) {
        return args.clone();
    }
    let mut lines = vec![raw.to_owned()];
    for (key, value) in map.iter().filter(|(k, _)| !SCHEMA_KEYS.contains(&k.as_str())) {
        lines.push(key.clone());
        lines.push(match value {
            JsonValue::Null => String::new(),
            other => mixdog_js::value_to_string(other),
        });
    }
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    let mut cleaned: serde_json::Map<String, JsonValue> = map.iter().filter(|(k, _)| SCHEMA_KEYS.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    cleaned.insert("patch".to_owned(), JsonValue::String(lines.join("\n")));
    JsonValue::Object(cleaned)
}

/// `^\s*\[mixdog compacted\b[^\]\n]*\]`: the compacted-history marker a model pasted back as input.
fn starts_with_placeholder(text: &str) -> bool {
    let Some(rest) = mixdog_js::js_trim_start(text).strip_prefix("[mixdog compacted") else { return false };
    if rest.chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
        return false;
    }
    rest.find([']', '\n']).is_some_and(|at| rest.as_bytes()[at] == b']')
}

fn is_compacted_placeholder(patch: &str) -> bool {
    starts_with_placeholder(patch)
        || patch.split('\n').any(|line| !(line.starts_with('+') || line.starts_with('-') || line.starts_with(' ')) && starts_with_placeholder(line))
}

fn thrown(code: ToolErrorCode, message: &str) -> ToolError {
    fail(code, format!("Error: {message}"))
}

#[async_trait]
impl Tool for ApplyPatchTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    fn freeform(&self) -> Option<&Freeform> {
        Some(&self.freeform)
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        // Node `resolveApplyPatchRequest`: salvage, validate, then read the option flags.
        let args = salvage_shattered(&args);
        let patch = salvage_opening(arg_str(&args, "patch").unwrap_or(""));
        let patch = patch.as_str();
        if js_trim(patch).is_empty() {
            return Err(invalid("patch", "required", "Error: apply_patch: \"patch\" is required (unified diff or V4A patch string)"));
        }
        if is_compacted_placeholder(patch) {
            return Err(thrown(
                ToolErrorCode::InvalidArgs { field: "patch".to_owned(), reason: "placeholder".to_owned() },
                "patch body is a compacted-history placeholder ([mixdog compacted …]), not patch content. Submit real patch text; do not reuse or reconstruct the marker.",
            ));
        }
        if patch.len() > PATCH_MAX_BYTES {
            return Err(invalid(
                "patch",
                "too_large",
                format!("Error: apply_patch: patch too large ({} bytes > {PATCH_MAX_BYTES} byte cap); split into smaller patches", patch.len()),
            ));
        }
        let requested = args.get("format").and_then(JsonValue::as_str).map(str::to_lowercase).unwrap_or_default();
        if !requested.is_empty() && requested != "unified" && requested != "v4a" {
            return Err(invalid("format", "enum", "Error: apply_patch: \"format\" must be \"unified\" or \"v4a\""));
        }
        let dry_run = arg_bool(&args, "dry_run");
        let fuzzy = args.get("fuzzy").and_then(JsonValue::as_bool) != Some(false);
        let reject_partial = args.get("reject_partial").and_then(JsonValue::as_bool) != Some(false);
        let ordered = arg_bool(&args, "sequence") || matches!(arg_str(&args, "mode").map(str::to_lowercase).as_deref(), Some("ordered" | "sequence"));
        let base = match arg_str(&args, "base_path").filter(|b| !js_trim(b).is_empty()) {
            Some(b) => resolve_path(&ctx.cwd, b)?,
            None => ctx.cwd.clone(),
        };
        let opts = Options { fuzzy, reject_partial, dry: dry_run, state: self.state.clone() };
        let parse_failed = |text: String| fail(error_code(&text), text);
        let (sections, coalesce_sections) = if requested == "v4a" || is_v4a(patch) {
            match parse_v4a(patch) {
                Ok(s) => (s, true),
                Err(e) => return Err(parse_failed(format!("Error: apply_patch: V4A parse failed — {e}"))),
            }
        } else if requested != "unified" && has_bare_hunk(patch) {
            match parse_unified_as_v4a(patch, UnifiedAnchors::Bare) {
                Ok(s) => (s, false),
                Err(e) => return Err(parse_failed(format!("Error: apply_patch: bare @@ parse failed — {e}"))),
            }
        } else {
            let prepared = patch.strip_prefix('\u{FEFF}').unwrap_or(patch).replace("\r\n", "\n");
            match parse_patch(&prepared) {
                Ok(files) => return self.call_unified(ctx, &base, files, &opts, ordered).await,
                Err(message) => {
                    if !can_fall_back_counted(patch, &requested, &message) {
                        return Err(parse_failed(format!(
                            "Error: apply_patch: parse failed — {message}; prefer V4A envelope for multi-hunk edits (no @@ line counts)"
                        )));
                    }
                    match parse_unified_as_v4a(patch, UnifiedAnchors::Counted) {
                        Ok(s) => (s, false),
                        Err(fallback) => {
                            return Err(parse_failed(format!("Error: apply_patch: parse failed — {message}; V4A fallback failed — {fallback}")));
                        }
                    }
                }
            }
        };
        let sections = redirect_sections(ctx, &base, sections).await?;
        let mut touched: Vec<AbsPath> = Vec::new();
        for s in &sections {
            touched.push(resolve_path(&base, &s.path)?);
            if let Some(dest) = &s.move_path {
                touched.push(resolve_path(&base, dest)?);
            }
        }
        let _locked = lock_patch_targets(ctx, &touched).await?;
        let rename_only = sections.len() == 1 && sections[0].kind == Kind::Update && sections[0].move_path.is_some();
        let any_rename = sections.iter().any(|s| s.kind == Kind::Update && s.move_path.is_some());
        let mut keys = HashSet::new();
        for s in &sections {
            keys.insert(path_key(&resolve_path(&base, &s.path)?));
        }
        // A multi-file model-surface patch keeps going past a rejected file and merges repeated
        // sections per file; the explicit ordered mode does neither.
        let file_partial = coalesce_sections && !any_rename && keys.len() > 1;
        let sequence = (ordered || file_partial) && !rename_only;
        let outcome = if sequence {
            let mode = Sequence { continue_after_failure: file_partial && !ordered, coalesce: file_partial && !ordered };
            run_sequence(ctx, &base, sections, &opts, mode).await
        } else {
            run_batch(ctx, &base, sections, &opts, coalesce_sections).await
        };
        let mut text = into_text(outcome)?;
        if sequence && !dry_run {
            text = self.append_excerpts(ctx, &base, patch, text).await;
        }
        if is_error_text(&text) {
            return Err(fail(error_code(&text), text));
        }
        Ok(with_card_diff(ctx, text_output(text)))
    }
}

// ---- unified patches (Node `codex-batch` over jsdiff's parsed entries) ----

fn is_null(name: &Option<String>) -> bool {
    name.as_deref() == Some("/dev/null")
}

/// How a parsed entry classifies: `/dev/null` old side is a create, new side a delete.
#[derive(Clone, Copy, PartialEq, Eq)]
enum UKind {
    Create,
    Delete,
    Modify,
}

fn classify(file: &UFile) -> UKind {
    match (is_null(&file.old_name), is_null(&file.new_name)) {
        (true, false) => UKind::Create,
        (false, true) => UKind::Delete,
        _ => UKind::Modify,
    }
}

/// The header that names an entry's target: the new side of a create, the old side otherwise.
fn target_name(file: &UFile) -> Option<&str> {
    let name = if classify(file) == UKind::Create { file.new_name.as_deref() } else { file.old_name.as_deref() };
    name.filter(|n| !n.is_empty() && *n != "/dev/null")
}

fn range_text(start: usize, lines: usize) -> String {
    format!("{},{lines}", if lines == 0 { start.saturating_sub(1) } else { start })
}

/// The entry's hunks re-rendered as the engine reads them (a zero-length range un-bumped).
fn to_uhunks(file: &UFile) -> Vec<UHunk> {
    file.hunks
        .iter()
        .map(|h| UHunk {
            header: format!("@@ -{} +{} @@", range_text(h.old_start, h.old_lines), range_text(h.new_start, h.new_lines)),
            old_start: h.old_start,
            lines: h.lines.clone(),
        })
        .collect()
}

/// The header the engine is given: an absolute name inside the base is made relative to it.
fn engine_name(base: &AbsPath, raw: &str) -> String {
    let stripped = strip_diff_prefix(raw);
    if std::path::Path::new(stripped).is_absolute() {
        if let Some(rel) = relative_inside(base.as_path(), &PathBuf::from(stripped)).filter(|r| !r.as_os_str().is_empty()) {
            return fwd(&rel);
        }
    }
    raw.to_owned()
}

/// Node `rewriteParsedReadRedirects`: a missing target with one relocated twin is re-pointed at it.
async fn redirect_files(ctx: &ToolContext, base: &AbsPath, mut files: Vec<UFile>) -> Result<Vec<UFile>, ToolError> {
    for file in &mut files {
        let kind = classify(file);
        let Some(old) = file.old_name.clone().filter(|o| !o.is_empty()) else { continue };
        if kind == UKind::Create {
            continue;
        }
        let requested = resolve_path(base, strip_diff_prefix(&old))?;
        if let Some(header) = relocated_header(ctx, base, &requested).await? {
            if kind == UKind::Modify {
                if let Some(new) = file.new_name.clone().filter(|n| !n.is_empty()) {
                    if path_key(&resolve_path(base, strip_diff_prefix(&new))?) == path_key(&requested) {
                        file.new_name = Some(header.clone());
                    }
                }
            }
            file.old_name = Some(header);
        }
    }
    Ok(files)
}

/// The one-operation-per-target rule and Node's pre-validation, then one `Entry` per file. Errors
/// are complete model-facing texts.
async fn unified_entries(ctx: &ToolContext, base: &AbsPath, files: Vec<UFile>, fuzzy: bool) -> R<Vec<Entry>> {    if files.is_empty() {
        return text_err("Error: patch contained no file sections");
    }
    let mut seen: Vec<(String, String)> = Vec::new();
    for file in &files {
        let Some(name) = target_name(file) else { continue };
        let key = path_key(&resolve_path(base, strip_diff_prefix(name))?);
        if seen.iter().any(|(k, _)| *k == key) {
            return text_err(format!("Error: apply_patch: multiple operations target {}", strip_diff_prefix(name).replace('\\', "/")));
        }
        seen.push((key, name.to_owned()));
    }
    let mut entries = Vec::new();
    for file in &files {
        let kind = classify(file);
        let Some(name) = target_name(file) else { return text_err(NO_HEADER) };
        let display = strip_diff_prefix(name).replace('\\', "/");
        if kind != UKind::Delete && file.hunks.is_empty() {
            return text_err(format!("Error: apply_patch: entry {display} has no hunks — patch header malformed (use `@@ -A,B +C,D @@` per hunk)."));
        }
        let abs = resolve_path(base, strip_diff_prefix(name))?;
        let lines = || file.hunks.iter().flat_map(|h| &h.lines);
        let added = lines().filter(|l| l.starts_with('+')).count();
        let removed = lines().filter(|l| l.starts_with('-')).count();
        let shown_path = normalize_output_path(&display);
        let native_entry = |delete: bool| NativeEntry {
            delete,
            header: display.clone(),
            old_name: engine_name(base, file.old_name.as_deref().unwrap_or("/dev/null")),
            new_name: engine_name(base, file.new_name.as_deref().unwrap_or("/dev/null")),
            abs: abs.clone(),
            hunks: to_uhunks(file),
            deleted_lines: Vec::new(),
        };
        match kind {
            UKind::Create => {
                let mut content = lines().filter_map(|l| l.strip_prefix('+')).collect::<Vec<_>>().join("\n");
                content.push('\n');
                entries.push(Entry { kind: EKind::Create, abs, shown: shown_path, added, removed: 0, content: content.into_bytes(), before: None, js: true, native: None, error: None, gate: None });
            }
            UKind::Delete => {
                let before = read_present(ctx, &abs, SNAPSHOT_MAX_BYTES, true).await?;
                let js = uses_js_writer(ctx, base, &abs, true).await?;
                let native = (!js).then(|| native_entry(true));
                entries.push(Entry { kind: EKind::Delete, abs, shown: shown_path, added: 0, removed, content: Vec::new(), before, js, native, error: None, gate: None });
            }
            UKind::Modify => {
                // Bytes the codec check can read; a file past the edit limit or absent is left to
                // the snapshot (batch) or the content guard (dry run) and to the engine.
                let bytes = read_present(ctx, &abs, EDIT_MAX_BYTES, false).await?;
                let decoded = bytes.as_deref().map(decode_patch_target);
                let utf16 = matches!(&decoded, Some(Ok((_, codec))) if codec.encoding != Encoding::Utf8);
                let js = utf16 || uses_js_writer(ctx, base, &abs, false).await?;
                let decode_failure = |decoded: &Option<Result<(String, Codec), String>>| match decoded {
                    Some(Err(reason)) => Some(decode_message(reason, &normalize_output_path(&display))),
                    _ => None,
                };
                if !js {
                    let native = native_entry(false);
                    let gate = decode_failure(&decoded);
                    entries.push(Entry { kind: EKind::Modify, abs, shown: shown_path, added, removed, content: Vec::new(), before: bytes, js: false, native: Some(native), error: None, gate });
                    continue;
                }
                let (content, error) = match decoded {
                    Some(Ok((text, codec))) => match apply_unified_hunks(&Lines::split(&text), &to_uhunks(file), if fuzzy { 2 } else { 0 }, &normalize_output_path(&display)) {
                        Ok(applied) => (encode_text(&applied.join(), codec), None),
                        Err(message) => (Vec::new(), Some(message)),
                    },
                    other => {
                        let message = decode_failure(&other).unwrap_or_else(|| format!("ENOENT: no such file or directory, lstat '{}'", abs.as_path().display()));
                        (Vec::new(), Some(message))
                    }
                };                entries.push(Entry { kind: EKind::Modify, abs, shown: shown_path, added, removed, content, before: bytes, js: true, native: None, error, gate: None });
            }
        }
    }
    Ok(entries)
}

/// A unified patch as one batch: validated in full, written as one unit.
async fn run_unified(ctx: &ToolContext, base: &AbsPath, files: Vec<UFile>, opts: &Options) -> R<String> {
    let mut notices = Notices::default();
    let entries = unified_entries(ctx, base, files, opts.fuzzy).await?;
    let mut tx = if opts.dry { Tx::unit() } else { begin_tx(ctx, &entries, &[], base).await? };
    tx.state = opts.state.clone();
    let outcome = apply_ops(ctx, base, &[], &entries, opts, &mut tx).await;
    finish_batch(ctx, &mut tx, outcome, opts.dry, &mut notices).await
}
/// `canFallbackCountedUnified`'s error test: jsdiff refused the counts, not the shape.
fn is_count_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    let hunk_at = lower.find("hunk at line ").is_some_and(|at| {
        let rest = &lower[at..];
        rest.contains("more lines than expected") || rest.contains("less lines than expected")
    });
    let expected_old = lower.match_indices("expected ").any(|(at, _)| {
        let rest = &lower[at + 9..];
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        digits > 0 && rest[digits..].starts_with(" old lines")
    });
    hunk_at || expected_old || lower.contains("line count did not match")
}

/// Whether the text could be a counted unified diff whose counts are merely wrong.
fn can_fall_back_counted(patch: &str, requested: &str, message: &str) -> bool {
    if requested == "unified" {
        return false;
    }
    let text = patch.strip_prefix('\u{FEFF}').unwrap_or(patch).replace("\r\n", "\n");
    let lines: Vec<&str> = text.split('\n').collect();
    lines.iter().any(|l| l.starts_with("--- "))
        && lines.iter().any(|l| l.starts_with("+++ "))
        && is_counted_header(lines.iter().find(|l| l.starts_with("@@")).copied().unwrap_or(""))
        && is_count_error(message)
}
const HEADERLESS: &str = "Error: apply_patch: a file section header could not be parsed (no target path) — the patch body is not a valid diff. Each section must start with `*** Update File: <path>` / `*** Add File: <path>` / `*** Delete File: <path>` (V4A, wrapped in `*** Begin Patch` / `*** End Patch`), or a `--- a/<path>` + `+++ b/<path>` pair (unified).";

/// A unified patch in the explicit ordered mode: one unit per file, in listed order.
async fn run_unified_sequence(ctx: &ToolContext, base: &AbsPath, files: Vec<UFile>, opts: &Options) -> R<String> {
    let mut notices = Notices::default();
    let count = files.len();
    let mut applied: Vec<String> = Vec::new();
    let mut failures: Vec<(usize, String, String)> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut unit_paths: Vec<AbsPath> = Vec::new();
    for file in &files {
        if let Some(name) = target_name(file) {
            unit_paths.push(resolve_path(base, strip_diff_prefix(name))?);
        }
    }
    let mut targets = Vec::new();
    for file in &files {
        if let Some(name) = target_name(file) {
            targets.push((resolve_path(base, strip_diff_prefix(name))?, classify(file) == UKind::Delete));
        }
    }
    let delete_only = delete_only_keys(&targets);
    let before = if !opts.dry && (ctx.review.is_some() || opts.state.is_some()) { capture(ctx, &unit_paths, &delete_only).await?.unwrap_or_default() } else { Vec::new() };
    let mut mutated: Vec<AbsPath> = Vec::new();
    let outcome: R<()> = async {
    for (i, file) in files.into_iter().enumerate() {
        let Some(name) = target_name(&file) else { return text_err(HEADERLESS) };
        let display = strip_diff_prefix(name).replace('\\', "/");
        if !failures.is_empty() {
            skipped.push(display);
            continue;
        }
        if ctx.cancel.is_cancelled() {
            failures.push((i, display, "Error: apply_patch aborted".to_owned()));
            continue;
        }
        let result = match unified_entries(ctx, base, vec![file], opts.fuzzy).await {
            Ok(entries) => apply_ops(ctx, base, &[], &entries, opts, &mut Tx::unit())
                .await
                .map(|text| (text, entries.into_iter().map(|e| e.abs).collect::<Vec<_>>())),
            Err(stop) => Err(stop),
        };
        match result {
            Ok((text, touched)) => {
                applied.push(text);
                unit_committed(opts.state.as_deref(), &touched.iter().collect::<Vec<_>>()).await;
                mutated.extend(touched);
            }
            Err(Stop::Text(e)) => failures.push((i, display, e)),
            Err(other) => return Err(other),
        }
    }
    Ok(())
    }
    .await;
    if !mutated.is_empty() {
        committed_patch(ctx, opts.state.as_deref(), &before, &mutated, &[], false).await;
    }
    outcome?;
    let report = sequence_report(count, &applied, &failures, &skipped, false, opts.dry);
    Ok(wrap(&report, &mut notices))
}

impl ApplyPatchTool {
    /// A genuine unified diff: one batch, or the ordered sequence when asked for.
    async fn call_unified(&self, ctx: &ToolContext, base: &AbsPath, files: Vec<UFile>, opts: &Options, ordered: bool) -> ToolOutcome {
        let files = redirect_files(ctx, base, files).await?;
        let mut touched: Vec<AbsPath> = Vec::new();
        for file in &files {
            if let Some(name) = target_name(file) {
                touched.push(resolve_path(base, strip_diff_prefix(name))?);
            }
        }
        let _locked = lock_patch_targets(ctx, &touched).await?;
        let outcome = if ordered { run_unified_sequence(ctx, base, files, opts).await } else { run_unified(ctx, base, files, opts).await };
        let text = into_text(outcome)?;
        if is_error_text(&text) {
            return Err(fail(error_code(&text), text));
        }
        Ok(with_card_diff(ctx, text_output(text)))
    }
}