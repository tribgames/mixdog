//! What the agent's `github` tool shows the model (`src/runtime/github/tool.mjs`, b6f10295a): the REST response reduced to its
//! decision fields (API-only URLs and node ids dropped, users and nested repositories named by login / full_name), lists as
//! compact rows, issue and pull-request views with a capped body, and every result within the output cap. JavaScript's
//! semantics are kept where the text depends on them: lengths count UTF-16 units, `||` and `&&` read truthiness, a field whose
//! value is `undefined` is left out of the JSON.

use serde_json::Map;
use serde_json::Value;

/// `GITHUB_OUTPUT_MAX_BYTES` (`shared/tool-output-limit.mjs`): the bytes of the text one result may take.
pub const OUTPUT_MAX_BYTES: usize = 10 * 1024;
const MIN_CLAMPED_STRING: usize = 200;
const EXCERPT_MAX: usize = 140;
const BODY_MAX: usize = 1500;
const MAX_VIEW_DEPTH: usize = 4;

const KEPT_URL_KEYS: [&str; 4] = ["html_url", "browser_download_url", "target_url", "details_url"];
const DROPPED_KEYS: [&str; 8] = [
    "url",
    "node_id",
    "_links",
    "gravatar_id",
    "performed_via_github_app",
    "author_association",
    "sub_issues_summary",
    "issue_dependencies_summary",
];
const USER_KEYS: [&str; 11] = ["user", "owner", "assignee", "merged_by", "actor", "triggering_actor", "author", "uploader", "sender", "closed_by", "creator"];
const USER_LIST_KEYS: [&str; 2] = ["assignees", "requested_reviewers"];

fn units(text: &str) -> usize {
    mixdog_js::utf16_len(text)
}

fn head(text: &str, count: usize) -> String {
    mixdog_js::slice_utf16(text, count)
}

/// JavaScript truthiness of a field (`undefined` is `None`).
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `value || undefined`.
fn or_undefined(value: Option<&Value>) -> Option<Value> {
    truthy(value).then(|| value.cloned()).flatten()
}

/// `value.key` (`value?.key`): only an object has the field.
fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value?.as_object()?.get(key)
}

/// An object whose `undefined` fields are left out, as `JSON.stringify` writes it.
struct Fields(Map<String, Value>);

impl Fields {
    fn new() -> Self {
        Self(Map::new())
    }

    fn put(mut self, key: &str, value: Option<Value>) -> Self {
        if let Some(value) = value {
            self.0.insert(key.to_owned(), value);
        }
        self
    }

    fn done(self) -> Value {
        Value::Object(self.0)
    }
}

/// `userLogin`.
fn user_login(value: Option<&Value>) -> Option<String> {
    let object = value?.as_object()?;
    let login = object.get("login")?.as_str()?;
    match object.get("type") {
        Some(kind) if truthy(Some(kind)) && kind.as_str() != Some("User") => Some(format!("{login} ({})", mixdog_js::value_to_string(kind))),
        _ => Some(login.to_owned()),
    }
}

/// `userLogin(value)` where its answer is used as a truthy value.
fn truthy_login(value: &Value) -> Option<Value> {
    user_login(Some(value)).filter(|login| !login.is_empty()).map(Value::String)
}

/// `login`.
fn login(value: Option<&Value>) -> Option<Value> {
    user_login(value).map(Value::String).or_else(|| value.filter(|value| value.is_string()).cloned())
}

fn is_nested_repository(key: Option<&str>, parent: Option<&str>) -> bool {
    matches!(key, Some("head_repository" | "repository")) || (key == Some("repo") && matches!(parent, Some("head" | "base")))
}

fn is_empty_reactions(value: &Value) -> bool {
    value.as_object().is_some_and(|reactions| reactions.values().all(|item| item.as_f64().is_none_or(|n| n == 0.0)))
}

