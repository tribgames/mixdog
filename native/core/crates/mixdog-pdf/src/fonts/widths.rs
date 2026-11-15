//! The widths of a font, ported from pdf.js 6.4.299 (`PartialEvaluator.extractWidths`, `getBaseFontMetrics`,
//! `buildCharCodeToWidth`, `isSerifFont` of `src/core/evaluator.js` and `normalizeFontName` of `src/core/fonts_utils.js`):
//! `/Widths` with `/FirstChar` and `/MissingWidth` of a simple font, `/DW` and `/W` of a CID font, `/DW2` and `/W2` of
//! vertical writing, and the Standard 14 metrics of a font that has no widths of its own.

use std::collections::BTreeMap;

use super::data::{
    self, Metrics, font_flags,
    standard_fonts::{SERIF_FONTS, STD_FONT_MAP},
};
use super::font::Properties;
use crate::error::{PdfError, Result};
use crate::object::{Dict, Obj};
use crate::xref::Xref;

/// The most entries one `/W` or `/W2` range may fill. pdf.js fills an array of any length; a file that asks for more
/// than any font has glyphs (the largest CID is 65535) is damaged, and its font fails here instead of running out of
/// memory.
const MAX_RANGE_ENTRIES: i64 = 1 << 24;

/// The glyph name to width table of a Standard 14 font (`None` for a fixed-width face).
pub type GlyphWidths = Option<&'static [(&'static str, u16)]>;

/// `normalizeFontName(name)`: `,` and `_` become `-`, white space goes.
pub fn normalize_font_name(name: &str) -> String {
    name.chars()
        .filter(|ch| !data::is_js_whitespace(*ch))
        .map(|ch| if ch == ',' || ch == '_' { '-' } else { ch })
        .collect()
}

/// `getStandardFontName(name)`.
pub fn get_standard_font_name(name: &str) -> Option<&'static str> {
    data::lookup(&STD_FONT_MAP, &normalize_font_name(name))
}

/// `isSerifFont(baseFontName)`: the name before the first `-` is a serif face or says "serif".
pub fn is_serif_font(base_font_name: &str) -> bool {
    let without_style = base_font_name.split('-').next().unwrap_or("");
    data::contains_name(&SERIF_FONTS, without_style)
        || without_style.to_lowercase().contains("serif")
}

/// What `getBaseFontMetrics` returns.
#[derive(Debug, Clone, Copy)]
pub struct BaseFontMetrics {
    pub default_width: f64,
    pub monospace: bool,
    pub widths: GlyphWidths,
}

/// `getBaseFontMetrics(name)`: the Standard 14 metrics of the font the name stands for (a serif or a sans-serif
/// face when it stands for none).
pub fn get_base_font_metrics(name: &str) -> BaseFontMetrics {
    let normalized = normalize_font_name(name);
    let font_name = data::lookup(&STD_FONT_MAP, &normalized).unwrap_or(&normalized);
    let metrics = data::metrics_of(font_name).unwrap_or_else(|| {
        let fallback = if is_serif_font(name) {
            "Times-Roman"
        } else {
            "Helvetica"
        };
        data::metrics_of(fallback).expect("the Standard 14 table holds Times-Roman and Helvetica")
    });
    match metrics {
        Metrics::Fixed(width) => BaseFontMetrics {
            default_width: f64::from(width),
            monospace: true,
            widths: None,
        },
        Metrics::Glyphs(table) => BaseFontMetrics {
            default_width: 0.0,
            monospace: false,
            widths: Some(table),
        },
    }
}

fn glyph_width(widths: GlyphWidths, glyph_name: &str) -> Option<f64> {
    let width = data::lookup(widths?, glyph_name)?;
    (width != 0).then_some(f64::from(width))
}

/// `buildCharCodeToWidth(widthsByGlyphName, properties)`: the width of each code 0 to 255 by the glyph the font's
/// `/Differences` or its base encoding gives it.
pub fn build_char_code_to_width(
    widths_by_glyph_name: GlyphWidths,
    properties: &Properties,
) -> BTreeMap<i64, f64> {
    let mut widths = BTreeMap::new();
    for char_code in 0..256_i64 {
        let from_differences = properties
            .differences
            .get(char_code)
            .and_then(|glyph| glyph_width(widths_by_glyph_name, glyph));
        let width = from_differences.or_else(|| {
            usize::try_from(char_code)
                .ok()
                .and_then(|code| properties.default_encoding.get(code))
                .and_then(|glyph| glyph_width(widths_by_glyph_name, glyph))
        });
        if let Some(width) = width {
            widths.insert(char_code, width);
        }
    }
    widths
}

