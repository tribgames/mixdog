//! Owner: s4-engine-refset
//! The refs one snapshot named, kept as fingerprints (`BrowserRefSet` of `ref-recovery.ts`). The core never sees a
//! backend node id: a ref is resolved by the host on `host/browser/ref/call`, and what the engine keeps of an element is
//! only what recovery and change reports compare.

use std::collections::HashMap;

use mixdog_app_protocol::v2::browser_engine::BrowserSnapshotElement;
use mixdog_app_protocol::v2::browser_engine::BrowserSnapshotPayload;

/// What a secret field that holds a value is remembered as (a filling is still a change to report; the secret is not kept).
const REDACTED_VALUE: &str = "[REDACTED]";

/// One element of a snapshot as it was named.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefFingerprint {
    /// The public ref id the agent addresses.
    pub ref_id: String,
    pub snapshot_id: String,
    pub url: String,
    pub role: String,
    pub name: String,
    pub href: String,
    /// Value and states are remembered for change reports, not for recovery.
    pub value: String,
    pub states: Vec<String>,
    /// The snapshot marked it a secret field (a password or protected input).
    pub sensitive: bool,
}

impl RefFingerprint {
    fn from_element(snapshot_id: &str, url: &str, element: &BrowserSnapshotElement) -> Self {
        let value = match element.value.as_deref() {
            Some(value) if !value.is_empty() => value.to_string(),
            _ if element.filled == Some(true) => REDACTED_VALUE.to_string(),
            _ => String::new(),
        };
        Self {
            ref_id: element.ref_id.clone(),
            snapshot_id: snapshot_id.to_string(),
            url: url.to_string(),
            role: element.role.clone(),
            name: element.name.clone(),
            href: element.href.clone().unwrap_or_default(),
            value,
            states: element.states.clone().unwrap_or_default(),
            sensitive: element.sensitive == Some(true),
        }
    }
}

/// A key that treats two elements as the same thing in the same state (`browserRefStateKey`): role, name, link target,
/// value and the states in any order.
pub fn state_key(role: &str, name: &str, href: &str, value: &str, states: &[String]) -> String {
    let mut sorted: Vec<&str> = states.iter().map(String::as_str).collect();
    sorted.sort_unstable();
    serde_json::json!([role, name, href, value, sorted]).to_string()
}

/// The refs of one snapshot of one page.
#[derive(Debug, Clone, PartialEq)]
pub struct RefSet {
    pub snapshot_id: String,
    /// The document the snapshot was taken of (`host/browser/snapshot` result); empty when unknown.
    pub document_id: String,
    /// The document revision of the snapshot, when the host gave one.
    pub revision: Option<u32>,
    pub url: String,
    pub viewport_width: f64,
    pub viewport_height: f64,
    /// How much of the page this observation actually reported. A capped or filtered snapshot is not the whole page, so a
    /// later comparison against it has to say that what it never covered is unseen, not newly arrived.
    pub covered_elements: usize,
    pub total_elements: u32,
    pub query: Option<String>,
    refs: Vec<RefFingerprint>,
    index: HashMap<String, usize>,
}

impl RefSet {
    /// `createBrowserRefSet`: every element of the payload under its public ref id, in payload order (a repeated id
    /// keeps its first place and the last element).
    pub fn from_payload(snapshot_id: &str, payload: &BrowserSnapshotPayload) -> Self {
        let mut set = Self {
            snapshot_id: snapshot_id.to_string(),
            document_id: String::new(),
            revision: None,
            url: payload.url.clone(),
            viewport_width: payload.viewport_width,
            viewport_height: payload.viewport_height,
            covered_elements: payload.elements.len(),
            total_elements: payload.total_elements,
            query: (!payload.query.is_empty()).then(|| payload.query.clone()),
            refs: Vec::with_capacity(payload.elements.len()),
            index: HashMap::with_capacity(payload.elements.len()),
        };
        for element in &payload.elements {
            let fingerprint = RefFingerprint::from_element(snapshot_id, &payload.url, element);
            match set.index.get(&fingerprint.ref_id) {
                Some(&at) => set.refs[at] = fingerprint,
                None => {
                    set.index.insert(fingerprint.ref_id.clone(), set.refs.len());
                    set.refs.push(fingerprint);
                }
            }
        }
        set
    }

