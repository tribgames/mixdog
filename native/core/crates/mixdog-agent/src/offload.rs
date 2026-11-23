//! Tool-result budgets: a result too large for the transcript is stored as an
//! artifact and replaced by a pointer and a head/tail preview; the text parts
//! of one batch share a per-message budget; inline images are re-encoded and
//! imported into the attachment store before they reach the transcript.
//!
//! Lengths are UTF-16 code units, as the budgets were defined: thresholds and
//! previews match the earlier runtime character for character.

use async_trait::async_trait;
use mixdog_core_api::domain::provider::BinarySource;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ImageSource;

use crate::result_kind::ResultKind;
use crate::result_kind::classify_result_kind;

pub const OFFLOAD_PREFIX: &str = "[tool output offloaded:";
const DEFAULT_THRESHOLD: usize = 50_000;
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
    Compacted {
        data: String,
        mime: String,
        note: Option<String>,
    },
    /// Imported into the attachment store: the history holds the reference. The store records the picture's verdict, a
    /// refusal included, so the image is never replaced by text; a send that cannot carry it names it.
    Stored {
        reference: String,
        mime: String,
        note: Option<String>,
    },
    Keep,
}

#[async_trait]
pub trait ImageCompactor: Send + Sync {
    async fn compact(&self, data: &str, mime: &str) -> ImageOutcome;

    /// An image a tool left in the blob store (`reference`: its sha256 digest), imported for its verdict: the attachment
    /// reference and the picture type; `None` leaves the part as it is.
    async fn import_blob(&self, reference: &str) -> Option<(String, String)> {
        let _ = reference;
        None
    }
}

/// Where a tool-result image enters the attachment store (the one importer every ingress shares).
#[async_trait]
pub trait ImageIntake: Send + Sync {
    /// The attachment reference of the stored image, whatever its verdict; `None` when the store could not take it now
    /// (the image then stays as it is, never lost).
    async fn store(&self, base64: &str, name: &str) -> Option<String>;

    /// The same for a picture already in the blob store: its reference and the picture type (`image/*` for a refused one,
    /// whose type was never established).
    async fn store_blob(&self, reference: &str, name: &str) -> Option<(String, String)>;
}

fn aggregate_excluded(tool: &str) -> bool {
    matches!(tool.to_lowercase().as_str(), "shell" | "task" | "read" | "head" | "tail" | "diff" | "skill" | "skill_view" | "skills_list")
}

fn u16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

pub(crate) fn is_offloaded(text: &str) -> bool {
    text.starts_with(OFFLOAD_PREFIX)
}

fn js_round(x: f64) -> usize {
    (x + 0.5).floor() as usize
}

/// Head and tail of `text` within `max` units, cut on line boundaries when one
/// is near; `(preview, truncated)`.
fn build_preview(text: &str, max: usize) -> (String, bool) {
    let len = u16_len(text);
    if len <= max {
        return (text.to_owned(), false);
    }
    let head_budget = (max as f64 * 0.6).floor() as usize;
    let tail_budget = max - head_budget;
    let edge_bytes = |chars: &mut dyn Iterator<Item = char>, mut left: usize| {
        chars
            .take_while(|c| {
                if c.len_utf16() > left {
                    return false;
                }
                left -= c.len_utf16();
                true
            })
            .map(char::len_utf8)
            .sum::<usize>()
    };
    let mut head = &text[..edge_bytes(&mut text.chars(), head_budget)];
    if let Some(cut) = head.rfind('\n')
        && u16_len(&head[..cut]) > (head_budget as f64 * 0.6).floor() as usize
    {
        head = &head[..cut];
    }
    let mut tail = &text[text.len() - edge_bytes(&mut text.chars().rev(), tail_budget)..];
    if let Some(cut) = tail.find('\n')
        && u16_len(&tail[..cut]) < (tail_budget as f64 * 0.4).floor() as usize
    {
        tail = &tail[cut + 1..];
    }
    let omitted_kb = js_round((len - u16_len(head) - u16_len(tail)) as f64 / 1024.0).max(1);
    (format!("{head}\n... [preview middle omitted — {omitted_kb} KB] ...\n{tail}"), true)
}

