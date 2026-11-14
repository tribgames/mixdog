//! Owner: s4-engine-actions-forms
//! Native control state read from the element itself (`ref-control-state.ts`): the options a `<select>` offers (which the
//! accessibility tree hides until it opens), and a checkbox or radio button's checked state, changed by clicking it once and
//! then read back, never toggled blindly.

use serde::Deserialize;

use super::access::ActionabilityReason;
use super::access::RefError;
use super::access::checked_ref_result;
use super::points::ref_point;
use super::points::with_covered_guidance;
use super::probes::Point;
use super::ref_actions::RefActions;
use crate::settle::actionability::ACTIONABILITY_TIMEOUT;
use crate::settle::actionability::ActionableError;
use crate::settle::actionability::ActionabilityError;
use crate::settle::actionability::ProbeFailure;
use crate::settle::actionability::wait_for_actionable;

const READ_SELECT_OPTIONS: &str = r##"function() {
  const el = this;
  if (!el || !el.isConnected) return { error: 'stale' };
  if ((el.tagName || '').toLowerCase() !== 'select') return { custom: true };
  const options = Array.from(
    { length: Math.min(el.options.length, 200) },
    (_, index) => el.options[index],
  )
    .map((option) => {
      const label = String(option.label || option.text || option.value || '').trim().slice(0, 200);
      if (!label) return '';
      const group = option.parentElement;
      const disabled = option.disabled || Boolean(group && group.tagName === 'OPTGROUP' && group.disabled);
      const marks = [option.selected && 'selected', disabled && 'disabled'].filter(Boolean);
      return marks.length ? label + ' [' + marks.join(', ') + ']' : label;
    })
    .filter(Boolean);
  return { options, total: el.options.length > 200 ? el.options.length : undefined };
}"##;

const READ_CHECKED: &str = r##"function() {
  const el = this;
  if (!el || !el.isConnected) return { error: 'stale' };
  const tag = (el.tagName || '').toLowerCase();
  const type = String(el.type || '').toLowerCase();
  if (tag !== 'input' || !['checkbox', 'radio'].includes(type)) {
    return { error: 'element is not a checkbox or radio button' };
  }
  return { checked: Boolean(el.checked), radio: type === 'radio' };
}"##;

/// The options a native select lists, with how many it has when the list was cut short.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SelectOptions {
    pub options: Vec<String>,
    pub total: Option<usize>,
}

