//! What the desktop host's validators handed on besides their verdict: `requiredPromptContent`, `requiredNewTaskDraft` and
//! `requiredModelSelection` returned a normalised copy of their input (`ipc-validation.ts`), and everything downstream read
//! that copy. The checks of this folder only judge, so the handlers that take a prompt or a draft call these on what they
//! decoded, after the check passed. Each is idempotent.
//!
//! One rule of the host is not kept: a file part of another type than a PDF or an office document was refused there; here it
//! is accepted (see `prompt.rs`), and such a type keeps its own spelling, trimmed.

use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim;
use mixdog_js::slice_utf16;
use mixdog_protocol::ModelSelection;
use mixdog_protocol::PromptContent;
use mixdog_protocol::PromptPart;
use serde_json::Map;
use serde_json::Value;

use super::prompt::canonical_prompt_file_mime;
use crate::v2::thread::NewTaskDraft;
use crate::v2::thread::TurnInput;

/// The longest file name a part keeps (`part.filename.slice(0, 160)`, in UTF-16 units).
const MAX_FILENAME_LENGTH: usize = 160;

/// A file name cut to [`MAX_FILENAME_LENGTH`] units; none when it is empty.
fn cut_filename(name: Option<String>) -> Option<String> {
    name.map(|name| slice_utf16(&name, MAX_FILENAME_LENGTH)).filter(|name| !name.is_empty())
}

/// `requiredPromptContent`'s copy: an image's type is trimmed and lowercased, a file's type is the canonical spelling of a
/// PDF or office type (any other keeps its trimmed text), and the name of an image or a file is cut to 160 units and
/// dropped when empty. A text, a stored attachment and the data are as given.
pub fn prompt_content(content: &mut PromptContent) {
    let PromptContent::Parts(parts) = content else { return };
    for part in parts {
        match part {
            PromptPart::Text { .. } => {}
            PromptPart::Image { mime_type, filename, .. } => {
                *mime_type = js_to_lowercase(js_trim(mime_type));
                *filename = cut_filename(filename.take());
            }
            PromptPart::File { mime_type, filename, .. } => {
                *mime_type = canonical_prompt_file_mime(mime_type).map_or_else(|| js_trim(mime_type).to_owned(), str::to_owned);
                *filename = cut_filename(filename.take());
            }
        }
    }
}

/// The prompt of a turn input; its options are returned as given (`return value as DesktopSubmitOptions`).
pub fn turn_input(input: &mut TurnInput) {
    prompt_content(&mut input.prompt);
}

/// `requiredModelSelection`'s copy: provider, model and effort trimmed (the fallbacks the same), `onlyIfEmpty` kept only
/// when true.
pub fn model_selection(selection: &mut ModelSelection) {
    selection.provider = js_trim(&selection.provider).to_owned();
    selection.model = js_trim(&selection.model).to_owned();
    selection.effort = selection.effort.take().map(|effort| js_trim(&effort).to_owned());
    if selection.only_if_empty == Some(false) {
        selection.only_if_empty = None;
    }
    for fallback in selection.fallbacks.iter_mut().flatten() {
        model_selection(fallback);
    }
}

/// `requiredNewTaskDraft`'s copy: the project path and the workflow id trimmed, the route as [`model_selection`], and the
/// worktree as [`new_task_worktree`].
pub fn new_task_draft(draft: &mut NewTaskDraft) {
    for text in [&mut draft.project_path, &mut draft.workflow_id] {
        *text = text.take().map(|text| js_trim(&text).to_owned());
    }
    if let Some(route) = &mut draft.route {
        model_selection(route);
    }
    if let Some(worktree) = &mut draft.worktree {
        new_task_worktree(worktree);
    }
}

/// The worktree choice of a draft as the host kept it: `confirmLarge` and `fromDefault` only when true, the branch trimmed,
/// `create` (kept when false) only beside a branch. A value that is not an object is left as it is.
pub fn new_task_worktree(worktree: &mut Value) {
    let Value::Object(record) = worktree else { return };
    let mut kept = Map::new();
    for flag in ["confirmLarge", "fromDefault"] {
        if record.get(flag) == Some(&Value::Bool(true)) {
            kept.insert(flag.to_owned(), Value::Bool(true));
        }
    }
    let branch = record.get("branch").and_then(Value::as_str).map(|branch| js_trim(branch).to_owned());
    if let Some(branch) = branch.filter(|branch| !branch.is_empty()) {
        kept.insert("branch".to_owned(), Value::String(branch));
        if let Some(create) = record.get("create").filter(|create| create.is_boolean()) {
            kept.insert("create".to_owned(), create.clone());
        }
    }
    *record = kept;
}

