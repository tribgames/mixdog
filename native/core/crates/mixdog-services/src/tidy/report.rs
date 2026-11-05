//! One JSON result per call, bounded the way every model-facing tool bounds output: per-engine
//! diagnostic caps with a `more` count first, then progressive trimming until the encoded report
//! fits the tool output budget. Counts and rule/directory summaries always survive trimming; only
//! sample rows are dropped. Cached rows and write payloads are never changed.

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use super::resolve::Resolved;
use super::shadow::shadow_note;
use super::worktree::worktree_notes;

pub const DIAGNOSTIC_CAP: usize = 20;
const FILE_LIST_CAP: usize = 25;
pub const RESULTS_PAGE_MAX: usize = 100;
const TRIM_STEPS: [usize; 3] = [8, 3, 0];
pub const TOOL_OUTPUT_MAX_BYTES: usize = 50 * 1024;

/// A tool-result envelope: one text block holding the JSON, flagged when it is an error.
pub fn tidy_tool_result(value: &Value, is_error: Option<bool>) -> Value {
    let is_error = is_error.unwrap_or_else(|| value.get("ok") == Some(&Value::Bool(false)));
    let mut out = json!({"content": [{"type": "text", "text": value.to_string()}]});
    if is_error {
        out["isError"] = json!(true);
    }
    out
}

fn page_list(values: &[Value], offset: usize, cap: usize) -> (Vec<Value>, usize, usize) {
    let items: Vec<Value> = if cap == 0 { Vec::new() } else { values.iter().skip(offset).take(cap).cloned().collect() };
    let more = values.len().saturating_sub(offset).saturating_sub(items.len());
    (items, more, offset)
}

fn arr(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], Vec::as_slice)
}

fn put(m: &mut Map<String, Value>, key: &str, v: Value) {
    m.insert(key.to_owned(), v);
}

fn put_if(m: &mut Map<String, Value>, cond: bool, key: &str, v: impl FnOnce() -> Value) {
    if cond {
        m.insert(key.to_owned(), v());
    }
}

/// Engine entry for the report: resolution facts plus the hint when missing.
fn shape_engine(e: &Resolved) -> Value {
    let mut m = Map::new();
    put(&mut m, "id", json!(e.id));
    put_if(&mut m, !e.version.is_empty(), "version", || json!(e.version));
    put(&mut m, "source", json!(e.source));
    put_if(&mut m, !e.path.is_empty(), "path", || json!(e.path));
    put(&mut m, "kind", json!(e.kind));
    put(&mut m, "languages", json!(e.languages));
    put_if(&mut m, e.config_file.is_some(), "configFile", || json!(e.config_file));
    put_if(&mut m, !e.suppressed_by.is_empty(), "suppressedBy", || json!(e.suppressed_by));
    put_if(&mut m, e.skipped.is_some(), "skipped", || json!(e.skipped));
    put_if(&mut m, e.toolchain, "toolchain", || json!(true));
    put_if(&mut m, e.installable, "installable", || json!(true));
    put_if(&mut m, e.missing, "installHint", || json!(e.install_hint));
    Value::Object(m)
}

/// check/fix header entry: which engine ran, or how to install a missing one. Resolution details
/// (path, version, source, kind, languages) belong to scan.
fn brief_engine(e: &Value) -> Value {
    let mut m = Map::new();
    put(&mut m, "id", e["id"].clone());
    for k in ["configFile", "suppressedBy", "skipped", "installable", "installHint"] {
        if e.get(k).is_some_and(|v| !v.is_null() && *v != "") {
            put(&mut m, k, e[k].clone());
        }
    }
    Value::Object(m)
}