/// `Number.isInteger(value)`.
pub(crate) fn is_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}

fn integer_of(obj: &Obj) -> Option<i64> {
    match obj {
        Obj::Num(n) if is_integer(*n) => Some(*n as i64),
        _ => None,
    }
}

/// `isNumberArray(items, len)` of the objects as they were fetched.
fn number_array(items: &[Obj], len: Option<usize>) -> Option<Vec<f64>> {
    if len.is_some_and(|len| len != items.len()) {
        return None;
    }
    items.iter().map(Obj::as_num).collect()
}

fn fetch(xref: &Xref, item: Option<&Obj>) -> Result<Obj> {
    match item {
        Some(item) => xref.fetch_if_ref(item, false),
        None => Ok(Obj::Null),
    }
}

fn check_range(start: i64, end: i64) -> Result<()> {
    if end.saturating_sub(start) >= MAX_RANGE_ENTRIES {
        return Err(PdfError::Unknown("Invalid array length".to_owned()));
    }
    Ok(())
}

/// The `/W` array of a CID font (`glyphsWidths`).
fn composite_widths(xref: &Xref, widths: &[Obj], out: &mut BTreeMap<i64, f64>) -> Result<()> {
    let mut i = 0;
    while i < widths.len() {
        let Some(mut start) = integer_of(&fetch(xref, widths.get(i))?) else {
            break;
        };
        i += 1;
        let code = fetch(xref, widths.get(i))?;
        if let Obj::Array(items) = &code {
            for item in items.iter() {
                if let Obj::Num(width) = fetch(xref, Some(item))? {
                    out.insert(start, width);
                }
                start += 1;
            }
        } else if let Some(end) = integer_of(&code) {
            i += 1;
            let Obj::Num(width) = fetch(xref, widths.get(i))? else {
                i += 1;
                continue;
            };
            check_range(start, end)?;
            for j in start..=end {
                out.insert(j, width);
            }
        } else {
            break;
        }
        i += 1;
    }
    Ok(())
}

/// The `/W2` array of a CID font written vertically (`glyphsVMetrics`).
fn vertical_metrics(xref: &Xref, items: &[Obj], out: &mut BTreeMap<i64, [f64; 3]>) -> Result<()> {
    let mut i = 0;
    while i < items.len() {
        let Some(mut start) = integer_of(&fetch(xref, items.get(i))?) else {
            break;
        };
        i += 1;
        let code = fetch(xref, items.get(i))?;
        if let Obj::Array(values) = &code {
            let mut j = 0;
            while j < values.len() {
                let triple = [
                    fetch(xref, values.get(j))?,
                    fetch(xref, values.get(j + 1))?,
                    fetch(xref, values.get(j + 2))?,
                ];
                if let Some(metric) = number_array(&triple, Some(3)) {
                    out.insert(start, [metric[0], metric[1], metric[2]]);
                }
                start += 1;
                j += 3;
            }
        } else if let Some(end) = integer_of(&code) {
            let triple = [
                fetch(xref, items.get(i + 1))?,
                fetch(xref, items.get(i + 2))?,
                fetch(xref, items.get(i + 3))?,
            ];
            i += 3;
            if let Some(metric) = number_array(&triple, Some(3)) {
                check_range(start, end)?;
                for j in start..=end {
                    out.insert(j, [metric[0], metric[1], metric[2]]);
                }
            }
        } else {
            break;
        }
        i += 1;
    }
    Ok(())
}

