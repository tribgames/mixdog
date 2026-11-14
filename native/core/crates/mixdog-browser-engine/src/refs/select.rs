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
const SELECT_NATIVE: &str = r##"function(values) {
  const el = this;
  const error = (__MIXDOG_EDITABILITY__)(el);
  if (error) return { error };
  if ((el.tagName || '').toLowerCase() !== 'select') return { custom: true };
  if (el.options.length > 5000) return { error: 'select has too many options; narrow the control before selecting' };
  const options = Array.from(el.options);
  const selected = new Set();
  for (const value of values) {
    const matches = options.filter(option =>
      String(option.value) === value || String(option.label || option.text) === value);
    if (!matches.length) {
      // A caller that cannot see the control needs its options in the error,
      // or the only recovery left is another snapshot of the same select.
      const listed = options.filter(option => !option.disabled)
        .slice(0, 8).map(option => String(option.label || option.text || option.value).slice(0, 40)).join(' | ');
      return { error: 'no option matched the requested value: ' + value
        + (listed ? '; options include: ' + listed : '') };
    }
    if (matches.length !== 1) return { error: 'requested option is ambiguous: ' + value };
    const option = matches[0];
    if (option.disabled || option.parentElement?.disabled) {
      return { error: 'requested option is disabled: ' + value };
    }
    selected.add(option);
  }
  if (!el.multiple && selected.size !== 1) {
    return { error: 'this select accepts exactly one option' };
  }
  if (el.multiple) {
    for (const option of options) option.selected = selected.has(option);
  } else {
    el.selectedIndex = options.indexOf([...selected][0]);
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  const actual = Array.from(el.selectedOptions);
  if (actual.length !== selected.size || actual.some(option => !selected.has(option))) {
    return { error: 'select input was dispatched once but the selection changed; observe before continuing' };
  }
  return { values: actual.map(option => String(option.value)) };
}"##;

/// The head both custom-dropdown functions share: the control and the lists it owns (`CUSTOM_CONTROL`).
const CUSTOM_CONTROL: &str = r##"
  const el = this;
  const error = (__MIXDOG_EDITABILITY__)(el);
  if (error) return { error };
  const target = el.closest('[role="combobox"],[role="listbox"],[role="menu"],[aria-haspopup]') || el;
  const ids = [...new Set(
    [target.getAttribute('aria-controls'), target.getAttribute('aria-owns')]
      .filter(Boolean).join(' ').split(/\s+/).filter(Boolean)
  )];
  const ownList = target.matches('[role="listbox"],[role="menu"],[role="tree"]');
  if (!ids.length && !ownList) {
    return { error: 'control has no associated option list; open it and choose an explicit option ref from a fresh snapshot' };
  }
"##;

const CUSTOM_CONTROL_PLACEHOLDER: &str = "__MIXDOG_CUSTOM_CONTROL__";

/// Opens a custom dropdown unless it is a list itself or already expanded (`OPEN_CUSTOM`).
const OPEN_CUSTOM: &str = r##"function() {
  __MIXDOG_CUSTOM_CONTROL__
  if (!ownList && target.getAttribute('aria-expanded') !== 'true') {
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
    target.click();
  }
  return {};
}"##;

/// Clicks the one open option that matches exactly (`PICK_CUSTOM`).
const PICK_CUSTOM: &str = r##"function(wanted) {
  __MIXDOG_CUSTOM_CONTROL__
  const root = target.getRootNode();
  const lists = ownList ? [target] : [];
  for (const id of ids) {
    const list = root.getElementById?.(id);
    if (list && !lists.includes(list)) lists.push(list);
  }
  if (!lists.length) return { pending: true };
  const compact = value => String(value ?? '').slice(0, 2000).replace(/\s+/g, ' ').trim();
  const visible = element => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let current = element; current; current = current.parentElement || current.getRootNode()?.host) {
      const style = current.ownerDocument.defaultView.getComputedStyle(current);
      if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') return false;
    }
    return true;
  };
  const candidates = new Set();
  const roots = [...lists];
  let scanned = 0;
  for (let index = 0; index < roots.length; index++) {
    const walker = el.ownerDocument.createTreeWalker(roots[index], 1);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (++scanned > 5000) return { error: 'associated option list is too large; choose an explicit option ref' };
      if (node.shadowRoot) roots.push(node.shadowRoot);
      if (node.matches('[role="option"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="treeitem"],[data-value]') && visible(node)) {
        candidates.add(node);
        if (candidates.size > 500) return { error: 'associated option list has too many options; choose an explicit option ref' };
      }
    }
  }
  if (!candidates.size) return { pending: true };
  const label = node => compact(node.getAttribute('aria-label') || node.textContent);
  const matches = [...candidates].filter(node =>
    label(node) === wanted || compact(node.getAttribute('data-value')) === wanted);
  if (matches.length > 1) return { error: 'requested option is ambiguous in the associated list; choose an explicit option ref' };
  if (!matches.length) {
    return { error: 'no open option matched exactly; visible options include: '
      + [...candidates].slice(0, 8).map(node => label(node).slice(0, 40)).join(' | ') };
  }
  const hit = matches[0];
  const hitError = (__MIXDOG_EDITABILITY__)(hit);
  if (hitError) return { error: hitError };
  const value = label(hit) || compact(hit.getAttribute('data-value'));
  hit.scrollIntoView({ block: 'center', behavior: 'instant' });
  hit.click();
  return { values: [value.slice(0, 120)] };
}"##;

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