    /// The document and revision the host reported with the snapshot.
    pub fn with_document(mut self, document_id: &str, revision: u32) -> Self {
        self.document_id = document_id.to_string();
        self.revision = Some(revision);
        self
    }

    /// The fingerprint a public ref id names, if this snapshot named it.
    pub fn get(&self, ref_id: &str) -> Option<&RefFingerprint> {
        self.index.get(ref_id).map(|&at| &self.refs[at])
    }

    /// The fingerprints in snapshot order.
    pub fn iter(&self) -> impl Iterator<Item = &RefFingerprint> {
        self.refs.iter()
    }

    pub fn len(&self) -> usize {
        self.refs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.refs.is_empty()
    }

    /// A document change (the page now shows another document than the one this snapshot was taken of) ends every ref of
    /// it: they name nodes that are gone. Returns whether anything was dropped; a set of an unknown document is kept.
    pub fn invalidate_on(&mut self, document_id: &str) -> bool {
        if self.document_id.is_empty() || self.document_id == document_id {
            return false;
        }
        let dropped = !self.refs.is_empty();
        self.refs.clear();
        self.index.clear();
        dropped
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn element(ref_id: &str, role: &str, name: &str) -> BrowserSnapshotElement {
        BrowserSnapshotElement {
            ref_id: ref_id.into(),
            role: role.into(),
            name: name.into(),
            tag: "ax".into(),
            href: None,
            value: None,
            sensitive: None,
            filled: None,
            states: None,
            in_viewport: None,
            depth: None,
            match_field: None,
        }
    }

    pub(crate) fn payload(snapshot_id: &str, elements: Vec<BrowserSnapshotElement>, url: &str) -> BrowserSnapshotPayload {
        BrowserSnapshotPayload {
            snapshot_id: snapshot_id.into(),
            url: url.into(),
            title: "Example".into(),
            scroll_y: 0.0,
            scroll_height: 900.0,
            viewport_width: 1280.0,
            viewport_height: 900.0,
            total_elements: elements.len() as u32,
            scanned: elements.len() as u32,
            scan_capped: false,
            cross_origin_frames: 0,
            headings: Vec::new(),
            text: String::new(),
            text_clipped: None,
            query: String::new(),
            unfiltered_elements: None,
            warnings: None,
            elements,
        }
    }

    #[test]
    fn a_ref_set_keeps_public_ids_in_order_and_a_secret_only_as_filled() {
        let mut secret = element("p-s1-e2", "textbox", "Password");
        secret.sensitive = Some(true);
        secret.filled = Some(true);
        let mut loaded = payload("p-s1", vec![element("p-s1-e1", "button", "Go"), secret], "https://a.test/");
        loaded.query = "go".into();
        let set = RefSet::from_payload("p-s1", &loaded).with_document("d1", 4);
        assert_eq!(set.iter().map(|entry| entry.ref_id.as_str()).collect::<Vec<_>>(), ["p-s1-e1", "p-s1-e2"]);
        assert_eq!(set.get("p-s1-e2").map(|entry| (entry.value.as_str(), entry.sensitive)), Some(("[REDACTED]", true)));
        assert_eq!((set.revision, set.covered_elements, set.total_elements, set.query.as_deref()), (Some(4), 2, 2, Some("go")));
        assert!(set.get("p-s1-e3").is_none());
    }

    #[test]
    fn a_document_change_drops_the_refs_of_the_old_document_only() {
        let loaded = payload("p-s1", vec![element("p-s1-e1", "button", "Go")], "https://a.test/");
        let mut set = RefSet::from_payload("p-s1", &loaded).with_document("d1", 1);
        assert!(!set.invalidate_on("d1"));
        assert_eq!(set.len(), 1);
        assert!(set.invalidate_on("d2"));
        assert!(set.is_empty() && set.get("p-s1-e1").is_none());
        let mut unknown = RefSet::from_payload("p-s1", &loaded);
        assert!(!unknown.invalidate_on("d2"));
        assert_eq!(unknown.len(), 1);
    }

    #[test]
    fn the_state_key_ignores_the_order_of_states() {
        let a = state_key("textbox", "Email", "", "a", &["required".into(), "focused".into()]);
        let b = state_key("textbox", "Email", "", "a", &["focused".into(), "required".into()]);
        assert_eq!(a, b);
        assert_ne!(a, state_key("textbox", "Email", "", "b", &["focused".into(), "required".into()]));
    }
}