/// One text body replaced by its pointer and preview; unchanged when it did
/// not persist (persistence is the reduction's commit point).
async fn offload_text(store: &dyn ArtifactStore, tool: &str, text: &str) -> Option<String> {
    let artifact = store.persist(text).await?;
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
        // The git tool already worded how to get less or more (`raise output_limit … or narrow the command`); a second
        // instruction here contradicted it and sent agents to re-read the stored file piecemeal.
        format!("\n[preview of {GIT_PREVIEW} chars; full output: {path}]")
    } else {
        "\n[preview truncated; full output preserved at the artifact path above]".to_owned()
    };
    Some(format!("{header}\n\n{preview}{suffix}"))
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

/// Whether the result's own text reads as an error (`classifyResultKind(text) === 'error'`): the convention is read from
/// the very start of the body, whatever the call's recorded kind says.
fn reads_as_error(text: &str) -> bool {
    classify_result_kind(text, "") == ResultKind::Error
}

/// One result of a batch.
pub struct BatchEntry {
    pub tool: String,
    pub content: Content,
}

/// Inline images are validated and re-encoded once, before the result reaches
/// the transcript; stored history is never revisited.
pub async fn compact_images(compactor: &dyn ImageCompactor, content: &Content) -> Content {
    let Content::Parts(parts) = content else { return content.clone() };
    compact_parts(compactor, parts.iter().map(std::borrow::Cow::Borrowed)).await
}

pub(crate) async fn compact_owned_images(compactor: &dyn ImageCompactor, content: Content) -> Content {
    let Content::Parts(parts) = content else {
        return content;
    };
    compact_parts(compactor, parts.into_iter().map(std::borrow::Cow::Owned)).await
}

