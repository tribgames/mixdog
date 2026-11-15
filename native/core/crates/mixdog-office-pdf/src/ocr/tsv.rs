//! The engine's table of words and the lines built from it (`pdf/pdf-ocr.mjs`: `ocrTsvRows`, `parseOcrTsv`,
//! `ocrTextLines`).
//!
//! Tesseract writes the table with a header row through its command line and without one through a library, so the
//! reader accepts both: taking the first data row as a header dropped that word and left every lookup undefined, which is
//! an empty result, not an error.
//!
//! A word box is where ink sits, not where a word begins and ends: Korean and CJK come back split at syllable boundaries
//! ("출" "고" "율" for 출고율) while a real word break can measure a single pixel. Geometry therefore cannot rebuild the
//! line, but the engine's own line text can: the rows and the text come back in the same order, so a line takes that text
//! when it carries exactly the same characters, and falls back to its word boxes when it does not.

use std::collections::HashMap;

use mixdog_js::{is_js_space, js_trim, string_to_number};

use crate::analysis::{js_max, js_min};

/// The engine's own column order.
const COLUMNS: [&str; 12] = [
    "level", "page_num", "block_num", "par_num", "line_num", "word_num", "left", "top", "width", "height", "conf", "text",
];

/// One recognised word and the box it sits in, in the pixels of the image that was read.
#[derive(Debug, Clone, PartialEq)]
pub struct OcrWord {
    pub text: String,
    pub confidence: f64,
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

/// One recognised row: the text to put on the page, the words it was read from and the box around them.
#[derive(Debug, Clone, PartialEq)]
pub struct OcrLine {
    pub text: String,
    /// The text is the engine's own reading of the row, not the boxes joined with spaces.
    pub from_engine: bool,
    pub words: Vec<OcrWord>,
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
    /// The widest space between two boxes on the row: a column gap means the row is really two.
    pub column_gap: f64,
}

/// Where each named column stands (`undefined` for one the header lacks).
struct Columns(HashMap<String, usize>);

impl Columns {
    fn index(&self, name: &str) -> Option<usize> {
        self.0.get(name).copied()
    }
}

/// `String(value || '').split(/\r?\n/)`.
fn split_lines(value: &str) -> Vec<&str> {
    let mut pieces: Vec<&str> = value.split('\n').collect();
    let last = pieces.len() - 1;
    for piece in &mut pieces[..last] {
        if let Some(stripped) = piece.strip_suffix('\r') {
            *piece = stripped;
        }
    }
    pieces
}

/// The rows of the table with the columns they are read by.
fn rows_of(value: &str) -> (Columns, Vec<Vec<&str>>) {
    let lines: Vec<&str> = split_lines(value).into_iter().filter(|line| !js_trim(line).is_empty()).collect();
    if lines.is_empty() {
        return (Columns(HashMap::new()), Vec::new());
    }
    let first: Vec<&str> = lines[0].split('\t').collect();
    let headed = first.contains(&"text") && first.contains(&"conf");
    // Object.fromEntries: the last of two columns of one name wins.
    let at = if headed {
        first.iter().enumerate().map(|(index, name)| ((*name).to_owned(), index)).collect()
    } else {
        COLUMNS.iter().enumerate().map(|(index, name)| ((*name).to_owned(), index)).collect()
    };
    let body = if headed { &lines[1..] } else { &lines[..] };
    let rows = body.iter().map(|line| line.split('\t').collect::<Vec<_>>()).filter(|columns| columns.len() >= COLUMNS.len()).collect();
    (Columns(at), rows)
}

/// `Number(columns[at.name] || fallback)`.
fn number_at(columns: &[&str], at: &Columns, name: &str, fallback: f64) -> f64 {
    match at.index(name).and_then(|index| columns.get(index)) {
        Some(text) if !text.is_empty() => string_to_number(text),
        _ => fallback,
    }
}

fn word_of(columns: &[&str], at: &Columns) -> OcrWord {
    OcrWord {
        text: at.index("text").and_then(|index| columns.get(index)).copied().unwrap_or("").to_owned(),
        confidence: number_at(columns, at, "conf", -1.0),
        left: number_at(columns, at, "left", 0.0),
        top: number_at(columns, at, "top", 0.0),
        width: number_at(columns, at, "width", 0.0),
        height: number_at(columns, at, "height", 0.0),
    }
}

/// A word that has text and a box with an area (a NaN size is none).
fn is_placed(word: &OcrWord) -> bool {
    !js_trim(&word.text).is_empty() && word.width > 0.0 && word.height > 0.0
}

/// `parseOcrTsv`: the words of the table, with their boxes.
pub fn parse_ocr_tsv(value: &str) -> Vec<OcrWord> {
    let (at, rows) = rows_of(value);
    if at.index("text").is_none() {
        return Vec::new();
    }
    rows.iter().map(|columns| word_of(columns, &at)).filter(is_placed).collect()
}

/// The word boxes of each line, keyed by the engine's page, block, paragraph and line ids, in the order the lines first
/// appear.
fn line_groups(rows: &[Vec<&str>], at: &Columns) -> Vec<Vec<OcrWord>> {
    let mut order: Vec<Vec<OcrWord>> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    for columns in rows {
        let word = word_of(columns, at);
        if !is_placed(&word) {
            continue;
        }
        let key = ["page_num", "block_num", "par_num", "line_num"]
            .iter()
            .map(|name| at.index(name).and_then(|index| columns.get(index)).copied().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("/");
        let slot = *seen.entry(key).or_insert_with(|| {
            order.push(Vec::new());
            order.len() - 1
        });
        order[slot].push(word);
    }
    order
}

/// `line.replace(/\s+/g, '')`.
fn compact(line: &str) -> String {
    line.chars().filter(|c| !is_js_space(*c)).collect()
}

/// A line whose boxes were all discarded leaves its reading without a group, and pairing by position then hands every
/// later line the text of its predecessor: one dropped line makes the rest of the page fall back to its word boxes. A
/// reading is therefore taken from the next line that carries exactly these characters, never from one that differs.
struct SpokenReader<'a> {
    spoken: Vec<&'a str>,
    next: usize,
}

impl<'a> SpokenReader<'a> {
    fn new(plain_text: &'a str) -> Self {
        let spoken = split_lines(plain_text).into_iter().map(js_trim).filter(|line| !line.is_empty()).collect();
        SpokenReader { spoken, next: 0 }
    }

