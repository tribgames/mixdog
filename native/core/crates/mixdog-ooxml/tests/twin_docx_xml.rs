//! Twin test `docx_xml`: the recording of Node's Word XML builders (`portable-docx-xml`, `portable-docx-styles` and
//! `docx-formatting`; `native/core/fixtures/office-docx-xml/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-docx-xml.mjs`) against this crate. `pure` replays each function on its recorded
//! arguments and compares the XML text, or the error message, exactly; `styles` asks for each style of a recorded styles part
//! and compares the id answered and the styles part left behind. Offsets Node counts in UTF-16 units are compared as such.
//! Re-recording is `twin_live_docx_xml` (ignored: it runs Node).

use mixdog_js::{json_number, to_number, value_to_string};
use mixdog_office_base::twin;
use mixdog_ooxml::docx_formatting::{format_first_body_phrase, patch_paragraph_format, patch_word_style};
use mixdog_ooxml::docx_styles::document_style_id;
use mixdog_ooxml::docx_xml::{
    Matched, Numbering, RunFontOverrides, align_word_table_columns, apply_word_run_format, blank_table_cells, check_docx_column, docx_style_id, docx_table,
    docx_tables, insert_docx_block_at, justify_word_paragraphs, merge_word_cell_properties, merge_word_run_fonts, missing_docx_cell_error,
    missing_docx_row_error, natural_table_column_widths, paragraph_format_xml, replace_docx_table, replace_word_properties, rewrite_table_columns,
    row_cell_matches, section_text_width, table_row_matches, with_first_run_text, word_justification, word_paragraph, word_run_properties,
    word_table_properties, word_table_xml, word_text_content, word_text_element,
};
use mixdog_ooxml::zipio::Package;
use serde_json::{Value, json};

fn golden() -> Value {
    twin::load_golden("office-docx-xml")
}

fn text(value: &Value) -> &str {
    value.as_str().expect("a string argument")
}

/// A string argument, or the empty string for the null the recording holds where Node was given nothing.
fn text_or_empty(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

/// Node's `{ result }` or `{ error }` of an attempt.
fn recorded(case: &Value) -> Value {
    match case.get("error") {
        Some(error) => json!({ "error": error }),
        None => json!({ "result": case["result"] }),
    }
}

fn outcome(result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => json!({ "result": value }),
        Err(error) => json!({ "error": error }),
    }
}

/// The UTF-16 position of a byte offset of the text.
fn utf16_at(base: &str, byte: usize) -> usize {
    base[..byte].encode_utf16().count()
}

/// The byte offset of a UTF-16 position of the text.
fn byte_at(base: &str, utf16: usize) -> usize {
    let mut units = 0;
    for (at, character) in base.char_indices() {
        if units >= utf16 {
            return at;
        }
        units += character.len_utf16();
    }
    base.len()
}

fn matches(base: &str, list: &[Matched]) -> Value {
    Value::Array(list.iter().map(|found| json!({ "index": utf16_at(base, found.index), "xml": found.xml })).collect())
}

fn numbering(value: &Value) -> Option<Numbering> {
    value.is_object().then(|| Numbering { level: to_number(&value["level"]), num_id: value_to_string(&value["numId"]) })
}

fn overrides(value: &Value) -> RunFontOverrides<'_> {
    RunFontOverrides {
        name: value["name"].as_str().unwrap_or(""),
        name_east_asia: value["nameEastAsia"].as_str().unwrap_or(""),
        size: value.get("size").map_or(0.0, to_number),
        color: value["color"].as_str().unwrap_or(""),
    }
}

fn table_measure(_: &str, _: &mixdog_ooxml::text_metrics::FontSpec) -> Result<f64, String> {
    Err("the recording holds no table that needs a measured face".to_owned())
}