async fn compact_parts<'a>(compactor: &dyn ImageCompactor, parts: impl ExactSizeIterator<Item = std::borrow::Cow<'a, ContentPart>>) -> Content {
    let mut out = Vec::with_capacity(parts.len());
    for part in parts {
        if let ContentPart::Image(ImageSource::FileId(id)) = part.as_ref()
            && let Some(digest) = id.strip_prefix("sha256:")
            && let Some((reference, mime_type)) = compactor.import_blob(digest).await
        {
            out.push(ContentPart::File { source: BinarySource::AttachmentRef(reference), mime_type, filename: None, text: None });
            continue;
        }
        let ContentPart::Image(ImageSource::Base64 { data, mime_type, .. }) = part.as_ref() else {
            out.push(part.into_owned());
            continue;
        };
        match compactor.compact(data, mime_type).await {
            ImageOutcome::Keep => out.push(part.into_owned()),
            ImageOutcome::Stored { reference, mime, note } => {
                if let Some(note) = note {
                    out.push(ContentPart::Text(note, None));
                }
                out.push(ContentPart::File { source: BinarySource::AttachmentRef(reference), mime_type: mime, filename: None, text: None });
            }
            ImageOutcome::Compacted { data, mime, note } => {
                if let Some(note) = note {
                    out.push(ContentPart::Text(note, None));
                }
                out.push(ContentPart::Image(ImageSource::Base64 { data, mime_type: mime, width: None, height: None }));
            }
        }
    }
    Content::Parts(out)
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

    #[test]
    fn previews_never_split_a_surrogate_pair() {
        let text = "😀".repeat(600);
        let (preview, truncated) = build_preview(&text, 512);
        assert!(truncated);
        assert!(!preview.contains('\u{fffd}'));
    }

    #[tokio::test]
    async fn a_large_result_becomes_a_pointer_and_a_head_tail_preview() {
        let store = Store(Mutex::new(Vec::new()));
        let text = format!("{}\n{}", "a".repeat(30_000), "z".repeat(30_000));
        let out = offload_result(&store, "grep", &Content::Text(text.clone().into()), false).await;
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
        let big = Content::Text("x".repeat(60_000).into());
        assert_eq!(offload_result(&store, "read", &big, false).await, big);
        let error = Content::Text(format!("Error: {}", "e".repeat(30_000)).into());
        assert_eq!(offload_result(&store, "grep", &error, false).await, error);
    }
    #[tokio::test]
    async fn an_offloaded_git_output_gives_no_second_narrowing_instruction() {
        let store = Store(Mutex::new(Vec::new()));
        let text = format!("{}\n{}", "a".repeat(30_000), "z".repeat(30_000));
        let Content::Text(out) = offload_result(&store, "git", &Content::Text(text.into()), false).await else { panic!() };
        assert!(out.ends_with("full output: /art/x.txt]"), "{out}");
        assert!(!out.contains("narrow:") && !out.contains("offset/limit"), "{out}");
    }
    /// An error is the text that reads as one (`classifyResultKind(text)`): an `Error:` result stays inline over the
    /// tool's own limit, other text of the same size does not.
    #[tokio::test]
    async fn an_error_stays_inline_by_its_text() {
        let store = Store(Mutex::new(Vec::new()));
        let error = Content::Text(format!("Error: {}", "e".repeat(25_000)).into());
        assert_eq!(offload_result(&store, "grep", &error, false).await, error);
        let dump = Content::Text("e".repeat(25_000).into());
        let out = offload_result(&store, "grep", &dump, false).await;
        assert!(matches!(&out, Content::Text(t) if t.starts_with(OFFLOAD_PREFIX)));
    }
    #[tokio::test]
    async fn cancelling_a_batch_during_persistence_keeps_the_inline_body() {
        struct Pending;
        #[async_trait]
        impl ArtifactStore for Pending {
            async fn persist(&self, _: &str) -> Option<Artifact> {
                std::future::pending().await
            }
            async fn preview(&self, _: &str) -> Option<Artifact> {
                None
            }
        }
        let body = "result".repeat(10_000);
        let mut entries = [BatchEntry { tool: "grep".into(), content: Content::Text(body.clone().into()) }];
        tokio::select! {
            biased;
            _ = offload_batch(&Pending, &mut entries) => panic!("persistence is still pending"),
            _ = std::future::ready(()) => {}
        }
        assert_eq!(entries[0].content, Content::Text(body.into()));
    }

    #[tokio::test]
    async fn the_batch_budget_offloads_the_largest_eligible_results_first() {
        let store = Store(Mutex::new(Vec::new()));
        let part = |n: usize| Content::Text("y".repeat(n).into());
        let mut entries = vec![
            BatchEntry { tool: "list".into(), content: part(49_000) },
            BatchEntry { tool: "glob".into(), content: part(49_000) },
            BatchEntry { tool: "find_files".into(), content: part(49_000) },
            BatchEntry { tool: "code_graph".into(), content: part(49_000) },
            BatchEntry { tool: "tree".into(), content: part(49_000) },
        ];
        offload_batch(&store, &mut entries).await;
        // 245k > 200k: one forced offload, the latest of the equal results
        let offloaded: Vec<bool> = entries.iter().map(|e| matches!(&e.content, Content::Text(t) if is_offloaded(t))).collect();
        assert_eq!(offloaded, [false, false, false, false, true]);
    }
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
        "setup" => setup_threshold(),
        _ => DEFAULT_THRESHOLD,
    }
}
/// `SETUP_OUTPUT_MAX_BYTES` (`MIXDOG_SETUP_OUTPUT_MAX_BYTES`, 20 KiB): the setup result's cap and its inline-offload threshold.
fn setup_threshold() -> usize {
    static MAX: std::sync::LazyLock<usize> =
        std::sync::LazyLock::new(|| mixdog_tools::github::positive_env_int(std::env::var("MIXDOG_SETUP_OUTPUT_MAX_BYTES").ok().as_deref(), 20 * 1024));
    *MAX
}
/// A result's per-tool offload (`force`: whatever its size). Errors stay inline
/// up to the global default so the model can self-correct without a read turn.
/// An error is the text that reads as one (the first text part of a structured
/// result), whatever kind the call was recorded with.
pub async fn offload_result(store: &dyn ArtifactStore, tool: &str, content: &Content, force: bool) -> Content {
    match planned_offload(store, tool, content, force).await {
        None => content.clone(),
        Some(Replacement::Text(text)) => Content::Text(text.into()),
        Some(Replacement::Parts(mut edits)) => {
            let Content::Parts(parts) = content else { unreachable!() };
            Content::Parts(parts.iter().enumerate().map(|(i, part)| edits.remove(&i).unwrap_or_else(|| part.clone())).collect())
        }
    }
}