#[cfg(test)]
mod normalize_inputs {
    use serde_json::json;

    use super::*;

    fn content(value: Value) -> PromptContent {
        serde_json::from_value(value).expect("prompt content")
    }

    #[test]
    fn an_image_type_is_lowercased_and_trimmed() {
        let mut prompt = content(json!([{ "type": "image", "mimeType": " Image/PNG ", "data": "AAAA" }]));
        prompt_content(&mut prompt);
        assert_eq!(prompt, content(json!([{ "type": "image", "mimeType": "image/png", "data": "AAAA" }])));
    }

    #[test]
    fn a_file_takes_the_canonical_type_and_a_name_cut_to_160_units() {
        let mut prompt = content(json!([
            { "type": "file", "mimeType": "Application/PDF;charset=x", "data": "AAAA", "filename": "a".repeat(200) },
            { "type": "file", "mimeType": " text/plain ", "data": "AAAA", "filename": "" },
        ]));
        prompt_content(&mut prompt);
        assert_eq!(
            prompt,
            content(json!([
                { "type": "file", "mimeType": "application/pdf", "data": "AAAA", "filename": "a".repeat(160) },
                { "type": "file", "mimeType": "text/plain", "data": "AAAA" },
            ]))
        );
    }

    #[test]
    fn the_name_is_cut_by_utf16_units() {
        // 159 units and a surrogate pair: the cut falls inside the pair, whose half cannot be kept in a string; it is written
        // as U+FFFD, as the host's encoders write a lone half.
        let name = format!("{}\u{1F680}", "a".repeat(159));
        let mut prompt = content(json!([{ "type": "file", "mimeType": "application/pdf", "data": "AAAA", "filename": name }]));
        prompt_content(&mut prompt);
        let PromptContent::Parts(parts) = prompt else { panic!("parts") };
        let PromptPart::File { filename: Some(kept), .. } = &parts[0] else { panic!("a named file") };
        assert_eq!(kept.chars().count(), 160);
        assert!(kept.starts_with(&"a".repeat(159)));
    }

    #[test]
    fn a_text_prompt_and_a_stored_attachment_are_as_given() {
        let mut text = PromptContent::Text("  hi  ".into());
        prompt_content(&mut text);
        assert_eq!(text, PromptContent::Text("  hi  ".into()));
        let stored = json!([{ "type": "text", "text": "  hi  " }, { "type": "image", "mimeType": "image/png", "attachmentRef": "att_1" }]);
        let mut parts = content(stored.clone());
        prompt_content(&mut parts);
        assert_eq!(parts, content(stored));
    }

    fn draft(value: Value) -> NewTaskDraft {
        serde_json::from_value(value).expect("draft")
    }

    #[test]
    fn a_draft_keeps_its_text_fields_trimmed() {
        let mut got = draft(json!({
            "projectPath": "  /work/app\n",
            "workflowId": " \u{a0}review ",
            "orchestrationMode": "swarm",
            "route": { "provider": " p ", "model": "\tm", "effort": " high ", "onlyIfEmpty": false,
                       "fallbacks": [{ "provider": " q", "model": "n ", "onlyIfEmpty": true }] },
        }));
        new_task_draft(&mut got);
        assert_eq!(
            got,
            draft(json!({
                "projectPath": "/work/app",
                "workflowId": "review",
                "orchestrationMode": "swarm",
                "route": { "provider": "p", "model": "m", "effort": "high",
                           "fallbacks": [{ "provider": "q", "model": "n", "onlyIfEmpty": true }] },
            }))
        );
    }

    #[test]
    fn a_draft_worktree_keeps_only_what_the_host_kept() {
        let cases = [
            (json!({ "confirmLarge": false, "fromDefault": false }), json!({})),
            (json!({ "confirmLarge": true, "fromDefault": true }), json!({ "confirmLarge": true, "fromDefault": true })),
            (json!({ "branch": "  feature/x \u{a0}", "create": true }), json!({ "branch": "feature/x", "create": true })),
            (json!({ "branch": " b ", "create": false }), json!({ "branch": "b", "create": false })),
            (json!({ "create": true }), json!({})),
        ];
        for (given, kept) in cases {
            let mut worktree = given.clone();
            new_task_worktree(&mut worktree);
            assert_eq!(worktree, kept, "{given}");
            let mut again = kept.clone();
            new_task_worktree(&mut again);
            assert_eq!(again, kept, "idempotent: {given}");
        }
    }
}
