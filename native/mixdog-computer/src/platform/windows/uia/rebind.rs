//! The element that stands in for a ref after its provider rebuilt the tree
//! (Find-ReboundElement): one enabled element of the same window with the
//! same role, name or automation id, and bounds the caller saw.

use super::element::{top_window, UiaElement};
use super::{control_type_id, property_condition, text, Uia};
use crate::a11y::Element;
use crate::platform::{window_id, Wid};
use crate::session::RefRecord;
use std::rc::Rc;
use windows::core::BSTR;
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::*;

/// How far each bounds value may drift and still be the same control.
const BOUNDS_SLACK: f64 = 2.0;

/// Whether `now` lies within the slack of the bounds the ref was handed out
/// with, on every side.
fn near(seen: (f64, f64, f64, f64), now: (f64, f64, f64, f64)) -> bool {
    (seen.0 - now.0).abs() <= BOUNDS_SLACK
        && (seen.1 - now.1).abs() <= BOUNDS_SLACK
        && (seen.2 - now.2).abs() <= BOUNDS_SLACK
        && (seen.3 - now.3).abs() <= BOUNDS_SLACK
}

/// The only item of `items`, none when there are none or several.
fn exactly_one<T>(items: Vec<T>) -> Option<T> {
    let mut items = items.into_iter();
    let first = items.next()?;
    items.next().is_none().then_some(first)
}

impl Uia {
    /// Find-ReboundElement: `None` leaves the ref stale.
    pub(super) fn rebound(&self, window: Wid, record: &RefRecord) -> Option<Rc<dyn Element>> {
        let seen = record.bounds?;
        if record.name.is_empty() && record.automation_id.is_empty() {
            return None;
        }
        let root = self.root_of(window).ok()?;
        // The name keys the search when there is one, else the automation id.
        let key = if record.name.is_empty() {
            property_condition(&self.automation, UIA_AutomationIdPropertyId, VARIANT::from(BSTR::from(record.automation_id.as_str())))
        } else {
            property_condition(&self.automation, UIA_NamePropertyId, VARIANT::from(BSTR::from(record.name.as_str())))
        }
        .ok()?;
        let kind = property_condition(&self.automation, UIA_ControlTypePropertyId, VARIANT::from(control_type_id(&record.role))).ok()?;
        // SAFETY: plain factory call, search and property reads on live elements.
        let matched = unsafe {
            let condition = self.automation.CreateAndCondition(&kind, &key).ok()?;
            let found = root.FindAll(TreeScope_Descendants, &condition).ok()?;
            let count = found.Length().ok()?;
            (0..count)
                .filter_map(|index| found.GetElement(index).ok())
                .filter(|candidate| {
                    let rect = candidate.CurrentBoundingRectangle().ok();
                    text(candidate.CurrentAutomationId()) == record.automation_id
                        && candidate.CurrentIsEnabled().is_ok_and(|flag| flag.as_bool())
                        && rect.is_some_and(|rect| {
                            near(
                                seen,
                                (rect.left as f64, rect.top as f64, (rect.right - rect.left) as f64, (rect.bottom - rect.top) as f64),
                            )
                        })
                })
                .collect::<Vec<_>>()
        };
        let element = exactly_one(matched)?;
        let top = top_window(&self.automation, &element);
        (window_id(top) == record.window_id).then(|| {
            Rc::new(UiaElement {
                automation: self.automation.clone(),
                element,
                window: top,
            }) as Rc<dyn Element>
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{exactly_one, near};

    #[test]
    fn bounds_may_drift_two_pixels_on_each_side_and_no_more() {
        let seen = (10.0, 20.0, 30.0, 40.0);
        assert!(near(seen, (12.0, 18.0, 32.0, 38.0)));
        assert!(!near(seen, (13.0, 20.0, 30.0, 40.0)));
        assert!(!near(seen, (10.0, 20.0, 30.0, 43.0)));
    }

    #[test]
    fn a_stand_in_is_the_only_match() {
        assert_eq!(exactly_one(vec![1]), Some(1));
        assert_eq!(exactly_one(Vec::<i32>::new()), None);
        assert_eq!(exactly_one(vec![1, 2]), None);
    }
}
