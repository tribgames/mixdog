//! The compact handoff projection of a session: episodes that compress
//! structurally become their summary, anything else stays as its raw turns,
//! and the latest live user turns are left out for the caller to replay.

use mixdog_js::{js_trim};
use std::collections::{HashMap, HashSet};

use serde_json::json;
use sha2::{Digest, Sha256};

use crate::memory::recall::row::{Row, compare_newest_first};

const CHUNK_QUALITY_VERSION: i64 = 1;

fn turn(row: &Row) -> i64 {
    i64::from(row.source_turn.unwrap_or(0))
}

fn chronological(a: &Row, b: &Row) -> std::cmp::Ordering {
    turn(a).cmp(&turn(b)).then_with(|| a.ts.cmp(&b.ts)).then_with(|| a.id.cmp(&b.id))
}

fn unique(rows: impl IntoIterator<Item = Row>) -> Vec<Row> {
    let mut seen = HashSet::new();
    rows.into_iter().filter(|row| seen.insert(row.id)).collect()
}

fn member_rows(row: &Row) -> Vec<Row> {
    let mut members = unique(row.member_list().iter().cloned());
    members.sort_by(chronological);
    members
}

fn raw_member(row: &Row) -> Row {
    Row {
        is_root: 0,
        chunk_root: None,
        compact_raw: true,
        members: None,
        element: None,
        summary: None,
        chunk_quality: None,
        ..row.clone()
    }
}

fn transcript_rows(rows: &[Row]) -> Vec<Row> {
    let mut out = Vec::new();
    for row in rows {
        let members = member_rows(row);
        if !members.is_empty() {
            out.extend(members);
        } else if row.role() == "user" || row.role() == "assistant" {
            out.push(row.clone());
        }
    }
    let mut out = unique(out);
    out.sort_by(chronological);
    out
}

fn tail_cutoff(rows: &[Row], preserve_latest_user_turns: usize) -> Option<Row> {
    if preserve_latest_user_turns == 0 {
        return None;
    }
    let users: Vec<Row> = transcript_rows(rows).into_iter().filter(|r| r.role() == "user").collect();
    if users.is_empty() {
        return None;
    }
    users.get(users.len().saturating_sub(preserve_latest_user_turns)).cloned()
}

fn is_before_cutoff(row: &Row, cutoff: Option<&Row>) -> bool {
    cutoff.is_none_or(|cutoff| turn(row) < turn(cutoff))
}

struct Compression {
    shorter: bool,
}

fn compression(estimate: &dyn Fn(&str) -> u64, summary: &str, members: &[Row]) -> Compression {
    let source = estimate(&members.iter().map(|m| m.content()).collect::<Vec<_>>().join("\n"));
    let summary_tokens = estimate(js_trim(summary));
    Compression { shorter: summary_tokens > 0 && summary_tokens < source }
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn source_hash_and_ids(members: &[Row]) -> (String, Vec<String>) {
    let mut sorted: Vec<&Row> = members.iter().collect();
    sorted.sort_by_key(|m| m.id);
    let canonical: Vec<_> = sorted
        .iter()
        .map(|m| json!([m.id.to_string(), m.session_id, m.ts.to_string(), m.role, m.content()]))
        .collect();
    let mut ids: Vec<String> = members.iter().map(|m| m.id.to_string()).collect();
    ids.sort();
    (sha256_hex(&serde_json::Value::Array(canonical).to_string()), ids)
}

/// Whether an episode's summary is a usable stand-in for its member turns.
pub fn chunk_quality_usable(root: &Row, estimate: &dyn Fn(&str) -> u64) -> bool {
    let members = root.member_list();
    if members.is_empty() || members.iter().any(|m| m.content.is_none()) {
        return false;
    }
    if members.iter().map(|m| m.id).collect::<HashSet<_>>().len() != members.len() {
        return false;
    }
    if members.iter().map(|m| m.session_id.clone()).collect::<HashSet<_>>().len() > 1 {
        return false;
    }
    if !compression(estimate, root.summary(), members).shorter {
        return false;
    }
    let Some(quality) = &root.chunk_quality else { return true };
    let verified = matches!(quality["verification"].as_str(), Some("structural" | "source-comparison"));
    if quality["version"].as_i64() != Some(CHUNK_QUALITY_VERSION) || !verified {
        return false;
    }
    let (source_hash, member_ids) = source_hash_and_ids(members);
    quality["sourceHash"].as_str() == Some(source_hash.as_str())
        && quality["memberIds"] == json!(member_ids)
        && quality["summaryHash"].as_str() == Some(sha256_hex(js_trim(root.summary())).as_str())
}

/// One complete compact projection of a session, newest first.
pub fn compact_handoff_rows(rows: Vec<Row>, preserve_latest_user_turns: usize, estimate: &dyn Fn(&str) -> u64) -> Vec<Row> {
    let cutoff = tail_cutoff(&rows, preserve_latest_user_turns);
    let mut projected: Vec<Row> = Vec::new();
    let mut references: HashMap<i64, usize> = HashMap::new();
    for row in &rows {
        for member in member_rows(row) {
            *references.entry(member.id).or_default() += 1;
        }
    }
    for row in &rows {
        let members = member_rows(row);
        if row.is_root != 1 {
            if is_before_cutoff(row, cutoff.as_ref()) {
                projected.push(raw_member(row));
            }
            continue;
        }
        let kept: Vec<&Row> = members.iter().filter(|m| is_before_cutoff(m, cutoff.as_ref())).collect();
        let compressible = !js_trim(row.summary()).is_empty()
            && !members.is_empty()
            && kept.len() == members.len()
            && members.iter().all(|m| references.get(&m.id) == Some(&1))
            && chunk_quality_usable(row, estimate);
        if compressible {
            projected.push(Row { element: Some(String::new()), compact_body: true, members: None, ..row.clone() });
            continue;
        }
        if !members.is_empty() {
            projected.extend(kept.into_iter().map(raw_member));
            continue;
        }
        if is_before_cutoff(row, cutoff.as_ref()) {
            projected.push(raw_member(row));
        }
    }
    let mut out = unique(projected);
    out.sort_by(compare_newest_first);
    out
}
