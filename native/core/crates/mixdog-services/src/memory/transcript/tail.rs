//! `ingest/transcript-tail.mjs`: one incremental read of a transcript file - the bytes past the
//! persisted offset, split into complete JSONL lines, stored as conversation rows. The persisted
//! boundary only advances past lines fully consumed (stored or intentionally skipped); a transient
//! insert error stops the walk and leaves the boundary before the line, so the next sweep retries
//! it. A complete line that is not JSON (crash damage) is skipped, never a permanent stop.

use std::path::Path;

use mixdog_js::{js_trim, json_parse};
use mixdog_rt::{CancellationToken, LaneToken};
use mixdog_statefile::{metadata, read_range};

use super::rows::{cwd_from_transcript_path, transcript_row_from_line};
use super::{Position, TranscriptIngest};
use crate::memory::error::Result;
use crate::memory::project::resolve_project_id;

/// Bytes appended since `prev`; none when there is nothing new. A truncate or rewrite (size below
/// the persisted offset) restarts at zero and bumps the generation: the rewritten lines would
/// otherwise reuse the same `transcript:<uuid>#<index>` references and be dropped by
/// `ON CONFLICT DO NOTHING`.
struct Tail {
    text: String,
    bytes: f64,
    line_index: f64,
    generation: f64,
}

async fn read_tail(ingest: &TranscriptIngest, path: &Path, prev: Position) -> Result<Option<Tail>> {
    let file = path.to_owned();
    let lane = ingest.io.maintenance;
    let Position { mut bytes, mut line_index, mut generation } = prev;
    let job = lane
        .submit_wait(&CancellationToken::new(), move |lane| -> std::io::Result<Option<Tail>> {
            let Ok(stat) = metadata(lane, &file) else { return Ok(None) };
            let size = stat.len() as f64;
            if size < bytes {
                bytes = 0.0;
                line_index = 0.0;
                generation += 1.0;
            }
            if size <= bytes {
                return Ok(None);
            }
            let buf = read_range(lane, &file, bytes as u64, (size - bytes) as usize)?;
            Ok(Some(Tail { text: String::from_utf8_lossy(&buf).into_owned(), bytes, line_index, generation }))
        })
        .await
        .map_err(|e| std::io::Error::other(format!("{e:?}")))?;
    Ok(job.await.map_err(|e| std::io::Error::other(e.to_string()))??)
}

/// Complete lines of `text` with the bytes each one consumes. A final segment without a newline is
/// a line still being written; it is re-read once the writer flushes.
fn complete_lines(text: &str) -> impl Iterator<Item = (&str, f64)> {
    let mut rest = text;
    std::iter::from_fn(move || {
        let newline = rest.find('\n')?;
        let raw = &rest[..newline];
        rest = &rest[newline + 1..];
        Some((raw.strip_suffix('\r').unwrap_or(raw), raw.len() as f64 + 1.0))
    })
}

fn source_ref(uuid: &str, index: f64, generation: f64) -> String {
    let index = mixdog_js::number_to_string(index);
    if generation > 0.0 { format!("transcript:{uuid}#{index}@g{}", mixdog_js::number_to_string(generation)) } else { format!("transcript:{uuid}#{index}") }
}

/// `ingestTranscriptTail`: the number of rows inserted.
pub async fn ingest_transcript_tail(ingest: &TranscriptIngest, path: &Path, cwd: Option<&Path>) -> Result<usize> {
    let key = path.to_string_lossy().into_owned();
    let Some(tail) = read_tail(ingest, path, ingest.offsets.snapshot(&key)).await? else { return Ok(0) };
    let uuid = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let resolved = match cwd.filter(|c| !c.as_os_str().is_empty()) {
        Some(cwd) => Some(cwd.to_owned()),
        None => cwd_from_transcript_path(ingest.io.maintenance, path).await,
    };
    // No cwd resolves to COMMON (project NULL); the process cwd would misclassify rows.
    let project_id = match &resolved {
        Some(cwd) => resolve_project_id(ingest.io.durability, cwd).await,
        None => None,
    };
    let mut boundary = Position { bytes: tail.bytes, line_index: tail.line_index, generation: tail.generation };
    let mut index = tail.line_index;
    let mut count = 0;
    let base = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    for (raw, consumed) in complete_lines(&tail.text) {
        // A crash leaves NULs where data never reached disk, and the writer resumes after them.
        let line = if raw.contains('\0') { raw.replace('\0', "") } else { raw.to_owned() };
        if js_trim(&line).is_empty() {
            boundary.bytes += consumed;
            continue;
        }
        let Ok(parsed) = json_parse(&line) else {
            // Complete lines never become valid: skip for good, or it blocks every line after it.
            tracing::info!("[transcript-watch] skipped a damaged line in {base}");
            boundary.bytes += consumed;
            continue;
        };
        index += 1.0;
        if let Some(row) = transcript_row_from_line(&parsed, (ingest.now)() as f64) {
            let reference = source_ref(&uuid, index, tail.generation);
            // A fractional ms (a sub-millisecond second stamp) is not a BIGINT: the insert fails as it does in Node.
            if row.ts_ms.fract() != 0.0 {
                tracing::info!("[transcript-watch] insert error ({reference}): invalid input syntax for type bigint: \"{}\"", mixdog_js::number_to_string(row.ts_ms));
                break;
            }
            let (ts, turn) = (row.ts_ms as i64, index as i32);
            let inserted = ingest
                .db
                .execute(
                    "INSERT INTO entries(ts, role, content, source_ref, session_id, source_turn, project_id, time_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT DO NOTHING",
                    &[&ts, &row.role, &row.content, &reference, &uuid, &turn, &project_id, &row.time_source],
                )
                .await;
            match inserted {
                Ok(n) if n > 0 => count += 1,
                Ok(_) => {}
                Err(error) => {
                    tracing::info!("[transcript-watch] insert error ({reference}): {}", error.message());
                    break; // transient: the boundary stays before this line
                }
            }
        }
        boundary.bytes += consumed;
        boundary.line_index = index;
    }
    ingest.offsets.set(&key, boundary);
    ingest.offsets.persist(&ingest.db).await;
    Ok(count)
}
