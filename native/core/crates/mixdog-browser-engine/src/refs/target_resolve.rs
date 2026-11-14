//! Owner: s4-engine-target-points
//! Snapshot-free element targeting (`target-resolve.ts`). A caller that already knows what it wants ("the Save button", "the
//! Email field") names it by role and accessible name or by a CSS selector; the engine takes the observation itself, insists
//! on exactly one match, and hands back a live ref. An ambiguous target fails with its candidates and their fresh refs, so the
//! next call can pick one without another observation.
//!
//! One call here is one attempt: a target that matched nothing is [`TargetError::Missing`], the refusal a wait may outlast
//! (`settle::actionability` repeats the whole resolution on a new observation); every other failure is final.
//!
//! A selector is read in the top document. A match the page-side ref table lists keeps that ref and one it does not gets a
//! minted `<snapshot>-t<n>` ref (a DOM-ref page). Where the host's refs are accessibility refs the page cannot mint one, so a
//! selector there names the elements the snapshot lists: each candidate is asked, through `host/browser/ref/call`, whether it
//! is a top-document match.

use std::fmt;

use mixdog_app_protocol::v2::browser_engine::BrowserSnapshotElement;
use mixdog_app_protocol::v2::browser_engine::BrowserSnapshotMode;
use mixdog_app_protocol::v2::browser_engine::HostBrowserPageEvalParams;
use mixdog_app_protocol::v2::browser_engine::HostBrowserRefMintParams;
use mixdog_app_protocol::v2::browser_engine::HostBrowserSnapshotParams;
use mixdog_app_protocol::v2::browser_engine::HostBrowserSnapshotResult;
use mixdog_app_protocol::v2::browser_engine::Precondition;
use mixdog_browser_policy::redaction::redact_browser_text;
use mixdog_js::is_js_space;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_words;
use mixdog_js::utf16_len;
use mixdog_rt::CancellationToken;
use serde::Deserialize;
use serde_json::Value;

use super::access::ActionabilityReason;
use super::access::RefError;
use crate::error::HostCallError;
use crate::limits::CDP_REQUEST_TIMEOUT;
use crate::limits::SNAPSHOT_TOOL_MAX_ELEMENTS;
use crate::port::BrowserHost;

const TARGET_FIELDS: [&str; 5] = ["role", "name", "selector", "exact", "nth"];
const MAX_SELECTOR_MATCHES: usize = 50;
const MAX_LISTED_CANDIDATES: usize = 8;

/// A selector query in the top document. Matches the page-side ref table lists keep their ref; with that table current, the
/// others get one minted. Without it (a page whose refs come from the accessibility tree) the query only counts and validates:
/// the host names and mints the refs (`host/browser/ref/mint`).
const SELECTOR_QUERY: &str = r##"(() => {
  const snapshot = window.__mixdogAgentSnapshot;
  const table = Boolean(snapshot && snapshot.id === __SNAPSHOT_ID__);
  let nodes;
  try { nodes = document.querySelectorAll(__SELECTOR__); } catch (error) { return { invalid: String(error && error.message || error) }; }
  if (nodes.length > __LIMIT__) return { count: nodes.length };
  const compact = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 120);
  const matches = [];
  for (const element of nodes) {
    let ref = null;
    if (table) {
      for (const [key, record] of snapshot.refs) {
        if ((record && record.element) === element || record === element) { ref = key; break; }
      }
      if (!ref) {
        snapshot.minted = (snapshot.minted || 0) + 1;
        ref = snapshot.id + '-t' + snapshot.minted;
        snapshot.refs.set(ref, { element, frames: [] });
      }
    }
    matches.push({
      ref,
      role: compact(element.getAttribute('role') || element.tagName).toLowerCase(),
      name: compact(element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || element.id),
    });
  }
  return { count: nodes.length, table, matches };
})()"##;

/// What a target names: role, accessible name and/or a CSS selector, with how to pick among several matches.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TargetSpec {
    /// ARIA role as the snapshot prints it, lower case.
    pub role: Option<String>,
    /// Accessible name: label, placeholder, or visible text. A substring unless `exact`.
    pub name: Option<String>,
    /// CSS selector in the top document; matches need not be interactive.
    pub selector: Option<String>,
    pub exact: bool,
    /// 1-based pick among several matches, in snapshot order.
    pub nth: Option<u32>,
}

/// Why a target was not resolved.
#[derive(Debug, Clone, PartialEq)]
pub enum TargetError {
    /// The target itself is not valid (a malformed spec, a selector the page rejects).
    Invalid(String),
    /// No element matched (yet): the refusal a wait may outlast.
    Missing(String),
    /// Several elements matched: the message lists them, `candidates` carries them with their fresh refs.
    Ambiguous { message: String, candidates: Vec<BrowserSnapshotElement> },
    /// Anything else that ended the resolution for good.
    Failed(String),
    Host(HostCallError),
}

impl TargetError {
    /// [`ActionabilityReason::Missing`] for a target that matched nothing, the only error a wait can outlast.
    pub fn reason(&self) -> Option<ActionabilityReason> {
        matches!(self, Self::Missing(_)).then_some(ActionabilityReason::Missing)
    }
}

impl fmt::Display for TargetError {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) | Self::Missing(message) | Self::Failed(message) | Self::Ambiguous { message, .. } => out.write_str(message),
            Self::Host(error) => fmt::Display::fmt(error, out),
        }
    }
}

