//! Window predicate and readiness reads (Get-WindowPredicates,
//! Probe-WindowAccessibility): every name, value and visible line of a
//! window, and whether it exposes any interactive element. Neither touches
//! the session's refs.

use super::super::msaa::{self, MsaaNode};
use super::super::native;
use super::snapshot::{cached_flag, cached_supported, variant_text, CHROMIUM_PREFIX};
use super::{any_of, control_type_id, property_condition, role_of, Uia};
use crate::a11y::{
    format_value, integrity_refusal, is_interactive, PredicateObservation, PredicateRead,
    INTERACTIVE_ROLES,
};
use crate::platform::WindowInfo;
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::WindowsAndMessaging::OBJID_CLIENT;

/// The roles whose value a predicate reads; elsewhere a value repeats the
/// name or is a number nobody waits on.
const VALUE_ROLES: [&str; 4] = ["Edit", "ComboBox", "Document", "Spinner"];

/// The nodes the readiness probe reads from MSAA.
const PROBE_MSAA_LIMIT: usize = 200;

/// What one UI Automation element gave a predicate read. `None` is a text
/// its provider did not serve.
struct Texts {
    role: &'static str,
    name: Option<String>,
    value: Option<String>,
    /// The visible lines of a text surface; empty for any other element.
    lines: Option<Vec<String>>,
    enabled: bool,
}

/// A predicate's value for an element whose value pattern served `supported`
/// and reports itself `available`: "" for a role whose value is not read,
/// `None` for a value that exists and could not be read.
fn value_text(role: &str, supported: Option<String>, available: bool) -> Option<String> {
    if !VALUE_ROLES.contains(&role) {
        return Some(String::new());
    }
    match supported {
        Some(value) => Some(value),
        None if available => None,
        None => Some(String::new()),
    }
}

/// Adds one element's texts in Get-WindowPredicates' order, each visible line
/// as its own observation before the element's name and value. Returns false
/// once the read is full.
fn observe(read: &mut PredicateRead, texts: Texts) -> bool {
    if texts.name.is_none() || texts.value.is_none() || texts.lines.is_none() {
        read.complete = false;
    }
    for line in texts.lines.unwrap_or_default() {
        if read.full() {
            return false;
        }
        read.add(texts.role, &line, "", texts.enabled);
    }
    let name = texts.name.unwrap_or_default();
    let value = texts.value.unwrap_or_default();
    if name.trim().is_empty() && value.trim().is_empty() {
        return true;
    }
    if read.full() {
        return false;
    }
    read.add(texts.role, &name, &value, texts.enabled);
    true
}

/// What the reads take from one MSAA node (MixMsaaNode's ControlType, Name,
/// Value, Enabled, and whether Width and Height give it an area).
#[derive(Default)]
struct MsaaSeen {
    role: String,
    name: String,
    value: String,
    enabled: bool,
    has_area: bool,
}

impl From<&MsaaNode> for MsaaSeen {
    fn from(node: &MsaaNode) -> MsaaSeen {
        MsaaSeen {
            role: node.control_type().to_string(),
            name: node.name.clone(),
            value: node.value.clone(),
            enabled: node.enabled(),
            has_area: node.w > 0 && node.h > 0,
        }
    }
}

/// The MSAA walk's size for a predicate read of `max` observations.
fn msaa_limit(max: usize) -> usize {
    (max * 5).clamp(100, 5000)
}

/// Appends the MSAA tree's names and values, which carry the controls UI
/// Automation leaves out. A failed or cut walk leaves the read incomplete.
fn append_msaa(read: &mut PredicateRead, walk: Result<(Vec<MsaaSeen>, bool), String>) {
    let (nodes, complete) = walk.unwrap_or_default();
    if !complete {
        read.complete = false;
    }
    for node in nodes {
        if read.full() {
            break;
        }
        if node.has_area {
            read.add(&format_value(&node.role, 100), &node.name, &node.value, node.enabled);
        }
    }
}

fn msaa_walk(window: &WindowInfo, maximum: usize) -> Result<(Vec<MsaaSeen>, bool), String> {
    let (nodes, complete) = msaa::snapshot(window.handle, &window.id(), maximum, OBJID_CLIENT.0)?;
    Ok((nodes.iter().map(MsaaSeen::from).collect(), complete))
}

