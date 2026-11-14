//! Input validation for the `workspace_names` methods: display names (project alias, session title), the file search
//! limit, transcript windows and history pages, the message count, text file content, the LSP document
//! and request, workspace writes, search options and folders. Each rule is the one the desktop main process applied
//! to the same input (`ipc-validation.ts`), with its exact message, so a client sees the same refusal whichever side
//! decides. Lengths are UTF-16 units and trimming is JavaScript's, as there.
//!
//! A method's JSON-valued field (`alias`, `files`, `options`, `request`, ...) that is an empty object `{}` is the
//! field's shape placeholder, which the clients corpus sends and every client's own params decode accepts; it passes.

use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::nodepath::resolve_host;
use mixdog_js::utf16_len;
use serde_json::Map;
use serde_json::Value;

use crate::error::ErrorData;

const PROJECT_ALIAS_MAX: usize = 120;
const SESSION_TITLE_MAX: usize = 1_024;
const FILE_SEARCH_LIMIT_MAX: f64 = 200.0;
const TRANSCRIPT_HISTORY_PAGE_ITEMS: f64 = 512.0;
const MESSAGE_COUNT_MAX: f64 = 10_000_000.0;
const MAX_TEXT_FILE_LENGTH: usize = 4_194_304;
const WORKSPACE_SEARCH_LIMIT_MAX: f64 = 5_000.0;
const WORKSPACE_WRITE_FILES_MAX: usize = 100;
const WORKSPACE_FOLDERS_MAX: usize = 64;
const SAFE_INTEGER_MAX: f64 = 9_007_199_254_740_991.0;
const STRUCTURED_NODES_MAX: usize = 20_000;
const STRUCTURED_DEPTH_MAX: usize = 12;
const STRUCTURED_ENTRIES_MAX: usize = 5_000;
const STRUCTURED_STRING_TOTAL_MAX: usize = 32_000_000;
const REQUIRED_STRING_MAX: usize = 32_768;

const LSP_DOCUMENT_KEYS: &[&str] = &["kind", "projectPath", "relPath", "languageId", "version", "content"];
const LSP_REQUEST_KEYS: &[&str] = &["projectPath", "relPath", "languageId", "method", "params"];
const WORKSPACE_WRITE_KEYS: &[&str] = &["relPath", "content", "expectedContent"];
const WORKSPACE_SEARCH_KEYS: &[&str] = &["query", "include", "exclude", "matchCase", "wholeWord", "regex", "maxResults"];

/// The language-server methods a client may request.
const LSP_REQUEST_METHODS: &[&str] = &[
    "textDocument/completion",
    "completionItem/resolve",
    "textDocument/signatureHelp",
    "textDocument/hover",
    "textDocument/definition",
    "textDocument/typeDefinition",
    "textDocument/declaration",
    "textDocument/implementation",
    "textDocument/references",
    "textDocument/documentHighlight",
    "textDocument/linkedEditingRange",
    "textDocument/documentSymbol",
    "textDocument/codeLens",
    "codeLens/resolve",
    "textDocument/prepareRename",
    "textDocument/rename",
    "textDocument/codeAction",
    "codeAction/resolve",
    "textDocument/formatting",
    "textDocument/rangeFormatting",
    "textDocument/onTypeFormatting",
    "textDocument/documentLink",
    "documentLink/resolve",
    "textDocument/documentColor",
    "textDocument/colorPresentation",
    "textDocument/foldingRange",
    "textDocument/selectionRange",
    "textDocument/semanticTokens/full",
    "textDocument/semanticTokens/full/delta",
    "textDocument/semanticTokens/range",
    "textDocument/inlayHint",
    "inlayHint/resolve",
    "textDocument/prepareCallHierarchy",
    "callHierarchy/incomingCalls",
    "callHierarchy/outgoingCalls",
    "workspace/symbol",
    "workspace/executeCommand",
];

type Verdict = Result<(), ErrorData>;

fn refuse(path: &str, expected: &str) -> ErrorData {
    ErrorData::InvalidParams { path: path.to_owned(), expected: expected.to_owned() }
}