/// `reduceGithubData`.
pub fn reduce(value: &Value, key: Option<&str>, parent: Option<&str>) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| key.filter(|key| USER_LIST_KEYS.contains(key)).and_then(|_| truthy_login(item)).unwrap_or_else(|| reduce(item, None, key)))
                .collect(),
        ),
        Value::Object(object) => {
            if let Some(login) = key.filter(|key| USER_KEYS.contains(key)).and_then(|_| truthy_login(value)) {
                return login;
            }
            if is_nested_repository(key, parent)
                && let Some(Value::String(name)) = object.get("full_name")
            {
                return Value::String(name.clone());
            }
            let numbered = matches!(object.get("number"), Some(Value::Number(_)));
            let mut reduced = Map::new();
            for name in mixdog_js::js_object_keys(object) {
                let item = &object[name];
                let dropped = DROPPED_KEYS.contains(&name.as_str())
                    || name.ends_with("node_id")
                    || (name.ends_with("_url") && !KEPT_URL_KEYS.contains(&name.as_str()));
                // Numbered objects (issues, PRs, milestones) are addressed by number; their id is noise.
                if dropped || (name == "id" && numbered) || (name == "reactions" && is_empty_reactions(item)) {
                    continue;
                }
                reduced.insert(name.clone(), reduce(item, Some(name), key));
            }
            Value::Object(reduced)
        }
        other => other.clone(),
    }
}

fn day(value: Option<&Value>) -> Option<Value> {
    value?.as_str().map(|text| Value::String(head(text, 10)))
}

/// `excerpt`: whitespace runs as one space, trimmed, at most 140 units with an ellipsis.
fn excerpt(value: Option<&Value>) -> Option<Value> {
    let body = value?.as_str()?;
    let mut collapsed = String::with_capacity(body.len());
    let mut in_space = false;
    for c in body.chars() {
        if mixdog_js::is_js_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    let text = mixdog_js::js_trim(&collapsed);
    if text.is_empty() {
        return None;
    }
    Some(Value::String(if units(text) > EXCERPT_MAX { format!("{}…", head(text, EXCERPT_MAX - 1)) } else { text.to_owned() }))
}

fn label_names(value: Option<&Value>) -> Option<Value> {
    let names: Vec<Value> = value
        .and_then(Value::as_array)
        .map(|labels| {
            labels
                .iter()
                .filter_map(|label| if label.is_string() { Some(label.clone()) } else { field(Some(label), "name").cloned() })
                .filter(|name| truthy(Some(name)))
                .collect()
        })
        .unwrap_or_default();
    (!names.is_empty()).then_some(Value::Array(names))
}

fn logins(value: Option<&Value>) -> Option<Value> {
    let names: Vec<Value> = value
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|item| login(Some(item))).filter(|name| truthy(Some(name))).collect())
        .unwrap_or_default();
    (!names.is_empty()).then_some(Value::Array(names))
}

fn stamp(value: Option<&Value>) -> Option<Value> {
    value.filter(|value| value.is_string()).cloned()
}

fn repo_name(value: Option<&Value>) -> Option<Value> {
    match value {
        Some(Value::String(name)) => Some(Value::String(name.clone())),
        other => field(other, "full_name").cloned(),
    }
}

/// `a || b`.
fn either<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    if truthy(first) { first } else { second }
}

/// The number of an issue or pull request a notification's subject URL names.
fn subject_number(subject: Option<&Value>) -> Option<Value> {
    let url = field(subject, "url").filter(|url| truthy(Some(url))).map(mixdog_js::value_to_string).unwrap_or_default();
    let digits = ["/issues/", "/pulls/"].iter().find_map(|kind| {
        let (_, tail) = url.rsplit_once(kind)?;
        (!tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit())).then(|| tail.to_owned())
    })?;
    let number: f64 = digits.parse().ok()?;
    (number != 0.0).then(|| serde_json::Number::from_f64(number).map(Value::Number)).flatten()
}

