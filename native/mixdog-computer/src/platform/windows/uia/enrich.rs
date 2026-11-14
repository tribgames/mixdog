//! The MSAA nodes a snapshot adds to what UI Automation listed
//! (Snapshot-Window's MSAA enrichment, observation.ps1:484-501;
//! MixBoundedUia.MsaaSnapshot).

use super::super::bounded::Mta;
use super::super::msaa::{self, role_text, state_text, MsaaNode, MAXIMUM};
use super::super::msaa_element::MsaaElement;
use super::snapshot::CHROMIUM_PREFIX;
use super::{any_of, property_condition, root_from, Uia};
use crate::a11y::{truncation_warning, Node, NodeExtra, CANDIDATE_LIMIT};
use crate::platform::{Wid, WindowInfo};
use std::rc::Rc;
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::WindowsAndMessaging::OBJID_CLIENT;

/// The window classes UI Automation reports as plain panes in some dialogs
/// (Test-UnproxiedNativeControls).
const UNPROXIED_CLASSES: [&str; 13] = [
    "Button",
    "ComboBox",
    "ComboBoxEx32",
    "Edit",
    "ListBox",
    "SysListView32",
    "SysTreeView32",
    "SysTabControl32",
    "ToolbarWindow32",
    "msctls_trackbar32",
    "msctls_updown32",
    "SysLink",
    "SysDateTimePick32",
];

const SKIPPED_FOR_UIA: &str = "MSAA enrichment skipped: UIA supplied the bounded capture";
const SKIPPED_FOR_CHROMIUM: &str = "MSAA enrichment skipped: Chromium capture will use pixels or OCR";

/// The most nodes one read of the tree is asked for: a bounded capture needs
/// eight per element it may show, within 200..=5000.
fn maximum(bounded: bool, offset_plus_max: usize) -> usize {
    if bounded {
        offset_plus_max.saturating_mul(8).clamp(200, MAXIMUM)
    } else {
        MAXIMUM
    }
}

/// Whether a bounded capture leaves the MSAA tree unread, and the warning
/// that says so: Chromium draws its own controls, so its large tree is never
/// searched for native ones, and a capture UI Automation filled is searched
/// only when `unproxied` finds native controls it left out.
fn skip_warning(
    chromium: bool,
    uia_found: usize,
    unproxied: impl FnOnce() -> Result<bool, String>,
) -> Result<Option<&'static str>, String> {
    let skip = chromium || (uia_found > 0 && !unproxied()?);
    Ok(skip.then_some(if uia_found > 0 { SKIPPED_FOR_UIA } else { SKIPPED_FOR_CHROMIUM }))
}

/// How many MSAA nodes may be read after `prior` candidates: the two trees
/// share the ceiling, and a read that passes it is cut there.
fn room(prior: usize) -> usize {
    CANDIDATE_LIMIT.saturating_sub(prior)
}

/// A snapshot node for what MSAA read. The capabilities, and a list item's
/// value, come from the merge (Get-MsaaObservation).
fn node_of(node: MsaaNode) -> Node {
    let extra = NodeExtra {
        source: "msaa",
        native_role: role_text(node.role),
        native_state: state_text(node.state),
        default_action: node.default_action.clone(),
        description: node.description.clone(),
        ..NodeExtra::default()
    };
    Node {
        role: node.control_type().to_string(),
        name: node.name.clone(),
        automation_id: String::new(),
        value: node.value.clone(),
        toggle: String::new(),
        selected: String::new(),
        expanded: String::new(),
        range: String::new(),
        accelerator: String::new(),
        can_invoke: false,
        can_set_value: false,
        can_toggle: false,
        can_scroll: false,
        enabled: node.enabled(),
        offscreen: node.offscreen(),
        x: node.x as f64,
        y: node.y as f64,
        width: node.w as f64,
        height: node.h as f64,
        extra,
        element: Rc::new(MsaaElement::new(node)),
    }
}

