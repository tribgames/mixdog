//! The standard 14 fonts and missing fonts: pdf.js `standard_fonts.js` (the name tables) and the loader of the bundled
//! substitute font files (`assets/standard_fonts/`, pdfjs-dist `standard_fonts/`).
//!
//! The substitute files are read only in the rendering configuration: it creates a [`StandardFonts`] over a reader of
//! the folder `assets/standard_fonts` (pdf.js `standardFontDataUrl`; the reader is the configuration's, so this crate
//! does no file I/O). The office analysis configuration never creates one, so no font file is read there.
//! Rendering runs without `useSystemFonts`: every name the table knows is drawn from its substitute file.

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex};

/// pdf.js `normalizeFontName`: `,` and `_` become `-`, whitespace is removed.
pub fn normalize_font_name(name: &str) -> String {
    name.chars().map(|c| if c == ',' || c == '_' { '-' } else { c }).filter(|&c| !is_js_whitespace(c)).collect()
}

/// The characters of the JS regular expression class `\s`.
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// pdf.js `getStdFontMap`: the names of fonts that are (or alias) one of the standard 14, and the standard name they
/// are drawn as.
const STD_FONT_MAP: &[(&str, &str)] = &[
    ("Times-Roman", "Times-Roman"),
    ("Helvetica", "Helvetica"),
    ("Courier", "Courier"),
    ("Symbol", "Symbol"),
    ("Times-Bold", "Times-Bold"),
    ("Helvetica-Bold", "Helvetica-Bold"),
    ("Courier-Bold", "Courier-Bold"),
    ("ZapfDingbats", "ZapfDingbats"),
    ("Times-Italic", "Times-Italic"),
    ("Helvetica-Oblique", "Helvetica-Oblique"),
    ("Courier-Oblique", "Courier-Oblique"),
    ("Times-BoldItalic", "Times-BoldItalic"),
    ("Helvetica-BoldOblique", "Helvetica-BoldOblique"),
    ("Courier-BoldOblique", "Courier-BoldOblique"),
    ("ArialNarrow", "Helvetica"),
    ("ArialNarrow-Bold", "Helvetica-Bold"),
    ("ArialNarrow-BoldItalic", "Helvetica-BoldOblique"),
    ("ArialNarrow-Italic", "Helvetica-Oblique"),
    ("ArialBlack", "Helvetica"),
    ("ArialBlack-Bold", "Helvetica-Bold"),
    ("ArialBlack-BoldItalic", "Helvetica-BoldOblique"),
    ("ArialBlack-Italic", "Helvetica-Oblique"),
    ("Arial-Black", "Helvetica"),
    ("Arial-Black-Bold", "Helvetica-Bold"),
    ("Arial-Black-BoldItalic", "Helvetica-BoldOblique"),
    ("Arial-Black-Italic", "Helvetica-Oblique"),
    ("Arial", "Helvetica"),
    ("Arial-Bold", "Helvetica-Bold"),
    ("Arial-BoldItalic", "Helvetica-BoldOblique"),
    ("Arial-Italic", "Helvetica-Oblique"),
    ("ArialMT", "Helvetica"),
    ("Arial-BoldItalicMT", "Helvetica-BoldOblique"),
    ("Arial-BoldMT", "Helvetica-Bold"),
    ("Arial-ItalicMT", "Helvetica-Oblique"),
    ("Arial-BoldItalicMT-BoldItalic", "Helvetica-BoldOblique"),
    ("Arial-BoldMT-Bold", "Helvetica-Bold"),
    ("Arial-ItalicMT-Italic", "Helvetica-Oblique"),
    ("ArialUnicodeMS", "Helvetica"),
    ("ArialUnicodeMS-Bold", "Helvetica-Bold"),
    ("ArialUnicodeMS-BoldItalic", "Helvetica-BoldOblique"),
    ("ArialUnicodeMS-Italic", "Helvetica-Oblique"),
    ("Courier-BoldItalic", "Courier-BoldOblique"),
    ("Courier-Italic", "Courier-Oblique"),
    ("CourierNew", "Courier"),
    ("CourierNew-Bold", "Courier-Bold"),
    ("CourierNew-BoldItalic", "Courier-BoldOblique"),
    ("CourierNew-Italic", "Courier-Oblique"),
    ("CourierNewPS-BoldItalicMT", "Courier-BoldOblique"),
    ("CourierNewPS-BoldMT", "Courier-Bold"),
    ("CourierNewPS-ItalicMT", "Courier-Oblique"),
    ("CourierNewPSMT", "Courier"),
    ("Helvetica-BoldItalic", "Helvetica-BoldOblique"),
    ("Helvetica-Italic", "Helvetica-Oblique"),
    ("HelveticaLTStd-Bold", "Helvetica-Bold"),
    ("Symbol-Bold", "Symbol"),
    ("Symbol-BoldItalic", "Symbol"),
    ("Symbol-Italic", "Symbol"),
    ("TimesNewRoman", "Times-Roman"),
    ("TimesNewRoman-Bold", "Times-Bold"),
    ("TimesNewRoman-BoldItalic", "Times-BoldItalic"),
    ("TimesNewRoman-Italic", "Times-Italic"),
    ("TimesNewRomanPS", "Times-Roman"),
    ("TimesNewRomanPS-Bold", "Times-Bold"),
    ("TimesNewRomanPS-BoldItalic", "Times-BoldItalic"),
    ("TimesNewRomanPS-BoldItalicMT", "Times-BoldItalic"),
    ("TimesNewRomanPS-BoldMT", "Times-Bold"),
    ("TimesNewRomanPS-Italic", "Times-Italic"),
    ("TimesNewRomanPS-ItalicMT", "Times-Italic"),
    ("TimesNewRomanPSMT", "Times-Roman"),
    ("TimesNewRomanPSMT-Bold", "Times-Bold"),
    ("TimesNewRomanPSMT-BoldItalic", "Times-BoldItalic"),
    ("TimesNewRomanPSMT-Italic", "Times-Italic"),
];

