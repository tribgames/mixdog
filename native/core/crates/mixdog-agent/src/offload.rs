//! Tool-result budgets: a result too large for the transcript is stored as an
//! artifact and replaced by a pointer and a head/tail preview; the text parts
//! of one batch share a per-message budget; inline images are re-encoded or
//! replaced before they reach the transcript.
//!
//! Lengths are UTF-16 code units, as the budgets were defined: thresholds and
//! previews match the earlier runtime character for character.

use async_trait::async_trait;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ImageSource;

use crate::message::ToolKind;

pub const OFFLOAD_PREFIX: &str = "[tool output offloaded:";
const DEFAULT_THRESHOLD: usize = 50_000;
const SETUP_THRESHOLD: usize = 20 * 1024;
const GREP_THRESHOLD: usize = 20_000;
const SHELL_SESSION_THRESHOLD: usize = 30_000;
const MESSAGE_MAX: usize = 200_000;
const MIN_PART: usize = 2_000;
const PREVIEW: usize = 512;
const GIT_PREVIEW: usize = 8_000;

/// A stored artifact: content-addressed, verified, owner-only.
pub struct Artifact {
    /// The path as shown to the model by an offload pointer (Node `normalizeOutputPath`).
    pub display_path: String,
    /// The path as the OS writes it (Node `artifact.path`): what a compaction's recovery notes and
    /// an execution dump's references name.
    pub path: String,
    /// Line count of the stored text.
    pub lines: usize,
    /// Lowercase hex SHA-256 of the stored text; the file is named by it.
    pub sha256: String,
}

#[async_trait]
pub trait ArtifactStore: Send + Sync {
    /// Persists `content` for the session; `None` when it did not land and
    /// verify (the complete text then stays inline). Cancel-safe.
    async fn persist(&self, content: &str) -> Option<Artifact>;

    /// The artifact persist would produce (path, line count, sha256),
    /// computed without creating a directory or a file: a compaction preview
    /// must not archive a transcript it will keep. None when the content
    /// has no artifact identity.
    async fn preview(&self, content: &str) -> Option<Artifact>;
}

/// How an inline image leaves the batch.
pub enum ImageOutcome {
    /// Re-encoded; `note` is the text that supersedes the original's size
    /// metadata, placed before the image.
    Compacted { data: String, mime: String, note: Option<String> },
    /// Unusable: fixed placeholder text in its place.
    Omitted(String),
    Keep,
}

#[async_trait]
pub trait ImageCompactor: Send + Sync {
    async fn compact(&self, data: &str, mime: &str) -> ImageOutcome;
}

/// Characters a tool's result may keep inline (`usize::MAX`: never offloaded).
/// Read-like tools bound themselves; shell and task already cap and name
/// their full log on disk.
fn threshold(tool: &str) -> usize {
    match tool.to_lowercase().as_str() {
        "read" | "head" | "tail" | "diff" | "skill" | "skill_view" | "skills_list" | "shell" | "task" => usize::MAX,
        "grep" => GREP_THRESHOLD,
        "glob" | "list" | "tree" | "find_files" | "code_graph" => DEFAULT_THRESHOLD,
        "bash_session" | "terminal" => SHELL_SESSION_THRESHOLD,
        "setup" => SETUP_THRESHOLD,
        _ => DEFAULT_THRESHOLD,
    }
}

fn aggregate_excluded(tool: &str) -> bool {
    matches!(
        tool.to_lowercase().as_str(),
        "shell" | "task" | "read" | "head" | "tail" | "diff" | "skill" | "skill_view" | "skills_list"
    )
}

fn u16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn is_offloaded(text: &str) -> bool {
    text.starts_with(OFFLOAD_PREFIX)
}

fn splits_pair(units: &[u16], at: usize) -> bool {
    at > 0
        && at < units.len()
        && (0xd800..=0xdbff).contains(&units[at - 1])
        && (0xdc00..=0xdfff).contains(&units[at])
}

fn js_round(x: f64) -> usize {
    (x + 0.5).floor() as usize
}

/// Head and tail of `text` within `max` units, cut on line boundaries when one
/// is near; `(preview, truncated)`.
fn build_preview(text: &str, max: usize) -> (String, bool) {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= max {
        return (text.to_owned(), false);
    }
    let head_budget = (max as f64 * 0.6).floor() as usize;
    let tail_budget = max - head_budget;
    let head_end = head_budget - usize::from(splits_pair(&units, head_budget));
    let mut head = &units[..head_end];
    if let Some(cut) = head.iter().rposition(|u| *u == u16::from(b'\n'))
        && cut > (head_budget as f64 * 0.6).floor() as usize
    {
        head = &head[..cut];
    }
    let mut tail_start = units.len().saturating_sub(tail_budget);
    if splits_pair(&units, tail_start) {
        tail_start += 1;
    }
    let mut tail = &units[tail_start..];
    if let Some(cut) = tail.iter().position(|u| *u == u16::from(b'\n'))
        && cut < (tail_budget as f64 * 0.4).floor() as usize
    {
        tail = &tail[cut + 1..];
    }
    let omitted_kb = js_round((units.len() - head.len() - tail.len()) as f64 / 1024.0).max(1);
    (
        format!(
            "{}\n... [preview middle omitted — {omitted_kb} KB] ...\n{}",
            String::from_utf16_lossy(head),
            String::from_utf16_lossy(tail)
        ),
        true,
    )
}

