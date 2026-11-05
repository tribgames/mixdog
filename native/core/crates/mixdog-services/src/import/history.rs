//! Whole-file conversion of a candidate under the import limits, following a Codex rollout's
//! `history_base` chain (paginated histories continue in earlier rollouts).

use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::Value;

use super::candidate::Candidate;
use super::codex::{rollout_id_of};
use super::convert::{Conversion, Converter, Limits, Source};
use super::fsutil::{ImportError, Opened, StreamOpts, case_fold, is_compressed, open_verified, real_path, stream_jsonl_lines};
use super::turns::{WARNING_HISTORY_PARTIAL, WARNING_HISTORY_SIZE_LIMIT, WARNING_HISTORY_UNAVAILABLE};

const HISTORY_CHAIN_MAX_DEPTH: usize = 32;
const META_CHUNK_BYTES: usize = 8 * 1024;
pub const IMPORT_CHUNK_BYTES: usize = 256 * 1024;

fn is_uuid(text: &str) -> bool {
    static RE: OnceLock<mixdog_js::JsRegex> = OnceLock::new();
    RE.get_or_init(|| mixdog_js::JsRegex::new_static(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "i"))
        .is_match(text)
}

/// Rollout file with this rollout id under the live, then the archived, sessions folder
/// (walking lists a plain file instead of its compressed sibling).
pub fn find_rollout_by_id(home: &Path, rollout_id: &str) -> Option<Candidate> {
    for folder in ["sessions", "archived_sessions"] {
        let Ok(root) = real_path(&home.join(folder)) else { continue };
        let mut paths = Vec::new();
        let mut seen = HashSet::from([case_fold(&root.to_string_lossy())]);
        super::candidate::walk_codex(&root, &root, &mut paths, &mut seen);
        for path in paths {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if rollout_id_of(&name).as_deref() != Some(rollout_id) {
                continue;
            }
            let Some(real) = super::candidate::contained_real_path(&root, &path) else { continue };
            if let Ok(meta) = std::fs::metadata(&real) {
                if meta.is_file() {
                    return Some(Candidate::for_file(Source::Codex, Some(root), real, meta.len()));
                }
            }
        }
    }
    None
}

struct FirstRecord {
    record: Option<Value>,
    bytes: u64,
}

/// First JSON record of a file (`None` when none completes within `max_bytes`, blank lines
/// included, or it is not JSON) and the bytes read for it.
fn first_record(candidate: &Candidate, max_bytes: u64, max_line_bytes: usize) -> Result<FirstRecord, ImportError> {
    let mut opened = open_verified(&candidate.path, candidate.root.as_deref())?;
    let mut first = String::new();
    let outcome = stream_jsonl_lines(
        &mut opened,
        &mut |line| {
            first = mixdog_js::js_trim(line.strip_prefix('\u{feff}').unwrap_or(line)).to_owned();
            first.is_empty()
        },
        StreamOpts { max_line_bytes, chunk_bytes: META_CHUNK_BYTES, max_bytes, on_chunk: None },
    )
    .map_err(|_| ImportError::new("unreadable"))?;
    let record = (!first.is_empty()).then(|| serde_json::from_str(&first).ok()).flatten();
    Ok(FirstRecord { record, bytes: outcome.bytes_read })
}

/// Whether a cutoff, in (decompressed) file bytes, falls on a record boundary: the end of the
/// file or just after a line feed.
fn ends_on_record(candidate: &Candidate, end: u64) -> Result<bool, ImportError> {
    let compressed = is_compressed(&candidate.path);
    if !compressed && end == candidate.size {
        return Ok(true);
    }
    let mut opened = open_verified(&candidate.path, candidate.root.as_deref())?;
    let io = |_| ImportError::new("unreadable");
    let mut byte = [0u8; 1];
    if let Opened::Plain(file) = &mut opened {
        file.seek(SeekFrom::Start(end - 1)).map_err(io)?;
        return Ok(file.read(&mut byte).map_err(io)? == 1 && byte[0] == b'\n');
    }
    // The decompressed size is unknown: read up to the cutoff, then see whether the file ends there.
    let mut chunk = vec![0u8; IMPORT_CHUNK_BYTES];
    let (mut position, mut last) = (0u64, 0u8);
    while position < end {
        let want = chunk.len().min((end - position) as usize);
        let n = opened.read(&mut chunk[..want]).map_err(io)?;
        if n == 0 {
            return Ok(false);
        }
        position += n as u64;
        last = chunk[n - 1];
    }
    Ok(last == b'\n' || opened.read(&mut byte).map_err(io)? == 0)
}

