//! Owner: s4-engine-refset
//! Finding the same element again in a fresh snapshot (`recoverBrowserRef` and `isBrowserStaleRefError` of
//! `ref-recovery.ts`). Read-only: it compares what two snapshots named and never acts, and it never crosses a navigation.

use super::ref_set::RefFingerprint;
use super::ref_set::RefSet;

/// What a search for a stale ref found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refind {
    /// The one element of the fresh snapshot that is the same.
    Found(String),
    /// Why recovery stopped.
    Stopped(String),
}

pub struct Recovery;

impl Recovery {
    /// One exact semantic match (role, name and link target) on the same page and URL, else why not.
    pub fn refind(source: &RefFingerprint, fresh: &RefSet) -> Refind {
        if source.url != fresh.url || page_id(&source.snapshot_id) != page_id(&fresh.snapshot_id) {
            return Refind::Stopped("the page or URL changed".into());
        }
        if source.name.is_empty() && source.href.is_empty() {
            return Refind::Stopped("the original element has no stable semantic name or link target".into());
        }
        let mut matches = fresh.iter().filter(|candidate| candidate.role == source.role && candidate.name == source.name && candidate.href == source.href);
        match (matches.next(), matches.next()) {
            (Some(only), None) => Refind::Found(only.ref_id.clone()),
            (None, _) => Refind::Stopped("no exact semantic match exists in the fresh snapshot".into()),
            (Some(_), Some(_)) => Refind::Stopped(format!("{} exact semantic matches are ambiguous", 2 + matches.count())),
        }
    }
}

/// The page part of a snapshot id: `p1-s4` (or `p1-S4`) is page `p1`.
pub fn page_id(snapshot_id: &str) -> &str {
    let Some(at) = snapshot_id.rfind('-') else { return snapshot_id };
    match snapshot_id[at + 1..].strip_prefix(['s', 'S']) {
        Some(digits) if !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()) => &snapshot_id[..at],
        _ => snapshot_id,
    }
}

/// Whether an error message says the node a ref named is gone (stale, detached, no such node or execution context), as
/// opposed to an ordinary failure of the action.
pub fn is_stale_ref_error(message: &str) -> bool {
    let text = message.to_lowercase();
    if ["stale", "detached"].iter().any(|word| has_word(&text, word)) {
        return true;
    }
    if ["no node with given id", "could not find node", "cannot find context with specified id"].iter().any(|phrase| text.contains(phrase)) {
        return true;
    }
    // `node[^\n]*not found`
    text.match_indices("node").any(|(at, _)| text[at + 4..].lines().next().is_some_and(|line| line.contains("not found")))
}

fn has_word(text: &str, word: &str) -> bool {
    let word_char = |c: char| c.is_alphanumeric() || c == '_';
    text.match_indices(word).any(|(at, _)| {
        !text[..at].chars().next_back().is_some_and(word_char) && !text[at + word.len()..].chars().next().is_some_and(word_char)
    })
}

#[cfg(test)]
mod tests {
    use mixdog_app_protocol::v2::browser_engine::BrowserSnapshotElement;

    use super::super::ref_set::tests::element;
    use super::super::ref_set::tests::payload;
    use super::*;

    const URL: &str = "https://example.test/app";

    fn set(snapshot_id: &str, elements: Vec<BrowserSnapshotElement>, url: &str) -> RefSet {
        RefSet::from_payload(snapshot_id, &payload(snapshot_id, elements, url))
    }

    #[test]
    fn one_exact_semantic_match_on_the_same_page_is_found() {
        let source = set("p1-s2", vec![element("p1-s2-e1", "button", "Continue")], URL);
        let mut help = element("p1-s3-e1", "link", "Help");
        help.href = Some("https://example.test/help".into());
        let mut cont = element("p1-s3-e2", "button", "Continue");
        cont.states = Some(vec!["focused".into()]);
        let fresh = set("p1-s3", vec![help, cont], URL);
        assert_eq!(Recovery::refind(source.get("p1-s2-e1").unwrap(), &fresh), Refind::Found("p1-s3-e2".into()));
    }

    #[test]
    fn recovery_stops_on_ambiguity_navigation_or_missing_identity() {
        let source = set("p2-s4", vec![element("p2-s4-e1", "button", "Delete"), element("p2-s4-e2", "textbox", "")], URL);
        let ambiguous = set("p2-s5", vec![element("p2-s5-e1", "button", "Delete"), element("p2-s5-e2", "button", "Delete")], URL);
        let stopped = |found: Refind| match found {
            Refind::Stopped(reason) => reason,
            Refind::Found(found) => panic!("found {found}"),
        };
        let delete = source.get("p2-s4-e1").unwrap();
        assert!(stopped(Recovery::refind(delete, &ambiguous)).contains("ambiguous"));
        assert_eq!(stopped(Recovery::refind(delete, &set("p2-s5", vec![], "https://example.test/other"))), "the page or URL changed");
        assert_eq!(stopped(Recovery::refind(delete, &set("p9-s5", vec![], URL))), "the page or URL changed");
        assert!(stopped(Recovery::refind(source.get("p2-s4-e2").unwrap(), &ambiguous)).contains("no stable semantic name"));
        assert!(stopped(Recovery::refind(delete, &set("p2-s5", vec![], URL))).contains("no exact semantic match"));
    }

    #[test]
    fn stale_ref_classification_excludes_ordinary_action_failures() {
        assert!(is_stale_ref_error("Node with given id not found"));
        assert!(is_stale_ref_error("ref p1-s1-e1 is detached"));
        assert!(is_stale_ref_error("the snapshot is stale"));
        assert!(is_stale_ref_error("Cannot find context with specified id"));
        assert!(!is_stale_ref_error("element is disabled"));
        assert!(!is_stale_ref_error("navigation timed out"));
        assert!(!is_stale_ref_error("unstable detachedness"));
    }

    #[test]
    fn the_page_id_drops_a_trailing_snapshot_counter() {
        assert_eq!(page_id("p1-s12"), "p1");
        assert_eq!(page_id("p1-s"), "p1-s");
        assert_eq!(page_id("p1"), "p1");
        assert_eq!(page_id("p-s1-S2"), "p-s1");
    }
}
