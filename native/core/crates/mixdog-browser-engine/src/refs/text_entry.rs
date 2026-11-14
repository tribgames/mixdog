//! Owner: s4-engine-actions-forms
//! Putting text into one element by ref (`ref-text-entry.ts`). `fill` replaces the whole value the way a form library expects
//! (through the native value setter, with the input and change events a page listens for), while `type` sends real keystrokes
//! for controls that only react while a person types. A rich editor owns its DOM, so its text is replaced as typed input.
//! `type` is one `input/batch` (select all, delete, the text): no round trip per key.

use serde::Deserialize;
use serde_json::json;

use super::access::RefError;
use super::access::checked_ref_result;
use super::ref_actions::EDITABILITY_CHECK;
use super::ref_actions::EDITABILITY_PLACEHOLDER;
use super::ref_actions::RefActions;
use super::ref_actions::insert_text;
use super::ref_actions::press;
use super::ref_actions::type_text;

/// Page functions written once for both realms: the element's realm applies them to the ref's element (`FILL_REF`).
const FILL_REF: &str = include_str!("../../assets/page/fill-ref.js");

/// Focuses the element for typing (`FOCUS_REF`).
const FOCUS_REF: &str = include_str!("../../assets/page/focus-ref.js");

/// What an editor holds, as text.
const READ_EDITOR_TEXT: &str = r#"function() { return String(this.innerText ?? this.textContent ?? ""); }"#;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct FillOutcome {
    value: Option<String>,
    sensitive: bool,
    content_editable: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct FocusOutcome {
    sensitive: bool,
}

fn with_editability(source: &str) -> String {
    source.replace(EDITABILITY_PLACEHOLDER, EDITABILITY_CHECK)
}