/// `None`: this group does not own `method`.
pub fn check(method: &str, params: Option<&Value>) -> Option<Verdict> {
    let verdict: fn(&Map<String, Value>) -> Verdict = match method {
        "project/update" => project_update,
        "thread/name/set" => thread_name_set,
        "thread/read" => thread_read,
        "thread/items/list" => thread_items_list,
        "search/start" => search_start,
        "thread/readState/update" => read_state_update,
        "projectFs/writeText" => write_text,
        "projectFs/writeTextBatch" => write_text_batch,
        "projectFs/searchText" | "projectFs/replaceText" => search_options,
        "projectFs/workspaceFile/write" => workspace_file_write,
        "lsp/document" => lsp_document,
        "lsp/request" => lsp_request,
        _ => return None,
    };
    Some(match params {
        Some(Value::Object(fields)) => verdict(fields),
        _ => Ok(()),
    })
}

// ---- scalars, as JavaScript reads them -----------------------------------------------------------------------------

fn is_placeholder(value: &Value) -> bool {
    matches!(value, Value::Object(fields) if fields.is_empty())
}

/// `Number.isInteger`.
fn integer(value: &Value) -> Option<f64> {
    let float = value.as_number()?.as_f64()?;
    (float.is_finite() && float.fract() == 0.0).then_some(float)
}

/// `Number.isSafeInteger`.
fn safe_integer(value: &Value) -> Option<f64> {
    integer(value).filter(|float| float.abs() <= SAFE_INTEGER_MAX)
}

/// An integer within `[low, high]`.
fn integer_within(value: &Value, low: f64, high: f64) -> bool {
    integer(value).is_some_and(|number| number >= low && number <= high)
}

/// `hasControlCharacter`: a C0 control character or DEL.
fn has_control_character(text: &str) -> bool {
    text.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}

/// `requiredString(value, name, maximum)` of the shared argument rules: a string whose trimmed form is not empty and not
/// longer than `maximum`.
fn required_string(value: Option<&Value>, path: &str, name: &str, maximum: usize) -> Verdict {
    let Some(Value::String(text)) = value else {
        return Err(refuse(path, &format!("{name} must be a string.")));
    };
    let text = js_trim(text);
    if text.is_empty() || utf16_len(text) > maximum {
        return Err(refuse(path, &format!("{name} is invalid.")));
    }
    Ok(())
}

fn allowed_keys(fields: &Map<String, Value>, allowed: &[&str], path: &str, name: &str) -> Verdict {
    if fields.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(refuse(path, &format!("{name} contains an unsupported field.")));
    }
    Ok(())
}

/// A string within the 4 MiB ceiling of every text lane (`requiredTextFileContent`).
fn within_text_ceiling(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::String(text)) if utf16_len(text) <= MAX_TEXT_FILE_LENGTH)
}

fn text_file_content(value: Option<&Value>, path: &str, name: &str) -> Verdict {
    if within_text_ceiling(value) { Ok(()) } else { Err(refuse(path, &format!("{name} is invalid."))) }
}

// ---- names, limits, transcript -------------------------------------------------------------------------------------

fn project_update(params: &Map<String, Value>) -> Verdict {
    let Some(alias) = params.get("alias") else { return Ok(()) };
    if is_placeholder(alias) {
        return Ok(());
    }
    let Value::String(text) = alias else {
        return Err(refuse("/alias", "alias must be a string."));
    };
    let text = js_trim(text);
    if utf16_len(text) > PROJECT_ALIAS_MAX || has_control_character(text) {
        return Err(refuse("/alias", "alias is invalid."));
    }
    Ok(())
}

fn thread_name_set(params: &Map<String, Value>) -> Verdict {
    let Some(title) = params.get("title") else { return Ok(()) };
    let Value::String(text) = title else {
        return Err(refuse("/title", "title must be a string."));
    };
    let text = js_trim(text);
    if text.is_empty() || utf16_len(text) > SESSION_TITLE_MAX || has_control_character(text) {
        return Err(refuse("/title", "title is invalid."));
    }
    Ok(())
}