async fn offload_in_place(store: &dyn ArtifactStore, tool: &str, content: &mut Content, force: bool) {
    match planned_offload(store, tool, content, force).await {
        None => {}
        Some(Replacement::Text(text)) => *content = Content::Text(text.into()),
        Some(Replacement::Parts(edits)) => {
            let Content::Parts(parts) = content else { unreachable!() };
            for (i, part) in edits {
                parts[i] = part;
            }
        }
    }
}

enum Replacement {
    Text(String),
    Parts(std::collections::HashMap<usize, ContentPart>),
}

// A cancelled persist must leave the caller's entry untouched, including for a multipart result.
async fn planned_offload(store: &dyn ArtifactStore, tool: &str, content: &Content, force: bool) -> Option<Replacement> {
    match content {
        Content::Text(text) => {
            if is_offloaded(text) || (!force && u16_len(text) <= threshold(tool)) {
                return None;
            }
            if !force && reads_as_error(text) && u16_len(text) <= DEFAULT_THRESHOLD {
                return None;
            }
            offload_text(store, tool, text).await.map(Replacement::Text)
        }
        Content::Parts(parts) => {
            if !parts.iter().any(|p| matches!(p, ContentPart::Text(_, _))) {
                return None;
            }
            let limit = if force { 0 } else { threshold(tool) };
            let mut inline = parts.iter().map(text_len).sum::<usize>();
            if inline <= limit {
                return None;
            }
            let first_text = parts.iter().find_map(|p| match p {
                ContentPart::Text(text, _) => Some(text.as_str()),
                _ => None,
            });
            if !force && first_text.is_some_and(reads_as_error) && inline <= DEFAULT_THRESHOLD {
                return None;
            }
            let mut order: Vec<usize> = (0..parts.len()).filter(|i| is_offloadable_part(&parts[*i])).collect();
            order.sort_by_key(|i| std::cmp::Reverse(text_len(&parts[*i])));
            let mut edits = std::collections::HashMap::new();
            for index in order {
                let ContentPart::Text(text, _) = &parts[index] else {
                    continue;
                };
                let Some(replaced) = offload_text(store, tool, text).await else {
                    continue;
                };
                inline = inline + u16_len(&replaced) - u16_len(text);
                edits.insert(index, ContentPart::Text(replaced, None));
                if inline <= limit {
                    break;
                }
            }
            (!edits.is_empty()).then_some(Replacement::Parts(edits))
        }
    }
}
/// Per-tool limits first, then the message-level budget across the batch's
/// remaining text results: largest first, ties preferring the latest result.
pub async fn offload_batch(store: &dyn ArtifactStore, entries: &mut [BatchEntry]) {
    for entry in entries.iter_mut() {
        offload_in_place(store, &entry.tool, &mut entry.content, false).await;
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
        let entry = &mut entries[index];
        offload_in_place(store, &entry.tool, &mut entry.content, true).await;
        let after = inline_len(&entry.content);
        total = (total as i64 + after as i64 - before as i64).max(0) as usize;
    }
}