fn rollup_engine_counts(results: &[Value]) -> Value {
    if results.is_empty() {
        return Value::Null;
    }
    let (mut fix, mut sev) = ([0i64; 5], [0i64; 3]);
    let (mut diagnostics, mut files_to_format, mut any) = (0i64, 0i64, false);
    let n = |v: &Value| v.as_i64().unwrap_or(0);
    for r in results {
        let Some(c) = r.get("counts").filter(|c| !c.is_null()) else { continue };
        any = true;
        diagnostics += n(&c["diagnostics"]);
        files_to_format += n(&c["filesToFormat"]);
        for (i, k) in ["safe", "unsafe", "manual", "fixable", "unfixable"].iter().enumerate() {
            fix[i] += n(&c["byFixability"][*k]);
        }
        for (i, k) in ["error", "warning", "info"].iter().enumerate() {
            sev[i] += n(&c["bySeverity"][*k]);
        }
    }
    if !any {
        return Value::Null;
    }
    json!({"diagnostics": diagnostics, "filesToFormat": files_to_format,
           "byFixability": {"safe": fix[0], "unsafe": fix[1], "manual": fix[2], "fixable": fix[3], "unfixable": fix[4]},
           "bySeverity": {"error": sev[0], "warning": sev[1], "info": sev[2]}})
}

struct Finding {
    loc: String,
    rule: String,
    severity: String,
    message: String,
    fix: bool,
}

fn shape_diagnostic(row: &Value) -> Finding {
    let file = row["file"].as_str().unwrap_or("").replace('\\', "/");
    let pick = |a: &str, b: &str| row.pointer(a).filter(|v| !v.is_null()).or_else(|| row.get(b)).and_then(Value::as_i64).unwrap_or(0);
    let rule = row.get("ruleId").filter(|v| !v.is_null()).or_else(|| row.get("code")).and_then(Value::as_str).unwrap_or("");
    let fix = match row.get("fixable").filter(|v| !v.is_null()).or_else(|| row.get("fix")) {
        Some(Value::Bool(b)) => *b,
        Some(Value::Null) | None => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    };
    Finding {
        loc: format!("{file}:{}:{}", pick("/range/start/line", "line"), pick("/range/start/column", "col")),
        rule: rule.to_owned(),
        severity: row["severity"].as_str().filter(|s| !s.is_empty()).unwrap_or("warning").to_owned(),
        message: row["message"].as_str().unwrap_or("").to_owned(),
        fix,
    }
}

/// A page row states only what its rule's byRule entry does not.
fn compact_diagnostic(row: &Value, by_rule: &Value) -> Value {
    let f = shape_diagnostic(row);
    let rule = by_rule.get(&f.rule).filter(|_| !f.rule.is_empty() || by_rule.get("").is_some());
    let mut m = Map::new();
    put(&mut m, "loc", json!(f.loc));
    put(&mut m, "rule", json!(f.rule));
    put_if(&mut m, rule.and_then(|r| r["severity"].as_str()) != Some(f.severity.as_str()), "severity", || json!(f.severity));
    put_if(&mut m, !f.message.is_empty() && rule.and_then(|r| r["message"].as_str()) != Some(f.message.as_str()), "message", || json!(f.message));
    put_if(&mut m, f.fix, "fix", || json!(true));
    Value::Object(m)
}

/// Summarizes the full selection, never the page or trimmed sample.
fn summarize_diagnostics(rows: &[Value], include_rules: bool) -> Value {
    let rank = |s: &str| match s { "error" => 3, "warning" => 2, _ => 1 };
    let mut by_rule: Vec<(String, Map<String, Value>)> = Vec::new();
    let mut by_dir: BTreeMap<String, i64> = BTreeMap::new();
    let mut dir_order: Vec<String> = Vec::new();
    for row in rows {
        let f = shape_diagnostic(row);
        let file = row["file"].as_str().unwrap_or("").replace('\\', "/");
        let file = file.strip_prefix("./").unwrap_or(&file);
        let parts: Vec<&str> = file.split('/').collect();
        let dir = parts[..parts.len().saturating_sub(1)].iter().take(2).copied().collect::<Vec<_>>().join("/");
        let dir = if dir.is_empty() { ".".to_owned() } else { dir };
        if !by_dir.contains_key(&dir) {
            dir_order.push(dir.clone());
        }
        *by_dir.entry(dir).or_default() += 1;
        if !include_rules || f.rule.is_empty() {
            continue;
        }
        let idx = by_rule.iter().position(|(r, _)| *r == f.rule).unwrap_or_else(|| {
            let mut t = Map::new();
            t.insert("count".into(), json!(0));
            t.insert("severity".into(), json!(f.severity));
            t.insert("fixable".into(), json!(0));
            if !f.message.is_empty() {
                t.insert("message".into(), json!(f.message));
            }
            by_rule.push((f.rule.clone(), t));
            by_rule.len() - 1
        });
        let t = &mut by_rule[idx].1;
        t["count"] = json!(t["count"].as_i64().unwrap_or(0) + 1);
        t["fixable"] = json!(t["fixable"].as_i64().unwrap_or(0) + i64::from(f.fix));
        if rank(&f.severity) > rank(t["severity"].as_str().unwrap_or("info")) {
            t["severity"] = json!(f.severity);
        }
    }
    let by_rule: Map<String, Value> = by_rule.into_iter().map(|(k, v)| (k, Value::Object(v))).collect();
    let by_dir: Map<String, Value> = dir_order.into_iter().map(|d| (d.clone(), json!(by_dir[&d]))).collect();
    json!({"byRule": by_rule, "byDir": by_dir})
}