impl std::error::Error for TargetError {}

impl From<HostCallError> for TargetError {
    fn from(error: HostCallError) -> Self {
        Self::Host(error)
    }
}

impl From<RefError> for TargetError {
    fn from(error: RefError) -> Self {
        match error {
            RefError::Host(error) => Self::Host(error),
            RefError::Refused { message, .. } | RefError::Failed(message) => Self::Failed(message),
        }
    }
}

/// `compact`: runs of white space become one space and the ends are trimmed.
fn compact(value: &str) -> String {
    js_words(value).collect::<Vec<_>>().join(" ")
}

/// `/^\/.+\/[a-z]*$/s`: a name written as a regular expression is not a plain name to narrow the observation with.
fn regex_shaped(name: &str) -> bool {
    let Some(rest) = name.strip_prefix('/') else { return false };
    rest.char_indices().any(|(at, c)| c == '/' && at > 0 && rest[at + 1..].bytes().all(|byte| byte.is_ascii_lowercase()))
}

fn json_string(value: &str) -> String {
    let mut out = String::new();
    mixdog_js::json_quote(value, &mut out);
    out
}

/// A string field of a target, empty when absent, or why it is not one.
fn text_field<'a>(input: &'a serde_json::Map<String, Value>, key: &str, limit: usize) -> Result<&'a str, String> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(""),
        Some(Value::String(value)) if utf16_len(value) <= limit => Ok(value),
        Some(_) => Err(format!("target.{key} must be a string of at most {limit} characters")),
    }
}

impl TargetSpec {
    /// `normalizeBrowserTarget`: the spec a raw target object says, or why it is not one.
    pub fn normalize(raw: &Value) -> Result<Self, String> {
        let Some(input) = raw.as_object() else { return Err("target must be an object with role, name, and/or selector".to_string()) };
        let unknown: Vec<&str> = input.keys().map(String::as_str).filter(|key| !TARGET_FIELDS.contains(key)).collect();
        if !unknown.is_empty() {
            return Err(format!("target does not accept field(s): {}", unknown.join(", ")));
        }
        let mut spec = Self::default();
        let role = js_to_lowercase(&compact(text_field(input, "role", 60)?));
        if !role.is_empty() {
            spec.role = Some(role);
        }
        let name = compact(text_field(input, "name", 500)?);
        if !name.is_empty() {
            spec.name = Some(name);
        }
        // Whitespace inside a CSS string or escaped identifier is significant.
        let selector = text_field(input, "selector", 4096)?;
        if !selector.trim_matches(is_js_space).is_empty() {
            spec.selector = Some(selector.to_string());
        }
        if let Some(exact) = input.get("exact") {
            spec.exact = exact.as_bool().ok_or("target.exact must be a boolean")?;
        }
        if let Some(nth) = input.get("nth") {
            let whole = nth.as_f64().filter(|value| value.fract() == 0.0 && (1.0..=500.0).contains(value));
            spec.nth = Some(whole.ok_or("target.nth must be an integer from 1 to 500")? as u32);
        }
        if spec.role.is_none() && spec.name.is_none() && spec.selector.is_none() {
            return Err("target requires role, name, and/or selector".to_string());
        }
        if spec.exact && spec.name.is_none() {
            return Err("target.exact applies to target.name".to_string());
        }
        Ok(spec)
    }

    /// `describeBrowserTarget`: the target as a reply names it, redacted.
    pub fn describe(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        if let Some(role) = &self.role {
            parts.push(role.clone());
        }
        if let Some(name) = &self.name {
            parts.push(format!("{}{}", json_string(&redact_browser_text(name)), if self.exact { " (exact)" } else { "" }));
        }
        if let Some(selector) = &self.selector {
            parts.push(format!("selector {}", json_string(&redact_browser_text(selector))));
        }
        if let Some(nth) = self.nth {
            parts.push(format!("#{nth}"));
        }
        parts.join(" ")
    }

    fn role_matches(&self, element: &BrowserSnapshotElement) -> bool {
        self.role.as_deref().is_none_or(|role| js_to_lowercase(&compact(&element.role)) == role)
    }

    fn name_matches(&self, element: &BrowserSnapshotElement) -> bool {
        let Some(wanted) = &self.name else { return true };
        let name = compact(&element.name);
        if self.exact { &name == wanted } else { js_to_lowercase(&name).contains(&js_to_lowercase(wanted)) }
    }
}

/// `candidateLine`: one element as a candidate list shows it, with the ref the next call can act on.
fn candidate_line(element: &BrowserSnapshotElement) -> String {
    let mut parts = vec![
        format!("[{}]{}", element.ref_id, if element.in_viewport == Some(true) { "*" } else { "" }),
        redact_browser_text(&element.role),
        json_string(&redact_browser_text(&element.name)),
    ];
    if let Some(href) = element.href.as_deref().filter(|href| !href.is_empty()) {
        parts.push(format!("href={}", redact_browser_text(href)));
    }
    if let Some(value) = element.value.as_deref().filter(|value| !value.is_empty()) {
        parts.push(format!("value={}", json_string(&redact_browser_text(value))));
    }
    if let Some(states) = element.states.as_ref().filter(|states| !states.is_empty()) {
        parts.push(redact_browser_text(&states.join(",")));
    }
    parts.join(" ")
}