/// `requiredTranscriptItemLimit`: absent or null keeps the window; a count is a safe integer of at least 1 (a larger one
/// is held at the window ceiling by the reader, not refused).
fn thread_read(params: &Map<String, Value>) -> Verdict {
    let Some(Value::Object(window)) = params.get("window") else { return Ok(()) };
    match window.get("lastItems") {
        None | Some(Value::Null) => Ok(()),
        Some(value) if safe_integer(value).is_some_and(|count| count >= 1.0) => Ok(()),
        Some(_) => Err(refuse("/window/lastItems", "transcript item limit is invalid.")),
    }
}

/// `requiredTranscriptHistoryRequest`: a page of at most 512 rows and an optional positive byte budget.
fn thread_items_list(params: &Map<String, Value>) -> Verdict {
    const EXPECTED: &str = "transcript history request is invalid.";
    if let Some(limit) = params.get("limit").filter(|value| !value.is_null()) {
        if !integer_within(limit, 1.0, TRANSCRIPT_HISTORY_PAGE_ITEMS) {
            return Err(refuse("/limit", EXPECTED));
        }
    }
    if let Some(budget) = params.get("byteBudget").filter(|value| !value.is_null()) {
        if !safe_integer(budget).is_some_and(|bytes| bytes >= 1.0) {
            return Err(refuse("/byteBudget", EXPECTED));
        }
    }
    Ok(())
}

/// `requiredFileSearchLimit`: absent keeps the default of 50; else an integer of 1 to 200.
fn search_start(params: &Map<String, Value>) -> Verdict {
    match params.get("limit") {
        None | Some(Value::Null) => Ok(()),
        Some(value) if integer_within(value, 1.0, FILE_SEARCH_LIMIT_MAX) => Ok(()),
        Some(_) => Err(refuse("/limit", "limit is invalid.")),
    }
}

fn read_state_update(params: &Map<String, Value>) -> Verdict {
    match params.get("messageCount") {
        None => Ok(()),
        Some(value) if integer_within(value, 0.0, MESSAGE_COUNT_MAX) => Ok(()),
        Some(_) => Err(refuse("/messageCount", "session message count is invalid.")),
    }
}

// ---- text files, workspace writes, search, folders -----------------------------------------------------------------

fn write_text(params: &Map<String, Value>) -> Verdict {
    if let Some(content) = params.get("content") {
        text_file_content(Some(content), "/content", "file content")?;
    }
    if let Some(expected) = params.get("expectedContent") {
        text_file_content(Some(expected), "/expectedContent", "expected file content")?;
    }
    Ok(())
}

/// `requiredWorkspaceTextWrites`.
fn write_text_batch(params: &Map<String, Value>) -> Verdict {
    let Some(files) = params.get("files") else { return Ok(()) };
    if is_placeholder(files) {
        return Ok(());
    }
    let rows = match files {
        Value::Array(rows) if !rows.is_empty() && rows.len() <= WORKSPACE_WRITE_FILES_MAX => rows,
        _ => return Err(refuse("/files", "Workspace edit files are invalid.")),
    };
    for (index, row) in rows.iter().enumerate() {
        let at = format!("/files/{index}");
        let Value::Object(record) = row else {
            return Err(refuse(&at, "Workspace edit file is invalid."));
        };
        allowed_keys(record, WORKSPACE_WRITE_KEYS, &at, "Workspace edit file")?;
        if !within_text_ceiling(record.get("content")) || !within_text_ceiling(record.get("expectedContent")) {
            return Err(refuse(&at, "Workspace edit file content is invalid."));
        }
        required_string(record.get("relPath"), &format!("{at}/relPath"), "relPath", 4_096)?;
    }
    Ok(())
}

/// `requiredWorkspaceSearchOptions`.
fn search_options(params: &Map<String, Value>) -> Verdict {
    let Some(options) = params.get("options") else { return Ok(()) };
    if is_placeholder(options) {
        return Ok(());
    }
    let Value::Object(input) = options else {
        return Err(refuse("/options", "Workspace search options are invalid."));
    };
    allowed_keys(input, WORKSPACE_SEARCH_KEYS, "/options", "Workspace search options")?;
    required_string(input.get("query"), "/options/query", "search query", 4_096)?;
    match input.get("maxResults") {
        None => Ok(()),
        Some(value) if integer_within(value, 1.0, WORKSPACE_SEARCH_LIMIT_MAX) => Ok(()),
        Some(_) => Err(refuse("/options/maxResults", "maxResults is invalid.")),
    }
}