fn shape_worktree_group(group: &Value, cap: usize) -> Value {
    let (items, more, _) = page_list(arr(&group["files"]), 0, cap);
    let mut m = Map::new();
    put(&mut m, "files", json!(items));
    put_if(&mut m, more > 0, "more", || json!(more));
    put(&mut m, "fileCount", json!(arr(&group["files"]).len()));
    put(&mut m, "findings", json!(group["findings"].as_i64().unwrap_or(0)));
    Value::Object(m)
}

fn shape_working_tree(w: &Value, cap: usize) -> Value {
    // Three distinguishable states: a split, a git that failed (`error`), no git to ask (`skipped`).
    if let Some(s) = w.get("skipped").filter(|v| !v.is_null()) {
        return json!({"skipped": s});
    }
    if let Some(e) = w.get("error").and_then(Value::as_str).filter(|e| !e.is_empty()) {
        return json!({"error": e});
    }
    let mut m = Map::new();
    for name in ["modified", "clean"] {
        if !arr(&w[name]["files"]).is_empty() {
            put(&mut m, name, shape_worktree_group(&w[name], cap));
        }
    }
    Value::Object(m)
}

fn structural_errors(s: &Value) -> Vec<Value> {
    let mut seen = Vec::new();
    let all = arr(&s["errors"]).iter().chain(arr(&s["ruleErrors"])).chain(s.get("error").filter(|e| !e.is_null()));
    for e in all {
        let shaped = json!({"language": e.get("language").and_then(Value::as_str).unwrap_or(""), "kind": e["kind"], "message": e["message"]});
        if !seen.contains(&shaped) {
            seen.push(shaped);
        }
    }
    seen
}

/// Counts without zero leaves or empty groups; `None` when nothing is left.
fn non_zero_counts(v: &Value) -> Option<Value> {
    match v {
        Value::Object(o) => {
            let kept: Map<String, Value> = o.iter().filter_map(|(k, x)| non_zero_counts(x).map(|x| (k.clone(), x))).collect();
            (!kept.is_empty()).then_some(Value::Object(kept))
        }
        Value::Null => None,
        Value::Number(n) if n.as_f64() == Some(0.0) => None,
        Value::Array(_) => Some(v.clone()),
        other => Some(other.clone()),
    }
}

fn present_groups(summary: &Value) -> Vec<(String, Value)> {
    summary.as_object().into_iter().flatten().filter(|(_, g)| g.as_object().is_some_and(|o| !o.is_empty())).map(|(k, g)| (k.clone(), g.clone())).collect()
}

