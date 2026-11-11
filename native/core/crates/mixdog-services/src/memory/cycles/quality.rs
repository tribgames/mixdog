//! `memory-chunk-quality.mjs`: the cycle1 classifier prompt, the parse and validation of its
//! line-format reply, chunk quality records, and the packet generator around one LLM call.
//!
//! Node's `pg` returns a BIGINT as a string, so a row's `ts` and `id` reach the prompt and the
//! source hash as strings; [`Row::ts`] is written the same way.

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use futures::future::BoxFuture;
use mixdog_js::token_estimate::estimate_tokens;
use mixdog_js::{JsRegex, js_trim, json_stringify};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::{Cycle1Llm, Cycle1Request};
use crate::memory::error::{MemoryError, Result};

const CHUNK_QUALITY_VERSION: i64 = 1;
pub const CYCLE1_INPUT_TOKEN_BUDGET: f64 = 16000.0;
/// A window below this many estimated tokens is left raw without a call.
const CYCLE1_MIN_SOURCE_TOKENS: u64 = 30;
const VALID_CATEGORY: [&str; 8] = ["rule", "constraint", "decision", "fact", "goal", "preference", "task", "issue"];
const MAX_SAFE: i64 = 9_007_199_254_740_991;

/// One `entries` row as cycle1 reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub id: i64,
    pub ts: i64,
    pub role: Option<String>,
    pub content: String,
    pub session_id: Option<String>,
    pub project_id: Option<String>,
    pub element: Option<String>,
}

fn source_tokens(rows: &[Row]) -> u64 {
    estimate_tokens(&rows.iter().map(|r| r.content.as_str()).collect::<Vec<_>>().join("\n"))
}

/// `chunkCompression(summary, members)`: `(source tokens, summary tokens, shorter)`.
pub fn chunk_compression(summary: &str, members: &[Row]) -> (u64, u64, bool) {
    let source = source_tokens(members);
    let summary_tokens = estimate_tokens(js_trim(summary));
    (source, summary_tokens, summary_tokens > 0 && summary_tokens < source)
}

fn length_rule(rows: &[Row], rewrite: bool) -> String {
    let source = source_tokens(rows);
    if rewrite {
        format!(
            "Rewrite: the previous summary of these rows was longer than the rows themselves ({source} runtime-estimated tokens). Keep it under {} tokens: the request, the final answer or decision and any verified result, nothing else.",
            20.max(source / 2)
        )
    } else {
        format!(
            "Length target: about {} runtime-estimated tokens in total, roughly one third of the source. A short source needs no filler; its summary must still be shorter than the source.",
            60.max(source / 3)
        )
    }
}

/// `chunkSourceText`: one `# session <id>` line per run of the same session, then `@n {json}` rows.
pub fn chunk_source_text(rows: &[Row]) -> String {
    let mut lines = Vec::new();
    let mut session: Option<&Option<String>> = None;
    for (i, row) in rows.iter().enumerate() {
        if i == 0 || session != Some(&row.session_id) {
            session = Some(&row.session_id);
            lines.push(format!("# session {}", row.session_id.as_deref().unwrap_or("unknown")));
        }
        let mut body = Map::new();
        body.insert("ts".into(), Value::String(row.ts.to_string()));
        body.insert("role".into(), row.role.clone().map_or(Value::Null, Value::String));
        if let Some(topic) = row.element.as_ref().filter(|e| !e.is_empty()) {
            body.insert("topic".into(), Value::String(topic.clone()));
        }
        body.insert("content".into(), Value::String(row.content.clone()));
        lines.push(format!("@{} {}", i + 1, json_stringify(&Value::Object(body))));
    }
    lines.join("\n")
}

/// `cycle1SourceBudget`.
pub fn cycle1_source_budget(input_token_budget: f64) -> Result<f64> {
    if !input_token_budget.is_finite() || input_token_budget < 4096.0 {
        return Err(MemoryError::Runtime("cycle1 input_token_budget must be at least 4096".into()));
    }
    Ok((input_token_budget - 2048.0).floor())
}

pub fn build_cycle1_chunk_prompt(rows: &[Row], rewrite: bool) -> String {
    [length_rule(rows, rewrite), String::new(), chunk_source_text(rows)].join("\n")
}