/// `requiredWorkspaceFolders`: at most 64 folders with a path each, no two the same once resolved (case-folded on Windows).
fn workspace_file_write(params: &Map<String, Value>) -> Verdict {
    let Some(folders) = params.get("folders") else { return Ok(()) };
    if is_placeholder(folders) {
        return Ok(());
    }
    let rows = match folders {
        Value::Array(rows) if rows.len() <= WORKSPACE_FOLDERS_MAX => rows,
        _ => return Err(refuse("/folders", "Workspace folders are invalid.")),
    };
    let mut seen: Vec<String> = Vec::with_capacity(rows.len());
    for (index, row) in rows.iter().enumerate() {
        let at = format!("/folders/{index}");
        let Value::Object(record) = row else {
            return Err(refuse(&at, "Workspace folder is invalid."));
        };
        let value = record.get("path");
        required_string(value, &format!("{at}/path"), "workspace folder path", 16_384)?;
        let Some(Value::String(text)) = value else { continue };
        let resolved = resolve_host(&[js_trim(text)]);
        let key = if cfg!(windows) { js_to_lowercase(&resolved) } else { resolved };
        if seen.contains(&key) {
            return Err(refuse("/folders", "Workspace folders must be unique."));
        }
        seen.push(key);
    }
    Ok(())
}

// ---- language server -----------------------------------------------------------------------------------------------

/// The `projectPath` every LSP call names.
fn lsp_project_path(params: &Map<String, Value>) -> Verdict {
    match params.get("projectPath") {
        None => Ok(()),
        value => required_string(value, "/projectPath", "projectPath", REQUIRED_STRING_MAX),
    }
}

/// `requiredLspDocumentInput`.
fn lsp_document(params: &Map<String, Value>) -> Verdict {
    lsp_project_path(params)?;
    let Some(document) = params.get("document") else { return Ok(()) };
    if is_placeholder(document) {
        return Ok(());
    }
    let Value::Object(input) = document else {
        return Err(refuse("/document", "LSP document input is invalid."));
    };
    allowed_keys(input, LSP_DOCUMENT_KEYS, "/document", "LSP document input")?;
    if !matches!(input.get("kind"), Some(Value::String(kind)) if matches!(kind.as_str(), "open" | "change" | "save" | "close")) {
        return Err(refuse("/document/kind", "LSP document kind is invalid."));
    }
    if !input.get("version").and_then(integer).is_some_and(|version| version >= 0.0) {
        return Err(refuse("/document/version", "LSP document version is invalid."));
    }
    if let Some(content) = input.get("content") {
        if !within_text_ceiling(Some(content)) {
            return Err(refuse("/document/content", "LSP document content is invalid."));
        }
    }
    if let Some(project_path) = input.get("projectPath") {
        required_string(Some(project_path), "/document/projectPath", "projectPath", REQUIRED_STRING_MAX)?;
    }
    required_string(input.get("relPath"), "/document/relPath", "relPath", 4_096)?;
    required_string(input.get("languageId"), "/document/languageId", "languageId", 64)
}

/// `requiredLspRequestInput`.
fn lsp_request(params: &Map<String, Value>) -> Verdict {
    lsp_project_path(params)?;
    let Some(request) = params.get("request") else { return Ok(()) };
    if is_placeholder(request) {
        return Ok(());
    }
    let Value::Object(input) = request else {
        return Err(refuse("/request", "LSP request input is invalid."));
    };
    allowed_keys(input, LSP_REQUEST_KEYS, "/request", "LSP request input")?;
    let method = input.get("method");
    required_string(method, "/request/method", "LSP method", 128)?;
    if !matches!(method, Some(Value::String(name)) if LSP_REQUEST_METHODS.contains(&js_trim(name))) {
        return Err(refuse("/request/method", "LSP method is unavailable."));
    }
    if let Some(body) = input.get("params") {
        if !body.is_object() {
            return Err(refuse("/request/params", "LSP params are invalid."));
        }
        let mut state = Structured { strings: 0, nodes: 0 };
        structured_value(body, &mut state, 0).map_err(|expected| refuse("/request/params", expected))?;
    }
    if let Some(project_path) = input.get("projectPath") {
        required_string(Some(project_path), "/request/projectPath", "projectPath", REQUIRED_STRING_MAX)?;
    }
    required_string(input.get("relPath"), "/request/relPath", "relPath", 4_096)?;
    required_string(input.get("languageId"), "/request/languageId", "languageId", 64)
}