fn list_candidates(elements: &[&BrowserSnapshotElement]) -> String {
    let mut shown: Vec<String> = elements.iter().take(MAX_LISTED_CANDIDATES).map(|element| candidate_line(element)).collect();
    if elements.len() > shown.len() {
        shown.push(format!("\u{2026} and {} more", elements.len() - shown.len()));
    }
    shown.join("\n")
}

/// `selectBrowserTarget`: the one element a target names among the candidates. Several matches are accepted only when
/// exactly one carries the name verbatim or `nth` picks. `unfiltered` is how many candidates the observation had before it
/// was narrowed, when it says.
pub fn select_target<'a>(spec: &TargetSpec, elements: &'a [BrowserSnapshotElement], unfiltered: Option<usize>) -> Result<&'a BrowserSnapshotElement, TargetError> {
    let by_role: Vec<&BrowserSnapshotElement> = elements.iter().filter(|element| spec.role_matches(element)).collect();
    let matches: Vec<&BrowserSnapshotElement> = by_role.iter().copied().filter(|element| spec.name_matches(element)).collect();
    let described = spec.describe();
    if matches.is_empty() {
        let mut same_role = String::new();
        if let (Some(role), false) = (&spec.role, by_role.is_empty()) {
            let listed: Vec<String> = by_role.iter().take(MAX_LISTED_CANDIDATES).map(|element| json_string(&redact_browser_text(&element.name))).collect();
            let more = if by_role.len() > MAX_LISTED_CANDIDATES { ", \u{2026}" } else { "" };
            same_role = format!(" Elements with role {role}: {}{more}.", listed.join(", "));
        }
        return Err(TargetError::Missing(format!(
            "no element matched target {described} among {} candidate element(s).{same_role} Loosen the target or take a snapshot to read the page.",
            unfiltered.unwrap_or(elements.len())
        )));
    }
    if let Some(nth) = spec.nth {
        let nth = nth as usize;
        return match matches.get(nth - 1) {
            Some(&element) => Ok(element),
            None => Err(TargetError::Missing(format!("target {described} asked for match #{nth} but only {} matched:\n{}", matches.len(), list_candidates(&matches)))),
        };
    }
    if let [only] = matches.as_slice() {
        return Ok(*only);
    }
    let wanted = spec.name.as_deref().map(js_to_lowercase);
    if let Some(wanted) = &wanted {
        let mut verbatim = matches.iter().copied().filter(|element| &js_to_lowercase(&compact(&element.name)) == wanted);
        if let (Some(only), None) = (verbatim.next(), verbatim.next()) {
            return Ok(only);
        }
    }
    // Suggest only the refinements this target does not already use.
    let mut refinements = vec!["nth"];
    if spec.name.is_some() && !spec.exact {
        refinements.push("exact:true");
    }
    if spec.role.is_none() {
        refinements.push("a role");
    }
    let last = refinements.pop().unwrap_or("nth");
    let hint = if refinements.is_empty() { last.to_string() } else { format!("{} or {last}", refinements.join(", ")) };
    Err(TargetError::Ambiguous {
        message: format!("target {described} matched {} elements; add {hint}, or act on one of these refs from the fresh snapshot:\n{}", matches.len(), list_candidates(&matches)),
        candidates: matches.into_iter().cloned().collect(),
    })
}

/// What a selector query found in the page.
#[derive(Default, Deserialize)]
#[serde(default)]
struct SelectorReport {
    invalid: Option<String>,
    count: usize,
    table: bool,
    matches: Vec<SelectorMatch>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct SelectorMatch {
    #[serde(rename = "ref")]
    ref_id: Option<String>,
    role: String,
    name: String,
}

/// A selector match the snapshot did not list, as an element carrying its minted ref.
fn css_element(ref_id: String, role: String, name: String) -> BrowserSnapshotElement {
    BrowserSnapshotElement { ref_id, role, name, tag: "css".to_string(), href: None, value: None, sensitive: None, filled: None, states: None, in_viewport: None, depth: None, match_field: None }
}

/// Where a resolution runs: the host, the page, the guard its calls carry and the cancel that ends them.
pub struct TargetContext<'a> {
    pub host: &'a dyn BrowserHost,
    pub page_id: &'a str,
    pub expect: Option<&'a Precondition>,
    pub cancel: &'a CancellationToken,
}

/// A target resolved to a live ref.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedTarget {
    pub ref_id: String,
    pub description: String,
    /// The snapshot the ref belongs to.
    pub snapshot_id: String,
    /// Set when the ref was minted for a selector match the snapshot did not list: the caller adds it to the page's ref set.
    pub minted: Option<BrowserSnapshotElement>,
}