fn project_row(action: &str, item: &Value) -> Option<Value> {
    let get = |key: &str| field(Some(item), key);
    let cloned = |key: &str| get(key).cloned();
    Some(match action {
        "issue.list" => Fields::new()
            .put("number", cloned("number"))
            .put("title", cloned("title"))
            .put("state", cloned("state"))
            .put("author", login(get("user")))
            .put("updated", day(get("updated_at")))
            .put("labels", label_names(get("labels")))
            .put("comments", or_undefined(get("comments")))
            .put("excerpt", excerpt(get("body")))
            .done(),
        "pr.list" => Fields::new()
            .put("number", cloned("number"))
            .put("title", cloned("title"))
            .put("state", if truthy(get("merged_at")) { Some(Value::String("merged".into())) } else { cloned("state") })
            .put("draft", or_undefined(get("draft")))
            .put("author", login(get("user")))
            .put("updated", day(get("updated_at")))
            .put("head", field(get("head"), "ref").cloned())
            .put("base", field(get("base"), "ref").cloned())
            .put("labels", label_names(get("labels")))
            .put("excerpt", excerpt(get("body")))
            .done(),
        "repo.list" => Fields::new()
            .put("name", cloned("full_name"))
            .put("description", excerpt(get("description")))
            .put(
                "visibility",
                or_undefined(get("visibility")).or_else(|| Some(Value::String(if truthy(get("private")) { "private" } else { "public" }.into()))),
            )
            .put("language", or_undefined(get("language")))
            .put("fork", or_undefined(get("fork")))
            .put("archived", or_undefined(get("archived")))
            .put("updated", day(either(get("pushed_at"), get("updated_at"))))
            .done(),
        "run.list" => Fields::new()
            .put("id", cloned("id"))
            .put("name", either(get("display_title"), get("name")).cloned())
            .put("workflow", cloned("name"))
            .put("status", cloned("status"))
            .put("conclusion", or_undefined(get("conclusion")))
            .put("branch", cloned("head_branch"))
            .put("event", cloned("event"))
            .put("actor", login(get("actor")))
            .put("updated", day(get("updated_at")))
            .done(),
        "release.list" => Fields::new()
            .put("id", cloned("id"))
            .put("tag", cloned("tag_name"))
            .put("name", or_undefined(get("name")))
            .put("draft", or_undefined(get("draft")))
            .put("prerelease", or_undefined(get("prerelease")))
            .put("author", login(get("author")))
            .put("published", day(either(get("published_at"), get("created_at"))))
            .done(),
        "notification.list" => Fields::new()
            .put("id", cloned("id"))
            .put("unread", cloned("unread"))
            .put("reason", cloned("reason"))
            .put("type", field(get("subject"), "type").cloned())
            .put("title", field(get("subject"), "title").cloned())
            .put("number", subject_number(get("subject")))
            .put("repo", repo_name(get("repository")))
            .put("updated", day(get("updated_at")))
            .done(),
        "workflow.list" => Fields::new().put("id", cloned("id")).put("name", cloned("name")).put("path", cloned("path")).put("state", cloned("state")).done(),
        _ => return None,
    })
}

/// `projectList`.
pub fn project_list(action: &str, data: &Value) -> Option<Value> {
    let rows = data.as_array()?;
    project_row(action, &Value::Null)?;
    Some(Value::Array(rows.iter().map(|row| project_row(action, row).expect("a list projector")).collect()))
}

/// `bodyText`: CRLF as LF, trimmed, at most 1500 units (never half a surrogate pair) with what was cut counted.
fn body_text(value: Option<&Value>) -> Option<Value> {
    let body = value?.as_str()?.replace("\r\n", "\n");
    let text = mixdog_js::js_trim(&body);
    if text.is_empty() {
        return None;
    }
    let length = units(text);
    if length <= BODY_MAX {
        return Some(Value::String(text.to_owned()));
    }
    let high = text.encode_utf16().nth(BODY_MAX - 1).is_some_and(|unit| (0xd800..=0xdbff).contains(&unit));
    let cut = if high { BODY_MAX - 1 } else { BODY_MAX };
    Some(Value::String(format!("{}… {} more chars in raw", head(text, cut), length - cut)))
}

/// `pr.head && { … }`: the value itself when it is falsy.
fn when_truthy(value: Option<&Value>, build: impl FnOnce(Option<&Value>) -> Value) -> Option<Value> {
    if truthy(value) { Some(build(value)) } else { value.cloned() }
}