/// A checkbox's or radio button's state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CheckedState {
    pub checked: bool,
    pub radio: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct OptionsReport {
    custom: bool,
    options: Vec<String>,
    total: Option<usize>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct CheckedReport {
    checked: bool,
    radio: bool,
}

/// The reason a refusal carried, from the word its wait recorded.
fn reason_of(word: &str) -> ActionabilityReason {
    [
        ActionabilityReason::Covered,
        ActionabilityReason::Hidden,
        ActionabilityReason::Disabled,
        ActionabilityReason::Moving,
        ActionabilityReason::NotEditable,
    ]
    .into_iter()
    .find(|reason| reason.as_str() == word)
    .unwrap_or(ActionabilityReason::Missing)
}

impl RefActions {
    /// `listSelectOptions`: what a control offers, without choosing anything. A custom dropdown puts its options in the page
    /// once it is open, where a snapshot already sees them.
    pub async fn list_select_options(&self, ref_id: &str) -> Result<SelectOptions, RefError> {
        let report = checked_ref_result(self.call(ref_id, READ_SELECT_OPTIONS, Vec::new()).await?, ref_id)?;
        let report: OptionsReport = serde_json::from_value(report).unwrap_or_default();
        if report.custom {
            return Err(RefError::Failed(format!(
                "ref {ref_id} is not a native <select>; click it to open the list, then read the options from the fresh snapshot"
            )));
        }
        // `total` is present only when the list was cut short.
        Ok(SelectOptions { options: report.options, total: report.total })
    }

    /// `checkedRefState`.
    pub async fn checked_ref_state(&self, ref_id: &str) -> Result<CheckedState, RefError> {
        let report = checked_ref_result(self.call(ref_id, READ_CHECKED, Vec::new()).await?, ref_id)?;
        let report: CheckedReport = serde_json::from_value(report).unwrap_or_default();
        Ok(CheckedState { checked: report.checked, radio: report.radio })
    }

    /// `resolveRefPoint`: where the ref sits right now, waiting for a blocker to clear and refusing when something still covers
    /// it. A covered ref's refusal carries a fresh snapshot so the blocker can be dismissed by ref.
    pub async fn resolve_ref_point(&self, ref_id: &str) -> Result<Point, RefError> {
        let this = self;
        let probe = move || async move {
            match ref_point(&*this.host, &this.target(ref_id), this.cancel.token()).await {
                Ok(point) => Ok(point),
                Err(RefError::Refused { reason, message }) => Err(ProbeFailure::NotActionable(ActionabilityError::new(message, reason.as_str()))),
                Err(error) => Err(ProbeFailure::Other(error)),
            }
        };
        let error = match wait_for_actionable(probe, &self.cancel, ACTIONABILITY_TIMEOUT).await {
            Ok(point) => return Ok(point),
            Err(ActionableError::Cancelled(_)) => return Err(crate::error::HostCallError::Cancelled.into()),
            Err(ActionableError::Failed(error)) => return Err(error),
            Err(ActionableError::NotActionable(blocker)) => RefError::Refused { reason: reason_of(&blocker.reason), message: blocker.message },
        };
        Err(with_covered_guidance(&*self.host, &self.page_id, error, &*self.format_snapshot, self.cancel.token()).await)
    }

    /// `setCheckedRef`: makes a checkbox or radio button checked or unchecked with one click, then reads it back. The click is
    /// never repeated: a state that did not change is reported, not retried.
    pub async fn set_checked_ref(&self, ref_id: &str, checked: bool) -> Result<(), RefError> {
        let state = self.checked_ref_state(ref_id).await?;
        if state.radio && !checked {
            return Err(RefError::Failed("radio buttons cannot be unchecked directly; choose another option".into()));
        }
        if state.checked == checked {
            return Ok(());
        }
        let point = self.resolve_ref_point(ref_id).await?;
        self.click_guarded(ref_id, point.x, point.y).await?;
        let after = self.checked_ref_state(ref_id).await?;
        if after.checked != checked {
            return Err(RefError::Failed(format!(
                "check input was dispatched once but the element remained checked={}; the action was not retried",
                after.checked
            )));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::super::ref_actions::tests::REF;
    use super::super::ref_actions::tests::actions;
    use super::super::ref_actions::tests::batch_done;
    use super::super::ref_actions::tests::call;
    use super::*;
    use crate::fake::FakeHost;

    fn state(checked: bool, radio: bool) -> crate::fake::Expect {
        call(json!({"checked": checked, "radio": radio}))
    }

    fn point() -> crate::fake::Expect {
        call(json!({"x": 10.0, "y": 20.0}))
    }

    #[tokio::test]
    async fn the_options_of_a_native_select_come_back_with_their_marks_and_the_total_when_cut() {
        let host = Arc::new(FakeHost::scripted(vec![
            call(json!({"options": ["Red [selected]", "Blue", "Green [disabled]"]})),
            call(json!({"options": ["A"], "total": 900})),
        ]));
        let actions = actions(host);
        assert_eq!(
            actions.list_select_options(REF).await,
            Ok(SelectOptions { options: vec!["Red [selected]".into(), "Blue".into(), "Green [disabled]".into()], total: None })
        );
        assert_eq!(actions.list_select_options(REF).await, Ok(SelectOptions { options: vec!["A".into()], total: Some(900) }));
    }

    #[tokio::test]
    async fn a_custom_control_has_no_option_list_to_read() {
        let host = Arc::new(FakeHost::scripted(vec![call(json!({"custom": true}))]));
        let error = actions(host).list_select_options(REF).await.expect_err("custom");
        assert_eq!(
            error.to_string(),
            format!("ref {REF} is not a native <select>; click it to open the list, then read the options from the fresh snapshot")
        );
    }

    #[tokio::test]
    async fn a_checked_control_is_not_clicked_again() {
        let host = Arc::new(FakeHost::scripted(vec![state(true, false)]));
        assert_eq!(actions(host.clone()).set_checked_ref(REF, true).await, Ok(()));
        host.finish().expect("the state read only");
    }

    #[tokio::test]
    async fn an_unchecked_box_is_clicked_once_at_its_hit_tested_point_and_read_back() {
        let host = Arc::new(FakeHost::scripted(vec![
            state(false, false),
            point(),
            batch_done().with_params(json!({"steps": [{"op": "pointer", "kind": "click", "x": 10.0, "y": 20.0, "button": "left", "hitGuard": {"snapshotId": "p1-s2", "ref": REF}}]})),
            state(true, false),
        ]));
        assert_eq!(actions(host.clone()).set_checked_ref(REF, true).await, Ok(()));
        host.finish().expect("state, point, click, state");
    }

    #[tokio::test]
    async fn a_click_that_changed_nothing_is_reported_and_never_retried() {
        let host = Arc::new(FakeHost::scripted(vec![state(false, false), point(), batch_done(), state(false, false)]));
        let error = actions(host.clone()).set_checked_ref(REF, true).await.expect_err("unchanged");
        assert_eq!(error.to_string(), "check input was dispatched once but the element remained checked=false; the action was not retried");
        host.finish().expect("exactly one click");
    }

    #[tokio::test]
    async fn a_radio_button_cannot_be_unchecked_and_a_non_checkbox_is_refused() {
        let host = Arc::new(FakeHost::scripted(vec![state(true, true), call(json!({"error": "element is not a checkbox or radio button"}))]));
        let actions = actions(host);
        assert_eq!(
            actions.set_checked_ref(REF, false).await,
            Err(RefError::Failed("radio buttons cannot be unchecked directly; choose another option".into()))
        );
        assert_eq!(actions.checked_ref_state(REF).await, Err(RefError::Failed("element is not a checkbox or radio button".into())));
    }

    #[tokio::test]
    async fn a_blocker_that_clears_lets_the_click_through_and_a_hidden_ref_is_the_refusal_it_is() {
        let host = Arc::new(FakeHost::scripted(vec![call(json!({"error": "covered", "covering": "a banner"})), point()]));
        assert_eq!(actions(host.clone()).resolve_ref_point(REF).await, Ok(Point { x: 10.0, y: 20.0 }));
        host.finish().expect("a covered probe, then the point");
        let failed = Arc::new(FakeHost::scripted(vec![call(json!({"error": "transformed-frame"}))]));
        let error = actions(failed).resolve_ref_point(REF).await.expect_err("not retried");
        assert!(error.to_string().contains("transformed parent frame"));
    }

    #[test]
    fn a_refusal_keeps_the_reason_its_wait_recorded() {
        assert_eq!(reason_of("covered"), ActionabilityReason::Covered);
        assert_eq!(reason_of("not-editable"), ActionabilityReason::NotEditable);
        assert_eq!(reason_of("unheard of"), ActionabilityReason::Missing);
    }
}