/// A clean engine is its id, filesChecked and diagnosticsCount 0; list, page and summary fields
/// appear only when the engine reported something.
fn shape_engine_result(result: &Value, summary: &Value, cap: usize, offset: usize, file_paging: (usize, usize)) -> Value {
    let diagnostics_count = arr(&result["diagnostics"]).len();
    let changed_count = arr(&result["filesChanged"]).len();
    let (diag_items, diag_more, diag_offset) = page_list(arr(&result["diagnostics"]), offset, cap);
    let (changed_items, changed_more, _) = page_list(arr(&result["filesChanged"]), file_paging.1, file_paging.0);
    let mut m = Map::new();
    put(&mut m, "id", result["id"].clone());
    put(&mut m, "filesChecked", json!(result["filesChecked"].as_i64().unwrap_or(0)));
    if changed_count > 0 {
        put(&mut m, "filesChanged", json!(changed_items));
        put_if(&mut m, changed_more > 0, "filesChangedMore", || json!(changed_more));
        put(&mut m, "filesChangedCount", json!(changed_count));
    }
    put(&mut m, "diagnosticsCount", json!(diagnostics_count));
    if diagnostics_count > 0 {
        put(&mut m, "diagnostics", json!(diag_items.iter().map(|r| compact_diagnostic(r, &summary["byRule"])).collect::<Vec<_>>()));
        put(&mut m, "more", json!(diag_more));
        for (k, g) in present_groups(summary) {
            put(&mut m, &k, g);
        }
        put(&mut m, "offset", json!(diag_offset));
        put_if(&mut m, diag_more > 0, "nextOffset", || json!(diag_offset + diag_items.len()));
    }
    for k in ["dryRun", "applied", "truncated"] {
        put_if(&mut m, result[k] == true, k, || json!(true));
    }
    for k in ["skipped", "error", "stderrTail"] {
        put_if(&mut m, result.get(k).and_then(Value::as_str).is_some_and(|s| !s.is_empty()), k, || result[k].clone());
    }
    if let Some(c) = non_zero_counts(result.get("counts").unwrap_or(&Value::Null)) {
        put(&mut m, "counts", c);
    }
    Value::Object(m)
}

fn shape_structural(s: &Value, summary: &Value, errors: &[Value], cap: usize, offset: usize) -> Value {
    if s.is_null() {
        return Value::Null;
    }
    let matches_all = arr(&s["matches"]);
    let (items, more, off) = page_list(matches_all, offset, cap);
    let mut m = Map::new();
    put(&mut m, "adapter", json!(s["adapter"].as_str().unwrap_or("none")));
    put_if(&mut m, s.get("packs").is_some_and(Value::is_array), "packsCount", || json!(arr(&s["packs"]).len()));
    put(&mut m, "matchesCount", json!(matches_all.len()));
    if !matches_all.is_empty() {
        for (k, g) in present_groups(summary) {
            put(&mut m, &k, g);
        }
        put(&mut m, "matches", json!(items.iter().map(|r| compact_diagnostic(r, &summary["byRule"])).collect::<Vec<_>>()));
        put(&mut m, "more", json!(more));
        put(&mut m, "offset", json!(off));
        put_if(&mut m, more > 0, "nextOffset", || json!(off + items.len()));
    }
    let fixable = matches_all.iter().filter(|x| x.get("fix").is_some_and(|f| !f.is_null())).count();
    let manual = matches_all.iter().filter(|x| x["manual"] == true).count();
    put_if(&mut m, fixable > 0, "fixable", || json!(fixable));
    put_if(&mut m, manual > 0, "manual", || json!(manual));
    put(&mut m, "applied", s.get("applied").cloned().unwrap_or_else(|| json!([])));
    put_if(&mut m, !arr(&s["rejected"]).is_empty(), "rejected", || s["rejected"].clone());
    put_if(&mut m, !errors.is_empty(), "errors", || json!(errors));
    put_if(&mut m, s.get("note").and_then(Value::as_str).is_some_and(|n| !n.is_empty()), "note", || s["note"].clone());
    Value::Object(m)
}

pub struct ReportInput {
    pub action: String,
    pub ok: bool,
    /// `[{id, files}]`
    pub languages: Vec<Value>,
    pub language_source: String,
    pub engines: Vec<Resolved>,
    pub results: Option<Vec<Value>>,
    pub structural: Value,
    pub function_length: Value,
    pub needs_approval: Value,
    pub installed: Value,
    pub errors: Vec<Value>,
    pub notes: Vec<String>,
    pub policy: Value,
    pub rules: Value,
    pub scope: Value,
    pub shadows: Option<Vec<Value>>,
    pub working_tree: Value,
    pub elapsed_ms: u64,
    pub offset: usize,
    pub limit: usize,
    pub max_bytes: usize,
}

impl Default for ReportInput {
    fn default() -> Self {
        Self {
            action: String::new(), ok: true, languages: Vec::new(), language_source: String::new(), engines: Vec::new(), results: None, structural: Value::Null,
            function_length: Value::Null, needs_approval: Value::Null, installed: Value::Null, errors: Vec::new(), notes: Vec::new(), policy: Value::Null, rules: Value::Null,
            scope: Value::Null, shadows: None, working_tree: Value::Null, elapsed_ms: 0, offset: 0, limit: DIAGNOSTIC_CAP, max_bytes: TOOL_OUTPUT_MAX_BYTES,
        }
    }
}