/// `selectorCandidates`: the elements a selector names, with how many nodes the page matched. The count is final past the
/// limit: a truncated list would hide a second match.
async fn selector_candidates(cx: &TargetContext<'_>, selector: &str, snapshot: &HostBrowserSnapshotResult) -> Result<(Vec<BrowserSnapshotElement>, usize), TargetError> {
    let expression = SELECTOR_QUERY
        .replace("__LIMIT__", &MAX_SELECTOR_MATCHES.to_string())
        .replace("__SNAPSHOT_ID__", &json_string(&snapshot.snapshot_id))
        .replace("__SELECTOR__", &json_string(selector));
    let params = HostBrowserPageEvalParams {
        page_id: cx.page_id.to_string(),
        expression,
        frame: None,
        await_promise: None,
        return_by_value: Some(true),
        world: None,
        timeout_ms: u32::try_from(CDP_REQUEST_TIMEOUT.as_millis()).unwrap_or(u32::MAX),
        expect: cx.expect.cloned(),
        check_unchanged: None,
    };
    let answer = cx.host.page_eval(params, cx.cancel).await?;
    if let Some(exception) = answer.exception {
        return Err(TargetError::Failed(exception.text));
    }
    let report: SelectorReport =
        serde_json::from_value(answer.value.unwrap_or(Value::Null)).map_err(|_| TargetError::Failed("the page did not answer the selector query".to_string()))?;
    if let Some(reason) = report.invalid {
        return Err(TargetError::Invalid(format!("target.selector is not a valid CSS selector: {}", redact_browser_text(&reason))));
    }
    if report.count > MAX_SELECTOR_MATCHES {
        return Err(TargetError::Failed(format!(
            "target.selector matched {} elements, exceeding the limit of {MAX_SELECTOR_MATCHES}; narrow target.selector before acting",
            report.count
        )));
    }
    let listed = &snapshot.payload.elements;
    if report.table {
        let candidates: Vec<BrowserSnapshotElement> = report
            .matches
            .into_iter()
            .filter_map(|found| {
                let ref_id = found.ref_id?;
                Some(listed.iter().find(|element| element.ref_id == ref_id).cloned().unwrap_or_else(|| css_element(ref_id, found.role, found.name)))
            })
            .collect();
        return Ok((candidates, report.count));
    }
    // The refs of the nodes the selector names, in document order: a node the snapshot lists keeps its ref, any other gets one
    // minted in the host's ref table, which `ref/call` and the pointer then resolve like a listed one.
    let params = HostBrowserRefMintParams {
        page_id: cx.page_id.to_string(),
        snapshot_id: snapshot.snapshot_id.clone(),
        selector: selector.to_string(),
        limit: u32::try_from(MAX_SELECTOR_MATCHES).unwrap_or(u32::MAX),
        expect: cx.expect.cloned(),
    };
    let minted = match cx.host.ref_mint(params, cx.cancel).await {
        Ok(minted) => minted,
        Err(HostCallError::StaleSnapshot) => return Err(TargetError::Failed("the page changed while resolving the target; try again".to_string())),
        Err(error) => return Err(error.into()),
    };
    if let Some(reason) = minted.invalid {
        return Err(TargetError::Invalid(format!("target.selector is not a valid CSS selector: {}", redact_browser_text(&reason))));
    }
    let count = minted.count as usize;
    if count > MAX_SELECTOR_MATCHES {
        return Err(TargetError::Failed(format!(
            "target.selector matched {count} elements, exceeding the limit of {MAX_SELECTOR_MATCHES}; narrow target.selector before acting"
        )));
    }
    let candidates = minted
        .matches
        .into_iter()
        .map(|found| listed.iter().find(|element| element.ref_id == found.ref_id).cloned().unwrap_or_else(|| css_element(found.ref_id, found.role, found.name)))
        .collect();
    Ok((candidates, count))
}

/// `resolveTargetRefs`: every target resolved against ONE fresh observation. A lone name-only target narrows the observation
/// with its own name as the query.
pub async fn resolve_targets(cx: &TargetContext<'_>, raw: &[Value]) -> Result<Vec<ResolvedTarget>, TargetError> {
    let targets = raw.iter().map(TargetSpec::normalize).collect::<Result<Vec<_>, _>>().map_err(TargetError::Invalid)?;
    let query = match targets.as_slice() {
        [single] => single.name.as_deref().filter(|name| single.selector.is_none() && !regex_shaped(name)),
        _ => None,
    };
    let params = HostBrowserSnapshotParams {
        page_id: cx.page_id.to_string(),
        mode: if query.is_some() { BrowserSnapshotMode::Query } else { BrowserSnapshotMode::Full },
        query: query.map(str::to_string),
        max_elements: u32::try_from(SNAPSHOT_TOOL_MAX_ELEMENTS).ok(),
        text_chars: None,
        frame: None,
    };
    let snapshot = cx.host.snapshot(params, cx.cancel).await?;
    let mut resolved = Vec::with_capacity(targets.len());
    for spec in &targets {
        let owned;
        let (pool, unfiltered): (&[BrowserSnapshotElement], Option<usize>) = match &spec.selector {
            Some(selector) => {
                let (found, count) = selector_candidates(cx, selector, &snapshot).await?;
                owned = found;
                (owned.as_slice(), Some(count))
            }
            None => (snapshot.payload.elements.as_slice(), snapshot.payload.unfiltered_elements.map(|count| count as usize)),
        };
        let chosen = select_target(spec, pool, unfiltered)?;
        let listed = snapshot.payload.elements.iter().any(|element| element.ref_id == chosen.ref_id);
        resolved.push(ResolvedTarget {
            ref_id: chosen.ref_id.clone(),
            description: spec.describe(),
            snapshot_id: snapshot.snapshot_id.clone(),
            minted: (!listed).then(|| chosen.clone()),
        });
    }
    Ok(resolved)
}

