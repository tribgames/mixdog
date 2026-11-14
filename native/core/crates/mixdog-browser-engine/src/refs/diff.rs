//! Owner: s4-engine-refset
//! Semantic report comparison only (`diffSnapshotElements` of `snapshot-diff.ts`); never supplies identity for input recovery.

use std::collections::HashMap;
use std::collections::HashSet;

use mixdog_app_protocol::v2::browser_engine::BrowserSnapshotElement;

use super::ref_set::RefSet;
use super::ref_set::state_key;

/// An earlier element with no counterpart now, named so a reply can say what went away (a Start button, a spinner)
/// rather than only how many.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoneElement {
    pub role: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotDiff {
    pub changed: Vec<BrowserSnapshotElement>,
    /// The subset of `changed` the earlier observation never named at all. When that observation covered the whole page
    /// these are genuinely new; when it was capped or filtered they may be untouched elements it simply left out, which is
    /// why they are marked instead of merged into one "new" list.
    pub unseen: Vec<BrowserSnapshotElement>,
    pub unchanged: usize,
    pub gone: Vec<GoneElement>,
}

fn identity(role: &str, name: &str, href: &str) -> String {
    serde_json::json!([role, name, href]).to_string()
}

/// What changed in `elements` (the new observation) against the refs of the earlier observation `previous`.
pub fn snapshot_diff(previous: &RefSet, elements: &[BrowserSnapshotElement]) -> SnapshotDiff {
    let mut remaining: HashMap<String, usize> = HashMap::new();
    // Identities in the order the earlier observation first named them, with how many of each are still unmatched.
    let mut order: Vec<(String, String, String)> = Vec::new();
    let mut identities: HashMap<String, usize> = HashMap::new();
    let mut known: HashSet<String> = HashSet::new();
    for entry in previous.iter() {
        *remaining.entry(state_key(&entry.role, &entry.name, &entry.href, &entry.value, &entry.states)).or_default() += 1;
        let id = identity(&entry.role, &entry.name, &entry.href);
        if known.insert(id.clone()) {
            order.push((id.clone(), entry.role.clone(), entry.name.clone()));
        }
        *identities.entry(id).or_default() += 1;
    }
    let mut changed = Vec::new();
    let mut unseen = Vec::new();
    let mut unchanged = 0;
    for element in elements {
        let href = element.href.as_deref().unwrap_or_default();
        let value = element.value.as_deref().unwrap_or_default();
        let key = state_key(&element.role, &element.name, href, value, element.states.as_deref().unwrap_or_default());
        let id = identity(&element.role, &element.name, href);
        match remaining.get_mut(&key) {
            Some(left) if *left > 0 => {
                *left -= 1;
                unchanged += 1;
            }
            _ => {
                changed.push(element.clone());
                if !known.contains(&id) {
                    unseen.push(element.clone());
                }
            }
        }
        if let Some(count) = identities.get_mut(&id) {
            *count = count.saturating_sub(1);
        }
    }
    // A value or focus change is not a disappearance. Multiplicity still matters when controls have identical names;
    // these keys never authorize an action.
    let mut gone = Vec::new();
    for (id, role, name) in order {
        for _ in 0..identities.get(&id).copied().unwrap_or(0) {
            gone.push(GoneElement { role: role.clone(), name: name.clone() });
        }
    }
    SnapshotDiff { changed, unseen, unchanged, gone }
}

#[cfg(test)]
mod tests {
    use super::super::ref_set::tests::element;
    use super::super::ref_set::tests::payload;
    use super::*;

    fn stated(ref_id: &str, role: &str, name: &str, value: Option<&str>, states: &[&str]) -> BrowserSnapshotElement {
        let mut made = element(ref_id, role, name);
        made.value = value.map(str::to_string);
        made.states = Some(states.iter().map(|state| state.to_string()).collect());
        made
    }

    fn previous(elements: Vec<BrowserSnapshotElement>) -> RefSet {
        RefSet::from_payload("p-s1", &payload("p-s1", elements, "https://a.test/"))
    }

    #[test]
    fn state_ordering_and_refreshed_refs_are_not_changes_while_focus_and_values_remain_visible() {
        let set = previous(vec![
            stated("old1", "textbox", "Email", Some("a"), &["required", "focused"]),
            stated("old2", "button", "Save", None, &[]),
            stated("old3", "textbox", "Name", Some("before"), &[]),
        ]);
        let next = vec![
            stated("new1", "textbox", "Email", Some("a"), &["focused", "required"]),
            stated("new2", "button", "Save", None, &["focused"]),
            stated("new3", "textbox", "Name", Some("after"), &[]),
        ];
        let diff = snapshot_diff(&set, &next);
        assert_eq!(diff, SnapshotDiff { changed: vec![next[1].clone(), next[2].clone()], unseen: vec![], unchanged: 1, gone: vec![] });
    }

    #[test]
    fn duplicate_semantic_controls_preserve_multiplicity_and_true_removals_remain_reported() {
        let set = previous(vec![
            stated("old1", "button", "Item", None, &["disabled"]),
            stated("old2", "button", "Item", None, &[]),
            stated("old3", "button", "Removed", None, &[]),
        ]);
        let next = vec![stated("new1", "button", "Item", None, &[]), element("new2", "button", "Added")];
        let diff = snapshot_diff(&set, &next);
        assert_eq!(diff.changed, vec![next[1].clone()]);
        assert_eq!(diff.unseen, vec![next[1].clone()]);
        assert_eq!(diff.unchanged, 1);
        assert_eq!(
            diff.gone,
            vec![
                GoneElement { role: "button".into(), name: "Item".into() },
                GoneElement { role: "button".into(), name: "Removed".into() },
            ]
        );
    }
}
