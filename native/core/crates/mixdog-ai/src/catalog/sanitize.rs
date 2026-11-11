//! The model-list sanitizer (`sanitizeModelList`, `model-list-sanitize.mjs`):
//! narrows a provider's listed rows to current, chat-capable, coding-relevant
//! models and collapses dated snapshots. Conservative: a row whose family or
//! mode is unknown is kept. Output is a filtered subset of the input rows, in
//! order.
//!
//! The staleness and coding-fit passes read the projected models.dev document
//! ([`super::ModelsDev::projected`], what Node keeps in `modelsDevSource.cache`);
//! `None` is a cold catalog, which skips staleness and leaves the id-only
//! coding-fit fallback.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::sync::LazyLock;

use mixdog_js::js_trim;
use regex::Regex;
use serde_json::Value;

use super::lookup::models_dev_provider_id;
use mixdog_core_api::domain::provider::ModelRecord;

/// JS `\s`.
const WS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// The string a pattern tests (ids are lowercased first, which is what makes
/// the JS `i` flag unnecessary), with JS `\b` and `\d` spelled ASCII.
fn rx(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static pattern")
}

static CODING_UNFIT_ID: LazyLock<Regex> = LazyLock::new(|| rx(r"-search(-preview)?((?-u:\b)|-|$)|-(audio|realtime)-preview"));

static NON_CHAT: LazyLock<Regex> = LazyLock::new(|| {
    let words = [
        "embed", "embedding", "embeddings", "tts", "stt", "whisper", "audio", "speech", "voice", "image", "images", "video",
        "videos", "moderation", "moderations", "rerank", "reranker", "similarity", r"dall[-_]?e", "sora", "imagen", "imagine",
        "veo", "kling", "runway", "realtime", "transcribe", "transcription", "diarize", "guard", "safety", "classifier",
        "robotics", r"computer[-_]?use",
    ]
    .join("|");
    rx(&format!(r"(^|[-_/{WS}])({words})([-_/{WS}]|$)"))
});

static NON_LLM_IDS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"^tts((?-u:\b)|-)",
        r"^whisper((?-u:\b)|-)",
        r"^dall[-_]?e((?-u:\b)|-)",
        r"^(text-)?embedding",
        r"^text-embedding-ada",
        r"^text-moderation((?-u:\b)|-)",
        r"^omni-moderation((?-u:\b)|-)",
        r"^gpt-image((?-u:\b)|-)",
        r"^chatgpt-image((?-u:\b)|-)",
        r"^gpt-(4o|4o-mini|realtime|audio)?-?(tts|transcribe)((?-u:\b)|-)",
        r"^gpt-audio((?-u:\b)|-)",
        r"^gpt-realtime((?-u:\b)|-)",
        r"-tts((?-u:\b)|-)",
        r"(^|-)robotics((?-u:\b)|-)",
        r"computer[-_]?use",
        r"native[-_]?audio",
        r"-customtools((?-u:\b)|-|$)",
        r"^codex-auto-review$",
        r"^grok-build$",
    ]
    .map(rx)
    .to_vec()
});

static LEGACY: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"^gpt-4(o|-turbo|-32k|-[0-9]|$)",
        r"^chatgpt-4o((?-u:\b)|-)",
        r"^gpt-3(\.5)?((?-u:\b)|-)",
        r"^(text-)?(davinci|babbage|curie|ada)((?-u:\b)|-)",
        r"^o1(-mini|-preview|-[0-9]|$)",
        r"^o3-mini((?-u:\b)|-)",
        r"^claude-(1|2|3|instant)((?-u:\b)|-|\.)",
        r"^gemini-1((?-u:\b)|-|\.)",
        r"^gemini-2\.0((?-u:\b)|-|\.)",
        r"^gemini-pro((?-u:\b)|-)",
        r"^grok-(1|2|3)((?-u:\b)|-|\.)",
        r"^grok-beta((?-u:\b)|-)",
    ]
    .map(rx)
    .to_vec()
});