/// One target resolved to a live ref.
pub async fn resolve_target(cx: &TargetContext<'_>, raw: &Value) -> Result<ResolvedTarget, TargetError> {
    let mut resolved = resolve_targets(cx, std::slice::from_ref(raw)).await?;
    resolved.pop().ok_or_else(|| TargetError::Failed("the target resolved to nothing".to_string()))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::fake::Expect;
    use crate::fake::FakeHost;
    use crate::fake::page_facts;
    use crate::refs::ref_set::tests::element;
    use crate::refs::ref_set::tests::payload;

    fn spec(raw: Value) -> TargetSpec {
        TargetSpec::normalize(&raw).expect("a valid target")
    }

    fn message(result: Result<&BrowserSnapshotElement, TargetError>) -> String {
        result.expect_err("an error").to_string()
    }

    #[test]
    fn target_normalisation_rejects_empty_unknown_and_ill_typed_specs() {
        let error = |raw: Value| TargetSpec::normalize(&raw).expect_err("rejected");
        assert!(error(json!({})).contains("requires role, name, and/or selector"));
        assert!(error(json!({"text": "x"})).contains("does not accept field(s): text"));
        assert!(error(json!({"name": "x", "nth": 0})).contains("nth must be an integer"));
        assert!(error(json!({"name": "x", "nth": 1.5})).contains("nth must be an integer"));
        assert!(error(json!({"name": "x", "nth": 501})).contains("nth must be an integer"));
        assert!(error(json!({"role": "button", "exact": true})).contains("exact applies to target.name"));
        assert!(error(json!({"name": "x", "exact": "yes"})).contains("exact must be a boolean"));
        assert!(error(json!([])).contains("must be an object"));
        assert!(error(json!(null)).contains("must be an object"));
        assert_eq!(spec(json!({"role": " Button ", "name": "  Save  changes "})), TargetSpec { role: Some("button".into()), name: Some("Save changes".into()), ..TargetSpec::default() });
        assert_eq!(spec(json!({"name": "x", "nth": 2.0})).nth, Some(2));
    }

    #[test]
    fn selector_normalisation_preserves_css_literals_and_escaped_whitespace() {
        for selector in ["[data-key=\"a  b\"]", "#a\\  b", "  [title=\" spaced \"]  "] {
            assert_eq!(spec(json!({"selector": selector})).selector.as_deref(), Some(selector));
        }
        for raw in [json!({"selector": " \t\n"}), json!({"selector": 1}), json!({"selector": "x".repeat(4097)})] {
            assert!(TargetSpec::normalize(&raw).is_err(), "{raw}");
        }
        assert!(TargetSpec::normalize(&json!({"selector": "x".repeat(4097)})).expect_err("long").contains("at most 4096"));
        assert!(TargetSpec::normalize(&json!({"selector": 1})).expect_err("number").contains("must be a string"));
        assert!(TargetSpec::normalize(&json!({"name": "\u{1F600}".repeat(251)})).is_err(), "limits count UTF-16 units");
    }

    #[test]
    fn a_target_is_described_redacted_and_in_order() {
        assert_eq!(spec(json!({"role": "checkbox", "name": "agree"})).describe(), "checkbox \"agree\"");
        assert_eq!(spec(json!({"role": "button", "name": "Continue", "exact": true})).describe(), "button \"Continue\" (exact)");
        assert_eq!(spec(json!({"selector": "#a", "nth": 2})).describe(), "selector \"#a\" #2");
    }

    fn save_elements() -> Vec<BrowserSnapshotElement> {
        let mut link = element("p1-s2-e3", "link", "Save");
        link.href = Some("https://example.test/save".into());
        vec![element("p1-s2-e1", "button", "Save as draft"), element("p1-s2-e2", "button", "Save"), link, element("p1-s2-e4", "textbox", "Email")]
    }

    #[test]
    fn selection_insists_on_one_match_prefers_the_verbatim_name_and_lists_candidates_with_refs() {
        let elements = save_elements();
        let pick = |raw: Value| select_target(&spec(raw), &elements, None).expect("one").ref_id.clone();
        assert_eq!(pick(json!({"role": "button", "name": "save"})), "p1-s2-e2");
        assert_eq!(pick(json!({"name": "email"})), "p1-s2-e4");
        assert_eq!(pick(json!({"role": "button", "name": "save", "nth": 1})), "p1-s2-e1");
        assert_eq!(pick(json!({"name": "save as"})), "p1-s2-e1");
        let ambiguous = select_target(&spec(json!({"name": "save"})), &elements, None).expect_err("ambiguous");
        let text = ambiguous.to_string();
        assert!(text.contains("matched 3 elements"), "{text}");
        assert!(text.contains("[p1-s2-e1] button \"Save as draft\""), "{text}");
        assert!(text.contains("[p1-s2-e2] button \"Save\""), "{text}");
        assert!(text.contains("[p1-s2-e3] link \"Save\" href=https://example.test/save"), "{text}");
        let TargetError::Ambiguous { candidates, .. } = ambiguous else { panic!("not ambiguous") };
        assert_eq!(candidates.iter().map(|candidate| candidate.ref_id.as_str()).collect::<Vec<_>>(), ["p1-s2-e1", "p1-s2-e2", "p1-s2-e3"]);
        let missing = message(select_target(&spec(json!({"role": "button", "name": "publish"})), &elements, Some(12)));
        assert!(missing.contains("no element matched target button \"publish\" among 12 candidate element(s). Elements with role button: \"Save as draft\", \"Save\"."), "{missing}");
        assert!(message(select_target(&spec(json!({"role": "button", "name": "save", "nth": 5})), &elements, None)).contains("only 2 matched"));
        let without_save: Vec<_> = elements.iter().filter(|element| element.ref_id != "p1-s2-e2").cloned().collect();
        assert!(message(select_target(&spec(json!({"role": "button", "name": "save", "exact": true})), &without_save, None)).contains("no element matched"));
    }

    #[test]
    fn exact_names_distinguish_case_and_match_the_whole_normalized_name() {
        let elements = vec![element("p1-s2-e1", "button", "Save"), element("p1-s2-e2", "button", "SAVE"), element("p1-s2-e3", "button", "Save as draft")];
        let pick = |raw: Value, from: &[BrowserSnapshotElement]| select_target(&spec(raw), from, None).map(|found| found.ref_id.clone());
        assert_eq!(pick(json!({"name": "Save", "exact": true}), &elements), Ok("p1-s2-e1".to_string()));
        assert_eq!(pick(json!({"name": "SAVE", "exact": true}), &elements), Ok("p1-s2-e2".to_string()));
        assert!(pick(json!({"name": "Save", "exact": true}), &elements[1..]).is_err());
        assert!(pick(json!({"name": "save", "exact": true}), &elements).is_err());
        assert_eq!(pick(json!({"name": "  Save  as draft ", "exact": true}), &elements), Ok("p1-s2-e3".to_string()));
        assert_eq!(pick(json!({"name": "sAvE aS"}), &elements), Ok("p1-s2-e3".to_string()));
    }

    #[test]
    fn exact_names_preserve_ambiguity_and_nth_only_counts_case_sensitive_matches() {
        let elements = vec![element("p1-s2-e1", "button", "Save"), element("p1-s2-e2", "button", "SAVE"), element("p1-s2-e3", "button", "Save")];
        assert!(message(select_target(&spec(json!({"name": "Save", "exact": true})), &elements, None)).contains("matched 2 elements"));
        assert_eq!(select_target(&spec(json!({"name": "Save", "exact": true, "nth": 2})), &elements, None).expect("second").ref_id, "p1-s2-e3");
    }

    #[test]
    fn an_ambiguous_target_suggests_only_the_refinements_it_does_not_already_use() {
        let elements = vec![element("p1-s2-e1", "link", "Dynamic Content"), element("p1-s2-e2", "link", "Dynamic Loading")];
        assert!(message(select_target(&spec(json!({"name": "dynamic"})), &elements, None)).contains("; add nth, exact:true or a role, or act"));
        assert!(message(select_target(&spec(json!({"role": "link", "name": "dynamic"})), &elements, None)).contains("; add nth or exact:true, or act"));
        assert!(message(select_target(&spec(json!({"role": "link"})), &elements, None)).contains("; add nth, or act"));
    }

    #[test]
    fn a_long_candidate_list_is_cut_and_a_missing_target_is_the_retryable_error() {
        let elements: Vec<_> = (1..=10).map(|n| element(&format!("p1-s2-e{n}"), "button", "Same")).collect();
        let text = message(select_target(&spec(json!({"name": "same"})), &elements, None));
        assert!(text.contains("matched 10 elements") && text.ends_with("\u{2026} and 2 more"), "{text}");
        let missing = select_target(&spec(json!({"name": "nothing"})), &elements, None).expect_err("missing");
        assert_eq!(missing.reason(), Some(ActionabilityReason::Missing));
        let ambiguous = select_target(&spec(json!({"name": "same"})), &elements, None).expect_err("ambiguous");
        assert_eq!(ambiguous.reason(), None);
    }

    #[test]
    fn a_name_written_as_a_regular_expression_is_not_a_query() {
        for (name, shaped) in [("/a/", true), ("/a/i", true), ("/a/b/gi", true), ("//", false), ("/a", false), ("a/b/", false), ("/a/I", false), ("/a/ i", false), ("agree", false)] {
            assert_eq!(regex_shaped(name), shaped, "{name}");
        }
    }

    fn snapshot_answer(elements: Vec<BrowserSnapshotElement>, unfiltered: Option<u32>) -> Expect {
        let mut loaded = payload("p1-s2", elements, "https://example.test/");
        loaded.unfiltered_elements = unfiltered;
        Expect::ok(
            "host/browser/snapshot",
            json!({"snapshotId": "p1-s2", "documentId": "p1:1", "revision": 1, "payload": loaded, "warnings": [], "facts": page_facts("p1", 3)}),
        )
    }

    fn eval_answer(value: Value) -> Expect {
        Expect::ok("host/browser/page/eval", json!({"value": value, "facts": page_facts("p1", 3)}))
    }

    fn mint_answer(count: u32, matches: Value) -> Expect {
        Expect::ok("host/browser/ref/mint", json!({"count": count, "matches": matches, "facts": page_facts("p1", 3)}))
    }

    fn cancel() -> CancellationToken {
        CancellationToken::new()
    }

    fn checkbox_page() -> Vec<BrowserSnapshotElement> {
        vec![element("p1-s2-e1", "button", "Cancel"), element("p1-s2-e2", "checkbox", "I agree")]
    }

    #[tokio::test]
    async fn a_lone_named_target_narrows_the_observation_with_its_name() {
        let host = FakeHost::scripted(vec![snapshot_answer(checkbox_page(), None).with_params(json!({"pageId": "p1", "mode": "query", "query": "agree", "maxElements": 500}))]);
        let cancel = cancel();
        let cx = TargetContext { host: &host, page_id: "p1", expect: None, cancel: &cancel };
        let resolved = resolve_target(&cx, &json!({"role": "checkbox", "name": "agree"})).await.expect("resolved");
        assert_eq!(resolved, ResolvedTarget { ref_id: "p1-s2-e2".into(), description: "checkbox \"agree\"".into(), snapshot_id: "p1-s2".into(), minted: None });
        host.finish().expect("one snapshot");
    }

    #[tokio::test]
    async fn a_batch_resolves_against_one_unfiltered_observation() {
        let host = FakeHost::scripted(vec![snapshot_answer(checkbox_page(), None)]);
        let cancel = cancel();
        let cx = TargetContext { host: &host, page_id: "p1", expect: None, cancel: &cancel };
        let many = resolve_targets(&cx, &[json!({"name": "cancel"}), json!({"name": "agree"})]).await.expect("resolved");
        assert_eq!(many.iter().map(|entry| entry.ref_id.as_str()).collect::<Vec<_>>(), ["p1-s2-e1", "p1-s2-e2"]);
        let calls = host.calls();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].params.get("query").is_none(), "{}", calls[0].params);
        assert_eq!(calls[0].params["mode"], "full");
        host.finish().expect("one snapshot");
        let regex_host = FakeHost::scripted(vec![snapshot_answer(checkbox_page(), None)]);
        let cx = TargetContext { host: &regex_host, page_id: "p1", expect: None, cancel: &cancel };
        resolve_target(&cx, &json!({"name": "/agree/i"})).await.expect("resolved");
        assert!(regex_host.calls()[0].params.get("query").is_none(), "a regular expression is not a query");
    }

    #[tokio::test]
    async fn a_target_that_matched_nothing_is_the_retryable_error_and_an_ambiguous_one_is_final() {
        let cancel = cancel();
        let host = FakeHost::scripted(vec![snapshot_answer(Vec::new(), Some(0))]);
        let cx = TargetContext { host: &host, page_id: "p1", expect: None, cancel: &cancel };
        let error = resolve_target(&cx, &json!({"role": "button", "name": "Continue", "exact": true})).await.expect_err("nothing");
        assert_eq!(error.reason(), Some(ActionabilityReason::Missing));
        assert!(error.to_string().contains("among 0 candidate element(s)"), "{error}");
        let two = FakeHost::scripted(vec![snapshot_answer(vec![element("p1-s2-e1", "button", "Continue"), element("p1-s2-e2", "button", "Continue")], None)]);
        let cx = TargetContext { host: &two, page_id: "p1", expect: None, cancel: &cancel };
        let error = resolve_target(&cx, &json!({"role": "button", "name": "Continue"})).await.expect_err("ambiguous");
        assert!(matches!(&error, TargetError::Ambiguous { candidates, .. } if candidates.len() == 2), "{error}");
        two.finish().expect("one observation, no retry here");
        let invalid = resolve_target(&cx, &json!({"text": "x"})).await.expect_err("invalid");
        assert!(matches!(invalid, TargetError::Invalid(_)));
    }

    #[tokio::test]
    async fn a_selector_names_the_snapshot_elements_the_top_document_matches() {
        let cancel = cancel();
        let host = FakeHost::scripted(vec![
            snapshot_answer(checkbox_page(), None),
            eval_answer(json!({"count": 1, "table": false, "matches": [{"ref": null, "role": "input", "name": "agree"}]})),
            mint_answer(1, json!([{"ref": "p1-s2-e2", "role": "checkbox", "name": "I agree"}]))
                .with_params(json!({"pageId": "p1", "snapshotId": "p1-s2", "selector": "input[name=agree]", "limit": 50})),
        ]);
        let cx = TargetContext { host: &host, page_id: "p1", expect: None, cancel: &cancel };
        let resolved = resolve_target(&cx, &json!({"selector": "input[name=agree]"})).await.expect("resolved");
        assert_eq!((resolved.ref_id.as_str(), resolved.minted.is_none()), ("p1-s2-e2", true));
        let calls = host.calls();
        let expression = calls[1].params["expression"].as_str().expect("an expression");
        assert!(expression.contains("\"input[name=agree]\"") && expression.contains("\"p1-s2\"") && !expression.contains("__SELECTOR__") && !expression.contains("__LIMIT__") && !expression.contains("__SNAPSHOT_ID__"), "{expression}");
        host.finish().expect("one mint after the query");
    }

    #[tokio::test]
    async fn a_selector_target_the_snapshot_does_not_list_gets_a_ref_minted_by_the_host() {
        let cancel = cancel();
        // A consent row the accessibility tree does not list: the host mints `p1-s2-t77` for it and the engine names it by that ref.
        let both = json!([{"ref": "p1-s2-e1", "role": "button", "name": "Cancel"}, {"ref": "p1-s2-t77", "role": "div", "name": "Consent row"}]);
        let host = FakeHost::scripted(vec![snapshot_answer(checkbox_page(), None), eval_answer(json!({"count": 2, "table": false, "matches": []})), mint_answer(2, both.clone())]);
        let cx = TargetContext { host: &host, page_id: "p1", expect: None, cancel: &cancel };
        let error = resolve_target(&cx, &json!({"selector": "button, div"})).await.expect_err("ambiguous");
        assert!(error.to_string().contains("[p1-s2-t77] div \"Consent row\""), "{error}");
        let picked = FakeHost::scripted(vec![snapshot_answer(checkbox_page(), None), eval_answer(json!({"count": 2, "table": false, "matches": []})), mint_answer(2, both)]);
        let cx = TargetContext { host: &picked, page_id: "p1", expect: None, cancel: &cancel };
        let resolved = resolve_target(&cx, &json!({"selector": "button, div", "role": "div"})).await.expect("minted");
        assert_eq!(resolved.ref_id, "p1-s2-t77");
        let element = resolved.minted.expect("the minted element");
        assert_eq!((element.role.as_str(), element.name.as_str(), element.tag.as_str()), ("div", "Consent row", "css"));
        let none = FakeHost::scripted(vec![snapshot_answer(checkbox_page(), None), eval_answer(json!({"count": 0, "table": false, "matches": []})), mint_answer(0, json!([]))]);
        let cx = TargetContext { host: &none, page_id: "p1", expect: None, cancel: &cancel };
        let error = resolve_target(&cx, &json!({"selector": "#nope"})).await.expect_err("nothing");
        assert_eq!(error.reason(), Some(ActionabilityReason::Missing));
        assert!(error.to_string().contains("among 0 candidate element(s)"), "{error}");
    }

    #[tokio::test]
    async fn a_page_side_ref_table_keeps_known_refs_and_mints_for_unknown_nodes() {
        let cancel = cancel();
        let found = json!({"count": 2, "table": true, "matches": [
            {"ref": "p1-s2-e1", "role": "button", "name": "Cancel"},
            {"ref": "p1-s2-t1", "role": "div", "name": "Consent row"}
        ]});
        let host = FakeHost::scripted(vec![snapshot_answer(checkbox_page(), None), eval_answer(found.clone())]);
        let cx = TargetContext { host: &host, page_id: "p1", expect: None, cancel: &cancel };
        let error = resolve_target(&cx, &json!({"selector": "button, div"})).await.expect_err("ambiguous");
        assert!(error.to_string().contains("[p1-s2-t1] div \"Consent row\""), "{error}");
        let picked = FakeHost::scripted(vec![snapshot_answer(checkbox_page(), None), eval_answer(found)]);
        let cx = TargetContext { host: &picked, page_id: "p1", expect: None, cancel: &cancel };
        let minted = resolve_target(&cx, &json!({"selector": "button, div", "nth": 2})).await.expect("minted");
        assert_eq!(minted.ref_id, "p1-s2-t1");
        let element = minted.minted.expect("the minted element");
        assert_eq!((element.role.as_str(), element.name.as_str(), element.tag.as_str()), ("div", "Consent row", "css"));
        let known = FakeHost::scripted(vec![snapshot_answer(checkbox_page(), None), eval_answer(json!({"count": 1, "table": true, "matches": [{"ref": "p1-s2-e1", "role": "button", "name": "Cancel"}]}))]);
        let cx = TargetContext { host: &known, page_id: "p1", expect: None, cancel: &cancel };
        let reused = resolve_target(&cx, &json!({"selector": "button"})).await.expect("known");
        assert_eq!((reused.ref_id.as_str(), reused.minted.is_none()), ("p1-s2-e1", true));
    }

    #[tokio::test]
    async fn a_selector_that_matches_too_many_nodes_or_is_invalid_stops_at_once() {
        let cancel = cancel();
        let many = FakeHost::scripted(vec![snapshot_answer(checkbox_page(), None), eval_answer(json!({"count": 51}))]);
        let cx = TargetContext { host: &many, page_id: "p1", expect: None, cancel: &cancel };
        let error = resolve_target(&cx, &json!({"selector": "button", "name": "Delete", "exact": true})).await.expect_err("too many");
        assert_eq!(error, TargetError::Failed("target.selector matched 51 elements, exceeding the limit of 50; narrow target.selector before acting".into()));
        many.finish().expect("no element asked");
        let bad = FakeHost::scripted(vec![snapshot_answer(checkbox_page(), None), eval_answer(json!({"invalid": "'bad(' is not a valid selector"}))]);
        let cx = TargetContext { host: &bad, page_id: "p1", expect: None, cancel: &cancel };
        let error = resolve_target(&cx, &json!({"selector": "bad("})).await.expect_err("invalid");
        assert!(matches!(&error, TargetError::Invalid(text) if text.contains("not a valid CSS selector")), "{error}");
    }

    #[tokio::test]
    async fn a_page_that_changed_while_the_selector_was_resolved_is_said_so() {
        let cancel = cancel();
        let host = FakeHost::scripted(vec![
            snapshot_answer(checkbox_page(), None),
            eval_answer(json!({"count": 1, "table": false, "matches": []})),
            Expect::err("host/browser/ref/mint", HostCallError::StaleSnapshot),
        ]);
        let cx = TargetContext { host: &host, page_id: "p1", expect: None, cancel: &cancel };
        let error = resolve_target(&cx, &json!({"selector": "input"})).await.expect_err("stale");
        assert_eq!(error, TargetError::Failed("the page changed while resolving the target; try again".into()));
        let gone = FakeHost::scripted(vec![Expect::err("host/browser/snapshot", HostCallError::PageGone)]);
        let cx = TargetContext { host: &gone, page_id: "p1", expect: None, cancel: &cancel };
        assert_eq!(resolve_target(&cx, &json!({"name": "x"})).await, Err(TargetError::Host(HostCallError::PageGone)));
    }
}
