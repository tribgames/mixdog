//! Input validation for the `prompt` methods: the prompt content, submit options, abort options and new-task draft that
//! `thread/start` (`initialInput`, `draft`), `turn/start` (`input`) and `turn/interrupt` carry. Each check is the desktop
//! host's own (`ipc-validation.ts` `requiredPromptContent`, `requiredSubmitOptions`, `requiredAbortOptions`,
//! `requiredNewTaskDraft`), with its limits and its exact message, applied to the protocol's params and to every origin.
//! A field the protocol carries as `null` is absent, as the typed params decode it.

use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::utf16_len;
use serde_json::Map;
use serde_json::Value;

use crate::error::ErrorData;

type Checked = Result<(), ErrorData>;

const MAX_PROMPT_LENGTH: usize = 1_000_000;
const MAX_PROMPT_PARTS: usize = 32;
const MAX_PROMPT_IMAGES: usize = 8;
const MAX_PROMPT_FILES: usize = 8;
const MAX_PROMPT_IMAGE_BASE64_LENGTH: usize = 16_000_000;
const MAX_PROMPT_IMAGE_BASE64_TOTAL: usize = 30_000_000;
const MAX_PROMPT_FILE_BASE64_LENGTH: usize = 28_000_000;
const MAX_PROMPT_FILE_BASE64_TOTAL: usize = 28_000_000;
const MAX_PROMPT_FILE_MIME_LENGTH: usize = 128;
const MAX_STRUCTURED_NODES: usize = 20_000;
const MAX_STRUCTURED_DEPTH: usize = 12;
const MAX_STRUCTURED_ENTRIES: usize = 5_000;
const MAX_STRUCTURED_STRING_TOTAL: usize = 32_000_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// The keys `requiredSubmitOptions` knows (`id` is the protocol's `clientSubmissionId`; the retry ids are the protocol's own).
const SUBMIT_OPTION_KEYS: &[&str] = &[
    "clientSubmissionId",
    "submittedAt",
    "displayText",
    "goalCommand",
    "retryFailedTurn",
    "retryTurnId",
    "retryAttemptId",
    "priority",
    "pastedImages",
    "pastedTexts",
    "kickoff",
];
const NEW_TASK_DRAFT_KEYS: &[&str] = &["projectPath", "route", "workflowId", "orchestrationMode", "worktree"];
const NEW_TASK_WORKTREE_KEYS: &[&str] = &["confirmLarge", "branch", "create", "fromDefault"];

/// `None`: this group does not own `method`.
pub fn check(method: &str, params: Option<&Value>) -> Option<Result<(), ErrorData>> {
    let owned = matches!(method, "thread/start" | "turn/start" | "turn/interrupt");
    owned.then(|| match params.and_then(Value::as_object) {
        Some(params) => check_params(method, params),
        None => Ok(()),
    })
}

fn check_params(method: &str, params: &Map<String, Value>) -> Checked {
    match method {
        // The host read `submitNewTask(prompt, options, draft)` in that order.
        "thread/start" => {
            if let Some(input) = present(params, "initialInput") {
                turn_input(input, "/initialInput")?;
            }
            match present(params, "draft") {
                Some(draft) => new_task_draft(draft, "/draft"),
                None => Ok(()),
            }
        }
        "turn/start" => match present(params, "input") {
            Some(input) => turn_input(input, "/input"),
            None => Ok(()),
        },
        _ => abort_options(params),
    }
}

fn invalid(path: &str, expected: &str) -> ErrorData {
    ErrorData::InvalidParams { path: path.to_owned(), expected: expected.to_owned() }
}

/// The field when it is set: absent and `null` are the same.
fn present<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    object.get(key).filter(|value| !value.is_null())
}

fn require_allowed_keys(object: &Map<String, Value>, allowed: &[&str], path: &str, name: &str) -> Checked {
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid(path, &format!("{name} contains an unsupported field.")));
    }
    Ok(())
}

/// `requiredString`: a string whose trimmed text is not empty and at most `maximum` UTF-16 units; the trimmed text.
fn required_string<'a>(value: &'a Value, path: &str, name: &str, maximum: usize) -> Result<&'a str, ErrorData> {
    let Some(text) = value.as_str() else {
        return Err(invalid(path, &format!("{name} must be a string.")));
    };
    let text = js_trim(text);
    if text.is_empty() || utf16_len(text) > maximum {
        return Err(invalid(path, &format!("{name} is invalid.")));
    }
    Ok(text)
}

