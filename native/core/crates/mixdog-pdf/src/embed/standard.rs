//! The standard 14 fonts as pdf-lib's `StandardFontEmbedder` serves them: WinAnsi (Symbol and ZapfDingbats: their own
//! encodings), the AFM widths and kerning pairs of `@pdf-lib/standard-fonts` 1.0.0 (the file `standard_data.txt`, written
//! by `benchmarks/rust-core/recorders/record-office-embed.mjs --standard-data`), and the one-dictionary font object.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use crate::{Dict, Obj};

use super::EmbedError;

const DATA: &str = include_str!("standard_data.txt");

/// A font of the standard 14.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StandardFontName {
    Courier,
    CourierBold,
    CourierOblique,
    CourierBoldOblique,
    Helvetica,
    HelveticaBold,
    HelveticaOblique,
    HelveticaBoldOblique,
    TimesRoman,
    TimesRomanBold,
    TimesRomanItalic,
    TimesRomanBoldItalic,
    Symbol,
    ZapfDingbats,
}

impl StandardFontName {
    pub const ALL: [StandardFontName; 14] = [
        Self::Courier,
        Self::CourierBold,
        Self::CourierOblique,
        Self::CourierBoldOblique,
        Self::Helvetica,
        Self::HelveticaBold,
        Self::HelveticaOblique,
        Self::HelveticaBoldOblique,
        Self::TimesRoman,
        Self::TimesRomanBold,
        Self::TimesRomanItalic,
        Self::TimesRomanBoldItalic,
        Self::Symbol,
        Self::ZapfDingbats,
    ];

    /// The PostScript name, which is also the `BaseFont` (`StandardFonts` of pdf-lib).
    pub fn name(self) -> &'static str {
        match self {
            Self::Courier => "Courier",
            Self::CourierBold => "Courier-Bold",
            Self::CourierOblique => "Courier-Oblique",
            Self::CourierBoldOblique => "Courier-BoldOblique",
            Self::Helvetica => "Helvetica",
            Self::HelveticaBold => "Helvetica-Bold",
            Self::HelveticaOblique => "Helvetica-Oblique",
            Self::HelveticaBoldOblique => "Helvetica-BoldOblique",
            Self::TimesRoman => "Times-Roman",
            Self::TimesRomanBold => "Times-Bold",
            Self::TimesRomanItalic => "Times-Italic",
            Self::TimesRomanBoldItalic => "Times-BoldItalic",
            Self::Symbol => "Symbol",
            Self::ZapfDingbats => "ZapfDingbats",
        }
    }

    /// The font called `name` (its PostScript name).
    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|font| font.name() == name)
    }

    fn encoding(self) -> usize {
        match self {
            Self::ZapfDingbats => 2,
            Self::Symbol => 1,
            _ => 0,
        }
    }
}

const ENCODING_NAMES: [&str; 3] = ["WinAnsi", "Symbol", "ZapfDingbats"];