static DASHED_DATE: LazyLock<Regex> = LazyLock::new(|| rx(r"-[0-9]{4}-[0-9]{2}-[0-9]{2}$"));
static COMPACT_DATE: LazyLock<Regex> = LazyLock::new(|| rx(r"-20[0-9]{6}$"));
static MMDD: LazyLock<Regex> = LazyLock::new(|| rx(r"^([^\n\r\x{2028}\x{2029}]*)-0[0-9]{3}$"));
static RELEASE: LazyLock<Regex> = LazyLock::new(|| rx(r"^([0-9]{4})-([0-9]{2})(?:-([0-9]{2}))?$"));
static CLAUDE_FAMILY: LazyLock<Regex> = LazyLock::new(|| rx(r"(?:^|/)claude-([a-z]+)(?:-|$)"));
static PREVIEW: LazyLock<Regex> = LazyLock::new(|| {
    rx(&format!(r"(^|[-_.:/{WS}])(preview|exp|experimental)([-_.:/{WS}]|$)"))
});

const HOSTED: [&str; 15] = [
    "openai", "openai-oauth", "openai-ws", "anthropic", "anthropic-oauth", "gemini", "google", "xai", "grok-oauth",
    "deepseek", "groq", "mistral", "opencode-go", "openrouter", "azure",
];

fn lower(text: &str) -> String {
    text.to_lowercase()
}

fn is_non_llm_id(lid: &str) -> bool {
    NON_LLM_IDS.iter().any(|re| re.is_match(lid))
}

fn is_legacy(lid: &str) -> bool {
    LEGACY.iter().any(|re| re.is_match(lid))
}

fn is_non_chat_mode(row: &ModelRecord) -> bool {
    let mode = row.mode.as_deref().map(|m| lower(js_trim(m))).unwrap_or_default();
    !mode.is_empty() && !["chat", "completion", "responses", "messages"].contains(&mode.as_str())
}

/// `_canonicalKey`: only the unambiguous date suffixes.
fn canonical_key(id: &str) -> String {
    let key = lower(js_trim(id));
    let key = DASHED_DATE.replace(&key, "");
    COMPACT_DATE.replace(&key, "").into_owned()
}

fn is_dated(id: &str) -> bool {
    canonical_key(id) != lower(js_trim(id))
}

fn mmdd_base(id: &str) -> Option<String> {
    MMDD.captures(&lower(js_trim(id))).map(|c| c[1].to_owned())
}

fn same_limits(a: &ModelRecord, b: &ModelRecord) -> bool {
    a.context_window.unwrap_or(0) == b.context_window.unwrap_or(0) && a.max_output_tokens.unwrap_or(0) == b.max_output_tokens.unwrap_or(0)
}

/// `Date.UTC(y, m - 1, d)` in epoch ms, with JS's overflow and two-digit-year rules.
fn date_utc(year: i64, month0: i64, day: i64) -> i64 {
    let year = if (0..100).contains(&year) { 1900 + year } else { year };
    let total = year * 12 + month0;
    let (y, m) = (total.div_euclid(12), total.rem_euclid(12) + 1);
    // Days from civil (Hinnant).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    (days + day - 1) * 86_400_000
}

/// `_releaseEpoch`: a models.dev `release_date` (`YYYY-MM[-DD]`).
fn release_epoch(row: &Value) -> Option<i64> {
    let text = js_trim(row.get("release_date")?.as_str()?);
    let c = RELEASE.captures(text)?;
    let num = |i: usize| c.get(i).map(|m| m.as_str().parse::<i64>().expect("digits"));
    Some(date_utc(num(1)?, num(2)? - 1, num(3).unwrap_or(1)))
}

/// `_stalenessFamily`.
fn staleness_family(row: &Value, id: &str) -> Option<String> {
    let model_id = lower(js_trim(id));
    if let Some(c) = CLAUDE_FAMILY.captures(&model_id) {
        return Some(format!("claude-{}", &c[1]));
    }
    let family = row.get("family").and_then(Value::as_str).map(|f| lower(js_trim(f)))?;
    (!family.is_empty()).then_some(family)
}

fn is_preview_variant(id: &str) -> bool {
    PREVIEW.is_match(&lower(id))
}