/// pdf.js `getNonStdFontMap`: other well known font names with the standard (or system) font they stand for.
const NON_STD_FONT_MAP: &[(&str, &str)] = &[
    ("Calibri", "Helvetica"),
    ("Calibri-Bold", "Helvetica-Bold"),
    ("Calibri-BoldItalic", "Helvetica-BoldOblique"),
    ("Calibri-Italic", "Helvetica-Oblique"),
    ("CenturyGothic", "Helvetica"),
    ("CenturyGothic-Bold", "Helvetica-Bold"),
    ("CenturyGothic-BoldItalic", "Helvetica-BoldOblique"),
    ("CenturyGothic-Italic", "Helvetica-Oblique"),
    ("ComicSansMS", "Comic Sans MS"),
    ("ComicSansMS-Bold", "Comic Sans MS-Bold"),
    ("ComicSansMS-BoldItalic", "Comic Sans MS-BoldItalic"),
    ("ComicSansMS-Italic", "Comic Sans MS-Italic"),
    ("GillSansMT", "Helvetica"),
    ("GillSansMT-Bold", "Helvetica-Bold"),
    ("GillSansMT-BoldItalic", "Helvetica-BoldOblique"),
    ("GillSansMT-Italic", "Helvetica-Oblique"),
    ("Impact", "Helvetica"),
    ("ItcSymbol-Bold", "Helvetica-Bold"),
    ("ItcSymbol-BoldItalic", "Helvetica-BoldOblique"),
    ("ItcSymbol-Book", "Helvetica"),
    ("ItcSymbol-BookItalic", "Helvetica-Oblique"),
    ("ItcSymbol-Medium", "Helvetica"),
    ("ItcSymbol-MediumItalic", "Helvetica-Oblique"),
    ("LucidaConsole", "Courier"),
    ("LucidaConsole-Bold", "Courier-Bold"),
    ("LucidaConsole-BoldItalic", "Courier-BoldOblique"),
    ("LucidaConsole-Italic", "Courier-Oblique"),
    ("LucidaSans-Demi", "Helvetica-Bold"),
    ("MS-Gothic", "MS Gothic"),
    ("MS-Gothic-Bold", "MS Gothic-Bold"),
    ("MS-Gothic-BoldItalic", "MS Gothic-BoldItalic"),
    ("MS-Gothic-Italic", "MS Gothic-Italic"),
    ("MS-Mincho", "MS Mincho"),
    ("MS-Mincho-Bold", "MS Mincho-Bold"),
    ("MS-Mincho-BoldItalic", "MS Mincho-BoldItalic"),
    ("MS-Mincho-Italic", "MS Mincho-Italic"),
    ("MS-PGothic", "MS PGothic"),
    ("MS-PGothic-Bold", "MS PGothic-Bold"),
    ("MS-PGothic-BoldItalic", "MS PGothic-BoldItalic"),
    ("MS-PGothic-Italic", "MS PGothic-Italic"),
    ("MS-PMincho", "MS PMincho"),
    ("MS-PMincho-Bold", "MS PMincho-Bold"),
    ("MS-PMincho-BoldItalic", "MS PMincho-BoldItalic"),
    ("MS-PMincho-Italic", "MS PMincho-Italic"),
    ("NuptialScript", "Times-Italic"),
    ("SegoeUISymbol", "Helvetica"),
    ("TrebuchetMS", "Helvetica"),
    ("TrebuchetMS-Bold", "Helvetica-Bold"),
    ("TrebuchetMS-BoldItalic", "Helvetica-BoldOblique"),
    ("TrebuchetMS-Italic", "Helvetica-Oblique"),
];

