//! Number formats in the words of the file: `Excel-Word`, the colour names of the UI languages, `Excel-ColorNames` and
//! `Excel-EnglishNumberFormat`.
//!
//! Excel reads the colour of a number format section in its UI language even through the English `NumberFormat` property:
//! a Korean Excel refuses `#,##0;[Red]-#,##0` and takes `[빨강]`, and reports the colour back the same way. The file format
//! and the portable writer keep the English names, so the reader translates what Excel reports back into English for the
//! UI languages it knows (the writer's half, `Set-ExcelNumberFormat`, uses the same table).

use std::cell::Cell;

use crate::com::Result;
use crate::com::Value as Com;
use crate::ps::text;

use super::cells::get_with;
use super::cells::int_of;
use super::cells::string_of;

/// The colour keys in the order the host walks them.
pub(crate) const COLOR_KEYS: [&str; 8] = ["Black", "Blue", "Cyan", "Green", "Magenta", "Red", "White", "Yellow"];

/// The UI language of the Korean Excel (LCID 1042).
const KOREAN: i32 = 1042;

/// `Excel-Word`: a word from its code points (the host script is read without a byte-order mark, so a literal Hangul string
/// arrives mangled).
pub(crate) fn excel_word(codes: &[u32]) -> String {
    codes.iter().filter_map(|code| char::from_u32(*code)).collect()
}

/// The names one UI language gives the colours of a number format.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ColorNames {
    pub black: String,
    pub blue: String,
    pub cyan: String,
    pub green: String,
    pub magenta: String,
    pub red: String,
    pub white: String,
    pub yellow: String,
    /// The word of `ColorN`.
    pub color: String,
}

impl ColorNames {
    /// The name the UI language gives a colour key of [`COLOR_KEYS`].
    pub(crate) fn name_of(&self, key: &str) -> Option<&str> {
        Some(match key {
            "Black" => &self.black,
            "Blue" => &self.blue,
            "Cyan" => &self.cyan,
            "Green" => &self.green,
            "Magenta" => &self.magenta,
            "Red" => &self.red,
            "White" => &self.white,
            "Yellow" => &self.yellow,
            _ => return None,
        })
    }
}

/// The names of a language the table knows.
fn names_of(language: i32) -> Option<ColorNames> {
    (language == KOREAN).then(|| ColorNames {
        // 검정 파랑 녹청 녹색 자홍 빨강 흰색 노랑, and 색N for ColorN.
        black: excel_word(&[0xAC80, 0xC815]),
        blue: excel_word(&[0xD30C, 0xB791]),
        cyan: excel_word(&[0xB179, 0xCCAD]),
        green: excel_word(&[0xB179, 0xC0C9]),
        magenta: excel_word(&[0xC790, 0xD64D]),
        red: excel_word(&[0xBE68, 0xAC15]),
        white: excel_word(&[0xD770, 0xC0C9]),
        yellow: excel_word(&[0xB178, 0xB791]),
        color: excel_word(&[0xC0C9]),
    })
}

thread_local! {
    /// `$script:ExcelColorNamesInUse`: the UI language, read once per host (a host runs its COM work on one thread).
    static LANGUAGE: Cell<Option<i32>> = const { Cell::new(None) };
}

/// `Excel-ColorNames $application`: the colour names of the application's UI language; `None` for a language the table does
/// not know (the format is then left as it is). The language is asked once per host.
pub(crate) fn color_names(application: &Com) -> Option<ColorNames> {
    let language = match LANGUAGE.with(Cell::get) {
        Some(language) => language,
        None => {
            let asked = language_of(application).unwrap_or(0);
            LANGUAGE.with(|slot| slot.set(Some(asked)));
            asked
        }
    };
    names_of(language)
}

/// `[int]$application.LanguageSettings.LanguageID(2)` (msoLanguageIDUI).
fn language_of(application: &Com) -> Result<i32> {
    let settings = application.member("LanguageSettings")?;
    int_of(&get_with(&settings, "LanguageID", &[Com::I4(2)])?)
}

/// `Excel-EnglishNumberFormat`: a range's format as the file and the portable writer spell it, the UI language's colour
/// names back in English. `format` is the range's format when the caller already read it.
pub(crate) fn english_number_format(range: &Com, format: Option<&str>) -> Result<String> {
    let format = match format {
        Some(format) => format.to_owned(),
        None => string_of(&range.member("NumberFormat")?),
    };
    if !format.contains('[') {
        return Ok(format);
    }
    let Some(names) = color_names(&range.member("Application")?) else { return Ok(format) };
    let mut format = format;
    for key in COLOR_KEYS {
        if let Some(local) = names.name_of(key) {
            format = format.replace(&format!("[{local}]"), &format!("[{key}]"));
        }
    }
    let pattern = format!(r"\[{}(\d{{1,2}})\]", text::regex_escape(&names.color));
    Ok(text::replace(&format, &pattern, "[Color$1]", true).unwrap_or(format))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_korean_names_are_built_from_their_code_points() {
        let names = names_of(KOREAN).expect("Korean is known");
        assert_eq!(names.red, "빨강");
        assert_eq!(names.black, "검정");
        assert_eq!(names.color, "색");
        assert!(names_of(1033).is_none());
    }
}