/// `partitionCycle1Rows`: consecutive packets within `max_rows` and the source budget.
pub fn partition_cycle1_rows(rows: &[Row], source_budget: f64, max_rows: usize) -> Vec<Vec<Row>> {
    let mut packets = Vec::new();
    let mut packet: Vec<Row> = Vec::new();
    for row in rows {
        if !packet.is_empty() && (packet.len() >= max_rows || {
            let mut with = packet.clone();
            with.push(row.clone());
            estimate_tokens(&chunk_source_text(&with)) as f64 > source_budget
        }) {
            packets.push(std::mem::take(&mut packet));
        }
        packet.push(row.clone());
    }
    if !packet.is_empty() {
        packets.push(packet);
    }
    packets
}

/// One line of the classifier's reply.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Parsed {
    pub idx_list: Vec<i64>,
    pub parse_error: Option<&'static str>,
    pub element: String,
    pub category: String,
    pub summary: String,
}

/// `parseCycle1LineFormat`: `1-3,5|element|category|summary`, one chunk per line.
pub fn parse_cycle1_line_format(raw: &str) -> Option<Vec<Parsed>> {
    let list = JsRegex::new_static(r"^\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*$", "");
    let text = js_trim(raw);
    let lines: Vec<&str> = text.split('\n').filter(|line| !js_trim(line).is_empty()).collect();
    if lines.is_empty() {
        return None;
    }
    let mut chunks = Vec::new();
    for line in lines {
        let parts: Vec<&str> = line.split('|').collect();
        if parts.len() < 4 || !list.is_match(js_trim(parts[0])) {
            chunks.push(Parsed { parse_error: Some("invalid_line_format"), ..Parsed::default() });
            continue;
        }
        let mut indexes = Vec::new();
        for token in parts[0].split(',') {
            let mut bounds = token.split('-').map(|v| mixdog_js::string_to_number(js_trim(v)));
            let from = bounds.next().unwrap_or(f64::NAN);
            let to = bounds.next().unwrap_or(from);
            let safe = |n: f64| n.fract() == 0.0 && n.abs() <= MAX_SAFE as f64;
            if !safe(from) || !safe(to) || to < from || to - from >= 1000.0 {
                indexes = vec![0];
                break;
            }
            indexes.extend((from as i64)..=(to as i64));
        }
        chunks.push(Parsed {
            idx_list: indexes,
            parse_error: None,
            element: js_trim(parts[1]).to_owned(),
            category: js_trim(parts[2]).to_lowercase(),
            summary: js_trim(&parts[3..].join("|")).to_owned(),
        });
    }
    Some(chunks)
}

/// A reply chunk that did not pass, or a row set left out.
#[derive(Clone, Debug, PartialEq)]
pub struct InvalidChunk {
    pub reason: String,
    pub idx_list: Option<Vec<i64>>,
    pub member_ids: Vec<i64>,
    pub error: Option<String>,
}

impl InvalidChunk {
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("reason".into(), json!(self.reason));
        if let Some(idx) = &self.idx_list {
            out.insert("idx_list".into(), json!(idx));
        }
        out.insert("member_ids".into(), json!(self.member_ids));
        if let Some(error) = &self.error {
            out.insert("error".into(), json!(error));
        }
        Value::Object(out)
    }
}

pub struct Validity {
    pub valid: bool,
    pub errors: Vec<String>,
    pub omitted: Vec<usize>,
    pub accepted: Vec<Parsed>,
    pub invalid: Vec<InvalidChunk>,
}

fn unique<T: std::hash::Hash + Eq + Clone>(items: impl IntoIterator<Item = T>) -> Vec<T> {
    let mut seen = HashSet::new();
    items.into_iter().filter(|item| seen.insert(item.clone())).collect()
}