/// The probe's answer from what each tree showed: UI Automation first, then
/// the roles of the MSAA nodes, read only when it is asked for.
fn probe_source(
    uia: bool,
    msaa_roles: impl FnOnce() -> Result<Vec<String>, String>,
) -> Result<Option<&'static str>, String> {
    if uia {
        return Ok(Some("uia"));
    }
    let legacy = msaa_roles()?.iter().any(|role| is_interactive(role));
    Ok(legacy.then_some("msaa"))
}

impl Uia {
    /// Get-WindowPredicates' cache set.
    fn predicate_cache(&self) -> windows::core::Result<IUIAutomationCacheRequest> {
        // SAFETY: plain factory and registration calls.
        unsafe {
            let cache = self.automation.CreateCacheRequest()?;
            for id in [
                UIA_NamePropertyId,
                UIA_ControlTypePropertyId,
                UIA_IsEnabledPropertyId,
                UIA_IsOffscreenPropertyId,
                UIA_IsValuePatternAvailablePropertyId,
                UIA_ValueValuePropertyId,
                UIA_IsTextPatternAvailablePropertyId,
                UIA_IsKeyboardFocusablePropertyId,
            ] {
                cache.AddProperty(id)?;
            }
            Ok(cache)
        }
    }

    fn texts(&self, element: &IUIAutomationElement, read_text: bool) -> Result<Texts, String> {
        // SAFETY: cached property reads on an element built with the
        // predicate cache.
        let (control_type, name, enabled) = unsafe {
            (
                element.CachedControlType(),
                element.CachedName(),
                element.CachedIsEnabled(),
            )
        };
        let role = control_type.map_or("Custom", |control_type| role_of(control_type.0));
        let valued = cached_flag(element, UIA_IsValuePatternAvailablePropertyId);
        let supported = cached_supported(element, UIA_ValueValuePropertyId);
        // A terminal or document body has no value: its visible lines are
        // what a predicate matches. Only a focusable surface is read, which
        // bounds the cost of one poll.
        let surface = read_text
            && !valued
            && cached_flag(element, UIA_IsKeyboardFocusablePropertyId)
            && cached_flag(element, UIA_IsTextPatternAvailablePropertyId);
        Ok(Texts {
            role,
            name: name.ok().map(|name| name.to_string()),
            value: value_text(role, supported.as_ref().map(variant_text), valued),
            lines: if surface {
                self.visible_lines(element)?
            } else {
                Some(Vec::new())
            },
            enabled: enabled.is_ok_and(|flag| flag.as_bool()),
        })
    }

    /// Get-WindowPredicates' element read: every on-screen descendant, since
    /// a role filter cannot prove a text absent, then the MSAA tree.
    pub(super) fn predicates(
        &self,
        window: &WindowInfo,
        max: usize,
    ) -> Result<(Vec<PredicateObservation>, bool), String> {
        if let Some(refusal) = integrity_refusal(&native::integrity(window.handle)) {
            return Err(refusal);
        }
        let root = self.root_of(window.handle)?;
        let to_error = |error: windows::core::Error| error.message();
        // SAFETY: a plain factory call.
        let everything = unsafe { self.automation.CreateTrueCondition() }.map_err(to_error)?;
        let cache = self.predicate_cache().map_err(to_error)?;
        // SAFETY: a plain cached search under the window's root.
        let found = unsafe { root.FindAllBuildCache(TreeScope_Descendants, &everything, &cache) }
            .map_err(to_error)?;
        // SAFETY: a plain length read.
        let count = unsafe { found.Length() }.map_err(to_error)?;
        let read_text = !window.class_name.starts_with(CHROMIUM_PREFIX);
        let mut read = PredicateRead::new(max);
        for index in 0..count {
            if read.full() {
                break;
            }
            // SAFETY: an index below the array's length.
            let Ok(element) = (unsafe { found.GetElement(index) }) else {
                read.complete = false;
                continue;
            };
            // SAFETY: a cached property read.
            if unsafe { element.CachedIsOffscreen() }.is_ok_and(|flag| flag.as_bool()) {
                continue;
            }
            if !observe(&mut read, self.texts(&element, read_text)?) {
                break;
            }
        }
        if read.observations.len() < max {
            append_msaa(&mut read, msaa_walk(window, msaa_limit(max)));
        }
        Ok((read.observations, read.complete))
    }

