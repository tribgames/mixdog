//! `Issues-Word`: what a Word document leaves for its author to resolve: tracked changes and comments, field errors, a missing
//! font, a long paragraph set in heading size, and a table wider than the page.

use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::com::Value as Com;
use crate::issues::missing_font_issue;
use crate::issues::office_issue;
use crate::office::Env;
use crate::platform::FontSet;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::text::is_match;

/// `$document.<collection>.Count`, as Word answers it.
fn collection_count(document: &Obj, collection: &str) -> Result<Com> {
    document.get(collection)?.member("Count")
}

/// `$count -gt 0`.
fn is_positive(count: &Com) -> bool {
    match count.as_f64() {
        Some(number) => number > 0.0,
        None => crate::office::long_of(count).is_some_and(|number| number > 0),
    }
}

/// `[Math]::Round($number, 1)` as a message spells it.
fn rounded(number: f64) -> Result<String> {
    Ok(convert::to_ps_string(&Value::Double(convert::round_digits(number, 1).map_err(Error::host)?)))
}

/// The field results that say they failed.
fn field_issues(document: &Obj, issues: &mut Vec<Value>) -> Result<()> {
    let mut field_index = 0;
    for field in super::items_of(&document.get("Fields")?)? {
        field_index += 1;
        let mut read = || -> Result<()> {
            let text = super::string(&field.member("Result")?.member("Text")?).trim().to_owned();
            if is_match(&text, "Error!|Reference source not found", false).map_err(Error::host)? {
                issues.push(office_issue("error", "field_error", &format!("/body/field[{field_index}]"), &text));
            }
            Ok(())
        };
        let _ = read();
    }
    Ok(())
}

/// The paragraphs in order through `Next()`, each one's range and font taken once: asking `Paragraphs.Item(n)`, the count
/// again on every pass, and a fresh range for every property cost a 65-paragraph report 0.8 s a read, 0.5 s this way.
fn paragraph_issues(fonts: &FontSet, document: &Obj, issues: &mut Vec<Value>) -> Result<()> {
    let mut paragraph = document.get("Paragraphs")?.member("First")?;
    let mut paragraph_index = 0;
    while super::is_object(&paragraph) {
        paragraph_index += 1;
        let mut read = || -> Result<()> {
            let path = format!("/body/p[{paragraph_index}]");
            let range = paragraph.member("Range")?;
            let font = range.member("Font")?;
            if let Some(issue) = missing_font_issue(fonts, &super::string(&font.member("Name")?), &path) {
                issues.push(issue);
            }
            let text = super::range_text(&range)?;
            let font_size = super::single(&font.member("Size")?)?;
            if text.encode_utf16().count() > 180 && font_size >= 18.0 {
                issues.push(office_issue("warning", "oversized_heading_text", &path, "A long paragraph uses heading-sized text and is likely mis-styled."));
            }
            Ok(())
        };
        let _ = read();
        paragraph = paragraph.call_member("Next", &[]).unwrap_or(Com::Null);
    }
    Ok(())
}

/// A table wider than the page's usable width (one point of slack).
fn table_issues(document: &Obj, issues: &mut Vec<Value>) -> Result<()> {
    let mut table_index = 1;
    while table_index <= super::count(&document.get("Tables")?)? {
        let mut read = || -> Result<()> {
            let table = super::item(&document.get("Tables")?, table_index)?;
            let mut width = 0.0;
            for column in super::items_of(&table.member("Columns")?)? {
                width += super::double(&column.member("Width")?)?;
            }
            let sections = table.member("Range")?.member("Sections")?;
            let page = super::item(&sections, 1)?.member("PageSetup")?;
            let available =
                super::double(&page.member("PageWidth")?)? - super::double(&page.member("LeftMargin")?)? - super::double(&page.member("RightMargin")?)?;
            if width > available + 1.0 {
                issues.push(office_issue(
                    "warning",
                    "table_width",
                    &format!("/body/tbl[{table_index}]"),
                    &format!("Table width {}pt exceeds available page width {}pt.", rounded(width)?, rounded(available)?),
                ));
            }
            Ok(())
        };
        let _ = read();
        table_index += 1;
    }
    Ok(())
}

/// `Issues-Word`.
pub(super) fn issues_word(env: &Env<'_>, document: &Obj) -> Result<Value> {
    let fonts = env.platform.installed_office_fonts();
    let mut issues = Vec::new();
    if is_positive(&collection_count(document, "Revisions")?) {
        let count = super::string(&collection_count(document, "Revisions")?);
        issues.push(office_issue("info", "unresolved_revisions", "/body", &format!("{count} tracked revision(s) remain unresolved.")));
    }
    if is_positive(&collection_count(document, "Comments")?) {
        let count = super::string(&collection_count(document, "Comments")?);
        issues.push(office_issue("info", "unresolved_comments", "/body", &format!("{count} comment(s) remain in the document.")));
    }
    field_issues(document, &mut issues)?;
    paragraph_issues(&fonts, document, &mut issues)?;
    table_issues(document, &mut issues)?;
    Ok(Value::Array(issues))
}