fn is_run_action(action: &str) -> bool {
    action == "check" || action == "fix"
}

struct Parts {
    ok: bool,
    status: &'static str,
    action: String,
    scope: Value,
    languages: Vec<Value>,
    language_source: String,
    resolved: Vec<Resolved>,
    missing: Vec<Resolved>,
    policy: Value,
    results: Option<Vec<Value>>,
    result_summaries: Vec<Value>,
    rolled: Value,
    structural: Value,
    structural_summary: Value,
    function_length: Value,
    shadows: Vec<Value>,
    working_tree: Value,
    pass_errors: Vec<Value>,
    rules: Value,
    installed: Value,
    needs_approval: Value,
    errors: Vec<Value>,
    notes: Vec<String>,
    elapsed_ms: u64,
    page_offset: usize,
}

/// Assembles the report and trims it until it fits the tool output budget.
pub fn build_tidy_report(input: ReportInput) -> Value {
    let results = input.results.clone().unwrap_or_default();
    let truncation_notes: Vec<String> = results
        .iter()
        .filter(|r| r["truncated"] == true)
        .map(|r| r["note"].as_str().filter(|n| !n.is_empty()).map_or_else(|| format!("{} output was truncated; split the scope and re-run", r["id"].as_str().unwrap_or("")), str::to_owned))
        .collect();
    let engine_truncated = results.iter().any(|r| r["truncated"] == true);
    let start_cap = input.limit.min(RESULTS_PAGE_MAX);
    let pass_errors = structural_errors(&input.structural);
    let succeeded = input.ok && arr(&input.structural["rejected"]).is_empty() && !engine_truncated && input.errors.is_empty() && !results.iter().any(|r| r.get("error").is_some_and(|e| !e.is_null() && *e != ""));
    let changed = !arr(&input.structural["applied"]).is_empty() || results.iter().any(|r| r["dryRun"] != true && !arr(&r["filesChanged"]).is_empty() && input.action == "fix");
    let status = if succeeded { if pass_errors.is_empty() { "complete" } else { "partial" } } else if changed { "partial" } else { "failed" };
    let run = is_run_action(&input.action);
    let mut notes = input.notes.clone();
    notes.extend(truncation_notes);
    if !run {
        notes.extend(input.shadows.iter().flatten().map(shadow_note));
    }
    let wt = if input.working_tree.is_null() { None } else { Some(&input.working_tree) };
    notes.extend(worktree_notes(wt, &input.action));
    let mut languages_seen: Vec<String> = Vec::new();
    for e in &pass_errors {
        let l = e["language"].as_str().filter(|l| !l.is_empty()).unwrap_or("unknown language").to_owned();
        if !languages_seen.contains(&l) {
            languages_seen.push(l);
        }
    }
    notes.extend(languages_seen.iter().map(|l| format!("{l} structural pass did not complete; see structural.errors")));
    if !pass_errors.is_empty() {
        notes.push("structural apply blocked for the entire run; no structural fixes were written".into());
    }
    let summaries = results
        .iter()
        .map(|r| {
            let kind = input.engines.iter().find(|e| e.id == r["id"].as_str().unwrap_or("")).map(|e| e.kind.clone());
            summarize_diagnostics(arr(&r["diagnostics"]), kind.is_none_or(|k| k.iter().any(|x| x == "lint")))
        })
        .collect();
    let (resolved, missing): (Vec<Resolved>, Vec<Resolved>) = input.engines.iter().cloned().partition(|e| !e.missing);
    let structural_matches = arr(&input.structural["matches"]).to_vec();
    let parts = Parts {
        ok: succeeded,
        status,
        action: input.action.clone(),
        scope: input.scope.clone(),
        languages: input.languages.clone(),
        language_source: input.language_source.clone(),
        resolved,
        missing,
        policy: input.policy.clone(),
        results: input.results.clone(),
        result_summaries: summaries,
        rolled: rollup_engine_counts(&results),
        structural: input.structural.clone(),
        structural_summary: summarize_diagnostics(&structural_matches, true),
        function_length: if run { input.function_length.clone() } else { Value::Null },
        shadows: if run { Vec::new() } else { input.shadows.clone().unwrap_or_default() },
        working_tree: input.working_tree.clone(),
        pass_errors,
        rules: input.rules.clone(),
        installed: input.installed.clone(),
        needs_approval: input.needs_approval.clone(),
        errors: input.errors.clone(),
        notes,
        elapsed_ms: input.elapsed_ms,
        page_offset: input.offset,
    };
    let mut caps = vec![start_cap];
    caps.extend(TRIM_STEPS.iter().copied().filter(|s| *s < start_cap));
    let mut report = compose(&parts, caps[0]);
    if engine_truncated {
        report["truncated"] = json!(true);
    }
    for cap in &caps[1..] {
        if report.to_string().len() <= input.max_bytes {
            return report;
        }
        report = compose(&parts, *cap);
        report["truncated"] = json!(true);
    }
    report
}