fn has_control_character(text: &str) -> bool {
    text.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}

struct StructuredState {
    strings: usize,
    nodes: usize,
}

/// `validateStructuredValue` of `capability-request.ts`.
fn validate_structured(value: &Value, state: &mut StructuredState, depth: usize, path: &str) -> Checked {
    state.nodes += 1;
    if state.nodes > MAX_STRUCTURED_NODES || depth > MAX_STRUCTURED_DEPTH {
        return Err(invalid(path, "structured input is too large."));
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
        Value::String(text) => {
            state.strings += utf16_len(text);
            if state.strings > MAX_STRUCTURED_STRING_TOTAL {
                return Err(invalid(path, "structured input is too large."));
            }
            Ok(())
        }
        Value::Array(entries) => {
            if entries.len() > MAX_STRUCTURED_ENTRIES {
                return Err(invalid(path, "structured input contains too many entries."));
            }
            entries.iter().try_for_each(|entry| validate_structured(entry, state, depth + 1, path))
        }
        Value::Object(fields) => {
            if fields.len() > MAX_STRUCTURED_ENTRIES {
                return Err(invalid(path, "structured input contains too many fields."));
            }
            for (key, entry) in fields {
                if matches!(key.as_str(), "__proto__" | "prototype" | "constructor") {
                    return Err(invalid(path, "structured input contains an invalid field."));
                }
                validate_structured(entry, state, depth + 1, path)?;
            }
            Ok(())
        }
    }
}

/// `^[A-Za-z0-9+/]*={0,2}$`.
fn is_base64(text: &str) -> bool {
    let body = text.trim_end_matches('=');
    text.len() - body.len() <= 2 && body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

/// `^image/(?:png|jpe?g|gif|webp)$` on the lowercased type.
fn is_prompt_image_mime(mime: &str) -> bool {
    matches!(mime, "image/png" | "image/jpg" | "image/jpeg" | "image/gif" | "image/webp")
}

fn turn_input(input: &Value, path: &str) -> Checked {
    let Some(input) = input.as_object() else {
        return Ok(());
    };
    prompt_content(input.get("prompt"), &format!("{path}/prompt"))?;
    match present(input, "options") {
        Some(options) => submit_options(options, &format!("{path}/options")),
        None => Ok(()),
    }
}

/// A part's inline bytes (base64 within `maximum`), or, with none, the stored attachment it names.
fn part_data<'a>(
    part: &'a Map<String, Value>,
    path: &str,
    maximum: usize,
    expected: &str,
) -> Result<Option<&'a str>, ErrorData> {
    let stored = present(part, "attachmentRef").and_then(Value::as_str).is_some_and(|reference| !reference.is_empty());
    match present(part, "data") {
        None if stored => Ok(None),
        Some(Value::String(data)) if !data.is_empty() && utf16_len(data) <= maximum && is_base64(data) => Ok(Some(data)),
        _ => Err(invalid(&format!("{path}/data"), expected)),
    }
}