/// `projectView`.
pub fn project_view(action: &str, data: &Value) -> Option<Value> {
    data.as_object()?;
    let get = |key: &str| field(Some(data), key);
    let cloned = |key: &str| get(key).cloned();
    Some(match action {
        "pr.view" => Fields::new()
            .put("number", cloned("number"))
            .put("title", cloned("title"))
            .put("state", cloned("state"))
            .put("draft", cloned("draft"))
            .put("merged", cloned("merged"))
            .put("mergeable", cloned("mergeable"))
            .put("mergeable_state", cloned("mergeable_state"))
            .put("user", login(get("user")))
            .put("labels", label_names(get("labels")))
            .put("assignees", logins(get("assignees")))
            .put("requested_reviewers", logins(get("requested_reviewers")))
            .put(
                "head",
                when_truthy(get("head"), |head| {
                    Fields::new()
                        .put("ref", field(head, "ref").cloned())
                        .put("sha", field(head, "sha").cloned())
                        .put("repo", repo_name(field(head, "repo")))
                        .done()
                }),
            )
            .put("base", when_truthy(get("base"), |base| Fields::new().put("ref", field(base, "ref").cloned()).put("sha", field(base, "sha").cloned()).done()))
            .put("commits", cloned("commits"))
            .put("additions", cloned("additions"))
            .put("deletions", cloned("deletions"))
            .put("changed_files", cloned("changed_files"))
            .put("comments", cloned("comments"))
            .put("review_comments", cloned("review_comments"))
            .put("html_url", cloned("html_url"))
            .put("created_at", stamp(get("created_at")))
            .put("updated_at", stamp(get("updated_at")))
            .put("closed_at", stamp(get("closed_at")))
            .put("merged_at", stamp(get("merged_at")))
            .put("body", body_text(get("body")))
            .done(),
        "issue.view" => Fields::new()
            .put("number", cloned("number"))
            .put("title", cloned("title"))
            .put("state", cloned("state"))
            .put("state_reason", or_undefined(get("state_reason")))
            .put("user", login(get("user")))
            .put("labels", label_names(get("labels")))
            .put("assignees", logins(get("assignees")))
            .put("milestone", field(get("milestone"), "title").cloned())
            .put("comments", cloned("comments"))
            .put("html_url", cloned("html_url"))
            .put("created_at", stamp(get("created_at")))
            .put("updated_at", stamp(get("updated_at")))
            .put("closed_at", stamp(get("closed_at")))
            .put("body", body_text(get("body")))
            .done(),
        _ => return None,
    })
}

/// `rowsWereCut`: a row whose text was shortened (ends with "…") needs raw for the rest.
pub fn rows_were_cut(rows: &[Value]) -> bool {
    rows.iter().any(|row| row.as_object().is_some_and(|row| row.values().any(|value| value.as_str().is_some_and(|text| text.ends_with('…')))))
}

pub fn fits(text: &str) -> bool {
    text.len() <= OUTPUT_MAX_BYTES
}

fn stringify(value: &Map<String, Value>) -> String {
    mixdog_js::json_stringify(&Value::Object(value.clone()))
}

/// `{ ...result, data, ...extra }`.
fn with_data(result: &Map<String, Value>, data: Value, extra: &[(&str, String)]) -> String {
    let mut object = result.clone();
    object.insert("data".to_owned(), data);
    for (key, value) in extra {
        object.insert((*key).to_owned(), Value::String(value.clone()));
    }
    stringify(&object)
}

fn clamp_strings(value: &Value, max: usize) -> Value {
    match value {
        Value::String(text) => {
            let length = units(text);
            Value::String(if length > max { format!("{}… [{} more chars in raw]", head(text, max), length - max) } else { text.clone() })
        }
        Value::Array(items) => Value::Array(items.iter().map(|item| clamp_strings(item, max)).collect()),
        Value::Object(object) => Value::Object(object.iter().map(|(key, item)| (key.clone(), clamp_strings(item, max))).collect()),
        other => other.clone(),
    }
}

fn longest_string(value: &Value) -> usize {
    match value {
        Value::String(text) => units(text),
        Value::Array(items) => items.iter().map(longest_string).max().unwrap_or(0),
        Value::Object(object) => object.values().map(longest_string).max().unwrap_or(0),
        _ => 0,
    }
}

/// `clampToFit`: the largest uniform string length that fits; long bodies shrink before structure.
fn clamp_to_fit(build: impl Fn(Value) -> String, data: &Value, result: &Map<String, Value>) -> String {
    let (mut lo, mut hi) = (MIN_CLAMPED_STRING, MIN_CLAMPED_STRING.max(longest_string(data)));
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if fits(&build(clamp_strings(data, mid))) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    let text = build(clamp_strings(data, lo));
    if fits(&text) { text } else { structural_view(result, data) }
}

fn bounded_view(value: &Value, count: usize, depth: usize) -> Value {
    match value {
        Value::String(_) => clamp_strings(value, MIN_CLAMPED_STRING),
        Value::Array(_) | Value::Object(_) if depth >= MAX_VIEW_DEPTH => Value::String("[nested data omitted; see raw]".into()),
        Value::Array(items) => {
            let mut shown: Vec<Value> = items.iter().take(count).map(|item| bounded_view(item, count, depth + 1)).collect();
            if items.len() > count {
                shown.push(Value::String(format!("… {} more items in raw", items.len() - count)));
            }
            Value::Array(shown)
        }
        Value::Object(object) => Value::Object(object.iter().map(|(key, item)| (key.clone(), bounded_view(item, count, depth + 1))).collect()),
        other => other.clone(),
    }
}

