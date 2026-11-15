//! `extractPdfOutline`: the bookmarks flattened in reading order with the page each one opens, so a long report's
//! structure is visible before its text.

use mixdog_fsio::ReadProof;
use mixdog_pdf::document::Document;
use mixdog_pdf::outline_read::{self, OutlineItem};
use mixdog_pdf::{Obj, PdfError};
use serde_json::Value;

use super::layout::{destination_page, explicit_destination};
use super::object;
use crate::document::{AnalysisError, PdfSource, open_pdf};

#[derive(Debug, Clone, PartialEq)]
pub struct OutlineEntry {
    pub title: String,
    /// The 1-based page the bookmark opens; `None` when its destination names no page.
    pub page: Option<i64>,
    /// 1 for a top-level bookmark.
    pub level: usize,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Outline {
    pub entries: Vec<OutlineEntry>,
    pub truncated: bool,
}

fn walk(
    document: &Document,
    items: &[OutlineItem],
    level: usize,
    entries: &mut Vec<OutlineEntry>,
    max_entries: usize,
) -> Result<(), PdfError> {
    for item in items {
        if entries.len() >= max_entries {
            return Ok(());
        }
        // A destination that cannot be read leaves the bookmark without a page.
        let page = match &item.dest {
            Some(dest) => match explicit_destination(document, dest)? {
                Some(destination) if matches!(destination.first(), Some(Obj::Ref(_))) => {
                    destination_page(document, destination.first())?
                }
                _ => None,
            },
            None => None,
        };
        entries.push(OutlineEntry {
            title: item.title.clone(),
            page,
            level,
            url: item.url.clone().filter(|url| !url.is_empty()),
        });
        walk(document, &item.items, level + 1, entries, max_entries)?;
    }
    Ok(())
}

/// `extractPdfOutline(path, { maxEntries })`; `max_entries` defaults to [`crate::limits::DEFAULT_MAX_OUTLINE_ENTRIES`].
pub fn extract_pdf_outline<P: ReadProof>(
    proof: &P,
    source: PdfSource<'_>,
    max_entries: usize,
) -> Result<Outline, AnalysisError> {
    let document = open_pdf(proof, source, None)?;
    let reader = |error: PdfError| AnalysisError::from_pdf(&error);
    let mut entries = Vec::new();
    let items = outline_read::get_outline(&document)
        .map_err(reader)?
        .unwrap_or_default();
    walk(&document, &items, 1, &mut entries, max_entries).map_err(reader)?;
    let truncated = entries.len() >= max_entries;
    Ok(Outline { entries, truncated })
}

impl OutlineEntry {
    pub fn to_json(&self) -> Value {
        let mut pairs = vec![
            ("title", Value::from(self.title.clone())),
            ("page", self.page.map_or(Value::Null, Value::from)),
            ("level", Value::from(self.level)),
        ];
        if let Some(url) = &self.url {
            pairs.push(("url", Value::from(url.clone())));
        }
        object(pairs)
    }
}

impl Outline {
    pub fn to_json(&self) -> Value {
        object(vec![
            (
                "entries",
                Value::Array(self.entries.iter().map(OutlineEntry::to_json).collect()),
            ),
            ("truncated", Value::Bool(self.truncated)),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_json_has_a_null_page_and_a_url_only_when_there_is_one() {
        let entry = OutlineEntry {
            title: "A".into(),
            page: None,
            level: 2,
            url: Some("https://x.test/".into()),
        };
        assert_eq!(
            entry.to_json().to_string(),
            r#"{"title":"A","page":null,"level":2,"url":"https://x.test/"}"#
        );
        let plain = OutlineEntry {
            title: "B".into(),
            page: Some(3),
            level: 1,
            url: None,
        };
        assert_eq!(
            plain.to_json().to_string(),
            r#"{"title":"B","page":3,"level":1}"#
        );
    }
}
