//! Owner: s4-engine-reply
//! What the agent can see of the open pages (the list text of `tabs.ts`) and what closing one says. Which page a command runs
//! against is the host's (`host/browser/pages/resolve`); this is only the words.
//!
//! A background page is addressed by its page id (the `tab` selector carries a page id), so a listing names it by that id; a
//! popup also names the page that opened it.

use mixdog_app_protocol::v2::browser_engine::PageDescriptor;
use mixdog_browser_policy::redaction::redact_browser_text;
use mixdog_browser_policy::redaction::redact_url;

/// The `list_tabs` reply text. `pages` are the session's pages in the order the host lists them: the visible ones are numbered
/// `v1`, `v2`, ... in that order; `active_page_id` is the visible page commands run against.
pub fn list_tabs_text(pages: &[PageDescriptor], active_page_id: Option<&str>) -> String {
    let mut lines = Vec::new();
    let mut visible = 0;
    for page in pages.iter().filter(|page| !page.background) {
        visible += 1;
        let marker = if active_page_id == Some(page.page_id.as_str()) { " (active)" } else { "" };
        lines.push(format!("- {} [v{visible}]{marker}: {}", page.page_id, title_and_address(page)));
    }
    for page in pages.iter().filter(|page| page.background) {
        // A popup is named by the page that opened it (`popup from <opener>`), as the listing always did.
        let opener = pages.iter().find(|other| other.facts.opened_popups.iter().any(|id| *id == page.page_id));
        let kind = opener.map(|opener| format!("popup from {}", opener.page_id)).unwrap_or_else(|| "background".to_owned());
        lines.push(format!("- {} ({kind}): {}", page.page_id, title_and_address(page)));
    }
    if lines.is_empty() {
        return "No tabs are open. navigate opens the visible tab; background:true opens a hidden page.".to_owned();
    }
    format!("Tabs:\n{}", lines.join("\n"))
}

fn title_and_address(page: &PageDescriptor) -> String {
    let title = if page.facts.title.is_empty() { "(untitled)" } else { page.facts.title.as_str() };
    let address = if page.facts.url.is_empty() { "about:blank" } else { page.facts.url.as_str() };
    format!("{} — {}", redact_browser_text(title), redact_url(address))
}

/// `close_tab` of a background page: the reply text.
pub fn closed_background_tab(name: &str) -> String {
    format!("Closed background tab \"{name}\".")
}

/// `close_tab` aimed at the visible tab: `list_tabs` prints it with the same page id as any other, so a caller naturally aims
/// close_tab at it. The panel keeps that page for the session, so say what it is instead of sending the caller back to the listing.
pub fn visible_tab_close_refusal(tab: &str) -> String {
    format!("\"{tab}\" is the visible tab, which stays with the browser panel; navigate it elsewhere, or call hide to put the panel away.")
}

/// `close_tab` of a name no background page has.
pub fn unknown_background_tab(tab: &str) -> String {
    format!("unknown background tab \"{tab}\"; call list_tabs")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::fake::page_facts;

    fn page(id: &str, background: bool, title: &str, url: &str) -> PageDescriptor {
        let mut facts = page_facts(id, 1);
        if let Some(object) = facts.as_object_mut() {
            object.insert("title".into(), json!(title));
            object.insert("url".into(), json!(url));
            object.insert("background".into(), json!(background));
        }
        serde_json::from_value(json!({"pageId": id, "tabId": format!("t-{id}"), "sessionId": "s1", "background": background, "facts": facts})).expect("page")
    }

    #[test]
    fn an_empty_session_says_how_a_tab_opens() {
        assert_eq!(list_tabs_text(&[], None), "No tabs are open. navigate opens the visible tab; background:true opens a hidden page.");
    }

    #[test]
    fn visible_tabs_are_numbered_and_the_active_one_is_marked_before_the_background_ones() {
        let pages = vec![
            page("p9", true, "Worker", "https://w.test/"),
            page("p1", false, "One", "https://one.test/"),
            page("p2", false, "", ""),
        ];
        assert_eq!(
            list_tabs_text(&pages, Some("p2")),
            "Tabs:\n- p1 [v1]: One — https://one.test/\n- p2 [v2] (active): (untitled) — about:blank\n- p9 (background): Worker — https://w.test/"
        );
    }

    #[test]
    fn a_background_popup_names_the_page_that_opened_it() {
        let mut opener = page("p1", false, "One", "https://one.test/");
        opener.facts.opened_popups = vec!["p7".into()];
        let pages = vec![opener, page("p7", true, "Pop", "https://pop.test/"), page("p9", true, "Worker", "https://w.test/")];
        assert_eq!(
            list_tabs_text(&pages, Some("p1")),
            "Tabs:\n- p1 [v1] (active): One — https://one.test/\n- p7 (popup from p1): Pop — https://pop.test/\n- p9 (background): Worker — https://w.test/"
        );
    }

    #[test]
    fn the_address_is_redacted() {
        let pages = vec![page("p1", false, "Login", "https://u:pw@a.test/cb?access_token=abc123")];
        let text = list_tabs_text(&pages, None);
        assert!(!text.contains("abc123") && !text.contains(":pw@"), "{text}");
    }

    #[test]
    fn closing_says_what_was_closed_or_why_not() {
        assert_eq!(closed_background_tab("p9"), "Closed background tab \"p9\".");
        assert_eq!(
            visible_tab_close_refusal("p1"),
            "\"p1\" is the visible tab, which stays with the browser panel; navigate it elsewhere, or call hide to put the panel away."
        );
        assert_eq!(unknown_background_tab("zz"), "unknown background tab \"zz\"; call list_tabs");
    }
}