    fn reading(&mut self, joined: &str) -> Option<&'a str> {
        let target = compact(joined);
        if target.is_empty() {
            return None;
        }
        let found = self.spoken.iter().enumerate().skip(self.next).find(|(_, line)| compact(line) == target)?;
        self.next = found.0 + 1;
        Some(*found.1)
    }
}

fn line_of(mut words: Vec<OcrWord>, reader: &mut SpokenReader<'_>) -> OcrLine {
    words.sort_by(|a, b| a.left.partial_cmp(&b.left).unwrap_or(std::cmp::Ordering::Equal));
    let left = words.iter().map(|word| word.left).fold(f64::INFINITY, js_min);
    let top = words.iter().map(|word| word.top).fold(f64::INFINITY, js_min);
    let width = words.iter().map(|word| word.left + word.width).fold(f64::NEG_INFINITY, js_max) - left;
    let height = words.iter().map(|word| word.top + word.height).fold(f64::NEG_INFINITY, js_max) - top;
    let joined = words.iter().map(|word| word.text.as_str()).collect::<Vec<_>>().join(" ");
    let engine = reader.reading(&joined);
    // The widest space between two boxes on this row. A column gap means the row is really two, and one stretched run
    // would put every character in it at the wrong place.
    let column_gap = words.windows(2).fold(0.0, |widest, pair| js_max(widest, pair[1].left - (pair[0].left + pair[0].width)));
    OcrLine {
        text: engine.map_or(joined, str::to_owned),
        from_engine: engine.is_some(),
        words,
        left,
        top,
        width,
        height,
        column_gap,
    }
}

