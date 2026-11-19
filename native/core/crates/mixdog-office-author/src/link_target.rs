//! The link targets an authored document may carry: the page scripts filter by the same rule, and the builders enforce
//! it again before a hyperlink relationship is created.

/// The serialized form of `href` when it is an absolute `http`, `https`, `mailto` or `tel` target. The serialized URL
/// is what a relationship carries, never the raw string: it has no control characters left to break the XML.
pub(crate) fn safe_link(href: &str) -> Option<String> {
    let url = url::Url::parse(href).ok()?;
    matches!(url.scheme(), "http" | "https" | "mailto" | "tel").then(|| url.into())
}

#[cfg(test)]
mod tests {
    use super::safe_link;

    #[test]
    fn only_web_mail_and_phone_targets_are_safe() {
        for good in ["https://x.test/a?b=1", "HTTP://x.test", "mailto:a@x.test", "tel:+8210"] {
            assert!(safe_link(good).is_some(), "{good}");
        }
        for bad in ["javascript:alert(1)", "file:///c:/x", "data:text/html,x", "#top", "/relative", ""] {
            assert!(safe_link(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn the_target_is_the_serialized_url_without_control_characters() {
        for raw in ["https://x.test/a\u{1}", "https://x.test/a\u{1}b", "\u{1}https://x.test/a"] {
            let target = safe_link(raw).expect("a link");
            assert!(target.chars().all(|c| !c.is_control()), "{target:?}");
        }
        assert_eq!(safe_link("HTTP://X.test").as_deref(), Some("http://x.test/"));
    }
}