fn pure(name: &str, args: &[Value]) -> Value {
    let arg = |at: usize| &args[at];
    let options_flag = |at: usize, key: &str| args.get(at).is_some_and(|options| options[key] == Value::Bool(true));
    match name {
        "wordTableProperties" => outcome(Ok(json!(word_table_properties(arg(0), arg(1)["totalWidth"].as_f64().unwrap_or(0.0))))),
        "mergeWordCellProperties" => outcome(Ok(json!(merge_word_cell_properties(text(arg(0)), arg(1))))),
        "wordJustification" => outcome(Ok(json!(word_justification(text_or_empty(arg(0)))))),
        "justifyWordParagraphs" => outcome(Ok(json!(justify_word_paragraphs(text(arg(0)), text(arg(1)))))),
        "wordTableXml" => outcome(word_table_xml(arg(0), arg(1)["available"].as_f64().unwrap_or(0.0), &mut table_measure).map(Value::from)),
        "naturalTableColumnWidths" => outcome(
            natural_table_column_widths(arg(0), arg(1), arg(2).as_f64().unwrap_or(0.0), &mut table_measure)
                .map(|widths| widths.map_or(Value::Null, |list| Value::Array(list.into_iter().map(json_number).collect()))),
        ),
        "tableRowMatches" => outcome(Ok(matches(text(arg(0)), &table_row_matches(text(arg(0)))))),
        "rowCellMatches" => outcome(Ok(matches(text(arg(0)), &row_cell_matches(text(arg(0)))))),
        "rewriteTableColumns" => outcome(
            rewrite_table_columns(text(arg(0)), arg(1).as_u64().expect("a column") as usize, text(arg(2)) == "delete").map(Value::from),
        ),
        "alignWordTableColumns" => outcome(Ok(json!(align_word_table_columns(text(arg(0)), arg(1).as_array().expect("alignments"))))),
        "docxTable" => outcome(docx_table(text(arg(0)), Some(arg(1))).map(|found| json!({ "index": utf16_at(text(arg(0)), found.index), "xml": found.xml }))),
        "docxTables" => outcome(Ok(matches(text(arg(0)), &docx_tables(text(arg(0)))))),
        "replaceDocxTable" => outcome(
            docx_table(text(arg(0)), Some(arg(1))).map(|found| json!(replace_docx_table(text(arg(0)), &found, text(arg(2))))),
        ),
        "missingDocxRowError" => outcome(Ok(json!(missing_docx_row_error(arg(0), text(arg(1)))))),
        "checkDocxColumn" => outcome(check_docx_column(arg(0), text(arg(1))).map(|column| json!(column))),
        "missingDocxCellError" => {
            let cells: Vec<Matched> = (0..arg(1).as_u64().expect("a cell count")).map(|index| Matched { index: index as usize, xml: String::new() }).collect();
            outcome(Ok(json!(missing_docx_cell_error(arg(0), &cells))))
        }
        "sectionTextWidth" => {
            let document = text(arg(0));
            outcome(Ok(json_number(section_text_width(document, byte_at(document, arg(1).as_u64().expect("a position") as usize)))))
        }
        "insertDocxBlockAt" => outcome(insert_docx_block_at(text(arg(0)), text(arg(1)), to_number(arg(2))).map(Value::from)),
        "docxStyleId" => outcome(Ok(json!(docx_style_id(text_or_empty(arg(0)))))),
        "mergeWordRunFonts" => outcome(Ok(json!(merge_word_run_fonts(text(arg(0)), &overrides(arg(1)))))),
        "applyWordRunFormat" => outcome(Ok(json!(apply_word_run_format(text(arg(0)), text(arg(1)))))),
        "wordTextElement" => outcome(Ok(json!(word_text_element(text(arg(0)), options_flag(1, "preserve"))))),
        "wordTextContent" => outcome(Ok(json!(word_text_content(text_or_empty(arg(0)), options_flag(1, "preserve"))))),
        "wordRunProperties" => outcome(Ok(json!(word_run_properties(arg(0))))),
        "wordParagraph" => {
            let options = args.get(1).filter(|options| options.is_object());
            let field = |key: &str| options.and_then(|options| options[key].as_str()).unwrap_or("");
            let words = if arg(0).is_null() { String::new() } else { value_to_string(arg(0)) };
            outcome(Ok(json!(word_paragraph(&words, field("alignment"), field("style"), field("runProperties")))))
        }
        "blankTableCells" => outcome(Ok(json!(blank_table_cells(text(arg(0)))))),
        "withFirstRunText" => outcome(Ok(json!(with_first_run_text(text(arg(0)), text(arg(1)))))),
        "replaceWordProperties" => outcome(Ok(json!(replace_word_properties(text(arg(0)), text(arg(1)), text(arg(2)), text(arg(3)))))),
        "paragraphFormatXml" => outcome(Ok(json!(paragraph_format_xml(arg(0), numbering(arg(1)).as_ref())))),
        "patchParagraphFormat" => outcome(patch_paragraph_format(text(arg(0)), arg(1), numbering(arg(2)).as_ref()).map(Value::from)),
        "patchWordStyle" => outcome(patch_word_style(text(arg(0)), arg(1)).map(Value::from)),
        "formatFirstBodyPhrase" => {
            outcome(format_first_body_phrase(text(arg(0)), text(arg(1)), arg(2)).map(|done| json!({ "xml": done.xml, "changed": done.changed })))
        }
        other => panic!("the recording has a function this test does not replay: {other}"),
    }
}

fn every_style_answer_equals_the_recording() {
    let golden = golden();
    let cases = golden["styles"].as_array().expect("style cases");
    assert!(cases.len() >= 100, "the recording lost style cases: {}", cases.len());
    for case in cases {
        let mut package = Package::new();
        for (name, content) in case["files"].as_object().expect("files") {
            package.set(name, text(content));
        }
        let answer = document_style_id(&mut package, text(&case["requested"]), text(&case["type"]));
        let left = package.file("word/styles.xml").map(|bytes| String::from_utf8_lossy(bytes).into_owned());
        let produced = json!({ "result": { "answer": { "id": answer.id, "found": answer.found }, "styles": left } });
        let what = format!("documentStyleId {} / {} / {}", text(&case["label"]), text(&case["requested"]), text(&case["type"]));
        twin::assert_matches(&what, &recorded(case), &produced);
    }
}

fn every_output_equals_the_recording() {
    let golden = golden();
    let cases = golden["pure"].as_array().expect("pure cases");
    assert!(cases.len() > 500, "the recording lost cases: {}", cases.len());
    for case in cases {
        let name = text(&case["fn"]);
        let args = case["args"].as_array().expect("arguments");
        let produced = pure(name, args);
        twin::assert_matches(&format!("{name}({})", Value::Array(args.clone())), &recorded(case), &produced);
    }
    every_style_answer_equals_the_recording();
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-ooxml --test twin_docx_xml -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/portable)"]
fn twin_live_docx_xml() {
    twin::run_recorder("benchmarks/rust-core/recorders/record-office-docx-xml.mjs", &twin::node_source_root());
    every_output_equals_the_recording();
}