/// `requiredPromptContent`.
fn prompt_content(value: Option<&Value>, path: &str) -> Checked {
    let parts = match value {
        Some(Value::String(text)) => {
            if js_trim(text).is_empty() || utf16_len(text) > MAX_PROMPT_LENGTH {
                return Err(invalid(path, "prompt is invalid."));
            }
            return Ok(());
        }
        Some(Value::Array(parts)) if !parts.is_empty() && parts.len() <= MAX_PROMPT_PARTS => parts,
        _ => return Err(invalid(path, "prompt content is invalid.")),
    };
    let (mut text_length, mut image_length, mut image_count, mut file_length, mut file_count) = (0, 0, 0, 0, 0);
    let mut has_content = false;
    for (index, entry) in parts.iter().enumerate() {
        let part_path = format!("{path}/{index}");
        let Some(part) = entry.as_object() else {
            return Err(invalid(&part_path, "prompt part is invalid."));
        };
        let stored = present(part, "attachmentRef").is_some();
        match part.get("type").and_then(Value::as_str) {
            Some("text") => match present(part, "text") {
                // A stored text attachment has no text.
                None => has_content |= stored,
                Some(Value::String(text)) => {
                    text_length += utf16_len(text);
                    if text_length > MAX_PROMPT_LENGTH {
                        return Err(invalid(&format!("{part_path}/text"), "prompt text is too large."));
                    }
                    has_content |= stored || !js_trim(text).is_empty();
                }
                Some(_) => return Err(invalid(&format!("{part_path}/text"), "prompt text part is invalid.")),
            },
            Some("image") => {
                image_count += 1;
                if image_count > MAX_PROMPT_IMAGES {
                    return Err(invalid(&part_path, "too many prompt images."));
                }
                let mime_path = format!("{part_path}/mimeType");
                let mime = js_to_lowercase(required_string(
                    part.get("mimeType").unwrap_or(&Value::Null),
                    &mime_path,
                    "image mime type",
                    64,
                )?);
                if !is_prompt_image_mime(&mime) {
                    return Err(invalid(&mime_path, "image type is unsupported."));
                }
                let data = part_data(part, &part_path, MAX_PROMPT_IMAGE_BASE64_LENGTH, "image data is invalid.")?;
                image_length += data.map_or(0, utf16_len);
                if image_length > MAX_PROMPT_IMAGE_BASE64_TOTAL {
                    return Err(invalid(&part_path, "prompt images are too large."));
                }
                has_content = true;
            }
            Some("file") => {
                file_count += 1;
                if file_count > MAX_PROMPT_FILES {
                    return Err(invalid(&part_path, "too many prompt files."));
                }
                // The host refused every type but PDF and Office documents; the runtime reads any inline file by
                // its content and a phone sends other types (`text/plain`), so only the type's shape is checked.
                required_string(
                    part.get("mimeType").unwrap_or(&Value::Null),
                    &format!("{part_path}/mimeType"),
                    "file mime type",
                    MAX_PROMPT_FILE_MIME_LENGTH,
                )?;
                let data = part_data(part, &part_path, MAX_PROMPT_FILE_BASE64_LENGTH, "file data is invalid.")?;
                file_length += data.map_or(0, utf16_len);
                if file_length > MAX_PROMPT_FILE_BASE64_TOTAL {
                    return Err(invalid(&part_path, "prompt files are too large."));
                }
                has_content = true;
            }
            _ => return Err(invalid(&format!("{part_path}/type"), "prompt part type is unsupported.")),
        }
    }
    if !has_content {
        return Err(invalid(path, "prompt is empty."));
    }
    Ok(())
}

/// The office types a file part may name, in their canonical case (`OFFICE_MIME_TYPES`, `shared/prompt-limits.ts`).
const OFFICE_MIME_TYPES: [&str; 7] = [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroEnabled.12",
    "application/msword",
    "application/vnd.ms-powerpoint",
    "application/vnd.ms-excel",
];

/// `canonicalPromptFileMimeType` (`shared/prompt-limits.ts`): the canonical-case type of a PDF or office document, its
/// parameters ignored; `None` for any other type. The one implementation every crate that shapes a file part uses.
pub fn canonical_prompt_file_mime(mime: &str) -> Option<&'static str> {
    let base = js_to_lowercase(js_trim(mime.split(';').next().unwrap_or_default()));
    if base == "application/pdf" {
        return Some("application/pdf");
    }
    OFFICE_MIME_TYPES.into_iter().find(|candidate| js_to_lowercase(candidate) == base)
}

/// `Number.isSafeInteger(n) && n > 0`.
fn is_positive_safe_integer(number: &serde_json::Number) -> bool {
    if let Some(n) = number.as_u64() {
        return (1..=MAX_SAFE_INTEGER).contains(&n);
    }
    number.as_f64().is_some_and(|n| n.fract() == 0.0 && n >= 1.0 && n <= MAX_SAFE_INTEGER as f64)
}