struct Structured {
    strings: usize,
    nodes: usize,
}

/// `validateStructuredValue`: bounded size and depth, and no prototype-polluting key.
fn structured_value(value: &Value, state: &mut Structured, depth: usize) -> Result<(), &'static str> {
    state.nodes += 1;
    if state.nodes > STRUCTURED_NODES_MAX || depth > STRUCTURED_DEPTH_MAX {
        return Err("structured input is too large.");
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
        Value::String(text) => {
            state.strings += utf16_len(text);
            if state.strings > STRUCTURED_STRING_TOTAL_MAX {
                return Err("structured input is too large.");
            }
            Ok(())
        }
        Value::Array(entries) => {
            if entries.len() > STRUCTURED_ENTRIES_MAX {
                return Err("structured input contains too many entries.");
            }
            entries.iter().try_for_each(|entry| structured_value(entry, state, depth + 1))
        }
        Value::Object(entries) => {
            if entries.len() > STRUCTURED_ENTRIES_MAX {
                return Err("structured input contains too many fields.");
            }
            for (key, entry) in entries {
                if matches!(key.as_str(), "__proto__" | "prototype" | "constructor") {
                    return Err("structured input contains an invalid field.");
                }
                structured_value(entry, state, depth + 1)?;
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[derive(serde::Deserialize)]
    struct Row {
        case: String,
        method: String,
        params: Value,
        expected: Option<Expected>,
    }

    #[derive(serde::Deserialize)]
    struct Expected {
        path: String,
        expected: String,
    }

    #[derive(serde::Deserialize)]
    struct Accepted {
        client: String,
        method: String,
        // A notification row (`initialized`) has no params.
        #[serde(default)]
        params: Value,
    }

    fn verdict(method: &str, params: &Value) -> Verdict {
        check(method, Some(params)).expect("the group owns the method")
    }

    fn refused(method: &str, params: Value) -> (String, String) {
        match verdict(method, &params) {
            Err(ErrorData::InvalidParams { path, expected }) => (path, expected),
            other => panic!("{method}: expected a refusal, got {other:?}"),
        }
    }

    fn fixture_rows() -> Vec<Row> {
        serde_json::from_str(include_str!("fixtures/workspace_names.json")).expect("fixture rows")
    }

    #[test]
    fn validate_workspace_names_fixture_rows_match() {
        let rows = fixture_rows();
        assert!(!rows.is_empty());
        for row in rows {
            let got = verdict(&row.method, &row.params);
            match (&row.expected, got) {
                (None, Ok(())) => {}
                (Some(want), Err(ErrorData::InvalidParams { path, expected })) => {
                    assert_eq!((&want.path, &want.expected), (&path, &expected), "{}: {}", row.method, row.case);
                }
                (want, got) => panic!("{}: {}: expected refusal {}, got {:?}", row.method, row.case, want.is_some(), got),
            }
        }
    }

    /// Every method this group owns has a refuse row and an accept row in the fixture.
    #[test]
    fn validate_workspace_names_fixture_covers_every_method() {
        let rows = fixture_rows();
        for method in [
            "project/update",
            "thread/name/set",
            "thread/read",
            "thread/items/list",
            "search/start",
            "thread/readState/update",
            "projectFs/writeText",
            "projectFs/writeTextBatch",
            "projectFs/searchText",
            "projectFs/replaceText",
            "projectFs/workspaceFile/write",
            "lsp/document",
            "lsp/request",
        ] {
            assert!(rows.iter().any(|row| row.method == method && row.expected.is_some()), "{method}: no refuse row");
            assert!(rows.iter().any(|row| row.method == method && row.expected.is_none()), "{method}: no accept row");
        }
    }

    /// Everything the clients send for these methods is accepted (TUI, phone, desktop, protocol-client).
    #[test]
    fn validate_workspace_names_accepts_every_client_row() {
        let rows: Vec<Accepted> = serde_json::from_str(include_str!("fixtures/clients-accepted.json")).expect("clients rows");
        let mut seen = 0;
        for row in rows {
            if let Some(got) = check(&row.method, Some(&row.params)) {
                seen += 1;
                assert!(got.is_ok(), "{} row of {} is refused: {:?}", row.method, row.client, got);
            }
        }
        assert!(seen > 0);
    }

    #[test]
    fn validate_workspace_names_text_ceiling_is_in_utf16_units() {
        let at_limit = "a".repeat(MAX_TEXT_FILE_LENGTH);
        assert!(verdict("projectFs/writeText", &json!({"content": at_limit, "expectedContent": ""})).is_ok());
        let over = "a".repeat(MAX_TEXT_FILE_LENGTH + 1);
        assert_eq!(refused("projectFs/writeText", json!({"content": over})), ("/content".into(), "file content is invalid.".into()));
        assert_eq!(
            refused("projectFs/writeText", json!({"content": "", "expectedContent": over})),
            ("/expectedContent".into(), "expected file content is invalid.".into())
        );
        // Each astral character is two UTF-16 units.
        let astral = "\u{1F600}".repeat(MAX_TEXT_FILE_LENGTH / 2 + 1);
        assert_eq!(refused("projectFs/writeText", json!({"content": astral})).0, "/content");
        let batch = |content: &str| json!({"files": [{"relPath": "a.txt", "content": content, "expectedContent": ""}]});
        assert_eq!(
            refused("projectFs/writeTextBatch", batch(&over)),
            ("/files/0".into(), "Workspace edit file content is invalid.".into())
        );
        let document = |content: &str| {
            json!({"projectPath": "p", "document": {"kind": "open", "relPath": "a", "languageId": "rust", "version": 1, "content": content}})
        };
        assert_eq!(refused("lsp/document", document(&over)).1, "LSP document content is invalid.");
    }

    #[test]
    fn validate_workspace_names_names_trim_as_javascript_does() {
        assert!(verdict("thread/name/set", &json!({"title": "\u{feff} ok \u{a0}"})).is_ok());
        assert_eq!(refused("thread/name/set", json!({"title": "\u{feff}\u{a0}"})).1, "title is invalid.");
        let long = "x".repeat(SESSION_TITLE_MAX + 1);
        assert_eq!(refused("thread/name/set", json!({"title": long})).1, "title is invalid.");
        assert!(verdict("thread/name/set", &json!({"title": format!(" {} ", "x".repeat(SESSION_TITLE_MAX))})).is_ok());
        assert!(verdict("project/update", &json!({"alias": "   "})).is_ok());
        assert_eq!(refused("project/update", json!({"alias": "a\u{7f}"})).1, "alias is invalid.");
        assert_eq!(refused("project/update", json!({"alias": 5})).1, "alias must be a string.");
    }

    #[test]
    fn validate_workspace_names_structured_params_are_bounded() {
        let deep = |levels: usize| (0..levels).fold(json!(1), |inner, _| json!({"a": inner}));
        let request = |body: Value| {
            json!({"projectPath": "p", "request": {"relPath": "a", "languageId": "rust", "method": "textDocument/hover", "params": body}})
        };
        assert!(verdict("lsp/request", &request(deep(11))).is_ok());
        assert_eq!(refused("lsp/request", request(deep(13))).1, "structured input is too large.");
        let polluted: Value = serde_json::from_str(r#"{"__proto__": {}}"#).unwrap();
        assert_eq!(refused("lsp/request", request(polluted)).1, "structured input contains an invalid field.");
        let wide = Value::Array(vec![json!(0); STRUCTURED_ENTRIES_MAX + 1]);
        assert_eq!(refused("lsp/request", request(json!({"a": wide}))).1, "structured input contains too many entries.");
        assert_eq!(refused("lsp/request", request(json!(null))).1, "LSP params are invalid.");
    }

    #[test]
    fn validate_workspace_names_unrelated_methods_and_shapes_pass_through() {
        assert!(check("turn/start", Some(&json!({}))).is_none());
        assert!(check("thread/name/set", None).is_some_and(|verdict| verdict.is_ok()));
        assert!(check("thread/name/set", Some(&json!([1]))).is_some_and(|verdict| verdict.is_ok()));
    }
}