/// The environment header describes the run itself, so a `results` page leaves it out.
fn environment_header(parts: &Parts, action: &str) -> Map<String, Value> {
    let mut m = Map::new();
    if !is_run_action(action) {
        let shape = |e: &Resolved| if action == "scan" { shape_engine(e) } else { brief_engine(&shape_engine(e)) };
        put(&mut m, "languages", json!(parts.languages));
        put_if(&mut m, !parts.language_source.is_empty(), "languageSource", || json!(parts.language_source));
        put(&mut m, "engines", json!(parts.resolved.iter().map(shape).collect::<Vec<_>>()));
        put_if(&mut m, !parts.missing.is_empty(), "missing", || json!(parts.missing.iter().map(shape).collect::<Vec<_>>()));
        put_if(&mut m, !parts.policy.is_null(), "policy", || parts.policy.clone());
        return m;
    }
    let ran: Vec<&Resolved> = parts.resolved.iter().filter(|e| e.skipped.is_none()).collect();
    let covered: Vec<&String> = ran.iter().flat_map(|e| e.languages.iter()).collect();
    let in_scope: Vec<&str> = parts.languages.iter().filter_map(|l| l["id"].as_str()).collect();
    let uncovered: Vec<Value> = parts
        .missing
        .iter()
        .filter(|e| e.languages.iter().any(|l| (in_scope.is_empty() || in_scope.contains(&l.as_str())) && !covered.contains(&l)))
        .map(|e| brief_engine(&shape_engine(e)))
        .collect();
    put(&mut m, "engines", json!(ran.iter().map(|e| brief_engine(&shape_engine(e))).collect::<Vec<_>>()));
    put_if(&mut m, !uncovered.is_empty(), "missing", || json!(uncovered));
    m
}