/// `requiredSubmitOptions`.
fn submit_options(value: &Value, path: &str) -> Checked {
    let Some(input) = value.as_object() else {
        return Err(invalid(path, "submit options are invalid."));
    };
    validate_structured(value, &mut StructuredState { strings: 0, nodes: 0 }, 0, path)?;
    require_allowed_keys(input, SUBMIT_OPTION_KEYS, path, "submit options")?;
    let at = |key: &str| format!("{path}/{key}");
    if let Some(id) = present(input, "clientSubmissionId") {
        let ok = id
            .as_str()
            .is_some_and(|id| !js_trim(id).is_empty() && utf16_len(id) <= 256 && !has_control_character(id));
        if !ok {
            return Err(invalid(&at("clientSubmissionId"), "submit id is invalid."));
        }
    }
    if present(input, "submittedAt").is_some_and(|n| !matches!(n, Value::Number(n) if is_positive_safe_integer(n))) {
        return Err(invalid(&at("submittedAt"), "submit timestamp is invalid."));
    }
    for (key, expected) in
        [("retryFailedTurn", "submit retryFailedTurn is invalid."), ("kickoff", "submit kickoff is invalid.")]
    {
        if present(input, key).is_some_and(|flag| !flag.is_boolean()) {
            return Err(invalid(&at(key), expected));
        }
    }
    if present(input, "priority").is_some_and(|priority| !matches!(priority.as_str(), Some("now" | "next" | "later"))) {
        return Err(invalid(&at("priority"), "submit priority is invalid."));
    }
    if present(input, "displayText").is_some_and(|text| !text.as_str().is_some_and(|t| utf16_len(t) <= MAX_PROMPT_LENGTH)) {
        return Err(invalid(&at("displayText"), "submit display text is invalid."));
    }
    let goal_ok = |command: &Value| {
        command.as_str().is_some_and(|text| !js_trim(text).is_empty() && utf16_len(text) <= MAX_PROMPT_LENGTH)
    };
    if present(input, "goalCommand").is_some_and(|command| !goal_ok(command)) {
        return Err(invalid(&at("goalCommand"), "goal command is invalid."));
    }
    Ok(())
}

/// `requiredAbortOptions`, on the fields `turn/interrupt` carries.
fn abort_options(params: &Map<String, Value>) -> Checked {
    if present(params, "restorePrompt").is_some_and(|flag| !flag.is_boolean()) {
        return Err(invalid("/restorePrompt", "abort restorePrompt is invalid."));
    }
    match present(params, "submissionId") {
        Some(id) => required_string(id, "/submissionId", "abort submission id", 1_024).map(drop),
        None => Ok(()),
    }
}

/// `requiredNewTaskDraft`. The route is held to `requiredModelSelection` (the model group's `model_selection`).
fn new_task_draft(value: &Value, path: &str) -> Checked {
    let Some(input) = value.as_object() else {
        return Err(invalid(path, "new task draft is invalid."));
    };
    validate_structured(value, &mut StructuredState { strings: 0, nodes: 0 }, 0, path)?;
    require_allowed_keys(input, NEW_TASK_DRAFT_KEYS, path, "new task draft")?;
    let at = |key: &str| format!("{path}/{key}");
    if let Some(project) = present(input, "projectPath") {
        required_string(project, &at("projectPath"), "projectPath", 32_768)?;
    }
    if let Some(route) = present(input, "route") {
        super::model::model_selection(route, &at("route"))?;
    }
    if let Some(workflow) = present(input, "workflowId") {
        required_string(workflow, &at("workflowId"), "workflowId", 256)?;
    }
    if present(input, "orchestrationMode")
        .is_some_and(|mode| !matches!(mode.as_str(), Some("none" | "focused" | "balanced" | "swarm")))
    {
        return Err(invalid(&at("orchestrationMode"), "orchestrationMode is invalid."));
    }
    match present(input, "worktree") {
        Some(worktree) => new_task_worktree(worktree, &at("worktree")),
        None => Ok(()),
    }
}

fn new_task_worktree(value: &Value, path: &str) -> Checked {
    let Some(record) = value.as_object() else {
        return Err(invalid(path, "worktree is invalid."));
    };
    require_allowed_keys(record, NEW_TASK_WORKTREE_KEYS, path, "new task worktree")?;
    let at = |key: &str| format!("{path}/{key}");
    if present(record, "confirmLarge").is_some_and(|flag| !flag.is_boolean()) {
        return Err(invalid(&at("confirmLarge"), "worktree.confirmLarge must be a boolean."));
    }
    if present(record, "fromDefault").is_some_and(|flag| !flag.is_boolean()) {
        return Err(invalid(&at("fromDefault"), "worktree.fromDefault must be a boolean."));
    }
    let branch = match present(record, "branch") {
        Some(branch) => Some(required_string(branch, &at("branch"), "worktree.branch", 32_768)?),
        None => None,
    };
    if present(record, "create").is_some_and(|create| !create.is_boolean() || branch.is_none()) {
        return Err(invalid(&at("create"), "worktree.create requires a branch and must be a boolean."));
    }
    Ok(())
}