/// `ocrTextLines(value, plainText)`: one text line per recognised row, with the words that belong to it.
pub fn ocr_text_lines(value: &str, plain_text: &str) -> Vec<OcrLine> {
    let (at, rows) = rows_of(value);
    if ["line_num", "left", "text"].iter().any(|name| at.index(name).is_none()) {
        return Vec::new();
    }
    let mut reader = SpokenReader::new(plain_text);
    line_groups(&rows, &at).into_iter().map(|words| line_of(words, &mut reader)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(text: &str, confidence: f64, left: f64, top: f64, width: f64, height: f64) -> OcrWord {
        OcrWord { text: text.to_owned(), confidence, left, top, width, height }
    }

    #[test]
    fn the_text_layer_keeps_the_line_the_engine_read_not_its_word_boxes() {
        let rows = [
            "1\t1\t0\t0\t0\t0\t0\t0\t1191\t1684\t-1\t",
            "4\t1\t1\t1\t1\t0\t153\t378\t245\t26\t-1\t",
            "5\t1\t1\t1\t1\t1\t153\t378\t52\t26\t93.3\t정시",
            "5\t1\t1\t1\t1\t2\t231\t378\t34\t26\t91.3\t출",
            "5\t1\t1\t1\t1\t3\t281\t378\t17\t26\t93.0\t고",
            "5\t1\t1\t1\t1\t4\t297\t374\t23\t44\t92.7\t율",
            "5\t1\t1\t1\t1\t5\t321\t381\t77\t21\t92.4\t92.8%",
            "5\t1\t1\t1\t2\t1\t153\t444\t55\t26\t96.2\t야간",
            "5\t1\t1\t1\t2\t2\t900\t444\t55\t26\t96.9\t증원",
        ]
        .join("\n");
        let lines = ocr_text_lines(&rows, "정시 출고율 92.8%\n야간                      증원\n");
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text, "정시 출고율 92.8%");
        assert!(lines[0].from_engine);
        assert_eq!((lines[0].left, lines[0].top, lines[0].width, lines[0].height), (153.0, 374.0, 245.0, 44.0));
        // Two columns the engine read as one row: stretching a single run across the gap would put every character in it
        // far from the word it belongs to.
        assert!(lines[1].column_gap > lines[1].height * 1.5);
    }

    #[test]
    fn a_reading_is_kept_when_an_earlier_line_leaves_no_boxes() {
        let rows = [
            "5\t1\t1\t1\t1\t1\t153\t300\t0\t0\t61.0\t머리글",
            "5\t1\t1\t1\t2\t1\t231\t378\t34\t26\t91.3\t출",
            "5\t1\t1\t1\t2\t2\t281\t378\t17\t26\t93.0\t고",
            "5\t1\t1\t1\t2\t3\t297\t374\t23\t44\t92.7\t율",
            "5\t1\t1\t1\t2\t4\t321\t381\t77\t21\t92.4\t92.8%",
        ]
        .join("\n");
        let lines = ocr_text_lines(&rows, "머리글\n출고율 92.8%\n");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "출고율 92.8%");
        assert!(lines[0].from_engine);
    }

    #[test]
    fn a_line_without_a_matching_reading_is_its_boxes_joined() {
        let rows = "5\t1\t1\t1\t1\t1\t10\t20\t30\t12\t90\tHello\n5\t1\t1\t1\t1\t2\t50\t20\t30\t12\t90\tworld";
        let lines = ocr_text_lines(rows, "something else\n");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "Hello world");
        assert!(!lines[0].from_engine);
        assert_eq!(lines[0].column_gap, 10.0);
    }

    #[test]
    fn the_table_is_read_with_or_without_its_header() {
        let headed = parse_ocr_tsv(
            "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t20\t30\t12\t92.5\tHello",
        );
        assert_eq!(headed, vec![word("Hello", 92.5, 10.0, 20.0, 30.0, 12.0)]);
        // A library writes the table without a header row, so a reader that assumes one eats the first word and reports an
        // empty page.
        let headerless = parse_ocr_tsv("5\t1\t1\t1\t1\t1\t10\t20\t30\t12\t92.5\tHello\n5\t1\t1\t1\t1\t2\t50\t20\t20\t12\t88\tworld");
        assert_eq!(headerless.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(), ["Hello", "world"]);
        assert_eq!(headerless[0].left, 10.0);
    }

    #[test]
    fn rows_without_text_or_area_and_short_rows_are_left_out() {
        let rows = "5\t1\t1\t1\t1\t1\t10\t20\t0\t12\t92.5\tflat\n5\t1\t1\t1\t1\t2\t10\t20\t30\t12\t92.5\t  \n5\t1\t1\t1\t1\t3\t1\t2\t3\n5\t1\t1\t1\t1\t4\t10\t20\t30\t12\t\tkept\r\n";
        let words = parse_ocr_tsv(rows);
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].text, "kept");
        // An empty confidence is the engine's -1.
        assert_eq!(words[0].confidence, -1.0);
        assert!(parse_ocr_tsv("").is_empty());
        assert!(ocr_text_lines("level\tleft\tconf\ttext\n", "").is_empty());
    }
}