/// pdf.js `getSerifFonts`: names of serif fonts.
const SERIF_FONTS: &[&str] = &[
    "Adobe Jenson",
    "Adobe Text",
    "Albertus",
    "Aldus",
    "Alexandria",
    "Algerian",
    "American Typewriter",
    "Antiqua",
    "Apex",
    "Arno",
    "Aster",
    "Aurora",
    "Baskerville",
    "Bell",
    "Bembo",
    "Bembo Schoolbook",
    "Benguiat",
    "Berkeley Old Style",
    "Bernhard Modern",
    "Berthold City",
    "Bodoni",
    "Bauer Bodoni",
    "Book Antiqua",
    "Bookman",
    "Bordeaux Roman",
    "Californian FB",
    "Calisto",
    "Calvert",
    "Capitals",
    "Cambria",
    "Cartier",
    "Caslon",
    "Catull",
    "Centaur",
    "Century Old Style",
    "Century Schoolbook",
    "Chaparral",
    "Charis SIL",
    "Cheltenham",
    "Cholla Slab",
    "Clarendon",
    "Clearface",
    "Cochin",
    "Colonna",
    "Computer Modern",
    "Concrete Roman",
    "Constantia",
    "Cooper Black",
    "Corona",
    "Ecotype",
    "Egyptienne",
    "Elephant",
    "Excelsior",
    "Fairfield",
    "FF Scala",
    "Folkard",
    "Footlight",
    "FreeSerif",
    "Friz Quadrata",
    "Garamond",
    "Gentium",
    "Georgia",
    "Gloucester",
    "Goudy Old Style",
    "Goudy Schoolbook",
    "Goudy Pro Font",
    "Granjon",
    "Guardian Egyptian",
    "Heather",
    "Hercules",
    "High Tower Text",
    "Hiroshige",
    "Hoefler Text",
    "Humana Serif",
    "Imprint",
    "Ionic No. 5",
    "Janson",
    "Joanna",
    "Korinna",
    "Lexicon",
    "LiberationSerif",
    "Liberation Serif",
    "Linux Libertine",
    "Literaturnaya",
    "Lucida",
    "Lucida Bright",
    "Melior",
    "Memphis",
    "Miller",
    "Minion",
    "Modern",
    "Mona Lisa",
    "Mrs Eaves",
    "MS Serif",
    "Museo Slab",
    "New York",
    "Nimbus Roman",
    "NPS Rawlinson Roadway",
    "NuptialScript",
    "Palatino",
    "Perpetua",
    "Plantin",
    "Plantin Schoolbook",
    "Playbill",
    "Poor Richard",
    "Rawlinson Roadway",
    "Renault",
    "Requiem",
    "Rockwell",
    "Roman",
    "Rotis Serif",
    "Sabon",
    "Scala",
    "Seagull",
    "Sistina",
    "Souvenir",
    "STIX",
    "Stone Informal",
    "Stone Serif",
    "Sylfaen",
    "Times",
    "Trajan",
    "Trinit\u{e9}",
    "Trump Mediaeval",
    "Utopia",
    "Vale Type",
    "Bitstream Vera",
    "Vera Serif",
    "Versailles",
    "Wanted",
    "Weiss",
    "Wide Latin",
    "Windsor",
    "XITS",
];

/// pdf.js `getSymbolsFonts`.
const SYMBOLS_FONTS: &[&str] = &["Dingbats", "Symbol", "ZapfDingbats", "Wingdings", "Wingdings-Bold", "Wingdings-Regular"];