#[cfg(test)]
mod validate_prompt {
    use serde::Deserialize;
    use serde_json::Value;

    use super::*;

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Row {
        case: String,
        method: String,
        params: Value,
        /// `null` for an accepted row.
        path: Option<String>,
        expected: Option<String>,
    }

    #[derive(Deserialize)]
    struct Accepted {
        method: String,
        // A notification row (`initialized`) has no params.
        #[serde(default)]
        params: Value,
        source: String,
        case: String,
    }

    fn rows() -> Vec<Row> {
        serde_json::from_str(include_str!("fixtures/prompt.json")).expect("fixtures/prompt.json")
    }

    #[test]
    fn fixture_rows_match() {
        let rows = rows();
        assert!(!rows.is_empty());
        for row in &rows {
            let got = check(&row.method, Some(&row.params)).expect("the group owns the method");
            match (&row.path, &row.expected) {
                (None, None) => assert_eq!(got, Ok(()), "{}", row.case),
                (Some(path), Some(expected)) => assert_eq!(
                    got,
                    Err(ErrorData::InvalidParams { path: path.clone(), expected: expected.clone() }),
                    "{}",
                    row.case
                ),
                _ => panic!("{}: path and expected go together", row.case),
            }
        }
    }

    /// Every refusal of the source range has a row.
    #[test]
    fn every_refusal_has_a_row() {
        let rows = rows();
        for message in [
            "prompt is invalid.",
            "prompt content is invalid.",
            "prompt part is invalid.",
            "prompt text part is invalid.",
            "too many prompt images.",
            "image mime type is invalid.",
            "image type is unsupported.",
            "image data is invalid.",
            "too many prompt files.",
            "file mime type is invalid.",
            "file data is invalid.",
            "prompt part type is unsupported.",
            "prompt is empty.",
            "submit options are invalid.",
            "submit options contains an unsupported field.",
            "submit id is invalid.",
            "submit timestamp is invalid.",
            "submit retryFailedTurn is invalid.",
            "submit kickoff is invalid.",
            "submit priority is invalid.",
            "submit display text is invalid.",
            "goal command is invalid.",
            "abort restorePrompt is invalid.",
            "abort submission id is invalid.",
            "new task draft is invalid.",
            "new task draft contains an unsupported field.",
            "projectPath is invalid.",
            "workflowId is invalid.",
            "orchestrationMode is invalid.",
            "worktree is invalid.",
            "new task worktree contains an unsupported field.",
            "worktree.confirmLarge must be a boolean.",
            "worktree.fromDefault must be a boolean.",
            "worktree.branch is invalid.",
            "worktree.create requires a branch and must be a boolean.",
            "structured input is too large.",
            "structured input contains an invalid field.",
        ] {
            assert!(rows.iter().any(|row| row.expected.as_deref() == Some(message)), "no refuse row for `{message}`");
        }
    }

    /// A row a client sends today is accepted (owner direction 3).
    #[test]
    fn every_client_row_is_accepted() {
        let rows: Vec<Accepted> =
            serde_json::from_str(include_str!("fixtures/clients-accepted.json")).expect("clients-accepted.json");
        let mut seen = 0;
        for row in rows {
            if let Some(got) = check(&row.method, Some(&row.params)) {
                assert_eq!(got, Ok(()), "{} ({}, {})", row.method, row.case, row.source);
                seen += 1;
            }
        }
        assert!(seen > 20, "the corpus holds the rows of this group");
    }

