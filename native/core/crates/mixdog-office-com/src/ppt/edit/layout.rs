//! `PowerPoint-Layout` of `office-com-host.ps1`: a slide layout of the deck's master by index, by name or by type.

use crate::com::Error;
use crate::com::Result;
use crate::com::Value as Com;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::payload;
use crate::ps::text;

use super::count;
use super::i4;
use super::int_value;
use super::item;
use super::string_value;
use super::text_of;

/// The layout types in `PpSlideLayout` order (title = 1 ... picTx = 36), the names the portable writer reads from the layout
/// part.
const TYPES: [&str; 36] = [
    "title",
    "tx",
    "twoColTx",
    "tbl",
    "txAndChart",
    "chartAndTx",
    "dgm",
    "chart",
    "txAndClipArt",
    "clipArtAndTx",
    "titleOnly",
    "blank",
    "txAndObj",
    "objAndTx",
    "objOnly",
    "obj",
    "txAndMedia",
    "mediaAndTx",
    "objOverTx",
    "txOverObj",
    "txAndTwoObj",
    "twoObjAndTx",
    "twoObjOverTx",
    "fourObj",
    "vertTx",
    "clipArtAndVertTx",
    "vertTitleAndTx",
    "vertTitleAndTxOverChart",
    "twoObj",
    "objAndTwoObj",
    "twoObjAndObj",
    "cust",
    "secHead",
    "twoTxTwoObj",
    "objTx",
    "picTx",
];

/// The default layouts' English names, which the portable writer's template carries, and the types they name: a PowerPoint of
/// another language calls them otherwise ("제목만" for Title Only).
const DEFAULT_NAMES: [(&str, &str); 10] = [
    ("title slide", "title"),
    ("title and content", "obj"),
    ("section header", "secHead"),
    ("two content", "twoObj"),
    ("comparison", "twoTxTwoObj"),
    ("title only", "titleOnly"),
    ("content with caption", "objTx"),
    ("picture with caption", "picTx"),
    ("title and vertical text", "vertTx"),
    ("vertical title and text", "vertTitleAndTx"),
];

/// A layout and its 1-based index in the master's `CustomLayouts`.
pub(crate) struct Layout {
    pub index: i32,
    pub layout: Com,
}

fn found(layouts: &Com, index: i32) -> Result<Layout> {
    Ok(Layout { index, layout: item(layouts, index)? })
}

/// The first layout named Blank, else the first with no content placeholder, else the last.
fn default_layout(layouts: &Com) -> Result<Layout> {
    let mut index = 1;
    while index <= count(layouts)? {
        if payload::names_equal(&string_value(&item(layouts, index)?.member("Name")?), "Blank") {
            return found(layouts, index);
        }
        index += 1;
    }
    let mut index = 1;
    while index <= count(layouts)? {
        let candidate = item(layouts, index)?;
        let mut content_placeholders = 0;
        let mut shape_index = 1;
        while shape_index <= count(&candidate.member("Shapes")?)? {
            // A shape that cannot be read counts as content.
            let counts = || -> Result<bool> {
                let shape = item(&candidate.member("Shapes")?, shape_index)?;
                if int_value(&shape.member("Type")?)? != 14 {
                    return Ok(false);
                }
                let placeholder = int_value(&shape.member("PlaceholderFormat")?.member("Type")?)?;
                Ok(![13, 15, 16].contains(&placeholder))
            };
            if counts().unwrap_or(true) {
                content_placeholders += 1;
            }
            shape_index += 1;
        }
        if content_placeholders == 0 {
            return Ok(Layout { index, layout: candidate });
        }
        index += 1;
    }
    // `@{ Index = $layouts.Count; Layout = $layouts.Item($layouts.Count) }`: the count is read for each.
    let last = count(layouts)?;
    Ok(Layout { index: last, layout: item(layouts, count(layouts)?)? })
}

/// `PowerPoint-Layout $presentation $reference`.
pub(crate) fn powerpoint_layout(presentation: &Com, reference: &Value) -> Result<Layout> {
    let layouts = presentation.member("SlideMaster")?.member("CustomLayouts")?;
    let reference_text = text_of(reference);
    if reference.is_null() || reference_text.chars().all(char::is_whitespace) {
        return default_layout(&layouts);
    }
    if let Some(numeric) = convert::try_parse_int(&reference_text) {
        if numeric < 1 || numeric > count(&layouts)? {
            return Err(Error::host(format!("PowerPoint layout index out of range: {numeric}")));
        }
        return found(&layouts, numeric);
    }
    let mut available: Vec<String> = Vec::new();
    let mut index = 1;
    while index <= count(&layouts)? {
        let candidate = item(&layouts, index)?;
        let name = string_value(&candidate.member("Name")?);
        available.push(name.clone());
        if payload::names_equal(&name, &reference_text) {
            return Ok(Layout { index, layout: candidate });
        }
        index += 1;
    }
    let lookup = text::to_lower_invariant(reference_text.trim());
    let type_name = DEFAULT_NAMES
        .iter()
        .find(|(name, _)| *name == lookup)
        .map_or(reference_text.as_str(), |(_, type_name)| *type_name);
    let wanted = TYPES.iter().position(|known| payload::names_equal(known, type_name)).map_or(0, |at| at as i32 + 1);
    if wanted > 0 {
        let mut index = 1;
        while index <= count(&layouts)? {
            let slides = presentation.member("Slides")?;
            let at = count(&presentation.member("Slides")?)? + 1;
            let probe = slides.call_member("AddSlide", &[i4(at), item(&layouts, index)?])?;
            let slide_type = int_value(&probe.member("Layout")?)?;
            probe.call_member("Delete", &[])?;
            if slide_type == wanted {
                return found(&layouts, index);
            }
            index += 1;
        }
    }
    Err(Error::host(format!("PowerPoint layout '{reference_text}' not found; available layouts: {}", available.join(", "))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_types_run_in_ppslidelayout_order() {
        assert_eq!(TYPES[0], "title");
        assert_eq!(TYPES[10], "titleOnly");
        assert_eq!(TYPES[11], "blank");
        assert_eq!(TYPES[35], "picTx");
        assert_eq!(TYPES.len(), 36);
    }

    #[test]
    fn every_default_name_names_a_known_type() {
        for (_, type_name) in DEFAULT_NAMES {
            assert!(TYPES.contains(&type_name), "{type_name}");
        }
    }
}