/// `validateCycle1Grouping`.
pub fn validate_cycle1_grouping(chunks: Option<&[Parsed]>, rows: &[Row]) -> Validity {
    let chunks = chunks.unwrap_or(&[]);
    let mut counts: HashMap<i64, usize> = HashMap::new();
    for chunk in chunks {
        for n in unique(chunk.idx_list.iter().copied()) {
            *counts.entry(n).or_default() += 1;
        }
    }
    let (mut used, mut accepted, mut invalid) = (HashSet::new(), Vec::new(), Vec::new());
    let in_range = |n: i64| n >= 1 && (n as usize) <= rows.len();
    for chunk in chunks {
        let indexes = &chunk.idx_list;
        let mut reason = chunk.parse_error.map(str::to_owned);
        if reason.is_none() && (indexes.is_empty() || indexes.iter().any(|&n| !in_range(n))) {
            reason = Some("out_of_range_idx".into());
        }
        if reason.is_none() && (indexes.iter().any(|n| counts[n] > 1) || unique(indexes.iter().copied()).len() != indexes.len()) {
            reason = Some("duplicate_member_ids".into());
        }
        if reason.is_none() && (chunk.element.is_empty() || chunk.summary.is_empty() || !VALID_CATEGORY.contains(&chunk.category.as_str())) {
            reason = Some("incomplete_fields".into());
        }
        if reason.is_none() && unique(indexes.iter().map(|&n| rows[n as usize - 1].session_id.clone())).len() != 1 {
            reason = Some("mixed_sessions".into());
        }
        if let Some(reason) = reason {
            let member_ids = unique(indexes.iter().filter(|&&n| in_range(n)).map(|&n| rows[n as usize - 1].id));
            invalid.push(InvalidChunk { reason, idx_list: Some(indexes.clone()), member_ids, error: None });
        } else {
            used.extend(indexes.iter().copied());
            accepted.push(chunk.clone());
        }
    }
    let omitted: Vec<usize> = (1..=rows.len()).filter(|n| !used.contains(&(*n as i64))).collect();
    let mut errors = unique(invalid.iter().map(|item| item.reason.clone()));
    if !omitted.is_empty() {
        errors.push("omitted_rows".into());
    }
    Validity { valid: errors.is_empty() && !chunks.is_empty(), errors, omitted, accepted, invalid }
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// JS `Array.prototype.sort()` on strings: UTF-16 code unit order.
fn sorted_strings(mut items: Vec<String>) -> Vec<String> {
    items.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    items
}

fn canonical_members(members: &[Row]) -> Value {
    let mut sorted: Vec<&Row> = members.iter().collect();
    sorted.sort_by_key(|row| row.id);
    Value::Array(
        sorted
            .into_iter()
            .map(|row| json!([row.id.to_string(), row.session_id, row.ts.to_string(), row.role, row.content]))
            .collect(),
    )
}

/// `makeChunkQuality`: the structural provenance record stored with a root.
pub fn make_chunk_quality(summary: &str, members: &[Row], verified_at: i64) -> Value {
    let (source, summary_tokens, _) = chunk_compression(summary, members);
    json!({
        "version": CHUNK_QUALITY_VERSION,
        "verification": "structural",
        "memberIds": sorted_strings(members.iter().map(|r| r.id.to_string()).collect()),
        "sourceHash": sha256_hex(&json_stringify(&canonical_members(members))),
        "summaryHash": sha256_hex(js_trim(summary)),
        "sourceTokens": source,
        "summaryTokens": summary_tokens,
        "verifiedAt": verified_at,
    })
}

/// What `assessChunkQuality` answers.
#[derive(Clone, Debug, PartialEq)]
pub struct Assessment {
    pub usable: bool,
    pub reasons: Vec<&'static str>,
    /// The record's `verification`, or `"legacy"` for a root without one.
    pub provenance: Value,
    pub source_tokens: u64,
    pub summary_tokens: u64,
    pub shorter: bool,
}

/// `assessChunkQuality`.
pub fn assess_chunk_quality(summary: &str, quality: Option<&Value>, members: &[Row]) -> Assessment {
    let quality = quality.filter(|q| !q.is_null());
    let (usable, reasons) = assessment_reasons(summary, quality, members);
    let (source_tokens, summary_tokens, shorter) = chunk_compression(summary, members);
    let provenance = quality.and_then(|q| q.get("verification")).filter(|v| !v.is_null()).cloned().unwrap_or_else(|| json!("legacy"));
    Assessment { usable, reasons, provenance, source_tokens, summary_tokens, shorter }
}

fn assessment_reasons(summary: &str, quality: Option<&Value>, members: &[Row]) -> (bool, Vec<&'static str>) {
    let mut reasons = Vec::new();
    if members.is_empty() {
        reasons.push("missing_source");
    }
    if unique(members.iter().map(|r| r.id)).len() != members.len() {
        reasons.push("duplicate_members");
    }
    if unique(members.iter().map(|r| r.session_id.clone())).len() > 1 {
        reasons.push("mixed_sessions");
    }
    if !chunk_compression(summary, members).2 {
        reasons.push("not_shorter");
    }
    if let Some(quality) = quality.filter(|q| !q.is_null()) {
        let verification = quality.get("verification").and_then(Value::as_str);
        if quality.get("version") != Some(&json!(CHUNK_QUALITY_VERSION)) || !matches!(verification, Some("structural" | "source-comparison")) {
            reasons.push("invalid_provenance");
        }
        let expected = make_chunk_quality(summary, members, 0);
        if quality.get("sourceHash") != expected.get("sourceHash") || quality.get("memberIds").map(json_stringify) != expected.get("memberIds").map(json_stringify) {
            reasons.push("source_changed");
        }
        if quality.get("summaryHash") != expected.get("summaryHash") {
            reasons.push("summary_changed");
        }
    }
    (reasons.is_empty(), reasons)
}

/// `splitCycle1Row`: the row cut into fragments that each fit the source budget.
pub fn split_cycle1_row(row: &Row, source_budget: f64) -> std::result::Result<Vec<Row>, String> {
    let units: Vec<u16> = row.content.encode_utf16().collect();
    let slice = |from: usize, to: usize| String::from_utf16_lossy(&units[from..to]);
    let mut fragments = Vec::new();
    let mut offset = 0;
    while offset < units.len() {
        let (mut low, mut high, mut length) = (1usize, units.len() - offset, 0usize);
        while low <= high {
            let mid = (low + high) / 2;
            let probe = Row { content: slice(offset, offset + mid), ..row.clone() };
            if estimate_tokens(&chunk_source_text(&[probe])) as f64 <= source_budget {
                length = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        if length > 0 && (0xD800..=0xDBFF).contains(&units[offset + length - 1]) && offset + length < units.len() {
            length -= 1;
        }
        if length < 1 {
            return Err("cycle1 row metadata exceeds source token budget".into());
        }
        fragments.push(Row { content: slice(offset, offset + length), ..row.clone() });
        offset += length;
    }
    Ok(if fragments.is_empty() { vec![row.clone()] } else { fragments })
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Stats {
    pub grouping_calls: i64,
    pub verification_calls: i64,
    pub llm_ms: i64,
    pub verification_ms: i64,
    pub retries: i64,
    pub fragments: i64,
}

impl Stats {
    fn add(&mut self, other: &Stats) {
        self.grouping_calls += other.grouping_calls;
        self.verification_calls += other.verification_calls;
        self.llm_ms += other.llm_ms;
        self.verification_ms += other.verification_ms;
        self.retries += other.retries;
        self.fragments += other.fragments;
    }

    pub fn to_json(&self, total_ms: i64) -> Value {
        json!({
            "groupingCalls": self.grouping_calls, "verificationCalls": self.verification_calls, "llmMs": self.llm_ms,
            "verificationMs": self.verification_ms, "retries": self.retries, "fragments": self.fragments, "totalMs": total_ms,
        })
    }
}

/// An accepted chunk with its members and quality record.
#[derive(Clone, Debug)]
pub struct Chunk {
    pub element: String,
    pub category: String,
    pub summary: String,
    pub idx_list: Vec<i64>,
    pub members: Vec<Row>,
    pub quality: Value,
}

pub struct Generated {
    pub chunks: Vec<Chunk>,
    pub raw_row_ids: Vec<i64>,
    pub invalid_chunks: Vec<InvalidChunk>,
    pub stats: Stats,
    pub total_ms: i64,
}

enum Stop {
    Aborted,
    Failed(String),
}

type Step<T> = std::result::Result<T, Stop>;

/// What a generation needs besides the rows.
pub struct Generation<'a> {
    pub llm: &'a dyn Cycle1Llm,
    pub request: &'a Cycle1Request,
    pub cancel: &'a CancellationToken,
    pub input_token_budget: f64,
    pub now: &'a (dyn Fn() -> i64 + Send + Sync),
}

struct Packets<'a, 'b> {
    ctx: &'b Generation<'a>,
    stats: &'b mut Stats,
    failures: &'b mut Vec<InvalidChunk>,
}

impl Packets<'_, '_> {
    async fn call(&mut self, prompt: &str) -> Step<String> {
        if self.ctx.cancel.is_cancelled() {
            return Err(Stop::Aborted);
        }
        if estimate_tokens(prompt) as f64 > self.ctx.input_token_budget {
            return Err(Stop::Failed("cycle1 prompt exceeds input token budget".into()));
        }
        let started = Instant::now();
        self.stats.grouping_calls += 1;
        let reply = self.ctx.llm.call(self.ctx.request, self.ctx.cancel, prompt).await;
        self.stats.llm_ms += started.elapsed().as_millis() as i64;
        let reply = reply.map_err(Stop::Failed)?;
        if self.ctx.cancel.is_cancelled() {
            return Err(Stop::Aborted);
        }
        Ok(reply)
    }

    /// One packet in, its accepted chunks out, split into those that compressed and those that
    /// came back longer than their rows.
    async fn packet(&mut self, packet: &[Row], rewrite: bool) -> Step<(Vec<Parsed>, Vec<Parsed>)> {
        let reply = self.call(&build_cycle1_chunk_prompt(packet, rewrite)).await?;
        let parsed = parse_cycle1_line_format(&reply);
        let validity = validate_cycle1_grouping(parsed.as_deref(), packet);
        self.failures.extend(validity.invalid);
        if parsed.is_none() {
            self.failures.push(InvalidChunk { reason: "unparseable_response".into(), idx_list: None, member_ids: packet.iter().map(|r| r.id).collect(), error: None });
        }
        let (mut chunks, mut expanded) = (Vec::new(), Vec::new());
        for chunk in validity.accepted {
            let members: Vec<Row> = chunk.idx_list.iter().map(|&n| packet[n as usize - 1].clone()).collect();
            if chunk_compression(&chunk.summary, &members).2 { chunks.push(chunk) } else { expanded.push(chunk) }
        }
        Ok((chunks, expanded))
    }

    /// A grouping longer than its rows gets one rewrite of just those rows; a rewrite that is
    /// still longer leaves them raw.
    async fn with_rewrite(&mut self, packet: &[Row]) -> Step<Vec<Parsed>> {
        let (chunks, expanded) = self.packet(packet, false).await?;
        if expanded.is_empty() {
            return Ok(chunks);
        }
        self.stats.retries += 1;
        let mut positions: Vec<i64> = expanded.iter().flat_map(|c| c.idx_list.iter().copied()).collect();
        positions.sort_unstable();
        let subset: Vec<Row> = positions.iter().map(|&n| packet[n as usize - 1].clone()).collect();
        let (rewritten, _) = self.packet(&subset, true).await?;
        let mut all = chunks;
        all.extend(rewritten.into_iter().map(|c| Parsed { idx_list: c.idx_list.iter().map(|&n| positions[n as usize - 1]).collect(), ..c }));
        Ok(all)
    }
}

/// `generateCycle1Chunks`.
pub fn generate_cycle1_chunks<'a>(rows: &'a [Row], ctx: &'a Generation<'a>) -> BoxFuture<'a, Result<Generated>> {
    Box::pin(async move {
        let started = Instant::now();
        let mut stats = Stats::default();
        let mut failures = Vec::new();
        let source_budget = cycle1_source_budget(ctx.input_token_budget)?;
        let finish = |candidates: Vec<Parsed>, stats: Stats, failures: Vec<InvalidChunk>| project(candidates, rows, failures, stats, started, ctx.now);
        if rows.is_empty() || source_tokens(rows) < CYCLE1_MIN_SOURCE_TOKENS {
            return Ok(finish(Vec::new(), stats, failures));
        }
        let step: Step<Vec<Parsed>> = async {
            let mut chunks = Vec::new();
            if estimate_tokens(&chunk_source_text(rows)) as f64 > source_budget {
                if rows.len() != 1 {
                    let indexes: HashMap<i64, i64> = rows.iter().enumerate().map(|(i, r)| (r.id, i as i64 + 1)).collect();
                    for packet in partition_cycle1_rows(rows, source_budget, 50) {
                        let generated = match generate_cycle1_chunks(&packet, ctx).await {
                            Ok(generated) => generated,
                            Err(MemoryError::Cancelled) => return Err(Stop::Aborted),
                            Err(error) => return Err(Stop::Failed(error.message())),
                        };
                        stats.add(&generated.stats);
                        failures.extend(generated.invalid_chunks);
                        chunks.extend(generated.chunks.into_iter().map(|c| Parsed {
                            idx_list: c.members.iter().map(|m| indexes[&m.id]).collect(),
                            parse_error: None,
                            element: c.element,
                            category: c.category,
                            summary: c.summary,
                        }));
                    }
                    return Ok(chunks);
                }
                let fragments = split_cycle1_row(&rows[0], source_budget).map_err(Stop::Failed)?;
                stats.fragments = fragments.len() as i64;
                let mut parts: Vec<Parsed> = Vec::new();
                for fragment in fragments {
                    let (found, _) = Packets { ctx, stats: &mut stats, failures: &mut failures }.packet(std::slice::from_ref(&fragment), false).await?;
                    // Uncompressible fragments stay verbatim inside the complete row; none disappears.
                    if found.is_empty() && !failures.is_empty() {
                        return Ok(Vec::new());
                    }
                    parts.push(found.into_iter().next().unwrap_or(Parsed { element: String::new(), category: "fact".into(), summary: fragment.content.clone(), ..Parsed::default() }));
                }
                let summary: String = parts
                    .iter()
                    .enumerate()
                    .map(|(i, part)| format!("{}{}", if i > 0 && (!part.element.is_empty() || !parts[i - 1].element.is_empty()) { "\n" } else { "" }, part.summary))
                    .collect();
                if chunk_compression(&summary, rows).2
                    && let Some(metadata) = parts.iter().find(|p| !p.element.is_empty())
                {
                    chunks = vec![Parsed { idx_list: vec![1], summary, ..metadata.clone() }];
                }
                Ok(chunks)
            } else {
                Packets { ctx, stats: &mut stats, failures: &mut failures }.with_rewrite(rows).await
            }
        }
        .await;
        let candidates = match step {
            Ok(chunks) => chunks,
            Err(Stop::Aborted) => return Err(MemoryError::Cancelled),
            Err(Stop::Failed(error)) => {
                if ctx.cancel.is_cancelled() {
                    return Err(MemoryError::Cancelled);
                }
                failures.push(InvalidChunk { reason: "llm_error".into(), idx_list: None, member_ids: rows.iter().map(|r| r.id).collect(), error: Some(error) });
                Vec::new()
            }
        };
        Ok(finish(candidates, stats, failures))
    })
}

fn project(candidates: Vec<Parsed>, rows: &[Row], failures: Vec<InvalidChunk>, stats: Stats, started: Instant, now: &(dyn Fn() -> i64 + Send + Sync)) -> Generated {
    let mut covered = HashSet::new();
    let mut accepted: Vec<Chunk> = candidates
        .into_iter()
        .map(|chunk| {
            let mut order = chunk.idx_list.clone();
            order.sort_unstable();
            let members: Vec<Row> = order.iter().map(|&n| rows[n as usize - 1].clone()).collect();
            covered.extend(members.iter().map(|m| m.id));
            let quality = make_chunk_quality(&chunk.summary, &members, now());
            Chunk { element: chunk.element, category: chunk.category, summary: chunk.summary, idx_list: chunk.idx_list, members, quality }
        })
        .collect();
    accepted.sort_by_key(|chunk| chunk.idx_list.iter().copied().min());
    Generated {
        chunks: accepted,
        raw_row_ids: rows.iter().filter(|r| !covered.contains(&r.id)).map(|r| r.id).collect(),
        invalid_chunks: failures,
        stats,
        total_ms: started.elapsed().as_millis() as i64,
    }
}