/// One text body replaced by its pointer and preview; unchanged when it did
/// not persist (persistence is the reduction's commit point).
async fn offload_text(store: &dyn ArtifactStore, tool: &str, text: &str) -> String {
    let Some(artifact) = store.persist(text).await else {
        return text.to_owned();
    };
    // git offloads were fetched from the preview most of the time, so git
    // keeps a head and tail large enough to answer from directly.
    let git = tool.eq_ignore_ascii_case("git");
    let (preview, truncated) = build_preview(text, if git { GIT_PREVIEW } else { PREVIEW });
    let size_kb = js_round(u16_len(text) as f64 / 1024.0).max(1);
    let path = &artifact.display_path;
    let header = format!("{OFFLOAD_PREFIX} {tool} → {path} ({size_kb} KB, {} lines)]", artifact.lines);
    let suffix = if !truncated {
        String::new()
    } else if git {
        format!("\n[output capped at {GIT_PREVIEW} chars; narrow: read it with offset/limit; full output: {path}]")
    } else {
        "\n[preview truncated; full output preserved at the artifact path above]".to_owned()
    };
    format!("{header}\n\n{preview}{suffix}")
}

fn text_len(part: &ContentPart) -> usize {
    match part {
        ContentPart::Text(t, _) => u16_len(t),
        _ => 0,
    }
}

fn inline_len(content: &Content) -> usize {
    match content {
        Content::Text(t) => u16_len(t),
        Content::Parts(parts) => parts.iter().map(text_len).sum(),
    }
}

fn is_offloadable_part(part: &ContentPart) -> bool {
    matches!(part, ContentPart::Text(t, _) if u16_len(t) >= MIN_PART && !is_offloaded(t))
}

/// Characters still available for reduction: a pointer is never re-offloaded
/// and a part below the pointer's own size would grow the transcript.
fn offloadable_len(content: &Content) -> usize {
    match content {
        Content::Text(t) => {
            if is_offloaded(t) {
                0
            } else {
                u16_len(t)
            }
        }
        Content::Parts(parts) => parts.iter().filter(|p| is_offloadable_part(p)).map(text_len).sum(),
    }
}

/// A result's per-tool offload (`force`: whatever its size). Errors stay inline
/// up to the global default so the model can self-correct without a read turn.
pub async fn offload_result(
    store: &dyn ArtifactStore,
    tool: &str,
    kind: Option<ToolKind>,
    content: &Content,
    force: bool,
) -> Content {
    match content {
        Content::Text(text) => {
            if is_offloaded(text) || (!force && u16_len(text) <= threshold(tool)) {
                return content.clone();
            }
            if !force && kind == Some(ToolKind::Error) && u16_len(text) <= DEFAULT_THRESHOLD {
                return content.clone();
            }
            Content::Text(offload_text(store, tool, text).await)
        }
        Content::Parts(parts) => {
            if !parts.iter().any(|p| matches!(p, ContentPart::Text(_, _))) {
                return content.clone();
            }
            let limit = if force { 0 } else { threshold(tool) };
            let mut inline = inline_len(content);
            if inline <= limit {
                return content.clone();
            }
            if !force && kind == Some(ToolKind::Error) && inline <= DEFAULT_THRESHOLD {
                return content.clone();
            }
            let mut order: Vec<usize> = (0..parts.len()).filter(|i| is_offloadable_part(&parts[*i])).collect();
            order.sort_by_key(|i| std::cmp::Reverse(text_len(&parts[*i])));
            let mut next = parts.clone();
            let mut changed = false;
            for index in order {
                let ContentPart::Text(text, _) = &next[index] else {
                    continue;
                };
                let replaced = offload_text(store, tool, text).await;
                if replaced == *text {
                    continue;
                }
                inline = inline + u16_len(&replaced) - u16_len(text);
                next[index] = ContentPart::Text(replaced, None);
                changed = true;
                if inline <= limit {
                    break;
                }
            }
            if changed { Content::Parts(next) } else { content.clone() }
        }
    }
}

/// One result of a batch.
pub struct BatchEntry {
    pub tool: String,
    pub kind: Option<ToolKind>,
    pub content: Content,
}