/// One encoding: Unicode code point to `(code, glyph name)`.
type Encoding = HashMap<u32, (u8, &'static str)>;

struct Metrics {
    ascender: Option<f64>,
    descender: Option<f64>,
    bbox: [f64; 4],
    widths: HashMap<&'static str, f64>,
    kerning: HashMap<(&'static str, &'static str), f64>,
}

struct Data {
    encodings: [Encoding; 3],
    fonts: Vec<(&'static str, Metrics)>,
}

fn number(text: &str) -> f64 {
    text.parse().unwrap_or(0.0)
}

fn parse() -> Data {
    let mut encodings: [Encoding; 3] = [Encoding::new(), Encoding::new(), Encoding::new()];
    let mut fonts: Vec<(&'static str, Metrics)> = Vec::new();
    let mut encoding: Option<usize> = None;
    for line in DATA.lines() {
        let mut parts = line.split(' ');
        match parts.next() {
            Some("encoding") => {
                encoding = parts
                    .next()
                    .and_then(|name| ENCODING_NAMES.iter().position(|known| *known == name));
            }
            Some("c") => {
                let (Some(index), Some(point), Some(code), Some(name)) =
                    (encoding, parts.next(), parts.next(), parts.next())
                else {
                    continue;
                };
                encodings[index].insert(
                    point.parse().unwrap_or(0),
                    (code.parse().unwrap_or(0), name),
                );
            }
            Some("font") => {
                encoding = None;
                fonts.push((
                    parts.next().unwrap_or(""),
                    Metrics {
                        ascender: None,
                        descender: None,
                        bbox: [0.0; 4],
                        widths: HashMap::new(),
                        kerning: HashMap::new(),
                    },
                ));
            }
            Some("m") => {
                let Some((_, metrics)) = fonts.last_mut() else {
                    continue;
                };
                let values: Vec<&str> = parts.collect();
                if values.len() == 6 {
                    metrics.ascender = (values[0] != "-").then(|| number(values[0]));
                    metrics.descender = (values[1] != "-").then(|| number(values[1]));
                    metrics.bbox = [
                        number(values[2]),
                        number(values[3]),
                        number(values[4]),
                        number(values[5]),
                    ];
                }
            }
            Some("w") => {
                let (Some((_, metrics)), Some(name), Some(width)) =
                    (fonts.last_mut(), parts.next(), parts.next())
                else {
                    continue;
                };
                metrics.widths.insert(name, number(width));
            }
            Some("k") => {
                let (Some((_, metrics)), Some(left)) = (fonts.last_mut(), parts.next()) else {
                    continue;
                };
                for pair in parts {
                    if let Some((right, amount)) = pair.rsplit_once(':') {
                        metrics.kerning.insert((left, right), number(amount));
                    }
                }
            }
            _ => {}
        }
    }
    Data { encodings, fonts }
}

fn data() -> &'static Data {
    static DATA: OnceLock<Data> = OnceLock::new();
    DATA.get_or_init(parse)
}

/// JavaScript's `a || b` on numbers: `b` for a missing or zero `a`.
fn or(value: Option<f64>, fallback: f64) -> f64 {
    match value {
        Some(value) if value != 0.0 => value,
        _ => fallback,
    }
}

/// A standard font: what pdf-lib's `PDFFont` of a standard font answers.
#[derive(Debug, Clone, Copy)]
pub struct StandardFont {
    name: StandardFontName,
}

impl StandardFont {
    pub fn new(name: StandardFontName) -> Self {
        Self { name }
    }

    pub fn name(&self) -> &'static str {
        self.name.name()
    }

    pub fn font_name(&self) -> StandardFontName {
        self.name
    }

    fn metrics(&self) -> &'static Metrics {
        &data()
            .fonts
            .iter()
            .find(|(name, _)| *name == self.name.name())
            .expect("every standard font is in the data file")
            .1
    }

    fn table(&self) -> &'static Encoding {
        &data().encodings[self.name.encoding()]
    }

    /// True when the encoding of the font has a code for `character`.
    pub fn can_encode(&self, character: char) -> bool {
        self.table().contains_key(&(character as u32))
    }

    fn glyph(&self, character: char) -> Result<(u8, &'static str), EmbedError> {
        let code_point = character as u32;
        match self.table().get(&code_point) {
            Some(found) => Ok(*found),
            None => {
                // `String.fromCharCode(codePoint)` keeps the low 16 bits: a surrogate half cannot be a Rust character.
                let shown = char::from_u32(code_point & 0xFFFF).unwrap_or('\u{FFFD}');
                Err(EmbedError::new(format!(
                    "{} cannot encode \"{}\" (0x{:04x})",
                    ENCODING_NAMES[self.name.encoding()],
                    shown,
                    code_point
                )))
            }
        }
    }

    fn glyphs(&self, text: &str) -> Result<Vec<(u8, &'static str)>, EmbedError> {
        text.chars()
            .map(|character| self.glyph(character))
            .collect()
    }

    /// `encodeText`: one byte per character (pdf-lib writes them as a hex string).
    pub fn encode_text(&self, text: &str) -> Result<Vec<u8>, EmbedError> {
        Ok(self
            .glyphs(text)?
            .into_iter()
            .map(|(code, _)| code)
            .collect())
    }

    /// `widthOfTextAtSize`: the AFM widths plus the kerning of each pair, a missing width counted as 250.
    pub fn width_of_text_at_size(&self, text: &str, size: f64) -> Result<f64, EmbedError> {
        let glyphs = self.glyphs(text)?;
        let metrics = self.metrics();
        let mut total = 0.0;
        for (index, (_, left)) in glyphs.iter().enumerate() {
            let kerning = glyphs
                .get(index + 1)
                .and_then(|(_, right)| metrics.kerning.get(&(*left, *right)))
                .copied()
                .unwrap_or(0.0);
            total += or(metrics.widths.get(left).copied(), 250.0) + kerning;
        }
        Ok(total * (size / 1000.0))
    }

    /// `heightAtSize`.
    pub fn height_at_size(&self, size: f64, descender: bool) -> f64 {
        let metrics = self.metrics();
        let top = or(metrics.ascender, metrics.bbox[3]);
        let bottom = or(metrics.descender, metrics.bbox[1]);
        let mut height = top - bottom;
        if !descender {
            height += metrics.descender.unwrap_or(0.0);
        }
        (height / 1000.0) * size
    }

    /// `sizeAtHeight`.
    pub fn size_at_height(&self, height: f64) -> f64 {
        let metrics = self.metrics();
        let top = or(metrics.ascender, metrics.bbox[3]);
        let bottom = or(metrics.descender, metrics.bbox[1]);
        (1000.0 * height) / (top - bottom)
    }

    /// The font dictionary pdf-lib writes: `Type1`, the `BaseFont` and, for the WinAnsi fonts, `WinAnsiEncoding`.
    pub fn dictionary(&self) -> Dict {
        let mut dict = Dict::new();
        dict.set("Type", Obj::name("Font"));
        dict.set("Subtype", Obj::name("Type1"));
        dict.set("BaseFont", Obj::Name(Arc::from(self.name.name())));
        if self.name.encoding() == 0 {
            dict.set("Encoding", Obj::name("WinAnsiEncoding"));
        }
        dict
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helvetica_widths_include_kerning() {
        let font = StandardFont::new(StandardFontName::Helvetica);
        // H e l l o: 722 556 222 222 556, no pair kerned
        let plain = font.width_of_text_at_size("Hello", 10.0).unwrap();
        assert!((plain - 22.78).abs() < 1e-9, "{plain}");
        // A V: Helvetica kerns the pair by -70
        let kerned = font.width_of_text_at_size("AV", 1000.0).unwrap();
        assert_eq!(kerned, 667.0 + 667.0 - 70.0);
    }

    #[test]
    fn winansi_codes_and_refusals() {
        let font = StandardFont::new(StandardFontName::Helvetica);
        assert_eq!(
            font.encode_text("a\u{20ac}\u{2013}").unwrap(),
            vec![0x61, 0x80, 0x96]
        );
        assert_eq!(
            font.encode_text("한").unwrap_err().to_string(),
            "WinAnsi cannot encode \"한\" (0xd55c)"
        );
        assert_eq!(
            font.encode_text("\u{1F600}").unwrap_err().to_string(),
            "WinAnsi cannot encode \"\u{F600}\" (0x1f600)"
        );
        let symbol = StandardFont::new(StandardFontName::Symbol);
        assert!(symbol.encode_text("\u{3b1}").is_ok());
        assert_eq!(
            symbol
                .encode_text("a\u{20ac}")
                .unwrap_err()
                .to_string()
                .split('"')
                .next(),
            Some("Symbol cannot encode ")
        );
    }

    #[test]
    fn heights_follow_the_ascender_or_the_bounding_box() {
        let helvetica = StandardFont::new(StandardFontName::Helvetica);
        assert_eq!(helvetica.height_at_size(1000.0, true), 925.0);
        assert_eq!(helvetica.height_at_size(1000.0, false), 718.0);
        let symbol = StandardFont::new(StandardFontName::Symbol);
        assert_eq!(symbol.height_at_size(1000.0, true), 1010.0 + 293.0);
    }

    #[test]
    fn the_dictionary_names_the_encoding_of_the_winansi_fonts_only() {
        assert!(
            StandardFont::new(StandardFontName::TimesRoman)
                .dictionary()
                .has("Encoding")
        );
        assert!(
            !StandardFont::new(StandardFontName::ZapfDingbats)
                .dictionary()
                .has("Encoding")
        );
    }

    #[test]
    fn every_font_is_in_the_data_file() {
        for name in StandardFontName::ALL {
            assert_eq!(StandardFontName::from_name(name.name()), Some(name));
            assert!(
                StandardFont::new(name)
                    .width_of_text_at_size(" ", 1.0)
                    .is_ok()
            );
        }
    }
}
