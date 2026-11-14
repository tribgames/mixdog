//! Owner: s4-engine-actions-forms
//! Selection scoped to one control (`ref-select.ts`). The whole request is validated before a native option changes; a custom
//! dropdown's options stay in the control's own realm and are looked up by the control's `aria-controls`/`aria-owns`.

use mixdog_rt::time;
use serde::Deserialize;
use serde_json::json;

use super::access::RefError;
use super::access::checked_ref_result;
use super::ref_actions::EDITABILITY_CHECK;
use super::ref_actions::EDITABILITY_PLACEHOLDER;
use super::ref_actions::RefActions;
use crate::settle::settle::pause;
use crate::settle::settle::throw_if_cancelled;

/// What a selection function reports: the values chosen, or that the control is custom or its list not rendered yet.
#[derive(Deserialize, Default)]
#[serde(default)]
struct Selection {
    custom: bool,
    pending: bool,
    values: Option<Vec<String>>,
}

/// A native `<select>`: every requested value must match exactly one enabled option before anything changes (`SELECT_NATIVE`).
const SELECT_NATIVE: &str = include_str!("../../assets/page/select-native.js");

/// The head both custom-dropdown functions share: the control and the lists it owns (`CUSTOM_CONTROL`).
const CUSTOM_CONTROL: &str = include_str!("../../assets/page/custom-control.js");

const CUSTOM_CONTROL_PLACEHOLDER: &str = "__MIXDOG_CUSTOM_CONTROL__";

/// Opens a custom dropdown unless it is a list itself or already expanded (`OPEN_CUSTOM`).
const OPEN_CUSTOM: &str = include_str!("../../assets/page/open-custom.js");

/// Clicks the one open option that matches exactly (`PICK_CUSTOM`).
const PICK_CUSTOM: &str = include_str!("../../assets/page/pick-custom.js");

/// A custom-dropdown function with the shared head and the editability check spliced in.
fn custom_function(source: &str) -> String {
    source.replace(CUSTOM_CONTROL_PLACEHOLDER, CUSTOM_CONTROL).replace(EDITABILITY_PLACEHOLDER, EDITABILITY_CHECK)
}

fn selection(result: serde_json::Value, ref_id: &str) -> Result<Selection, RefError> {
    Ok(serde_json::from_value(checked_ref_result(result, ref_id)?).unwrap_or_default())
}

fn cancelled() -> RefError {
    crate::error::HostCallError::Cancelled.into()
}

impl RefActions {
    /// `selectCustomRef`: opens a custom dropdown and chooses the one open option that matches `values[0]`, waiting up to
    /// `dropdown_timeout` for the list to render.
    pub async fn select_custom_ref(&self, ref_id: &str, values: &[String]) -> Result<Vec<String>, RefError> {
        let [wanted] = values else {
            return Err(RefError::Failed("custom dropdowns require exactly one non-empty value".into()));
        };
        let wanted = wanted.trim();
        if wanted.is_empty() {
            return Err(RefError::Failed("custom dropdowns require exactly one non-empty value".into()));
        }
        selection(self.call(ref_id, &custom_function(OPEN_CUSTOM), Vec::new()).await?, ref_id)?;
        let deadline = time::Instant::now() + self.dropdown_timeout;
        let pick = custom_function(PICK_CUSTOM);
        loop {
            throw_if_cancelled(&self.cancel).map_err(|_| cancelled())?;
            let result = selection(self.call(ref_id, &pick, vec![json!(wanted)]).await?, ref_id)?;
            if let Some(values) = result.values {
                return Ok(values);
            }
            if !result.pending || time::Instant::now() >= deadline {
                return Err(RefError::Failed("no open option list was found for this control; take a fresh snapshot".into()));
            }
            pause(self.dropdown_poll, &self.cancel).await.map_err(|_| cancelled())?;
        }
    }