/// `isRollingModelAlias`.
fn is_rolling_alias(id: &str) -> bool {
    lower(js_trim(id)).ends_with("-latest")
}

/// The provider's models.dev rows (`getModelsDevProviderModelsSync`).
fn provider_models<'a>(models_dev: Option<&'a Value>, provider: &str) -> Option<&'a serde_json::Map<String, Value>> {
    let pid = models_dev_provider_id(provider)?;
    models_dev?.get(&pid)?.get("models")?.as_object()
}

/// What the passes read besides the rows.
#[derive(Clone, Copy)]
pub struct Context<'a> {
    /// The projected models.dev document; `None` while it is cold.
    pub models_dev: Option<&'a Value>,
    /// `Date.now()`.
    pub now_ms: i64,
    /// `MIXDOG_MODEL_STALE_MONTHS`, as [`stale_months`] reads it.
    pub stale_months: f64,
}

/// `_staleMonths`: the environment value, or 9 when unset, empty or not a number.
pub fn stale_months(raw: Option<&str>) -> f64 {
    match raw {
        None | Some("") => 9.0,
        Some(text) => {
            let n = mixdog_js::to_number(&Value::String(text.to_owned()));
            if n.is_finite() { n } else { 9.0 }
        }
    }
}

/// `_applyAutoStaleness`: family supersession and the absolute age cut, by
/// models.dev release dates. `kept` holds indexes into `rows`.
fn apply_auto_staleness(rows: &[ModelRecord], kept: Vec<usize>, provider: &str, ctx: &Context<'_>) -> Vec<usize> {
    let Some(catalog) = provider_models(ctx.models_dev, provider) else { return kept };

    struct Meta<'a> {
        index: usize,
        cat: Option<&'a Value>,
        family: Option<String>,
        epoch: Option<i64>,
    }
    let meta: Vec<Meta<'_>> = kept
        .iter()
        .map(|&index| {
            // `catModels[row.id] || null`: a row that is not an object is absent.
            let cat = catalog.get(&rows[index].id).filter(|v| crate::service::admin_route::truthy(Some(v)));
            Meta {
                index,
                cat,
                family: cat.and_then(|cr| staleness_family(cr, &rows[index].id)),
                epoch: cat.and_then(release_epoch),
            }
        })
        .collect();

    // The newest date per family over the whole catalog, so a superseding
    // model that is not listed still counts. Preview and experimental entries
    // count only against other previews.
    let mut newest: BTreeMap<String, i64> = BTreeMap::new();
    let mut newest_stable: BTreeMap<String, i64> = BTreeMap::new();
    for (id, cr) in catalog {
        let (Some(family), Some(epoch)) = (staleness_family(cr, id), release_epoch(cr)) else { continue };
        if is_rolling_alias(id) {
            continue;
        }
        let bump = |map: &mut BTreeMap<String, i64>| {
            let slot = map.entry(family.clone()).or_insert(epoch);
            *slot = (*slot).max(epoch);
        };
        bump(&mut newest);
        if !is_preview_variant(id) {
            bump(&mut newest_stable);
        }
    }

    let mut dropped: BTreeSet<usize> = BTreeSet::new();
    for m in &meta {
        let (Some(_), Some(family), Some(epoch)) = (m.cat, &m.family, m.epoch) else { continue };
        if is_rolling_alias(&rows[m.index].id) {
            continue;
        }
        let table = if is_preview_variant(&rows[m.index].id) { &newest } else { &newest_stable };
        if table.get(family).is_some_and(|newest| *newest > epoch) {
            dropped.insert(m.index);
        }
    }
    // Never empty a family: if supersession removed every listed member,
    // restore the newest listed one (the first on a tie).
    let mut by_family: BTreeMap<&str, Vec<&Meta<'_>>> = BTreeMap::new();
    for m in &meta {
        if let Some(family) = &m.family {
            by_family.entry(family).or_default().push(m);
        }
    }
    for members in by_family.values() {
        if !members.iter().all(|m| dropped.contains(&m.index)) {
            continue;
        }
        let mut best: Option<&Meta<'_>> = None;
        for m in members {
            if best.is_none_or(|b| m.epoch.unwrap_or(0) > b.epoch.unwrap_or(0)) {
                best = Some(m);
            }
        }
        if let Some(best) = best {
            dropped.remove(&best.index);
        }
    }

    // The absolute cut; skipped when it would empty the provider's list.
    if ctx.stale_months > 0.0 {
        let cutoff = ctx.now_ms as f64 - ctx.stale_months * 30.4375 * 24.0 * 60.0 * 60.0 * 1000.0;
        let mut cut: BTreeSet<usize> = BTreeSet::new();
        for m in &meta {
            if dropped.contains(&m.index) || m.cat.is_none() {
                continue;
            }
            let Some(epoch) = m.epoch else { continue };
            if is_rolling_alias(&rows[m.index].id) {
                continue;
            }
            if (epoch as f64) < cutoff {
                cut.insert(m.index);
            }
        }
        if kept.iter().any(|i| !dropped.contains(i) && !cut.contains(i)) {
            dropped.extend(cut);
        }
    }
    kept.into_iter().filter(|i| !dropped.contains(i)).collect()
}

