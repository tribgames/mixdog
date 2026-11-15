//! The issue records every inspection builds (`Office-Issue`, `Add-CappedOfficeIssue`, `Missing-FontIssue` of
//! `office-com-host.ps1`): the three readers (Word, Excel, PowerPoint) all call them.

use crate::platform::FontSet;
use crate::ps::ObjectKind;
use crate::ps::Value;

/// How many issues a capped inspection keeps before it counts what it leaves out.
pub const ISSUE_CAP: usize = 500;

/// `Office-Issue`: `{ severity, code, path, message }`.
pub fn office_issue(severity: &str, code: &str, path: &str, message: &str) -> Value {
    Value::object(
        ObjectKind::Ordered,
        vec![
            ("severity", Value::string(severity)),
            ("code", Value::string(code)),
            ("path", Value::string(path)),
            ("message", Value::string(message)),
        ],
    )
}

/// `Add-CappedOfficeIssue`: the issue is kept while fewer than `limit` are held, else it is counted in `omitted`.
pub fn add_capped_office_issue(issues: &mut Vec<Value>, omitted: &mut i32, issue: Value, limit: usize) {
    if issues.len() < limit {
        issues.push(issue);
    } else {
        *omitted += 1;
    }
}

/// `Missing-FontIssue`: a warning for a font name the machine does not have; a blank name, a theme font (`+mn-lt`) and an
/// installed one give none.
pub fn missing_font_issue(fonts: &FontSet, name: &str, path: &str) -> Option<Value> {
    if name.trim().is_empty() || name.starts_with('+') || fonts.contains(name) {
        return None;
    }
    Some(office_issue("warning", "missing_font", path, &format!("Font is not installed: {name}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fonts() -> FontSet {
        let mut fonts = FontSet::default();
        fonts.insert("Calibri");
        fonts
    }

    #[test]
    fn an_issue_has_its_four_fields_in_order() {
        let issue = office_issue("info", "unresolved_comments", "/body", "2 comment(s) remain in the document.");
        assert_eq!(
            crate::ps::json::to_json(&issue, 4),
            "{\"severity\":\"info\",\"code\":\"unresolved_comments\",\"path\":\"/body\",\"message\":\"2 comment(s) remain in the document.\"}"
        );
    }

    #[test]
    fn issues_past_the_cap_are_counted_not_kept() {
        let mut issues = Vec::new();
        let mut omitted = 0;
        for index in 0..(ISSUE_CAP + 3) {
            add_capped_office_issue(&mut issues, &mut omitted, office_issue("warning", "x", &index.to_string(), "m"), ISSUE_CAP);
        }
        assert_eq!((issues.len(), omitted), (ISSUE_CAP, 3));
    }

    #[test]
    fn a_missing_font_is_a_warning_and_a_theme_or_blank_or_installed_font_is_none() {
        let fonts = fonts();
        assert!(missing_font_issue(&fonts, "calibri", "/p").is_none());
        assert!(missing_font_issue(&fonts, "+mn-lt", "/p").is_none());
        assert!(missing_font_issue(&fonts, "  ", "/p").is_none());
        let issue = missing_font_issue(&fonts, "Zapfino", "/body/p[1]").expect("a warning");
        assert_eq!(
            crate::ps::json::to_json(&issue, 4),
            "{\"severity\":\"warning\",\"code\":\"missing_font\",\"path\":\"/body/p[1]\",\"message\":\"Font is not installed: Zapfino\"}"
        );
    }
}
