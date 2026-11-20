//! Bookmarks (`addOutlineEntries` of `pdf-edit-document.mjs`): a linked list under the catalog's `/Outlines`; new
//! entries go after whatever the file already has, so a merged report keeps its sources' entries too.
//!
//! [`PdfDocument::add_outline_entries`] writes one outline item per entry (`Title`, `Parent`, `Dest [page /Fit]`,
//! `Prev`, `Next`), links the first of them after the root's current `Last` (or makes it the `First`), moves `Last`
//! and adds the number of entries to `Count`; with no `/Outlines` it makes the root (`Type`, `First`, `Last`,
//! `Count`) and names it in the catalog. [`PdfDocument::outline_items`] reads the top-level list back.

use std::sync::Arc;

use crate::object::{Dict, Obj, Ref};
use crate::write::pages::{assert_range, invalid, not_a};
use crate::write::{PdfDocument, WriteError, decode_text_string, encode_text_string};

/// A bookmark to add: the title and the zero-based index of the page it opens (`Fit`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutlineEntry {
    pub title: String,
    pub page_index: usize,
}

/// A top-level outline item as read back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutlineItem {
    pub title: String,
    /// The zero-based index of the page the destination's first element names, when it is a page of the tree.
    pub page_index: Option<usize>,
}

impl PdfDocument {
    /// `addOutlineEntries(document, entries)`: the number of entries added.
    pub fn add_outline_entries(&mut self, entries: &[OutlineEntry]) -> Result<usize, WriteError> {
        if entries.is_empty() {
            return Ok(0);
        }
        let pages = self.pages();
        let mut page_refs = Vec::with_capacity(entries.len());
        for entry in entries {
            assert_range(entry.page_index, "index", pages.len().saturating_sub(1))?;
            let Some(page) = pages.get(entry.page_index) else {
                return Err(invalid(format!("PDF page out of range: {}", entry.page_index + 1)));
            };
            page_refs.push(*page);
        }
        let catalog_ref = self.store.trailer.root.ok_or_else(|| invalid("the file has no catalog"))?;
        let outlines = self.store.dict(catalog_ref).and_then(|catalog| catalog.get_raw("Outlines")).cloned();
        // An `/Outlines` that is a dictionary written inline in the catalog becomes an indirect object, so its items
        // can name it as their `Parent`.
        let existing: Option<Ref> = match &outlines {
            Some(Obj::Ref(r)) if matches!(self.store.get(*r), Some(Obj::Dict(_))) => Some(*r),
            Some(Obj::Dict(dict)) => {
                let promoted = self.store.register(Obj::Dict(dict.clone()));
                self.store.modify_dict(catalog_ref, |catalog| catalog.set("Outlines", Obj::Ref(promoted)));
                Some(promoted)
            }
            _ => None,
        };
        let root_ref = match existing {
            Some(root) => root,
            None => self.store.next_ref(),
        };
        let refs: Vec<Ref> = entries.iter().map(|_| self.store.next_ref()).collect();
        let previous_last: Option<Obj> = existing.and_then(|root| self.store.dict(root)).and_then(|root| root.get_raw("Last")).cloned();
        for (at, entry) in entries.iter().enumerate() {
            let mut item = Dict::new();
            item.set("Title", Obj::Str(Arc::from(encode_text_string(&entry.title))));
            item.set("Parent", Obj::Ref(root_ref));
            item.set("Dest", Obj::Array(Arc::new(vec![Obj::Ref(page_refs[at]), Obj::name("Fit")])));
            let previous = if at > 0 { refs.get(at - 1).map(|r| Obj::Ref(*r)) } else { previous_last.clone() };
            if let Some(previous) = previous {
                item.set("Prev", previous);
            }
            if at + 1 < entries.len() {
                item.set("Next", Obj::Ref(refs[at + 1]));
            }
            self.store.assign(refs[at], Obj::Dict(Arc::new(item)));
        }
        let first = refs[0];
        let last = refs[refs.len() - 1];
        if existing.is_some() {
            if let Some(previous) = &previous_last {
                let Obj::Ref(previous_ref) = previous else {
                    return Err(invalid("the outline's Last is not a reference"));
                };
                self.store.modify_dict(*previous_ref, |item| item.set("Next", Obj::Ref(first))).ok_or_else(|| not_a("PDFDict", "Last"))?;
            }
            let count = self.store.dict(root_ref).and_then(|root| self.store.lookup(root, "Count")).and_then(Obj::as_num).unwrap_or(0.0);
            let total = count.max(0.0) + entries.len() as f64;
            let set_first = previous_last.is_none();
            self.store.modify_dict(root_ref, |root| {
                if set_first {
                    root.set("First", Obj::Ref(first));
                }
                root.set("Last", Obj::Ref(last));
                root.set("Count", Obj::Num(total));
            });
        } else {
            let mut root = Dict::new();
            root.set("Type", Obj::name("Outlines"));
            root.set("First", Obj::Ref(first));
            root.set("Last", Obj::Ref(last));
            root.set("Count", Obj::Num(entries.len() as f64));
            self.store.assign(root_ref, Obj::Dict(Arc::new(root)));
            self.store.modify_dict(catalog_ref, |catalog| catalog.set("Outlines", Obj::Ref(root_ref)));
        }
        Ok(entries.len())
    }

    /// The top-level outline items in order, from `First` along `Next` (a list that loops ends where it loops).
    pub fn outline_items(&self) -> Vec<OutlineItem> {
        let mut items = Vec::new();
        let pages = self.pages();
        let Some(catalog) = self.store.trailer.root.and_then(|root| self.store.dict(root)) else {
            return items;
        };
        let Some(Obj::Dict(root)) = self.store.lookup(catalog, "Outlines") else {
            return items;
        };
        let mut current = root.get_raw("First").and_then(Obj::as_ref_value);
        let mut seen = std::collections::HashSet::new();
        while let Some(item_ref) = current {
            if !seen.insert(item_ref) {
                break;
            }
            let Some(item) = self.store.dict(item_ref) else {
                break;
            };
            let title = match self.store.lookup(item, "Title") {
                Some(Obj::Str(text)) => decode_text_string(text),
                _ => String::new(),
            };
            let page_index = match self.store.lookup(item, "Dest") {
                Some(Obj::Array(dest)) => dest.first().and_then(Obj::as_ref_value).and_then(|page| pages.iter().position(|candidate| *candidate == page)),
                _ => None,
            };
            items.push(OutlineItem { title, page_index });
            current = item.get_raw("Next").and_then(Obj::as_ref_value);
        }
        items
    }
}
