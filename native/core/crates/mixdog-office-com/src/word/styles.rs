//! `Word-CanonicalStyleName`: Word reports a style under the UI language (a Korean install answers "제목 1" where the package
//! stores the id `Heading1`), so a name read from the document is mapped back onto the identifier the writer accepts.
//!
//! The map of local names is read from the document's own built-in styles on first use and kept for the life of the host,
//! as `$script:WordLocalStyleMap` was. It lives per thread: a host's COM work is on one apartment thread.

use std::cell::RefCell;

use crate::com::Obj;
use crate::com::Result;
use crate::com::Value as Com;
use crate::ps::collate::strings_equal_ignore_case;

/// `$script:WordBuiltinStyleIds`, in the order `GetEnumerator()` lists a Windows PowerShell hashtable of these 36 keys
/// (a .NET Framework `Hashtable` of 89 buckets, filled in the order of the script, listed from its last bucket down): the
/// order the document is asked for each style's local name, and the order a name two ids share is overwritten in.
const BUILTIN_STYLE_IDS: &[(i32, &str)] = &[
    (-158, "NoSpacing"),
    (-75, "Subtitle"),
    (-32, "Header"),
    (-85, "BlockText"),
    (-267, "TOCHeading"),
    (-1, "Normal"),
    (-2, "Heading1"),
    (-3, "Heading2"),
    (-4, "Heading3"),
    (-5, "Heading4"),
    (-6, "Heading5"),
    (-7, "Heading6"),
    (-8, "Heading7"),
    (-9, "Heading8"),
    (-10, "Heading9"),
    (-106, "TableNormal"),
    (-20, "TOC1"),
    (-21, "TOC2"),
    (-22, "TOC3"),
    (-91, "PlainText"),
    (-30, "FootnoteText"),
    (-180, "ListParagraph"),
    (-181, "Quote"),
    (-182, "IntenseQuote"),
    (-35, "Caption"),
    (-44, "EndnoteText"),
    (-49, "ListBullet"),
    (-50, "ListNumber"),
    (-55, "ListBullet2"),
    (-56, "ListBullet3"),
    (-33, "Footer"),
    (-59, "ListNumber2"),
    (-60, "ListNumber3"),
    (-63, "Title"),
    (-155, "TableGrid"),
    (-67, "BodyText"),
];

thread_local! {
    /// The local name of each built-in style the document reported, to its identifier; `None` until first asked.
    static LOCAL_NAMES: RefCell<Option<Vec<(String, &'static str)>>> = const { RefCell::new(None) };
}

fn is_blank(text: &str) -> bool {
    text.trim().is_empty()
}

/// `[string]$doc.Styles.Item([int]$id).NameLocal`.
fn local_name(document: &Obj, id: i32) -> Result<String> {
    let styles: Com = document.get("Styles")?;
    let style = super::item(&styles, id)?;
    Ok(super::string(&style.member("NameLocal")?))
}

fn read_local_names(document: &Obj) -> Vec<(String, &'static str)> {
    let mut map: Vec<(String, &'static str)> = Vec::new();
    for (id, canonical) in BUILTIN_STYLE_IDS {
        let Ok(local) = local_name(document, *id) else { continue };
        if is_blank(&local) {
            continue;
        }
        match map.iter_mut().find(|entry| strings_equal_ignore_case(&entry.0, &local)) {
            Some(entry) => entry.1 = *canonical,
            None => map.push((local, *canonical)),
        }
    }
    map
}

/// `Word-CanonicalStyleName`: the identifier of the built-in style a local name is, else the name as it is; a blank name is
/// the empty string.
pub(crate) fn canonical_style_name(document: &Obj, local: &str) -> String {
    if is_blank(local) {
        return String::new();
    }
    LOCAL_NAMES.with(|cell| {
        let mut names = cell.borrow_mut();
        let map = names.get_or_insert_with(|| read_local_names(document));
        map.iter().find(|entry| strings_equal_ignore_case(&entry.0, local)).map_or_else(|| local.to_owned(), |entry| entry.1.to_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_enumeration_order_lists_every_id_once() {
        let mut ids: Vec<i32> = BUILTIN_STYLE_IDS.iter().map(|(id, _)| *id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 36);
        assert_eq!(BUILTIN_STYLE_IDS[0], (-158, "NoSpacing"));
        assert_eq!(BUILTIN_STYLE_IDS[35], (-67, "BodyText"));
    }
}