/// `_applyCodingUnfit`: hosted providers only. A catalog row that does not
/// call tools, or emits no text, is dropped; without a catalog row the id
/// fallback applies.
fn apply_coding_unfit(rows: &[ModelRecord], kept: Vec<usize>, provider: &str, ctx: &Context<'_>) -> Vec<usize> {
    let catalog = provider_models(ctx.models_dev, provider);
    kept.into_iter()
        .filter(|&i| {
            let id = &rows[i].id;
            if id.is_empty() {
                return false;
            }
            let row = catalog.and_then(|c| c.get(id)).filter(|v| crate::service::admin_route::truthy(Some(v)));
            match row {
                Some(cr) => {
                    if cr.get("tool_call") == Some(&Value::Bool(false)) {
                        return false;
                    }
                    let text_free = cr
                        .pointer("/modalities/output")
                        .and_then(Value::as_array)
                        .is_some_and(|out| !out.iter().any(|m| m.as_str() == Some("text")));
                    !text_free
                }
                None => !CODING_UNFIT_ID.is_match(&lower(id)),
            }
        })
        .collect()
}

/// `_preferRow`: the undated alias; of two dated rows the newest `created`,
/// else the lexically latest id.
fn prefer(a: usize, b: usize, rows: &[ModelRecord]) -> usize {
    let (ra, rb) = (&rows[a], &rows[b]);
    let (a_dated, b_dated) = (is_dated(&ra.id), is_dated(&rb.id));
    if a_dated != b_dated {
        return if a_dated { b } else { a };
    }
    if !a_dated && !b_dated {
        return a;
    }
    let (ac, bc) = (ra.created.unwrap_or(0), rb.created.unwrap_or(0));
    if ac != bc {
        return if ac > bc { a } else { b };
    }
    // JS compares strings by UTF-16 code unit.
    if rb.id.encode_utf16().cmp(ra.id.encode_utf16()) == Ordering::Greater { b } else { a }
}