/// pdf.js `getFontNameToFileMap`: the file of each substitute font.
const FONT_NAME_TO_FILE: &[(&str, &str)] = &[
    ("Courier", "FoxitFixed.pfb"),
    ("Courier-Bold", "FoxitFixedBold.pfb"),
    ("Courier-BoldOblique", "FoxitFixedBoldItalic.pfb"),
    ("Courier-Oblique", "FoxitFixedItalic.pfb"),
    ("Helvetica", "LiberationSans-Regular.ttf"),
    ("Helvetica-Bold", "LiberationSans-Bold.ttf"),
    ("Helvetica-BoldOblique", "LiberationSans-BoldItalic.ttf"),
    ("Helvetica-Oblique", "LiberationSans-Italic.ttf"),
    ("Times-Roman", "FoxitSerif.pfb"),
    ("Times-Bold", "FoxitSerifBold.pfb"),
    ("Times-BoldItalic", "FoxitSerifBoldItalic.pfb"),
    ("Times-Italic", "FoxitSerifItalic.pfb"),
    ("Symbol", "FoxitSymbol.pfb"),
    ("ZapfDingbats", "FoxitDingbats.pfb"),
    ("LiberationSans-Regular", "LiberationSans-Regular.ttf"),
    ("LiberationSans-Bold", "LiberationSans-Bold.ttf"),
    ("LiberationSans-Italic", "LiberationSans-Italic.ttf"),
    ("LiberationSans-BoldItalic", "LiberationSans-BoldItalic.ttf"),
];

fn lookup(table: &[(&'static str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/// pdf.js `getStandardFontName`: the standard 14 name a font name is drawn as, if the table knows it.
pub fn standard_font_name(name: &str) -> Option<&'static str> {
    lookup(STD_FONT_MAP, &normalize_font_name(name))
}

/// pdf.js `isKnownFontName`.
pub fn is_known_font_name(name: &str) -> bool {
    let name = normalize_font_name(name);
    lookup(STD_FONT_MAP, &name).is_some()
        || lookup(NON_STD_FONT_MAP, &name).is_some()
        || SERIF_FONTS.contains(&name.as_str())
        || SYMBOLS_FONTS.contains(&name.as_str())
}

/// The substitute font file of a standard font name (`Helvetica`, `Times-Roman`, ...).
pub fn font_file_name(standard_name: &str) -> Option<&'static str> {
    lookup(FONT_NAME_TO_FILE, standard_name)
}

/// Reads one substitute font file by its file name from the rendering configuration's font folder.
pub type FontFileReader = Box<dyn Fn(&str) -> io::Result<Vec<u8>> + Send + Sync>;

/// pdf.js `fetchStandardFontData`: the bytes of the substitute font files, each read once.
pub struct StandardFonts {
    read: FontFileReader,
    cache: Mutex<HashMap<String, Arc<Vec<u8>>>>,
}

impl StandardFonts {
    pub fn new(read: FontFileReader) -> Self {
        Self { read, cache: Mutex::new(HashMap::new()) }
    }

    /// The file of the standard font `name`, or `None` (warned, as pdf.js does) when the name has no file or the
    /// file cannot be read.
    pub fn fetch(&self, name: &str) -> Option<Arc<Vec<u8>>> {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(data) = cache.get(name) {
            return Some(data.clone());
        }
        let Some(file) = font_file_name(name) else {
            tracing::warn!("no standard font file for \"{name}\"");
            return None;
        };
        match (self.read)(file) {
            Ok(bytes) => {
                let data = Arc::new(bytes);
                cache.insert(name.to_string(), data.clone());
                Some(data)
            }
            Err(e) => {
                tracing::warn!("standard font file {file}: {e}");
                None
            }
        }
    }

    /// The bytes drawn for a font called `font_name`: its standard name through [`standard_font_name`], then the file.
    pub fn for_font(&self, font_name: &str) -> Option<Arc<Vec<u8>>> {
        self.fetch(standard_font_name(font_name)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_normalised_before_the_lookup() {
        assert_eq!(normalize_font_name("Times New_Roman,Bold"), "TimesNew-Roman-Bold");
        assert_eq!(standard_font_name("Times-Roman"), Some("Times-Roman"));
        assert_eq!(standard_font_name("Helvetica,Bold"), Some("Helvetica-Bold"));
        assert_eq!(standard_font_name("Comic Sans MS"), None);
        assert!(is_known_font_name("Comic Sans MS"));
        assert!(is_known_font_name("Wingdings"));
        assert!(!is_known_font_name("Nonexistent Font Face"));
    }

    #[test]
    fn every_standard_name_has_a_substitute_file_that_exists_in_the_assets() {
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets/standard_fonts");
        let read_file = move |file: &str| mixdog_fsio::read(&mixdog_fsio::Unlaned, dir.join(file));
        for (_, standard) in STD_FONT_MAP {
            let file = font_file_name(standard).unwrap_or_else(|| panic!("no file for {standard}"));
            assert!(read_file(file).is_ok_and(|d| !d.is_empty()), "{file} is missing");
        }
        let fonts = StandardFonts::new(Box::new(read_file));
        assert!(fonts.for_font("ZapfDingbats").is_some_and(|d| d.len() > 1000));
        assert!(fonts.fetch("Nope").is_none());
    }
}