fn longest_array(value: &Value) -> usize {
    match value {
        Value::Array(items) => items.iter().map(longest_array).fold(items.len(), usize::max),
        Value::Object(object) => object.values().map(longest_array).max().unwrap_or(0),
        _ => 0,
    }
}

/// `structuralView`: the largest per-array item count whose structural view fits; the minimal form only points at raw.
fn structural_view(result: &Map<String, Value>, data: &Value) -> String {
    let build = |count: usize| {
        with_data(
            result,
            bounded_view(data, count, 0),
            &[
                ("shown", format!("structural view: first {count} items of each nested list, strings cut to {MIN_CLAMPED_STRING} chars")),
                ("omitted", "remaining list items, long text and deeply nested fields are in raw; read them there".into()),
            ],
        )
    };
    if !fits(&build(0)) {
        let mut minimal = Map::new();
        minimal.insert("shown".into(), Value::String("no data fits the output limit".into()));
        minimal.insert("omitted".into(), Value::String("the whole result is in raw; read it there".into()));
        if let Some(raw) = result.get("raw") {
            minimal.insert("raw".into(), raw.clone());
        }
        return stringify(&minimal);
    }
    let (mut lo, mut hi) = (0, longest_array(data));
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if fits(&build(mid)) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    build(lo)
}

/// `capRecords`: long bodies shrink first so the page overview stays complete; only then are trailing records left to raw.
fn cap_records(result: &Map<String, Value>, data: &[Value]) -> String {
    let total = data.len();
    let build = |records: Value, count: usize| {
        let extra = if count < total {
            vec![
                ("shown", format!("records 1-{count} of {total} on this page")),
                ("omitted", format!("records {}-{total} of this page are in raw; read them there before changing page or limit", count + 1)),
            ]
        } else {
            Vec::new()
        };
        with_data(result, records, &extra)
    };
    let (mut lo, mut hi) = (1, total);
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if fits(&build(clamp_strings(&Value::Array(data[..mid].to_vec()), MIN_CLAMPED_STRING), mid)) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    let shown = Value::Array(data[..lo.min(total)].to_vec());
    clamp_to_fit(|records| build(records, lo), &shown, result)
}

/// `capText`: the tail of a log, from a line start, with the line range stated.
fn cap_text(result: &Map<String, Value>, text: &str, args: &Value) -> String {
    let code: Vec<u16> = text.encode_utf16().collect();
    let newline = u16::from(b'\n');
    let total = code.iter().filter(|unit| **unit == newline).count() + 1;
    let refetch = args.get("action").and_then(Value::as_str) == Some("run.logs") && !truthy(args.get("failed"));
    let build = |start: usize| {
        let first = code[..start].iter().filter(|unit| **unit == newline).count() + 1;
        with_data(
            result,
            Value::String(String::from_utf16_lossy(&code[start..])),
            &[
                ("shown", format!("lines {first}-{total} of {total}")),
                ("omitted", format!("lines before {first} are in raw{}", if refetch { "; failed:true refetches only failed jobs" } else { "" })),
            ],
        )
    };
    let (mut lo, mut hi) = (0, code.len());
    while lo < hi {
        let mid = (lo + hi) / 2;
        if fits(&build(mid)) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    let mut start = lo;
    let line_start = (start > 0 && code[start - 1] != newline).then(|| code[start..].iter().position(|unit| *unit == newline).map(|at| start + at)).flatten();
    match line_start {
        Some(at) if at + 1 < code.len() => start = at + 1,
        _ if code.get(start).is_some_and(|unit| (0xdc00..=0xdfff).contains(unit)) => start += 1,
        _ => {}
    }
    build(start)
}

/// `capGithubResult`.
pub fn cap_result(result: &Map<String, Value>, args: &Value) -> String {
    match result.get("data") {
        Some(Value::String(text)) => cap_text(result, text, args),
        Some(Value::Array(rows)) => cap_records(result, rows),
        data => {
            let data = data.cloned().unwrap_or(Value::Null);
            clamp_to_fit(|value| with_data(result, value, &[]), &data, result)
        }
    }
}