/// `extractWidths(dict, descriptor, properties)`: fills `widths`, `default_width`, `vmetrics` and
/// `default_vmetrics`, and sets or clears the fixed-pitch flag by whether every glyph has the same width.
pub fn extract_widths(
    xref: &Xref,
    dict: &Dict,
    descriptor: &Dict,
    properties: &mut Properties,
) -> Result<()> {
    let mut glyph_widths: BTreeMap<i64, f64> = BTreeMap::new();
    let mut default_width = 0.0;
    let mut glyph_vmetrics: BTreeMap<i64, [f64; 3]> = BTreeMap::new();
    let mut default_vmetrics = None;
    if properties.composite {
        default_width = match xref.get(dict, "DW")? {
            Obj::Num(dw) => dw.ceil(),
            _ => 1000.0,
        };
        if let Obj::Array(widths) = xref.get(dict, "W")? {
            composite_widths(xref, &widths, &mut glyph_widths)?;
        }
        if properties.vertical {
            let vmetrics = match xref.get_array(dict, "DW2")? {
                Obj::Array(items) => number_array(&items, Some(2)),
                _ => None,
            }
            .unwrap_or_else(|| vec![880.0, -1000.0]);
            default_vmetrics = Some([vmetrics[1], default_width * 0.5, vmetrics[0]]);
            if let Obj::Array(items) = xref.get(dict, "W2")? {
                vertical_metrics(xref, &items, &mut glyph_vmetrics)?;
            }
        }
    } else if let Obj::Array(widths) = xref.get(dict, "Widths")? {
        for (code, item) in (properties.first_char..).zip(widths.iter()) {
            if let Obj::Num(width) = fetch(xref, Some(item))? {
                glyph_widths.insert(code, width);
            }
        }
        default_width = match xref.get(descriptor, "MissingWidth")? {
            Obj::Num(width) => width,
            _ => 0.0,
        };
    } else if let Obj::Name(base_font) = xref.get(dict, "BaseFont")? {
        let metrics = get_base_font_metrics(&base_font);
        glyph_widths = build_char_code_to_width(metrics.widths, properties);
        default_width = metrics.default_width;
    }
    let mut is_monospace = true;
    let mut first_width = default_width;
    for &glyph_width in glyph_widths.values() {
        if glyph_width == 0.0 || glyph_width.is_nan() {
            continue;
        }
        if first_width == 0.0 || first_width.is_nan() {
            first_width = glyph_width;
            continue;
        }
        if first_width != glyph_width {
            is_monospace = false;
            break;
        }
    }
    if is_monospace {
        properties.flags |= font_flags::FIXED_PITCH as i32;
    } else {
        properties.flags &= !(font_flags::FIXED_PITCH as i32);
    }
    properties.default_width = default_width;
    properties.widths = glyph_widths;
    properties.default_vmetrics = default_vmetrics;
    properties.vmetrics = glyph_vmetrics;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn font_names_are_normalised_like_pdfjs() {
        assert_eq!(
            normalize_font_name("Times New Roman,Bold"),
            "TimesNewRoman-Bold"
        );
        assert_eq!(normalize_font_name("Arial_Black"), "Arial-Black");
    }

    #[test]
    fn serif_faces_are_found_by_name_before_the_style() {
        assert!(is_serif_font("Times-Roman"));
        assert!(is_serif_font("MySerifText-Bold"));
        assert!(!is_serif_font("Helvetica-Bold"));
    }

    #[test]
    fn the_base_metrics_of_a_standard_font() {
        let courier = get_base_font_metrics("Courier-Bold");
        assert!(courier.monospace);
        assert_eq!(courier.default_width, 600.0);
        assert!(courier.widths.is_none());
        let helvetica = get_base_font_metrics("Helvetica");
        assert!(!helvetica.monospace);
        assert_eq!(glyph_width(helvetica.widths, "space"), Some(278.0));
        // An unknown face gets the metrics of Helvetica, or of Times-Roman when it is a serif one.
        let unknown = get_base_font_metrics("Frobnitz");
        assert_eq!(glyph_width(unknown.widths, "space"), Some(278.0));
        let serif = get_base_font_metrics("FrobnitzSerif");
        assert_eq!(glyph_width(serif.widths, "space"), Some(250.0));
    }

    #[test]
    fn integers_are_what_number_is_integer_says() {
        assert!(is_integer(3.0));
        assert!(!is_integer(3.5));
        assert!(!is_integer(f64::NAN));
        assert!(!is_integer(f64::INFINITY));
    }
}