impl Uia {
    /// Whether the window holds a pane of a native control class
    /// (Test-UnproxiedNativeControls); a provider error counts as none. The
    /// root is looked up inside the bounded stage, as the window answers it.
    fn has_unproxied_controls(&self, window: Wid) -> Result<bool, String> {
        let to_error = |error: windows::core::Error| error.message();
        let classes = UNPROXIED_CLASSES
            .iter()
            .map(|class| property_condition(&self.automation, UIA_ClassNamePropertyId, VARIANT::from(*class)))
            .collect::<Result<Vec<_>, _>>()
            .map_err(to_error)?;
        let classes = any_of(&self.automation, classes).map_err(to_error)?;
        let pane = property_condition(&self.automation, UIA_ControlTypePropertyId, VARIANT::from(UIA_PaneControlTypeId.0))
            .map_err(to_error)?;
        // SAFETY: plain factory call.
        let condition = unsafe { self.automation.CreateAndCondition(&pane, &classes) }.map_err(to_error)?;
        let probe = Mta::new((self.automation.clone(), condition));
        self.bounded("the native control probe", move || {
            let (automation, condition) = probe.get();
            let root = root_from(&automation, window)?;
            // SAFETY: a plain search; an error is no match.
            Ok(unsafe { root.FindFirst(TreeScope_Descendants, &condition) }.is_ok())
        })
    }

    /// `Accessibility::enrich`: the MSAA nodes of the window, read as one
    /// bounded stage, with how many candidates they were and the warning of a
    /// skipped read.
    pub(super) fn enrich_snapshot(
        &self,
        window: &WindowInfo,
        uia_found: usize,
        bounded: bool,
        offset_plus_max: usize,
        prior: usize,
    ) -> Result<(Vec<Node>, usize, Option<String>), String> {
        if bounded {
            let chromium = window.class_name.starts_with(CHROMIUM_PREFIX);
            if let Some(warning) =
                skip_warning(chromium, uia_found, || self.has_unproxied_controls(window.handle))?
            {
                return Ok((Vec::new(), 0, Some(warning.into())));
            }
        }
        let (handle, id) = (window.handle, window.id());
        let wanted = maximum(bounded, offset_plus_max);
        let room = room(prior);
        if room == 0 {
            return Ok((Vec::new(), 0, Some(truncation_warning())));
        }
        let read = self.bounded("the MSAA enrichment", move || {
            let (nodes, complete) = msaa::snapshot(handle, &id, wanted.min(room), OBJID_CLIENT.0)
                .map_err(|error| format!("MSAA snapshot failed for {id}: {error}"))?;
            Ok((complete, Mta::new(nodes)))
        })?;
        let (complete, nodes) = read;
        let nodes = nodes.get();
        let candidates = nodes.len();
        let cut = !complete && room <= wanted;
        Ok((nodes.into_iter().map(node_of).collect(), candidates, cut.then(truncation_warning)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bounded_read_asks_for_eight_nodes_per_element_within_the_limits() {
        assert_eq!(maximum(true, 10), 200);
        assert_eq!(maximum(true, 50), 400);
        assert_eq!(maximum(true, 10_000), 5000);
        assert_eq!(maximum(true, usize::MAX), 5000);
        assert_eq!(maximum(false, 10), 5000);
    }

    #[test]
    fn a_bounded_capture_skips_chromium_and_a_full_uia_read() {
        let never = || -> Result<bool, String> { panic!("the probe runs only for a UIA read of a native window") };
        assert_eq!(skip_warning(true, 0, never), Ok(Some(SKIPPED_FOR_CHROMIUM)));
        assert_eq!(skip_warning(true, 3, never), Ok(Some(SKIPPED_FOR_UIA)));
        assert_eq!(skip_warning(false, 0, never), Ok(None));
        assert_eq!(skip_warning(false, 3, || Ok(false)), Ok(Some(SKIPPED_FOR_UIA)));
        assert_eq!(skip_warning(false, 3, || Ok(true)), Ok(None));
        assert_eq!(skip_warning(false, 3, || Err("timed out".into())), Err("timed out".into()));
        assert_eq!(
            SKIPPED_FOR_UIA,
            "MSAA enrichment skipped: UIA supplied the bounded capture"
        );
        assert_eq!(
            SKIPPED_FOR_CHROMIUM,
            "MSAA enrichment skipped: Chromium capture will use pixels or OCR"
        );
    }

    #[test]
    fn the_candidates_of_both_trees_share_one_limit() {
        assert_eq!(room(4000), 1000);
        assert_eq!(room(5000), 0);
        assert_eq!(room(5001), 0);
    }
}