/// Size of a compressed file once decompressed, counting no further than `cap`.
fn decompressed_length(candidate: &Candidate, cap: u64) -> Result<u64, ImportError> {
    let mut opened = open_verified(&candidate.path, candidate.root.as_deref())?;
    let mut chunk = vec![0u8; IMPORT_CHUNK_BYTES];
    let mut length = 0u64;
    while length < cap {
        let want = chunk.len().min((cap - length) as usize);
        let n = opened.read(&mut chunk[..want]).map_err(|_| ImportError::new("unreadable"))?;
        if n == 0 {
            break;
        }
        length += n as u64;
    }
    Ok(length)
}

pub struct Chain {
    /// Nearest first, each with the byte offset its contribution ends at.
    pub segments: Vec<(Candidate, u64)>,
    /// The warning code saying why the chain stopped early.
    pub partial: Option<&'static str>,
    pub meta_bytes: u64,
}

fn safe_positive_int(value: Option<&Value>) -> Option<u64> {
    let v = value?;
    v.as_u64().filter(|n| *n > 0 && *n <= (1 << 53)).or_else(|| {
        let f = v.as_f64()?;
        (f.fract() == 0.0 && f > 0.0 && f <= (1u64 << 53) as f64).then_some(f as u64)
    })
}

/// Rollouts a `history_base` leads to, nearest first, and what reading their metadata took.
/// Stops (`partial`, the warning code saying why) at a base that is missing or unreadable, that
/// would take the total read beyond `max_file_bytes`, or is not paginated, already visited, past
/// the depth cap, with a cutoff that passes the end of the file or does not end a record.
fn resolve_history_chain(
    candidate: &Candidate,
    first_base: &Value,
    home: &Path,
    max_file_bytes: u64,
    max_line_bytes: usize,
    spent: u64,
) -> Result<Chain, ImportError> {
    let mut seen: HashSet<Option<String>> = HashSet::new();
    seen.insert(rollout_id_of(&candidate.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
    let mut segments: Vec<(Candidate, u64)> = Vec::new();
    // The file itself is reserved at its decompressed size, which only reading it tells.
    let mut used = if is_compressed(&candidate.path) { decompressed_length(candidate, max_file_bytes)? } else { candidate.size } + spent;
    let mut meta_bytes = 0u64;
    let mut base = Some(first_base.clone());
    while let Some(current) = base {
        let partial = |segments, warning, meta_bytes| Ok(Chain { segments, partial: Some(warning), meta_bytes });
        let id = current.get("thread_id").and_then(Value::as_str).map(str::to_lowercase).unwrap_or_default();
        let end = safe_positive_int(current.get("end_byte_offset"));
        let ordinal = safe_positive_int(current.get("end_ordinal_exclusive"));
        if !is_uuid(&id) || seen.contains(&Some(id.clone())) || segments.len() >= HISTORY_CHAIN_MAX_DEPTH {
            return partial(segments, WARNING_HISTORY_PARTIAL, meta_bytes);
        }
        seen.insert(Some(id.clone()));
        let (Some(end), Some(_)) = (end, ordinal) else {
            return partial(segments, WARNING_HISTORY_PARTIAL, meta_bytes);
        };
        let Some(found) = find_rollout_by_id(home, &id) else {
            return partial(segments, WARNING_HISTORY_UNAVAILABLE, meta_bytes);
        };
        if !is_compressed(&found.path) && end > found.size {
            return partial(segments, WARNING_HISTORY_PARTIAL, meta_bytes);
        }
        if used + end > max_file_bytes {
            return partial(segments, WARNING_HISTORY_SIZE_LIMIT, meta_bytes);
        }
        let head = match ends_on_record(&found, end) {
            Ok(true) => first_record(&found, end.min(max_file_bytes - used - end), max_line_bytes),
            Ok(false) => return partial(segments, WARNING_HISTORY_PARTIAL, meta_bytes),
            Err(e) => Err(e),
        };
        let Ok(head) = head else {
            return partial(segments, WARNING_HISTORY_UNAVAILABLE, meta_bytes);
        };
        used += end + head.bytes;
        meta_bytes += head.bytes;
        let payload = head.record.as_ref().filter(|r| r.get("type").and_then(Value::as_str) == Some("session_meta")).and_then(|r| r.get("payload"));
        let Some(payload) = payload.filter(|p| p.get("history_mode").and_then(Value::as_str) == Some("paginated")) else {
            return partial(segments, WARNING_HISTORY_PARTIAL, meta_bytes);
        };
        segments.push((found, end));
        base = payload.get("history_base").filter(|b| b.is_object()).cloned();
    }
    Ok(Chain { segments, partial: None, meta_bytes })
}

pub struct ConvertedFile {
    pub conversion: Conversion,
    /// How far the read got, history bases included.
    pub bytes_read: u64,
}

/// Stream-converts a whole candidate file under the import limits. A file over `max_file_bytes`,
/// a line over `max_line_bytes` or a conversion over the converter's limits fails the file with
/// `tooLarge` without reading the rest. A Codex rollout continuing a `history_base` is preceded
/// by the records of each base up to its cutoff, oldest first (their session metadata dropped),
/// all within the one `max_file_bytes`; a base that cannot be followed leaves a `historyPartial`,
/// `historySizeLimit` or `historyUnavailable` warning.
pub fn convert_candidate_file(candidate: &Candidate, home: &Path, limits: Limits, chunk_bytes: usize) -> Result<ConvertedFile, ImportError> {
    let mut converter = Converter::new(candidate.source, limits);
    // Bytes read beyond the file itself: metadata pre-reads and the bases' cutoffs. All count
    // against `max_file_bytes`.
    let mut inherited_bytes = 0u64;
    if candidate.source == Source::Codex {
        let head = first_record(candidate, limits.max_file_bytes, limits.max_line_bytes)?;
        let payload = head.record.as_ref().and_then(|r| r.get("payload"));
        if let Some(base) = payload.and_then(|p| p.get("history_base")).filter(|b| b.is_object()) {
            inherited_bytes += head.bytes;
            let paginated = payload.and_then(|p| p.get("history_mode")).and_then(Value::as_str) == Some("paginated");
            let chain = if paginated {
                resolve_history_chain(candidate, base, home, limits.max_file_bytes, limits.max_line_bytes, inherited_bytes)?
            } else {
                Chain { segments: Vec::new(), partial: Some(WARNING_HISTORY_PARTIAL), meta_bytes: 0 }
            };
            inherited_bytes += chain.meta_bytes;
            if let Some(partial) = chain.partial {
                converter.mark_history_partial(partial);
            }
            for (base_file, end) in chain.segments.into_iter().rev() {
                let mut opened = open_verified(&base_file.path, base_file.root.as_deref())?;
                let read = stream_jsonl_lines(
                    &mut opened,
                    &mut |line| converter.push_line(line, true),
                    StreamOpts { max_line_bytes: limits.max_line_bytes, chunk_bytes, max_bytes: end, on_chunk: None },
                )
                .map_err(|_| ImportError::new("unreadable"))?;
                if read.overflow {
                    converter.mark_too_large();
                }
                inherited_bytes += read.bytes_read;
            }
        }
    }
    let mut opened = open_verified(&candidate.path, candidate.root.as_deref())?;
    let read = stream_jsonl_lines(
        &mut opened,
        &mut |line| converter.push_line(line, false),
        StreamOpts {
            max_line_bytes: limits.max_line_bytes,
            chunk_bytes,
            max_bytes: limits.max_file_bytes.saturating_sub(inherited_bytes),
            on_chunk: None,
        },
    )
    .map_err(|_| ImportError::new("unreadable"))?;
    if read.overflow || read.truncated {
        converter.mark_too_large();
    }
    Ok(ConvertedFile { conversion: converter.result(), bytes_read: read.bytes_read + inherited_bytes })
}

pub fn codex_home_of(candidate: &Candidate, fallback_root: Option<PathBuf>) -> PathBuf {
    let root = candidate.root.clone().or(fallback_root).unwrap_or_default();
    root.parent().map(Path::to_path_buf).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rollout(dir: &Path, name: &str, lines: &[&str]) -> Candidate {
        let path = dir.join(name);
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        let real = real_path(&path).unwrap();
        let size = std::fs::metadata(&real).unwrap().len();
        Candidate::for_file(Source::Codex, real_path(dir).ok(), real, size)
    }

    const BASE_ID: &str = "11111111-1111-4111-8111-111111111111";
    const TOP_ID: &str = "22222222-2222-4222-8222-222222222222";

    fn msg(role: &str, text: &str) -> String {
        format!(r#"{{"type":"response_item","payload":{{"type":"message","role":"{role}","content":[{{"type":"input_text","text":"{text}"}}]}}}}"#)
    }

    #[test]
    fn a_paginated_history_base_is_followed_up_to_its_cutoff() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let base_meta = r#"{"type":"session_meta","payload":{"id":"t","history_mode":"paginated"}}"#;
        let (m1, m2) = (msg("user", "first question"), msg("assistant", "first answer"));
        let cut = format!("{base_meta}\n{m1}\n").len() as u64;
        let beyond = msg("user", "after the cutoff");
        rollout(&sessions, &format!("rollout-2025-01-01T00-00-00-{BASE_ID}.jsonl"), &[base_meta, &m1, &m2, &beyond]);
        let top_meta = format!(
            r#"{{"type":"session_meta","payload":{{"id":"t","history_mode":"paginated","history_base":{{"thread_id":"{BASE_ID}","end_byte_offset":{cut},"end_ordinal_exclusive":1}}}}}}"#
        );
        let top = rollout(&sessions, &format!("rollout-2025-01-02T00-00-00-{TOP_ID}.jsonl"), &[&top_meta, &msg("assistant", "latest")]);
        let out = convert_candidate_file(&top, dir.path(), Limits::default(), IMPORT_CHUNK_BYTES).unwrap();
        let texts: Vec<_> = out.conversion.turns.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(texts, ["first question", "latest"], "the cutoff keeps only the first base record");
        assert_eq!(out.conversion.foreign_session_id.as_deref(), Some("t"));
        assert!(out.conversion.warnings.is_empty());
    }

    #[test]
    fn a_missing_base_leaves_the_unavailable_warning() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let top_meta = format!(
            r#"{{"type":"session_meta","payload":{{"id":"t","history_mode":"paginated","history_base":{{"thread_id":"{BASE_ID}","end_byte_offset":10,"end_ordinal_exclusive":1}}}}}}"#
        );
        let top = rollout(&sessions, &format!("rollout-x-{TOP_ID}.jsonl"), &[&top_meta, &msg("user", "hi")]);
        let out = convert_candidate_file(&top, dir.path(), Limits::default(), IMPORT_CHUNK_BYTES).unwrap();
        assert_eq!(out.conversion.warnings, [WARNING_HISTORY_UNAVAILABLE.to_owned()]);
        assert_eq!(out.conversion.message_count, 1);
    }

    #[test]
    fn a_compressed_rollout_converts_like_a_plain_one() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let body = format!("{}\n{}\n", r#"{"type":"session_meta","payload":{"id":"z"}}"#, msg("user", "zipped"));
        let path = sessions.join(format!("rollout-z-{TOP_ID}.jsonl.zst"));
        std::fs::write(&path, zstd::encode_all(body.as_bytes(), 3).unwrap()).unwrap();
        let real = real_path(&path).unwrap();
        let size = std::fs::metadata(&real).unwrap().len();
        let cand = Candidate::for_file(Source::Codex, real_path(&sessions).ok(), real, size);
        let out = convert_candidate_file(&cand, dir.path(), Limits::default(), IMPORT_CHUNK_BYTES).unwrap();
        assert_eq!(out.conversion.title.as_deref(), Some("zipped"));
    }
}