    /// The limits a fixture file cannot carry (their rows would be tens of megabytes), built here.
    #[test]
    fn large_inputs_keep_the_limits() {
        let turn = |prompt: Value, options: Value| {
            serde_json::json!({"threadId": "t", "opId": "o", "input": {"prompt": prompt, "options": options}})
        };
        let text = |n: usize| "a".repeat(n);
        let accepted = |params: Value| assert_eq!(check("turn/start", Some(&params)), Some(Ok(())));
        let refused = |params: Value, path: &str, expected: &str| {
            let want = Err(ErrorData::InvalidParams { path: path.to_owned(), expected: expected.to_owned() });
            assert_eq!(check("turn/start", Some(&params)), Some(want), "{expected}");
        };
        accepted(turn(text(1_000_000).into(), Value::Null));
        refused(turn(text(1_000_001).into(), Value::Null), "/input/prompt", "prompt is invalid.");
        // The limit counts UTF-16 units: 500,000 rockets fit, one more does not.
        accepted(turn("\u{1F680}".repeat(500_000).into(), Value::Null));
        refused(turn("\u{1F680}".repeat(500_001).into(), Value::Null), "/input/prompt", "prompt is invalid.");
        let texts = |a: usize, b: usize| {
            turn(serde_json::json!([{"type": "text", "text": text(a)}, {"type": "text", "text": text(b)}]), Value::Null)
        };
        accepted(texts(600_000, 400_000));
        refused(texts(600_000, 400_001), "/input/prompt/1/text", "prompt text is too large.");
        let image = |n: usize| serde_json::json!({"type": "image", "mimeType": "image/png", "data": text(n)});
        refused(turn(serde_json::json!([image(16_000_004)]), Value::Null), "/input/prompt/0/data", "image data is invalid.");
        refused(
            turn(serde_json::json!([image(16_000_000), image(14_000_000), image(4)]), Value::Null),
            "/input/prompt/2",
            "prompt images are too large.",
        );
        let file = |n: usize| serde_json::json!({"type": "file", "mimeType": "application/pdf", "data": text(n)});
        refused(turn(serde_json::json!([file(28_000_004)]), Value::Null), "/input/prompt/0/data", "file data is invalid.");
        refused(
            turn(serde_json::json!([file(20_000_000), file(8_000_004)]), Value::Null),
            "/input/prompt/1",
            "prompt files are too large.",
        );
        accepted(turn("a".into(), serde_json::json!({"displayText": text(1_000_000)})));
        refused(
            turn("a".into(), serde_json::json!({"displayText": text(1_000_001)})),
            "/input/options/displayText",
            "submit display text is invalid.",
        );
        refused(
            turn("a".into(), serde_json::json!({"goalCommand": text(1_000_001)})),
            "/input/options/goalCommand",
            "goal command is invalid.",
        );
        let pasted: serde_json::Map<String, Value> =
            (0..33).map(|i| (i.to_string(), serde_json::json!({"text": text(1_000_000)}))).collect();
        refused(
            turn("a".into(), serde_json::json!({"pastedTexts": pasted})),
            "/input/options",
            "structured input is too large.",
        );
    }

    /// The draft's route is held to `requiredModelSelection`, not only to being an object.
    #[test]
    fn draft_route_is_a_model_selection() {
        let draft = |route: Value| {
            serde_json::json!({"kind": "task", "opId": "0190f3c2-7a31-7c00-8000-000000000900", "draft": {"route": route}})
        };
        assert_eq!(check("thread/start", Some(&draft(serde_json::json!({"provider": "p", "contextTokens": 8})))), Some(Ok(())));
        let want = |path: &str, expected: &str| Some(Err(ErrorData::InvalidParams { path: path.to_owned(), expected: expected.to_owned() }));
        assert_eq!(
            check("thread/start", Some(&draft(serde_json::json!({"extra": 1})))),
            want("/draft/route", "model selection contains an unsupported field.")
        );
        assert_eq!(
            check("thread/start", Some(&draft(serde_json::json!({"contextTokens": 0})))),
            want("/draft/route/contextTokens", "selection.contextTokens must be a positive integer.")
        );
    }
}

#[cfg(test)]
mod canonical_file_mime {
    use super::canonical_prompt_file_mime;

    #[test]
    fn pdf_and_office_types_take_their_canonical_case_and_lose_parameters() {
        assert_eq!(canonical_prompt_file_mime(" Application/PDF ; charset=x"), Some("application/pdf"));
        assert_eq!(canonical_prompt_file_mime("APPLICATION/MSWORD"), Some("application/msword"));
        assert_eq!(
            canonical_prompt_file_mime("application/vnd.ms-excel.sheet.macroenabled.12"),
            Some("application/vnd.ms-excel.sheet.macroEnabled.12")
        );
    }

    #[test]
    fn any_other_type_is_none() {
        assert_eq!(canonical_prompt_file_mime("text/plain"), None);
    }
}