    /// Probe-WindowAccessibility: FindFirst stops at the first interactive
    /// element instead of walking the tree, and legacy controls that only
    /// publish MSAA still count.
    pub(super) fn readiness(&self, window: &WindowInfo) -> Result<Option<&'static str>, String> {
        if let Some(refusal) = integrity_refusal(&native::integrity(window.handle)) {
            return Err(refusal);
        }
        let root = self.root_of(window.handle)?;
        let to_error = |error: windows::core::Error| error.message();
        let mut conditions = Vec::new();
        for role in INTERACTIVE_ROLES {
            conditions.push(
                property_condition(&self.automation, UIA_ControlTypePropertyId, VARIANT::from(control_type_id(role)))
                    .map_err(to_error)?,
            );
        }
        let condition = any_of(&self.automation, conditions).map_err(to_error)?;
        // SAFETY: a plain search under the window's root.
        let uia = match unsafe { root.FindFirst(TreeScope_Descendants, &condition) } {
            Ok(_) => true,
            // A search that matched nothing succeeds with no element.
            Err(error) if error.code().is_ok() => false,
            Err(error) => return Err(to_error(error)),
        };
        probe_source(uia, || {
            let (nodes, _) = msaa_walk(window, PROBE_MSAA_LIMIT)?;
            Ok(nodes.into_iter().map(|node| node.role).collect())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(name: &str, value: &str, lines: &[&str]) -> Texts {
        Texts {
            role: "Document",
            name: Some(name.into()),
            value: Some(value.into()),
            lines: Some(lines.iter().map(|line| line.to_string()).collect()),
            enabled: true,
        }
    }

    fn seen(role: &str, name: &str, value: &str, has_area: bool) -> MsaaSeen {
        MsaaSeen {
            role: role.into(),
            name: name.into(),
            value: value.into(),
            enabled: false,
            has_area,
        }
    }

    fn names(read: &PredicateRead) -> Vec<&str> {
        read.observations.iter().map(|seen| seen.name.as_str()).collect()
    }

    #[test]
    fn a_value_is_read_only_for_the_four_value_roles() {
        for role in VALUE_ROLES {
            assert_eq!(value_text(role, Some("v".into()), false), Some("v".into()));
            assert_eq!(value_text(role, None, true), None);
            assert_eq!(value_text(role, None, false), Some(String::new()));
        }
        assert_eq!(value_text("Slider", Some("40".into()), true), Some(String::new()));
        assert_eq!(value_text("ListItem", None, true), Some(String::new()));
    }

    #[test]
    fn each_visible_line_is_its_own_observation_before_the_element() {
        let mut read = PredicateRead::new(10);
        assert!(observe(&mut read, texts("Terminal", "", &["$ make", "ok"])));
        assert_eq!(names(&read), ["$ make", "ok", "Terminal"]);
        assert!(read.observations.iter().all(|seen| seen.role == "Document" && seen.enabled));
        assert!(read.observations[0].value.is_empty());
        assert!(read.complete);
    }

    #[test]
    fn a_blank_element_adds_nothing_and_a_value_alone_is_kept() {
        let mut read = PredicateRead::new(10);
        assert!(observe(&mut read, texts(" ", "", &[])));
        assert!(read.observations.is_empty() && read.complete);
        assert!(observe(&mut read, texts("", "typed", &[])));
        assert_eq!(read.observations[0].value, "typed");
    }

    #[test]
    fn an_unserved_name_value_or_line_read_leaves_the_read_incomplete() {
        for broken in ["name", "value", "lines"] {
            let mut element = texts("label", "", &[]);
            match broken {
                "name" => element.name = None,
                "value" => element.value = None,
                _ => element.lines = None,
            }
            let mut read = PredicateRead::new(10);
            assert!(observe(&mut read, element));
            assert!(!read.complete, "{broken}");
            assert_eq!(read.observations.len(), usize::from(broken != "name"));
        }
    }

    #[test]
    fn an_overlong_name_or_line_is_cut_and_leaves_the_read_incomplete() {
        let long = "x".repeat(201);
        let mut read = PredicateRead::new(10);
        assert!(observe(&mut read, texts(&long, "", &[])));
        assert_eq!(read.observations[0].name.chars().count(), 200);
        assert!(!read.complete);
        let mut read = PredicateRead::new(10);
        assert!(observe(&mut read, texts("", "", &[&long])));
        assert_eq!(read.observations[0].name.chars().count(), 200);
        assert!(!read.complete);
    }

    #[test]
    fn lines_count_toward_the_maximum_and_reaching_it_stops_the_read() {
        let mut read = PredicateRead::new(2);
        assert!(!observe(&mut read, texts("Terminal", "", &["a", "b", "c"])));
        assert_eq!(names(&read), ["a", "b"]);
        assert!(!read.complete);
        // Exactly filled with nothing left over is still a whole read.
        let mut read = PredicateRead::new(2);
        assert!(observe(&mut read, texts("", "", &["a", "b"])));
        assert!(read.complete);
        let mut read = PredicateRead::new(2);
        assert!(!observe(&mut read, texts("Terminal", "", &["a", "b"])));
        assert_eq!(names(&read), ["a", "b"]);
        assert!(!read.complete);
    }

    #[test]
    fn the_msaa_walk_is_sized_from_the_maximum() {
        assert_eq!(msaa_limit(1), 100);
        assert_eq!(msaa_limit(20), 100);
        assert_eq!(msaa_limit(400), 2000);
        assert_eq!(msaa_limit(1000), 5000);
    }

    #[test]
    fn msaa_nodes_with_an_area_and_a_text_are_appended() {
        let mut read = PredicateRead::new(10);
        append_msaa(
            &mut read,
            Ok((
                vec![
                    seen("Button", "OK", "", true),
                    seen("Button", "hidden", "", false),
                    seen("Pane", " ", "", true),
                    seen("Edit", "", "typed", true),
                ],
                true,
            )),
        );
        assert_eq!(names(&read), ["OK", ""]);
        assert_eq!(read.observations[1].value, "typed");
        assert!(!read.observations[0].enabled && read.observations[0].role == "Button");
        assert!(read.complete);
    }

    #[test]
    fn an_incomplete_failed_or_cut_msaa_read_leaves_the_read_incomplete() {
        let mut read = PredicateRead::new(10);
        append_msaa(&mut read, Ok((vec![seen("Button", "OK", "", true)], false)));
        assert_eq!(read.observations.len(), 1);
        assert!(!read.complete);

        let mut read = PredicateRead::new(10);
        append_msaa(&mut read, Err("MSAA tree depth exceeds 64".into()));
        assert!(read.observations.is_empty() && !read.complete);

        let mut read = PredicateRead::new(1);
        append_msaa(
            &mut read,
            Ok((vec![seen("Button", "a", "", true), seen("Button", "b", "", true)], true)),
        );
        assert_eq!(names(&read), ["a"]);
        assert!(!read.complete);

        let mut read = PredicateRead::new(10);
        append_msaa(&mut read, Ok((vec![seen("Text", &"x".repeat(201), "", true)], true)));
        assert!(!read.complete);
    }

    #[test]
    fn the_probe_answers_uia_then_msaa_then_none() {
        let unread = || -> Result<Vec<String>, String> { panic!("MSAA is read only without a UIA match") };
        assert_eq!(probe_source(true, unread), Ok(Some("uia")));
        let roles = |roles: &[&str]| Ok(roles.iter().map(|role| role.to_string()).collect());
        assert_eq!(probe_source(false, || roles(&["Pane", "Button"])), Ok(Some("msaa")));
        assert_eq!(probe_source(false, || roles(&["Pane", "Text"])), Ok(None));
        assert_eq!(probe_source(false, || roles(&[])), Ok(None));
        assert_eq!(probe_source(false, || Err("no MSAA".into())), Err("no MSAA".to_string()));
    }
}