    /// `selectRef`: chooses the options named by `values` (a value or a label each) in a native `<select>`, or the option of a
    /// custom dropdown; answers the values now selected.
    pub async fn select_ref(&self, ref_id: &str, values: &[String]) -> Result<Vec<String>, RefError> {
        if values.is_empty() {
            return Err(RefError::Failed("select requires at least one value".into()));
        }
        let declaration = SELECT_NATIVE.replace(EDITABILITY_PLACEHOLDER, EDITABILITY_CHECK);
        let result = selection(self.call(ref_id, &declaration, vec![json!(values)]).await?, ref_id)?;
        if result.custom {
            return self.select_custom_ref(ref_id, values).await;
        }
        Ok(result.values.unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use mixdog_rt::CancellationToken;
    use serde_json::json;

    use super::super::ref_actions::tests::REF;
    use super::super::ref_actions::tests::actions;
    use super::super::ref_actions::tests::call;
    use super::*;
    use crate::fake::FakeHost;

    fn values(list: &[&str]) -> Vec<String> {
        list.iter().map(|value| (*value).to_string()).collect()
    }

    #[tokio::test]
    async fn a_native_select_answers_the_values_it_holds_and_carries_the_request() {
        let host = Arc::new(FakeHost::scripted(vec![call(json!({"values": ["us"]})).with_params(json!({"args": [["US"]]}))]));
        assert_eq!(actions(host.clone()).select_ref(REF, &values(&["US"])).await, Ok(values(&["us"])));
        let declaration = host.calls()[0].params["functionDeclaration"].as_str().expect("declaration").to_string();
        assert!(declaration.contains("requested option is ambiguous"));
        assert!(!declaration.contains(EDITABILITY_PLACEHOLDER));
    }

    #[tokio::test]
    async fn the_page_refusals_of_a_select_are_the_failure_text() {
        let message = "no option matched the requested value: Mars; options include: Earth | Venus";
        let host = Arc::new(FakeHost::scripted(vec![call(json!({"error": message}))]));
        assert_eq!(actions(host).select_ref(REF, &values(&["Mars"])).await, Err(RefError::Failed(message.into())));
        let none = Arc::new(FakeHost::scripted(Vec::new()));
        assert_eq!(actions(none).select_ref(REF, &[]).await, Err(RefError::Failed("select requires at least one value".into())));
    }

    #[tokio::test]
    async fn a_custom_control_opens_then_picks_the_matching_option() {
        let host = Arc::new(FakeHost::scripted(vec![
            call(json!({"custom": true})),
            call(json!({})),
            call(json!({"pending": true})),
            call(json!({"values": ["Blue"]})).with_params(json!({"args": ["Blue"]})),
        ]));
        assert_eq!(actions(host.clone()).select_ref(REF, &values(&["  Blue "])).await, Ok(values(&["Blue"])));
        host.finish().expect("select, open, a pending pick, a pick");
        let calls = host.calls();
        let open = calls[1].params["functionDeclaration"].as_str().expect("open");
        assert!(open.contains("target.click()") && !open.contains("__MIXDOG_"));
    }

    #[tokio::test]
    async fn a_list_that_never_renders_ends_the_wait_with_the_fresh_snapshot_advice() {
        let mut script = vec![call(json!({}))];
        script.extend((0..200).map(|_| call(json!({"pending": true}))));
        let host = Arc::new(FakeHost::scripted(script));
        let error = actions(host).select_custom_ref(REF, &values(&["Blue"])).await.expect_err("never renders");
        assert_eq!(error.to_string(), "no open option list was found for this control; take a fresh snapshot");
    }

    #[tokio::test]
    async fn a_custom_dropdown_takes_exactly_one_non_empty_value() {
        let host = Arc::new(FakeHost::scripted(Vec::new()));
        let actions = actions(host.clone());
        for bad in [values(&["a", "b"]), values(&["  "]), values(&[])] {
            assert_eq!(actions.select_custom_ref(REF, &bad).await, Err(RefError::Failed("custom dropdowns require exactly one non-empty value".into())));
        }
        host.finish().expect("no call was made");
    }

    #[tokio::test]
    async fn a_cancelled_wait_ends_as_a_cancel() {
        let token = CancellationToken::new();
        let host = Arc::new(FakeHost::scripted(vec![call(json!({})), call(json!({"pending": true}))]));
        let mut actions = actions(host);
        actions.cancel = token.clone().into();
        token.cancel();
        let error = actions.select_custom_ref(REF, &values(&["Blue"])).await.expect_err("cancelled");
        assert_eq!(error, RefError::Host(crate::error::HostCallError::Cancelled));
    }
}