/// `sanitizeModelList`.
pub fn sanitize_model_list(rows: Vec<ModelRecord>, provider: &str, ctx: &Context<'_>) -> Vec<ModelRecord> {
    let provider = lower(js_trim(provider));
    if !HOSTED.contains(&provider.as_str()) {
        // A custom or local provider: only the mode drop applies.
        return rows.into_iter().filter(|row| !row.id.is_empty() && !is_non_chat_mode(row)).collect();
    }

    let mut kept = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        if row.id.is_empty() {
            continue;
        }
        let lid = lower(&row.id);
        let mode_chat = row.mode.as_deref().is_some_and(|m| lower(js_trim(m)) == "chat");
        if is_non_llm_id(&lid) || lid.ends_with(":batch") || is_non_chat_mode(row) {
            continue;
        }
        if !mode_chat && NON_CHAT.is_match(&lid) {
            continue;
        }
        if is_legacy(&lid) {
            continue;
        }
        kept.push(index);
    }

    let fresh = apply_auto_staleness(&rows, kept, &provider, ctx);
    let coding_fit = apply_coding_unfit(&rows, fresh, &provider, ctx);

    // Dedupe on the unambiguous date suffixes; first-seen key order.
    let mut by_key: BTreeMap<String, usize> = BTreeMap::new();
    for &i in &coding_fit {
        let key = canonical_key(&rows[i].id);
        let winner = by_key.get(&key).map_or(i, |&prev| prefer(prev, i, &rows));
        by_key.insert(key, winner);
    }
    let mut winners: BTreeSet<usize> = by_key.values().copied().collect();

    // Collapse a `-0xxx` row onto its surviving undated alias with equal limits.
    let alias_by_key: BTreeMap<String, usize> = winners.iter().map(|&i| (canonical_key(&rows[i].id), i)).collect();
    for i in winners.clone() {
        let Some(base) = mmdd_base(&rows[i].id) else { continue };
        if let Some(&alias) = alias_by_key.get(&base)
            && alias != i
            && same_limits(&rows[alias], &rows[i])
        {
            winners.remove(&i);
        }
    }

    let keep: BTreeSet<usize> = coding_fit.into_iter().filter(|i| winners.contains(i)).collect();
    rows.into_iter().enumerate().filter(|(i, _)| keep.contains(i)).map(|(_, row)| row).collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn golden() -> Value {
        serde_json::from_str(mixdog_testkit::fixture!("fixtures/sanitize/golden.json")).expect("golden parses")
    }

    /// A listed row as the golden's JSON states it.
    fn row(value: &Value) -> ModelRecord {
        let mut record = ModelRecord::new(value["id"].as_str().unwrap());
        record.mode = value.get("mode").map(|m| m.as_str().unwrap().to_owned());
        record.context_window = value.get("contextWindow").and_then(Value::as_u64).filter(|n| *n > 0);
        record.max_output_tokens =value.get("outputTokens").and_then(Value::as_u64).filter(|n| *n > 0);
        record.created = value.get("created").and_then(Value::as_i64);
        record
    }

    #[test]
    fn every_sanitized_list_equals_node() {
        let golden = golden();
        let now = golden["now"].as_i64().unwrap();
        let catalog = &golden["catalog"];
        let variants: Vec<Vec<ModelRecord>> =
            golden["variants"].as_array().unwrap().iter().map(|v| v.as_array().unwrap().iter().map(row).collect()).collect();
        let cases = golden["cases"].as_array().unwrap();
        assert!(cases.len() > 400);
        for case in cases {
            let rows = variants[case["variant"].as_u64().unwrap() as usize].clone();
            let ctx = Context {
                models_dev: (!case["cold"].as_bool().unwrap()).then_some(catalog),
                now_ms: now,
                stale_months: stale_months(case["months"].as_str()),
            };
            let kept = sanitize_model_list(rows.clone(), case["provider"].as_str().unwrap(), &ctx);
            let got: Vec<usize> = kept.iter().map(|k| rows.iter().position(|r| r.id == k.id).unwrap()).collect();
            let want: Vec<usize> = case["kept"].as_array().unwrap().iter().map(|i| i.as_u64().unwrap() as usize).collect();
            assert_eq!(got, want, "{} variant {} cold {} months {}", case["provider"], case["variant"], case["cold"], case["months"]);
        }
    }

    #[test]
    fn javascript_dates_and_month_settings() {
        assert_eq!(date_utc(2026, 5, 1), 1_780_272_000_000);
        assert_eq!(date_utc(50, 0, 1), date_utc(1950, 0, 1), "two-digit years are 19xx");
        assert_eq!(date_utc(2026, 12, 1), date_utc(2027, 0, 1), "month overflow rolls the year");
        assert_eq!(release_epoch(&json!({"release_date": " 2026-03 "})), Some(date_utc(2026, 2, 1)));
        assert_eq!(release_epoch(&json!({"release_date": "2026-3"})), None);
        assert_eq!((stale_months(None), stale_months(Some("")), stale_months(Some("x")), stale_months(Some("12"))), (9.0, 9.0, 9.0, 12.0));
    }
}