/// One report shape at a given diagnostic cap; optional sections appear only when they carry something.
fn compose(parts: &Parts, cap: usize) -> Value {
    let action = parts.action.as_str();
    let file_paging = if action == "results" { (cap, parts.page_offset) } else { (FILE_LIST_CAP, 0) };
    let working_tree = if parts.working_tree.is_null() { None } else { Some(shape_working_tree(&parts.working_tree, FILE_LIST_CAP.min(cap))) };
    let results = parts.results.as_deref();
    let totals = results.filter(|r| r.len() > 1).and_then(|_| non_zero_counts(&parts.rolled));
    let structural_matches = arr(&parts.structural["matches"]).len();
    let paged = parts.page_offset > 0
        || results.is_some_and(|rs| rs.iter().any(|r| arr(&r["diagnostics"]).len() > cap || arr(&r["filesChanged"]).len() > file_paging.0))
        || structural_matches > cap;
    let mut m = Map::new();
    put(&mut m, "ok", json!(parts.ok));
    put(&mut m, "status", json!(parts.status));
    put(&mut m, "action", json!(action));
    // Check/fix scope is the caller's own paths; the other actions name it.
    put_if(&mut m, !parts.scope.is_null() && !is_run_action(action), "scope", || parts.scope.clone());
    if action != "results" {
        m.extend(environment_header(parts, action));
    }
    put_if(&mut m, !parts.shadows.is_empty(), "shadows", || json!(parts.shadows));
    if let Some(rs) = results {
        put(&mut m, "results", json!(rs.iter().enumerate().map(|(i, r)| shape_engine_result(r, &parts.result_summaries[i], cap, parts.page_offset, file_paging)).collect::<Vec<_>>()));
    }
    put_if(&mut m, totals.is_some(), "counts", || totals.clone().unwrap_or(Value::Null));
    put_if(&mut m, !parts.structural.is_null(), "structural", || shape_structural(&parts.structural, &parts.structural_summary, &parts.pass_errors, cap, parts.page_offset));
    if let Some(w) = working_tree.filter(|w| w.as_object().is_some_and(|o| !o.is_empty())) {
        put(&mut m, "workingTree", w);
    }
    put_if(&mut m, !parts.function_length.is_null(), "functionLength", || parts.function_length.clone());
    put_if(&mut m, paged, "paging", || json!({"offset": parts.page_offset, "limit": cap}));
    put_if(&mut m, !parts.rules.is_null(), "rules", || parts.rules.clone());
    put_if(&mut m, !parts.installed.is_null(), "installed", || parts.installed.clone());
    put_if(&mut m, !parts.needs_approval.is_null(), "needsApproval", || parts.needs_approval.clone());
    put_if(&mut m, !parts.errors.is_empty(), "errors", || json!(parts.errors));
    put_if(&mut m, !parts.notes.is_empty(), "notes", || json!(parts.notes));
    put(&mut m, "elapsedMs", json!(parts.elapsed_ms));
    Value::Object(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diag(file: &str, line: i64, code: &str, sev: &str, fixable: bool) -> Value {
        json!({"file": file, "line": line, "col": 1, "code": code, "message": format!("{code} message"), "severity": sev, "fixable": fixable})
    }

    fn engine(id: &str, kind: &[&str], langs: &[&str], missing: bool) -> Resolved {
        Resolved { id: id.into(), kind: kind.iter().map(|s| (*s).into()).collect(), languages: langs.iter().map(|s| (*s).into()).collect(), source: if missing { "missing" } else { "path" }.into(), missing, install_hint: "hint".into(), ..Default::default() }
    }

    fn run_input(results: Vec<Value>, limit: usize) -> ReportInput {
        ReportInput { action: "check".into(), engines: vec![engine("biome", &["format", "lint"], &["typescript"], false)], results: Some(results), limit, ..Default::default() }
    }

    #[test]
    fn rows_are_compacted_against_their_rule_summary_and_paged() {
        let rows: Vec<Value> = (1..=5).map(|n| diag("src/a.ts", n, "noVar", if n == 5 { "error" } else { "warning" }, n % 2 == 0)).collect();
        let r = build_tidy_report(run_input(vec![json!({"id": "biome", "filesChecked": 3, "diagnostics": rows})], 2));
        let res = &r["results"][0];
        assert_eq!((res["diagnosticsCount"].clone(), res["more"].clone(), res["nextOffset"].clone()), (json!(5), json!(3), json!(2)));
        // The rule's top severity is error, so a warning row states its own; the message is the rule's.
        assert_eq!(res["diagnostics"][0], json!({"loc": "src/a.ts:1:1", "rule": "noVar", "severity": "warning"}));
        assert_eq!(res["diagnostics"][1]["fix"], true);
        assert_eq!(res["byRule"]["noVar"], json!({"count": 5, "severity": "error", "fixable": 2, "message": "noVar message"}), "the highest severity wins");
        assert_eq!(res["byDir"], json!({"src": 5}));
        assert_eq!(r["paging"], json!({"offset": 0, "limit": 2}));
        assert_eq!((r["ok"].clone(), r["status"].clone()), (json!(true), json!("complete")));
        assert!(r.get("engines").is_some() && r.get("languages").is_none(), "run actions carry only the engines that ran");
    }

    #[test]
    fn a_report_over_budget_trims_samples_but_keeps_counts() {
        let rows: Vec<Value> = (1..=60).map(|n| diag(&format!("src/dir{n}/file.ts"), n, "rule", "warning", false)).collect();
        let mut input = run_input(vec![json!({"id": "biome", "filesChecked": 60, "diagnostics": rows})], 100);
        input.max_bytes = 1500;
        let r = build_tidy_report(input);
        assert_eq!(r["truncated"], true);
        let res = &r["results"][0];
        assert_eq!(res["diagnosticsCount"], 60);
        assert!(res["diagnostics"].as_array().unwrap().len() < 60);
        assert_eq!(res["byRule"]["rule"]["count"], 60);
    }

    #[test]
    fn failures_and_partial_writes_set_the_status() {
        let mut input = run_input(vec![json!({"id": "biome", "filesChecked": 1, "error": "boom"})], 20);
        assert_eq!(build_tidy_report(ReportInput { results: input.results.clone(), engines: vec![], action: "check".into(), ..Default::default() })["status"], "failed");
        input.action = "fix".into();
        input.results = Some(vec![json!({"id": "biome", "filesChecked": 1, "error": "boom", "filesChanged": ["a.ts"], "applied": false})]);
        assert_eq!(build_tidy_report(input)["status"], "partial", "an engine that wrote before failing is partial");
        let structural = json!({"adapter": "graph-binary", "matches": [], "applied": [], "errors": [{"language": "go", "kind": "rules", "message": "bad"}]});
        let r = build_tidy_report(ReportInput { action: "check".into(), structural, results: Some(vec![]), ..Default::default() });
        assert_eq!(r["status"], "partial");
        let notes = r["notes"].as_array().unwrap();
        assert!(notes.iter().any(|n| n == "go structural pass did not complete; see structural.errors"));
        assert!(notes.iter().any(|n| n.as_str().unwrap().contains("structural apply blocked")));
    }

    #[test]
    fn scan_reports_resolved_and_missing_engines_and_shadow_notes() {
        let input = ReportInput {
            action: "scan".into(),
            languages: vec![json!({"id": "typescript", "files": 3})],
            language_source: "git".into(),
            engines: vec![engine("biome", &["lint"], &["typescript"], false), engine("ruff", &["lint"], &["python"], true)],
            shadows: Some(vec![json!({"id": "biome", "bin": "biome", "via": "path", "shadow": {"path": "/x/biome", "version": "1.0"}, "engine": {"source": "managed", "path": "/m/biome"}})]),
            ..Default::default()
        };
        let r = build_tidy_report(input);
        assert_eq!(r["engines"][0]["id"], "biome");
        assert_eq!(r["missing"][0]["installHint"], "hint");
        assert_eq!(r["shadows"].as_array().unwrap().len(), 1);
        assert!(r["notes"][0].as_str().unwrap().contains("biome on PATH is /x/biome (1.0)"));
        assert_eq!(r["languageSource"], "git");
    }

    #[test]
    fn run_headers_name_uncovered_languages_only_and_totals_need_two_engines() {
        let mut input = run_input(vec![json!({"id": "biome", "filesChecked": 1, "counts": {"diagnostics": 2}}), json!({"id": "ruff", "filesChecked": 1, "counts": {"diagnostics": 3, "filesToFormat": 0}})], 20);
        input.engines.push(engine("ruff", &["lint"], &["python"], true));
        input.languages = vec![json!({"id": "typescript", "files": 1}), json!({"id": "python", "files": 1})];
        let r = build_tidy_report(input);
        assert_eq!(r["missing"][0]["id"], "ruff", "python is in scope and no running engine covers it");
        assert_eq!(r["counts"], json!({"diagnostics": 5}));
        let one = build_tidy_report(run_input(vec![json!({"id": "biome", "filesChecked": 1, "counts": {"diagnostics": 2}})], 20));
        assert!(one.get("counts").is_none() && one["results"][0]["counts"] == json!({"diagnostics": 2}));
    }

    #[test]
    fn the_tool_result_envelope_flags_errors() {
        let ok = tidy_tool_result(&json!({"ok": true}), None);
        assert!(ok.get("isError").is_none() && ok["content"][0]["text"] == "{\"ok\":true}");
        assert_eq!(tidy_tool_result(&json!({"ok": false}), None)["isError"], true);
        assert!(tidy_tool_result(&json!({"ok": false}), Some(false)).get("isError").is_none());
        let wt = shape_working_tree(&json!({"clean": {"files": ["a", "b"], "findings": 3}, "modified": {"files": []}}), 1);
        assert_eq!(wt, json!({"clean": {"files": ["a"], "more": 1, "fileCount": 2, "findings": 3}}));
    }
}