fn compact(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The key that selects everything in the field being typed into. The modifier is the shortcut one of the machine the page is on
/// (the host resolves `ControlOrMeta`: Command on macOS, Control elsewhere), which is not always the machine this core runs on.
fn select_all() -> (&'static str, &'static [&'static str]) {
    ("a", &["ControlOrMeta"])
}

impl RefActions {
    /// A rich editor owns its DOM: writing textContent bypasses its model and the next render drops the text. Everything is
    /// selected and the new text inserted as typed input instead, the way a person replaces it.
    async fn replace_content_editable(&self, ref_id: &str, text: &str) -> Result<String, RefError> {
        self.input(vec![if text.is_empty() { press("Backspace", &[]) } else { insert_text(text) }]).await?;
        let actual = self.call(ref_id, READ_EDITOR_TEXT, Vec::new()).await?;
        let actual = actual.as_str().unwrap_or_default();
        if !compact(text).is_empty() && compact(actual).is_empty() {
            return Err(RefError::Failed("the editor did not keep the inserted text; click into it first or use type".into()));
        }
        Ok((self.redact)(actual))
    }

    /// `fillRef`: replaces the element's whole value and answers what it holds now (redacted; a password answers
    /// `[REDACTED]` and its text is registered as a secret).
    pub async fn fill_ref(&self, ref_id: &str, text: &str) -> Result<String, RefError> {
        let declaration = with_editability(FILL_REF);
        let outcome = checked_ref_result(self.call(ref_id, &declaration, vec![json!(text)]).await?, ref_id)?;
        let outcome: FillOutcome = serde_json::from_value(outcome).unwrap_or_default();
        if outcome.content_editable {
            return self.replace_content_editable(ref_id, text).await;
        }
        if outcome.sensitive && !text.is_empty() {
            (self.remember_secret)(text);
        }
        Ok(if outcome.sensitive { "[REDACTED]".to_string() } else { (self.redact)(outcome.value.as_deref().unwrap_or_default()) })
    }

    /// `typeRef`: focuses the element, clears it, and types the text as real keystrokes, the gesture for controls that only
    /// react while a person types (`fill` owns bulk replacement). Select all, delete and the text go in one batch.
    pub async fn type_ref(&self, ref_id: &str, text: &str) -> Result<(), RefError> {
        let declaration = with_editability(FOCUS_REF);
        let focused = checked_ref_result(self.call(ref_id, &declaration, Vec::new()).await?, ref_id)?;
        let focused: FocusOutcome = serde_json::from_value(focused).unwrap_or_default();
        if focused.sensitive && !text.is_empty() {
            (self.remember_secret)(text);
        }
        let (key, modifiers) = select_all();
        self.input(vec![press(key, modifiers), press("Backspace", &[]), type_text(text)]).await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::Mutex;

    use serde_json::json;

    use super::super::ref_actions::tests::REF;
    use super::super::ref_actions::tests::actions;
    use super::super::ref_actions::tests::batch_done;
    use super::super::ref_actions::tests::call;
    use super::*;
    use crate::fake::FakeHost;

    #[tokio::test]
    async fn fill_sets_the_value_through_the_page_and_answers_what_the_element_holds() {
        let host = Arc::new(FakeHost::scripted(vec![call(json!({"value": "new text"})).with_params(json!({"ref": REF, "args": ["new text"]}))]));
        let value = actions(host.clone()).fill_ref(REF, "new text").await;
        assert_eq!(value, Ok("new text".to_string()));
        let calls = host.calls();
        let declaration = calls[0].params["functionDeclaration"].as_str().expect("declaration");
        assert!(declaration.contains("Object.getOwnPropertyDescriptor(proto, 'value')?.set"));
        assert!(declaration.contains("function(el) {"), "the editability check is spliced in");
        assert!(!declaration.contains(EDITABILITY_PLACEHOLDER));
    }

    #[tokio::test]
    async fn a_value_read_back_is_redacted() {
        let host = Arc::new(FakeHost::scripted(vec![call(json!({"value": "token hunter2"}))]));
        assert_eq!(actions(host).fill_ref(REF, "x").await, Ok("token [REDACTED]".to_string()));
    }

    #[tokio::test]
    async fn a_password_is_registered_as_a_secret_and_never_echoed() {
        let host = Arc::new(FakeHost::scripted(vec![call(json!({"value": "", "sensitive": true})), call(json!({"value": "", "sensitive": true})), batch_done()]));
        let secrets = Arc::new(Mutex::new(Vec::<String>::new()));
        let mut actions = actions(host.clone());
        let sink = secrets.clone();
        actions.remember_secret = Arc::new(move |value: &str| sink.lock().expect("secrets").push(value.to_string()));
        assert_eq!(actions.fill_ref(REF, "hunter2").await, Ok("[REDACTED]".to_string()));
        actions.type_ref(REF, "hunter3").await.expect("typed");
        assert_eq!(*secrets.lock().expect("secrets"), ["hunter2", "hunter3"]);
    }

    #[tokio::test]
    async fn a_refusal_of_the_page_is_the_failure_and_staleness_names_the_ref() {
        let host = Arc::new(FakeHost::scripted(vec![call(json!({"error": "element is readonly"})), call(json!({"error": "stale"}))]));
        let actions = actions(host);
        assert_eq!(actions.fill_ref(REF, "x").await, Err(RefError::Failed("element is readonly".into())));
        assert_eq!(actions.fill_ref(REF, "x").await, Err(RefError::Failed(format!("ref {REF} is stale or unknown; take a fresh snapshot first"))));
    }

    #[tokio::test]
    async fn an_editor_is_replaced_as_typed_input_and_cleared_by_deleting_the_selection() {
        let host = Arc::new(FakeHost::scripted(vec![
            call(json!({"contentEditable": true})),
            batch_done().with_params(json!({"steps": [{"op": "insertText", "text": "new text"}]})),
            call(json!("new text")),
            call(json!({"contentEditable": true})),
            batch_done().with_params(json!({"steps": [{"op": "press", "key": "Backspace"}]})),
            call(json!("")),
        ]));
        let actions = actions(host.clone());
        assert_eq!(actions.fill_ref(REF, "new text").await, Ok("new text".to_string()));
        assert_eq!(actions.fill_ref(REF, "").await, Ok(String::new()));
        host.finish().expect("every call");
    }

    #[tokio::test]
    async fn an_editor_that_drops_the_inserted_text_is_reported_instead_of_claimed_filled() {
        let host = Arc::new(FakeHost::scripted(vec![call(json!({"contentEditable": true})), batch_done(), call(json!("  \n "))]));
        let error = actions(host).fill_ref(REF, "lost").await.expect_err("dropped");
        assert!(error.to_string().contains("did not keep the inserted text"));
    }

    #[tokio::test]
    async fn type_is_one_batch_that_selects_all_deletes_and_types() {
        let (key, modifiers) = select_all();
        let host = Arc::new(FakeHost::scripted(vec![
            call(json!({})),
            batch_done().with_params(json!({"steps": [
                {"op": "press", "key": key, "modifiers": modifiers},
                {"op": "press", "key": "Backspace"},
                {"op": "type", "text": "hello"}
            ]})),
        ]));
        actions(host.clone()).type_ref(REF, "hello").await.expect("typed");
        host.finish().expect("a focus call and one batch");
    }

    #[test]
    fn whitespace_compacts_the_way_the_editor_check_reads_it() {
        assert_eq!(compact("  a \n b\t"), "a b");
    }
}