/// Per-tool limits first, then the message-level budget across the batch's
/// remaining text results: largest first, ties preferring the latest result.
pub async fn offload_batch(store: &dyn ArtifactStore, entries: &mut [BatchEntry]) {
    for entry in entries.iter_mut() {
        entry.content = offload_result(store, &entry.tool, entry.kind, &entry.content, false).await;
    }
    let eligible = |e: &BatchEntry| !aggregate_excluded(&e.tool);
    let mut total: usize = entries.iter().filter(|e| eligible(e)).map(|e| inline_len(&e.content)).sum();
    let mut attempted = vec![false; entries.len()];
    while total > MESSAGE_MAX {
        let mut ranked: Vec<(usize, usize)> = entries
            .iter()
            .enumerate()
            .filter(|(i, e)| !attempted[*i] && eligible(e))
            .map(|(i, e)| (i, offloadable_len(&e.content)))
            .filter(|(_, len)| *len > 0)
            .collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.cmp(&a.0)));
        let Some(&(index, _)) = ranked.first() else {
            break;
        };
        attempted[index] = true;
        let before = inline_len(&entries[index].content);
        let entry = &entries[index];
        let replaced = offload_result(store, &entry.tool, entry.kind, &entry.content, true).await;
        let after = inline_len(&replaced);
        entries[index].content = replaced;
        total = (total as i64 + after as i64 - before as i64).max(0) as usize;
    }
}

/// Inline images are validated and re-encoded once, before the result reaches
/// the transcript; stored history is never revisited.
pub async fn compact_images(compactor: &dyn ImageCompactor, content: &Content) -> Content {
    let Content::Parts(parts) = content else {
        return content.clone();
    };
    let mut out = Vec::with_capacity(parts.len());
    let mut changed = false;
    for part in parts {
        let ContentPart::Image(ImageSource::Base64 { data, mime_type, .. }) = part else {
            out.push(part.clone());
            continue;
        };
        match compactor.compact(data, mime_type).await {
            ImageOutcome::Keep => out.push(part.clone()),
            ImageOutcome::Omitted(text) => {
                changed = true;
                out.push(ContentPart::Text(text, None));
            }
            ImageOutcome::Compacted { data, mime, note } => {
                changed = true;
                if let Some(note) = note {
                    out.push(ContentPart::Text(note, None));
                }
                out.push(ContentPart::Image(ImageSource::Base64 { data, mime_type: mime, width: None, height: None }));
            }
        }
    }
    if changed { Content::Parts(out) } else { content.clone() }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct Store(Mutex<Vec<String>>);
    #[async_trait]
    impl ArtifactStore for Store {
        async fn persist(&self, content: &str) -> Option<Artifact> {
            self.0.lock().unwrap().push(content.to_owned());
            Some(Artifact { display_path: "/art/x.txt".into(), path: "/art/x.txt".into(), lines: content.lines().count(), sha256: "ab".repeat(32) })
        }
        async fn preview(&self, content: &str) -> Option<Artifact> {
            Some(Artifact { display_path: "/art/x.txt".into(), path: "/art/x.txt".into(), lines: content.lines().count(), sha256: "ab".repeat(32) })
        }
    }

    #[tokio::test]
    async fn a_large_result_becomes_a_pointer_and_a_head_tail_preview() {
        let store = Store(Mutex::new(Vec::new()));
        let text = format!("{}\n{}", "a".repeat(30_000), "z".repeat(30_000));
        let out = offload_result(&store, "grep", Some(ToolKind::Normal), &Content::Text(text.clone()), false).await;
        let Content::Text(out) = out else { panic!() };
        assert!(out.starts_with("[tool output offloaded: grep → /art/x.txt (59 KB, 2 lines)]\n\n"));
        assert!(out.contains("\n... [preview middle omitted — 58 KB] ...\n"));
        assert!(out.ends_with("\n[preview truncated; full output preserved at the artifact path above]"));
        assert_eq!(store.0.lock().unwrap()[0], text);
        // a preview names the same artifact without writing it
        let preview = store.preview(&text).await.unwrap();
        assert_eq!(preview.sha256.len(), 64);
        assert_eq!(store.0.lock().unwrap().len(), 1);
        // read-like tools and small errors stay inline
        let big = Content::Text("x".repeat(60_000));
        assert_eq!(offload_result(&store, "read", None, &big, false).await, big);
        assert_eq!(offload_result(&store, "grep", Some(ToolKind::Error), &Content::Text("e".repeat(30_000)), false).await, Content::Text("e".repeat(30_000)));
    }

    #[tokio::test]
    async fn the_batch_budget_offloads_the_largest_eligible_results_first() {
        let store = Store(Mutex::new(Vec::new()));
        let part = |n: usize| Content::Text("y".repeat(n));
        let mut entries = vec![
            BatchEntry { tool: "list".into(), kind: None, content: part(49_000) },
            BatchEntry { tool: "glob".into(), kind: None, content: part(49_000) },
            BatchEntry { tool: "find_files".into(), kind: None, content: part(49_000) },
            BatchEntry { tool: "code_graph".into(), kind: None, content: part(49_000) },
            BatchEntry { tool: "tree".into(), kind: None, content: part(49_000) },
        ];
        offload_batch(&store, &mut entries).await;
        // 245k > 200k: one forced offload, the latest of the equal results
        let offloaded: Vec<bool> = entries
            .iter()
            .map(|e| matches!(&e.content, Content::Text(t) if is_offloaded(t)))
            .collect();
        assert_eq!(offloaded, [false, false, false, false, true]);
    }

    #[test]
    fn previews_never_split_a_surrogate_pair() {
        let text = "😀".repeat(600);
        let (preview, truncated) = build_preview(&text, 512);
        assert!(truncated);
        assert!(!preview.contains('\u{fffd}'));
    }
}
