//! The `[word]` profile: persistent Word sessions, and what Word reads and writes as the portable reader and writer do.

use std::collections::HashMap;

use serde_json::{Value, json};

use super::{Live, all_captures, all_matches, base64_decode, capture, items, matches, mentions, number, paragraph_text, png_pixel, stringify};

/// A whole number as the JSON a snapshot carries it in (NaN, which a reading that found nothing is, as null).
fn whole(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 { json!(value as i64) } else { Value::Null }
}

#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn persistent_word_sessions_create_save_and_read_unicode_content() {
    let Some(live) = Live::start() else { return };
    let word = live.call(json!({ "action": "create", "path": live.path("문서.docx"), "format": "docx", "mode": "visible" }));
    assert!(number(&word["appPid"]) > 0.0);
    assert!(number(&word["windowHwnd"]) > 0.0);
    let session = word["session"].clone();
    live.call(json!({
        "action": "batch",
        "session": session,
        "operations": [
            { "op": "append_text", "text": "한글-日本語-中文 {{ name }}" },
            { "op": "set_header_footer", "section": 1, "kind": "header", "text": "Owner {{owner}}" },
            { "op": "fill_template", "tokens": { "name": "길동", "owner": "Mixdog" }, "strict": true },
            {
                "op": "add_table",
                "values": [["Metric", "Value"], ["Revenue", "120"], ["Summary", "Ready"]],
                "properties": { "borders": true, "columnWidths": [110, 110], "alignment": "center" }
            },
            { "op": "set_table_cell_style", "table": 1, "row": 1, "col": 1, "properties": { "fillColor": "D9EAF7", "bold": true } },
            { "op": "merge_table_cells", "table": 1, "row": 3, "col": 1, "colSpan": 2 },
            {
                "op": "set_paragraph_format",
                "paragraph": 1,
                "properties": { "spacingAfter": 6, "keepWithNext": true, "tabStops": [{ "position": 240, "alignment": "right", "leader": "dot" }] }
            }
        ]
    }));
    let snapshot = live.call(json!({ "action": "snapshot", "session": session }));
    let document = &snapshot["document"];
    assert!(mentions(document, "한글-日本語-中文"));
    assert!(mentions(document, "한글-日本語-中文 길동"));
    assert!(mentions(document, "Owner Mixdog"));
    assert!(!mentions(document, "{{"));
    assert_ne!(document["paragraphs"][0]["style"], "System.__ComObject");
    assert!(!document["paragraphs"][0]["style"].as_str().unwrap_or_default().is_empty());
    assert_eq!(document["tableCount"], 1);
    assert_eq!(document["tables"][0]["rows"][0]["cells"][0]["text"], "Metric");
    assert_eq!(document["tables"][0]["alignment"], 1);
    assert_eq!(items(&document["tables"][0]["columnWidths"]).len(), 2);
    assert_eq!(document["paragraphs"][0]["format"]["spacingAfter"], 6);

    let comment_batch = live.call(json!({
        "action": "batch",
        "session": session,
        "operations": [
            { "op": "add_comment", "find": "한글-日本語-中文", "text": "검토 의견" },
            { "op": "add_comment_reply", "comment": 1, "text": "답글 확인" },
            { "op": "set_comment_resolved", "comment": 1, "resolved": true }
        ]
    }));
    assert_eq!(comment_batch["results"][0]["anchor"], "phrase", "the result says the comment spans the phrase");
    let commented = live.document(&session);
    assert_eq!(commented["commentCount"], 1);
    assert_eq!(commented["comments"][0]["text"], "검토 의견");
    assert_eq!(commented["comments"][0]["anchoredText"], "한글-日本語-中文");
    assert_eq!(items(&commented["comments"][0]["replies"]).len(), 1);
    assert_eq!(commented["comments"][0]["replies"][0]["text"], "답글 확인");
    assert_eq!(commented["comments"][0]["resolved"], true);
    live.call(json!({ "action": "batch", "session": session, "operations": [{ "op": "delete_comment", "comment": 1 }] }));
    assert_eq!(live.document(&session)["commentCount"], 0);
    live.call(json!({
        "action": "batch",
        "session": session,
        "operations": [{
            "op": "add_provenance",
            "paragraph": 1,
            "source": { "document": "source-model.xlsx", "target": "/sheet[Inputs]/cell[C3]", "label": "Revenue" }
        }]
    }));
    let sourced = live.document(&session);
    assert!(matches(r"Source: source-model\.xlsx#/sheet\[Inputs\]/cell\[C3\]", "", sourced["comments"][0]["text"].as_str().unwrap_or_default()));
    live.call(json!({
        "action": "batch",
        "session": session,
        "operations": [{ "op": "track_changes", "enabled": true }, { "op": "append_text", "text": "추적 변경" }, { "op": "track_changes", "enabled": false }]
    }));
    let revised = live.document(&session);
    assert!(number(&revised["revisionCount"]) > 0.0);
    assert!(items(&revised["revisions"]).iter().any(|revision| revision["text"].as_str().unwrap_or_default().contains("추적 변경")));
    live.call(json!({ "action": "batch", "session": session, "operations": [{ "op": "resolve_revision", "revision": 1, "resolution": "accept" }] }));
    let resolved = live.document(&session);
    assert!(number(&resolved["revisionCount"]) < number(&revised["revisionCount"]));
    let professional = live.call(json!({
        "action": "batch",
        "session": session,
        "operations": [
            { "op": "add_bookmark", "name": "MixdogStart", "find": "한글-日本語-中文" },
            { "op": "add_hyperlink", "find": "한글-日本語-中文", "address": "https://mix.dog" },
            { "op": "set_list", "paragraph": 1, "kind": "bullet" },
            { "op": "insert_break", "kind": "page" },
            { "op": "add_page_numbers", "section": 1, "includeTotal": true },
            { "op": "insert_toc", "lowerHeadingLevel": 1, "upperHeadingLevel": 3 }
        ]
    }));
    let ops: Vec<&str> = items(&professional["results"]).iter().map(|result| result["op"].as_str().unwrap_or_default()).collect();
    assert_eq!(ops, ["add_bookmark", "add_hyperlink", "set_list", "insert_break", "add_page_numbers", "insert_toc"]);
    live.close(&session);
}

#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_a_section_laid_out_in_columns_reads_back_its_columns_and_their_spacing_as_the_portable_reader_reads_them() {
    let Some(live) = Live::start() else { return };
    let operations = json!([
        { "op": "append_text", "text": "물류운영 소식" },
        { "op": "insert_break", "kind": "section_continuous" },
        { "op": "set_page", "properties": { "columns": 2, "columnSpacing": 18 } },
        { "op": "append_text", "text": "두 단으로 흐르는 본문입니다." },
        { "op": "insert_break", "kind": "section_continuous" },
        { "op": "set_page", "properties": { "columns": 1 } },
        { "op": "append_text", "text": "문의: 운영기획팀" }
    ]);
    let read = |mode: &str| -> Vec<Value> {
        let created = live.create(&format!("columns-{mode}.docx"), "docx", mode, operations.clone());
        let document = live.document(&created["session"]);
        live.close(&created["session"]);
        items(&document["sections"]).iter().map(|section| json!([section["columns"], section["columnSpacing"]])).collect()
    };
    let word = read("background");
    assert_eq!(Value::Array(word.clone()), json!([[null, null], [2, 18], [null, null]]));
    assert_eq!(word, read("portable"));
}

#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_placed_list_items_hung_clauses_set_paragraph_format_lists_and_a_contents_range_read_as_the_portable_file_does() {
    let Some(live) = Live::start() else { return };
    let operations = json!([
        { "op": "append_text", "text": "제1장 총칙", "style": "Heading 1" },
        { "op": "append_text", "text": "제1조(목적)", "style": "Heading 2" },
        { "op": "append_text", "text": "세부 기준", "style": "Heading 3" },
        { "op": "append_text", "text": "①\t걸린 조항", "properties": { "indentLeft": 18, "indentFirstLine": -18 } },
        { "op": "append_text", "text": "상자 안의 항목", "properties": { "shading": "FEF3C7", "indentLeft": 12, "listKind": "bullet" } },
        { "op": "append_text", "text": "목록이 될 문단" },
        { "op": "append_text", "text": "목록에서 뺄 문단", "properties": { "listKind": "bullet" } },
        { "op": "set_paragraph_format", "paragraph": 6, "properties": { "listKind": "number", "indentLeft": 0 } },
        { "op": "set_paragraph_format", "paragraph": 7, "properties": { "listKind": "none" } },
        { "op": "append_text", "text": "첫 단계", "properties": { "listKind": "number" } },
        { "op": "append_text", "text": "참고 상자", "properties": { "shading": "EEF2F7" } },
        { "op": "append_text", "text": "이어지는 단계", "properties": { "listKind": "number", "listContinue": true } },
        // Word's own naming: the upper level is the first one listed.
        { "op": "insert_toc", "upperHeadingLevel": 1, "lowerHeadingLevel": 2 }
    ]);
    let read = |mode: &str| -> Value {
        let name = format!("lists-{mode}.docx");
        let created = live.create(&name, "docx", mode, operations.clone());
        let levels =
            items(&created["batch"]["results"]).iter().find(|result| result["op"] == "insert_toc").map_or(Value::Null, |result| result["levels"].clone());
        let document = live.document(&created["session"]);
        let paragraphs: Vec<Value> = items(&document["paragraphs"])
            .iter()
            .skip(3)
            .take(4)
            .map(|paragraph| {
                json!([
                    paragraph["text"],
                    if paragraph["list"]["kind"].as_str().is_some_and(|kind| !kind.is_empty()) { paragraph["list"]["kind"].clone() } else { Value::Null },
                    paragraph["style"]
                ])
            })
            .collect();
        live.close(&created["session"]);
        let xml = live.package(&name).text("word/document.xml");
        // Word splits a paragraph's words into runs of its own, so a paragraph is found by its joined text.
        let paragraph_xml = all_matches(r"<w:p[ >][\s\S]*?</w:p>", &xml);
        let find = |text: &str| paragraph_xml.iter().find(|paragraph| paragraph_text(paragraph).contains(text)).cloned().unwrap_or_default();
        let indents: Vec<Value> = ["걸린 조항", "상자 안의 항목", "목록이 될 문단"]
            .iter()
            .map(|text| {
                let paragraph = find(text);
                let indent = capture(r"<w:ind\b([^>]*)/>", "", &paragraph, 1).unwrap_or_default();
                let read =
                    |name: &str| capture(&format!(r#"\bw:{name}="(\d+)""#), "", &indent, 1).and_then(|digits| digits.parse::<f64>().ok()).unwrap_or(f64::NAN);
                // Word leaves out a hang the item's list already gives it (18 pt on both backends' lists).
                let mut hanging = if matches(r"<w:numPr>", "", &paragraph) { 360.0 } else { 0.0 };
                if matches(r"\bw:hanging=", "", &indent) {
                    hanging = read("hanging");
                }
                json!([whole(read("left")), whole(hanging)])
            })
            .collect();
        // The step after the note carries the list on: the list of the step before it, not a new one counting from 1.
        let steps: Vec<Option<String>> = ["첫 단계", "이어지는 단계"].iter().map(|text| capture(r#"<w:numId w:val="(\d+)""#, "", &find(text), 1)).collect();
        assert!(steps[0].is_some() && steps[0] == steps[1], "{mode}: {steps:?}");
        json!({ "levels": levels, "paragraphs": paragraphs, "indents": indents })
    };
    let word = read("background");
    assert_eq!(word["levels"], "1-2");
    assert_eq!(word["indents"], json!([[360, 360], [600, 360], [360, 360]]));
    assert_eq!(
        word["paragraphs"],
        json!([
            ["①\t걸린 조항", null, "Normal"],
            ["상자 안의 항목", "bullet", "ListParagraph"],
            ["목록이 될 문단", "number", "Normal"],
            ["목록에서 뺄 문단", null, "ListParagraph"]
        ])
    );
    assert_eq!(word, read("portable"));
}

#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_a_korean_list_counts_1_ga_1_any_other_1_a_i_and_lists_join_and_open_as_the_portable_file_does() {
    let Some(live) = Live::start() else { return };
    let item = |text: &str, level: i64, extra: Value| -> Value {
        let mut properties = json!({ "listKind": "number", "listLevel": level });
        if let (Some(map), Some(more)) = (properties.as_object_mut(), extra.as_object()) {
            map.extend(more.clone());
        }
        json!({ "op": "append_text", "text": text, "properties": properties })
    };
    let operations = json!([
        item("계획을 세운다", 0, json!({})),
        item("일정을 정한다", 1, json!({})),
        item("담당을 정한다", 2, json!({})),
        item("QA", 0, json!({})),
        { "op": "append_text", "text": "Rollout", "style": "Heading 1" },
        item("Plan the rollout", 0, json!({})),
        item("Pick the dates", 1, json!({})),
        { "op": "append_text", "text": "예외", "style": "Heading 1" },
        item("한국어 목록이지만 글로벌", 0, json!({ "listNumbering": "global" })),
        item("둘째 단계", 1, json!({})),
        { "op": "append_text", "text": "이어 붙일 한국어 문단" },
        { "op": "append_text", "text": "사이 문단" },
        { "op": "append_text", "text": "목록이 될 한국어 문단" },
        { "op": "append_text", "text": "목록에서 뺄 문단", "properties": { "listKind": "bullet" } },
        { "op": "set_list", "paragraph": 11, "kind": "number", "level": 1 },
        { "op": "set_list", "paragraph": 13, "kind": "number", "level": 1 },
        { "op": "set_list", "paragraph": 14, "kind": "none" }
    ]);
    let read = |mode: &str| -> Vec<Value> {
        let name = format!("numbering-{mode}.docx");
        let created = live.create(&name, "docx", mode, operations.clone());
        live.close(&created["session"]);
        let package = live.package(&name);
        let document = package.text("word/document.xml");
        let numbering = if package.contains("word/numbering.xml") { package.text("word/numbering.xml") } else { String::new() };
        let abstract_of: HashMap<String, String> = all_captures(r#"<w:num\b[^>]*\bw:numId="(\d+)"[^>]*>\s*<w:abstractNumId w:val="(\d+)""#, &numbering, 2)
            .into_iter()
            .map(|found| (found[1].clone(), found[2].clone()))
            .collect();
        let level_of = |num_id: &str, level: &str| -> String {
            let abstract_id = abstract_of.get(num_id).cloned().unwrap_or_else(|| "undefined".to_owned());
            let found = capture(&format!(r#"<w:abstractNum\b[^>]*\bw:abstractNumId="{abstract_id}"[^>]*>[\s\S]*?</w:abstractNum>"#), "", &numbering, 0)
                .unwrap_or_default();
            let lvl = capture(&format!(r#"<w:lvl\b[^>]*\bw:ilvl="{level}"[^>]*>[\s\S]*?</w:lvl>"#), "", &found, 0).unwrap_or_default();
            format!(
                "{} {}",
                capture(r#"<w:numFmt w:val="([^"]+)""#, "", &lvl, 1).unwrap_or_else(|| "undefined".to_owned()),
                capture(r#"<w:lvlText w:val="([^"]*)""#, "", &lvl, 1).unwrap_or_else(|| "undefined".to_owned())
            )
        };
        // Word splits a paragraph's words into runs; the list a paragraph joins is compared by the paragraphs it shares a numId
        // with, the ids themselves being each writer's own.
        let entries: Vec<(String, Option<String>, String)> = all_matches(r"<w:p[ >][\s\S]*?</w:p>", &document)
            .iter()
            .map(|xml| {
                (
                    paragraph_text(xml),
                    capture(r#"<w:numId w:val="(\d+)""#, "", xml, 1),
                    capture(r#"<w:ilvl w:val="(\d+)""#, "", xml, 1).unwrap_or_else(|| "0".to_owned()),
                )
            })
            .filter(|entry| !entry.0.is_empty())
            .collect();
        let mut first_of: HashMap<String, String> = HashMap::new();
        for (text, num_id, _) in &entries {
            if let Some(id) = num_id {
                first_of.entry(id.clone()).or_insert_with(|| text.clone());
            }
        }
        entries
            .iter()
            .map(|(text, num_id, level)| match num_id {
                Some(id) if id != "0" => json!([text, level_of(id, level), first_of.get(id)]),
                _ => json!([text, null]),
            })
            .collect()
    };
    let word = read("background");
    assert_eq!(
        Value::Array(word.clone()),
        json!([
            ["계획을 세운다", "decimal %1.", "계획을 세운다"],
            ["일정을 정한다", "ganada %2.", "계획을 세운다"],
            ["담당을 정한다", "decimal %3)", "계획을 세운다"],
            ["QA", "decimal %1.", "계획을 세운다"],
            ["Rollout", null],
            ["Plan the rollout", "decimal %1.", "Plan the rollout"],
            ["Pick the dates", "lowerLetter %2.", "Plan the rollout"],
            ["예외", null],
            ["한국어 목록이지만 글로벌", "decimal %1.", "한국어 목록이지만 글로벌"],
            ["둘째 단계", "lowerLetter %2.", "한국어 목록이지만 글로벌"],
            ["이어 붙일 한국어 문단", "lowerLetter %2.", "한국어 목록이지만 글로벌"],
            ["사이 문단", null],
            ["목록이 될 한국어 문단", "ganada %2.", "목록이 될 한국어 문단"],
            ["목록에서 뺄 문단", null]
        ])
    );
    assert_eq!(word, read("portable"));
}

// The default header used to land on the first page only: the HeadersFooters collection, handed through an if-expression, was
// unrolled into an array whose Item(1) is the first-page story. A picture went to the document start, the footer read "Page 1 of
// 1", and a sheet added later came first in the workbook.
#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_a_background_word_session_writes_the_header_the_picture_and_the_page_number_where_the_portable_writer_does() {
    let Some(live) = Live::start() else { return };
    let picture = live.path("dot.png");
    std::fs::write(&picture, base64_decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="))
        .expect("the picture");
    let created = live.create(
        "stories.docx",
        "docx",
        "background",
        json!([
            { "op": "append_text", "text": "본문 첫 단락" },
            { "op": "append_text", "text": "그림 앞 제목", "style": "Heading 1" },
            { "op": "add_image", "path": picture, "width": 24, "height": 24, "altText": "점" },
            { "op": "set_header_footer", "kind": "header", "text": "머리글 · 운영기획팀" },
            { "op": "add_page_numbers" }
        ]),
    );
    let snapshot = live.document(&created["session"]);
    let stories = &snapshot["sections"][0]["stories"];
    let headers: Vec<Value> = items(stories).iter().filter(|story| story["location"] == "header").map(|story| json!([story["kind"], story["text"]])).collect();
    assert_eq!(Value::Array(headers), json!([["primary", "머리글 · 운영기획팀"]]), "{}", stringify(stories));
    live.close(&created["session"]);
    let package = live.package("stories.docx");
    let document = package.text("word/document.xml");
    assert!(matches(r#"<w:headerReference w:type="default""#, "", &document));
    assert!(!document.contains("<w:titlePg/>"));
    // The picture follows the heading it was appended after, not the document start.
    // Word writes a Korean phrase as several runs (the East Asian font hint ends at the space), so the text is read without its
    // markup. Node's `indexOf` answered -1 for a split phrase and the comparison held without looking.
    let drawing = document.find("<w:drawing>").expect("a picture");
    let before: String = {
        let mut text = String::new();
        let mut in_tag = false;
        for c in document[..drawing].chars() {
            match c {
                '<' => in_tag = true,
                '>' => in_tag = false,
                c if !in_tag => text.push(c),
                _ => {}
            }
        }
        text
    };
    assert!(before.contains("그림 앞 제목"), "picture before its heading: {before}");
    assert!(before.contains("본문 첫 단락"), "picture before the body: {before}");
    let footers: Vec<String> = package.names().into_iter().filter(|name| matches(r"^word/footer\d*\.xml$", "", name)).map(|name| package.text(&name)).collect();
    let numbered = footers.iter().find(|xml| xml.contains("PAGE")).expect("a footer carries the PAGE field");
    assert!(!matches(r"NUMPAGES|Page ", "", numbered));
}

#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_a_background_word_session_reports_and_settles_a_redline_like_the_portable_reader() {
    let Some(live) = Live::start() else { return };
    let word = live.call(json!({ "action": "create", "path": live.path("redline.docx"), "format": "docx", "mode": "background" }));
    let session = word["session"].clone();
    live.call(json!({
        "action": "batch",
        "session": session,
        "operations": [
            { "op": "append_text", "text": "Alpha one." },
            { "op": "append_text", "text": "Beta two." },
            { "op": "add_table", "values": [["Item", "Price"], ["Widget", "old"]] },
            { "op": "track_changes", "enabled": true },
            { "op": "replace_text", "find": "one", "replace": "uno", "author": "Alice" },
            { "op": "replace_text", "find": "two", "replace": "dos", "author": "Bob" },
            { "op": "replace_text", "find": "old", "replace": "new", "author": "Bob" },
            { "op": "track_changes", "enabled": false }
        ]
    }));
    let before = live.document(&session);
    // Paragraph text is the accepted view; the struck-through words sit beside it.
    let tracked: Vec<&Value> = items(&before["paragraphs"]).iter().filter(|paragraph| super::truthy(&paragraph["tracked"])).collect();
    let pairs: Vec<Value> = tracked.iter().map(|paragraph| json!([paragraph["text"], paragraph["deletedText"]])).collect();
    assert_eq!(Value::Array(pairs), json!([["Alpha uno.", "one"], ["Beta dos.", "two"], ["new", "old"]]));
    assert!(tracked.iter().all(|paragraph| items(&paragraph["revisions"]).len() == 2));
    // A revision in a table names its cell, as the portable reader does, not the body-wide paragraph count Word keeps.
    let at: Vec<Value> = items(&before["revisions"]).iter().map(|revision| revision["at"].clone()).collect();
    let expected = vec![
        tracked[0]["path"].clone(),
        tracked[0]["path"].clone(),
        tracked[1]["path"].clone(),
        tracked[1]["path"].clone(),
        json!("/body/tbl[1]/row[2]/cell[2]"),
        json!("/body/tbl[1]/row[2]/cell[2]"),
    ];
    assert_eq!(at, expected);
    assert_eq!(
        before["revisionAuthors"],
        json!([{ "author": "Alice", "insertions": 1, "deletions": 1 }, { "author": "Bob", "insertions": 2, "deletions": 2 }])
    );
    let cells = &before["tables"][0]["rows"][1]["cells"];
    assert_eq!(json!([cells[1]["text"], cells[1]["deletedText"], cells[1]["tracked"]]), json!(["new", "old", true]));
    assert!(cells[0]["tracked"].is_null(), "a revision touching only the neighbouring cell does not flag this one");

    let nobody = live.call(json!({
        "action": "batch",
        "session": session,
        "operations": [{ "op": "resolve_revisions", "resolution": "accept", "author": "Nobody", "allowNoChange": true }]
    }));
    assert_eq!(nobody["results"][0]["changed"], false);
    assert!(matches(r#""Alice", "Bob""#, "", nobody["results"][0]["note"].as_str().unwrap_or_default()));
    let bob =
        live.call(json!({ "action": "batch", "session": session, "operations": [{ "op": "resolve_revisions", "resolution": "accept", "author": "Bob" }] }));
    assert_eq!(bob["results"][0]["resolved"], 4);
    let after = live.document(&session);
    assert_eq!(after["revisionAuthors"], json!([{ "author": "Alice", "insertions": 1, "deletions": 1 }]));
    let texts: Vec<Value> =
        items(&after["paragraphs"]).iter().filter(|paragraph| super::truthy(&paragraph["tracked"])).map(|paragraph| paragraph["text"].clone()).collect();
    assert_eq!(Value::Array(texts), json!(["Alpha uno."]));
    let cell = &after["tables"][0]["rows"][1]["cells"][1];
    assert_eq!(json!([cell["text"], cell["tracked"]]), json!(["new", null]));
    live.close(&session);
}

#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_move_paragraph_moves_the_paragraph_instead_of_deleting_it() {
    let Some(live) = Live::start() else { return };
    let operations: Vec<Value> = ["A", "B", "C", "D"].iter().map(|text| json!({ "op": "append_text", "text": text })).collect();
    let created = live.create("move.docx", "docx", "background", Value::Array(operations));
    let texts = || -> Vec<String> {
        items(&live.document(&created["session"])["paragraphs"])
            .iter()
            .map(|paragraph| paragraph["text"].as_str().unwrap_or_default().to_owned())
            .filter(|text| !text.is_empty())
            .collect()
    };
    let moved = |paragraph: i64, index: i64| {
        live.call(
            json!({ "action": "batch", "session": created["session"], "operations": [{ "op": "move_paragraph", "paragraph": paragraph, "index": index }] }),
        );
    };
    // Before the index-th paragraph that remains, or after the last one, as the portable writer moves it.
    moved(4, 2);
    assert_eq!(texts(), ["A", "D", "B", "C"]);
    moved(1, 9);
    assert_eq!(texts(), ["D", "B", "C", "A"]);
    live.close(&created["session"]);
}

#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_set_paragraph_text_rewrites_a_table_cell_paragraph_without_adding_one() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "cell.docx",
        "docx",
        "background",
        json!([{ "op": "append_text", "text": "첫 문단" }, { "op": "add_table", "values": [["가", "나"], ["다", "라"]] }, { "op": "append_text", "text": "표 뒤 문단" }]),
    );
    let listed = || -> Vec<String> {
        items(&live.document(&created["session"])["paragraphs"])
            .iter()
            .map(|paragraph| format!("{}:{}", paragraph["index"], paragraph["text"].as_str().unwrap_or_default()))
            .collect()
    };
    let before = listed();
    // Word numbers the cell paragraphs too: 2 is the first cell, and the paragraphs after it keep their numbers.
    live.call(json!({ "action": "batch", "session": created["session"], "operations": [{ "op": "set_paragraph_text", "paragraph": 2, "text": "수정" }] }));
    let expected: Vec<String> = before.iter().map(|entry| if entry == "2:가" { "2:수정".to_owned() } else { entry.clone() }).collect();
    assert_eq!(listed(), expected);
    // A cleared body paragraph stays in the reading, with its number to fill it by, as the portable reader lists it.
    live.call(json!({ "action": "batch", "session": created["session"], "operations": [{ "op": "set_paragraph_text", "paragraph": 1, "text": "" }] }));
    assert_eq!(listed()[0], "1:");
    live.close(&created["session"]);
}

// Word opened a break's paragraph in the next paragraph's style (an empty heading before a heading) and wrote a column break as a
// page break, inline in the next line; the break now stands in a plain paragraph of its own.
#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_a_page_or_column_break_stands_in_a_plain_paragraph_of_its_own_as_the_portable_writer_writes_it() {
    let Some(live) = Live::start() else { return };
    let broken = |mode: &str, kind: &str| -> Vec<String> {
        let created = live.create(
            &format!("break-{mode}-{kind}.docx"),
            "docx",
            mode,
            json!([
                { "op": "append_text", "text": "요약 문단" },
                { "op": "append_text", "text": "부록", "style": "Heading1" },
                { "op": "insert_break", "paragraph": 1, "kind": kind }
            ]),
        );
        let document = live.document(&created["session"]);
        live.close(&created["session"]);
        items(&document["paragraphs"])
            .iter()
            .take(3)
            .map(|paragraph| format!("{}:{}", paragraph["text"].as_str().unwrap_or_default(), paragraph["style"].as_str().unwrap_or_default()))
            .collect()
    };
    for kind in ["page", "column"] {
        let word = broken("background", kind);
        assert_eq!(word, ["요약 문단:Normal", ":Normal", "부록:Heading1"], "{kind}");
        assert_eq!(broken("portable", kind), word, "{kind}");
    }
}

// set_list number took Word's one-level gallery list, where level 1 failed (0x800A1200), and a nested bullet was indented by
// ListIndent, which moves a list's first item whole instead of nesting it. Both read as portably now.
#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_set_list_numbers_and_nests_items_at_the_level_asked_as_the_portable_writer_lists_them() {
    let Some(live) = Live::start() else { return };
    let listed = |mode: &str| -> Vec<String> {
        let created = live.create(
            &format!("list-{mode}.docx"),
            "docx",
            mode,
            json!([
                { "op": "append_text", "text": "처리 절차" },
                { "op": "append_text", "text": "접수" },
                { "op": "append_text", "text": "분류" },
                { "op": "append_text", "text": "야간 분류" },
                { "op": "set_list", "paragraph": 2, "kind": "number" },
                { "op": "set_list", "paragraph": 3, "kind": "number" },
                { "op": "set_list", "paragraph": 4, "kind": "number", "level": 1 }
            ]),
        );
        let document = live.document(&created["session"]);
        live.close(&created["session"]);
        let shown = |value: &Value| if value.is_null() { "undefined".to_owned() } else { value.as_str().map_or_else(|| value.to_string(), str::to_owned) };
        items(&document["paragraphs"])
            .iter()
            .skip(1)
            .take(3)
            .map(|paragraph| format!("{}:{}:{}", shown(&paragraph["text"]), shown(&paragraph["list"]["kind"]), shown(&paragraph["list"]["level"])))
            .collect()
    };
    let word = listed("background");
    assert_eq!(word, ["접수:number:0", "분류:number:0", "야간 분류:number:1"]);
    assert_eq!(listed("portable"), word);
}

// One past the last column adds a column at the end on both backends; Word's Columns.Item refused it with "no such member" (a
// localized COM error) while the portable writer added the column.
#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_a_column_inserted_one_past_the_last_lands_at_the_end_and_one_further_is_refused_as_portably() {
    let Some(live) = Live::start() else { return };
    let grown = |mode: &str| -> (String, bool, String) {
        let created = live.create(
            &format!("columns-{mode}.docx"),
            "docx",
            mode,
            json!([
                { "op": "add_table", "values": [["권역", "9월"], ["수도권", "29,000"]] },
                { "op": "insert_table_column", "table": 1, "column": 3 },
                { "op": "set_table_cell", "table": 1, "row": 1, "col": 3, "text": "증가율" }
            ]),
        );
        let refused =
            live.raw(json!({ "action": "batch", "session": created["session"], "operations": [{ "op": "insert_table_column", "table": 1, "column": 5 }] }));
        let document = live.document(&created["session"]);
        live.close(&created["session"]);
        let table = &document["tables"][0];
        let header = [&table["rows"][0], &table["cells"][0]].into_iter().find(|candidate| !candidate.is_null()).cloned().unwrap_or_else(|| table.clone());
        (stringify(&header), refused["isError"] == true, super::text_of(&refused))
    };
    let (header, refused, message) = grown("background");
    assert!(matches(r"권역[\s\S]*9월[\s\S]*증가율", "", &header));
    assert!(refused);
    assert!(matches(r"so it has no column 5: insert_table_column column is the position the new column takes, 1 to 4", "", &message));
    let (header, _, message) = grown("portable");
    assert!(matches(r"권역[\s\S]*9월[\s\S]*증가율", "", &header));
    assert!(matches(r"so it has no column 5: insert_table_column column is the position the new column takes, 1 to 4", "", &message));
}

#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_a_link_or_note_placed_by_paragraph_lands_at_the_end_of_its_text() {
    let Some(live) = Live::start() else { return };
    let operations: Vec<Value> = ["첫 문단", "둘째 문단", "셋째 문단"].iter().map(|text| json!({ "op": "append_text", "text": text })).collect();
    let created = live.create("placed.docx", "docx", "background", Value::Array(operations));
    live.call(json!({
        "action": "batch",
        "session": created["session"],
        "operations": [
            { "op": "add_hyperlink", "paragraph": 2, "address": "https://example.com", "display": "링크" },
            { "op": "add_note", "paragraph": 1, "text": "출처" }
        ]
    }));
    live.close(&created["session"]);
    let body = live.package("placed.docx").text("word/document.xml");
    let paragraphs = all_matches(r"<w:p[ >][\s\S]*?</w:p>", &body);
    // Laid over the paragraph's mark, the link joined the second paragraph to the third and its display replaced the paragraph's
    // text; the note's mark opened the second paragraph.
    let texts: Vec<String> = paragraphs.iter().take(3).map(|xml| paragraph_text(xml)).collect();
    assert_eq!(texts, ["첫 문단", "둘째 문단링크", "셋째 문단"]);
    assert!(paragraphs[0].contains("<w:footnoteReference "));
    assert!(!paragraphs[1].contains("<w:footnoteReference "));
}

// Word put a second table into the paragraph right after the first, and the two read back as one table; the portable writer keeps
// a paragraph between them, and so does Word now.
#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_two_tables_added_in_a_row_stay_two_tables() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "tables.docx",
        "docx",
        "background",
        json!([{ "op": "append_text", "text": "첫" }, { "op": "add_table", "rows": 1, "columns": 1, "values": [["A"]] }, { "op": "add_table", "rows": 1, "columns": 1, "values": [["B"]] }]),
    );
    let read = live.document(&created["session"]);
    assert_eq!(read["tableCount"], 2, "{}", stringify(&read["blockOrder"]));
    live.close(&created["session"]);
}

// Word ended every document it wrote with an empty paragraph, put a picture added at the end at the start of the last paragraph's
// text, and opened an empty paragraph after a page break; the paragraphs now read as the portable writer's do.
#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_appended_blocks_read_as_the_portable_writer_lays_them_out() {
    let Some(live) = Live::start() else { return };
    let picture = live.path("dot.png");
    std::fs::write(&picture, base64_decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="))
        .expect("the picture");
    let operations = json!([
        { "op": "append_text", "text": "제목", "style": "Heading 1" },
        { "op": "append_text", "text": "항목", "properties": { "listKind": "bullet" } },
        { "op": "append_text", "text": "목록 뒤" },
        { "op": "add_image", "path": picture, "width": 20, "height": 20 },
        { "op": "append_text", "text": "그림 설명" },
        { "op": "insert_break" },
        { "op": "append_text", "text": "둘째 쪽" },
        { "op": "add_table", "rows": 1, "columns": 1, "values": [["A"]] },
        { "op": "append_text", "text": "표 뒤" },
        { "op": "set_header_footer", "kind": "header", "text": "대외비" },
        { "op": "set_header_footer", "kind": "footer", "text": "물류운영팀" },
        { "op": "add_page_numbers" },
        { "op": "insert_break", "kind": "section_next" },
        { "op": "append_text", "text": "다음 구역" }
    ]);
    let mut read: HashMap<&str, Vec<Value>> = HashMap::new();
    let mut sections: HashMap<&str, Value> = HashMap::new();
    for mode in ["portable", "background"] {
        let created = live.create(&format!("{mode}.docx"), "docx", mode, operations.clone());
        let document = live.document(&created["session"]);
        read.insert(
            mode,
            items(&document["paragraphs"])
                .iter()
                .filter(|paragraph| !super::truthy(&paragraph["inTable"]))
                .map(|paragraph| paragraph["text"].clone())
                .collect(),
        );
        sections.insert(mode, document["sections"].clone());
        live.close(&created["session"]);
    }
    assert_eq!(read["background"], read["portable"]);
    assert_eq!(Value::Array(read["background"].clone()), json!(["제목", "항목", "목록 뒤", "", "그림 설명", "", "둘째 쪽", "표 뒤", "", "다음 구역"]));
    // Headers and footers read under the section that shows them on both backends.
    assert_eq!(sections["background"], sections["portable"]);
    let stories: Vec<Value> = items(&sections["portable"])
        .iter()
        .map(|section| {
            Value::Array(items(&section["stories"]).iter().map(|story| json!([story["location"], story["text"], story["linkToPrevious"] == true])).collect())
        })
        .collect();
    assert_eq!(
        Value::Array(stories),
        json!([[["header", "대외비", false], ["footer", "물류운영팀\n1", false]], [["header", "대외비", true], ["footer", "물류운영팀\n1", true]]])
    );
}

// Paragraphs appended one after another go into Word as one block: one at a time, a 150-paragraph Korean report took 56 s to
// create. The block still answers one result per operation, no paragraph carries its neighbour's format (a callout's text under
// its bold label stays regular), and it reads back as the portable writer lays it out.
#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_consecutive_paragraphs_append_as_one_block_and_read_back_one_by_one_in_their_own_formats() {
    let Some(live) = Live::start() else { return };
    let body = json!({ "name": "Calibri", "nameEastAsia": "맑은 고딕", "size": 10.5, "lineSpacing": 18, "spacingAfter": 8 });
    let with = |extra: Value| -> Value {
        let mut merged = body.clone();
        if let (Some(map), Some(more)) = (merged.as_object_mut(), extra.as_object()) {
            map.extend(more.clone());
        }
        merged
    };
    // compose_document names Normal on its list items, and the portable writer keeps it; Word moved them to List Paragraph, whose
    // contextual spacing took away each item's spacing. An item naming no style takes List Paragraph on both paths.
    let bullet =
        |text: &str| json!({ "op": "append_text", "text": text, "style": "Normal", "properties": with(json!({ "spacingAfter": 3, "listKind": "bullet" })) });
    let operations = json!([
        { "op": "append_text", "text": "현황", "style": "Heading 1" },
        { "op": "append_text", "text": "첫째 문단입니다.", "properties": body },
        { "op": "append_text", "text": "둘째 문단입니다.", "properties": body },
        { "op": "append_text", "text": "셋째 문단입니다.", "properties": body },
        bullet("항목 하나"),
        bullet("항목 둘"),
        { "op": "append_text", "text": "항목 셋", "properties": with(json!({ "listKind": "bullet" })) },
        { "op": "append_text", "text": "결론", "properties": with(json!({ "bold": true, "shading": "EEF2F7" })) },
        { "op": "append_text", "text": "맺음 문단입니다.", "properties": with(json!({ "size": 12, "shading": "EEF2F7" })) }
    ]);
    let mut read: HashMap<&str, Vec<Value>> = HashMap::new();
    for mode in ["portable", "background"] {
        let created = live.create(&format!("{mode}.docx"), "docx", mode, operations.clone());
        if mode == "background" {
            let named: Vec<Value> = items(&created["batch"]["results"]).iter().map(|entry| entry["paragraph"].clone()).collect();
            assert_eq!(Value::Array(named), json!([1, 2, 3, 4, 5, 6, 7, 8, 9]), "one result per operation, each naming its own paragraph");
        }
        let document = live.document(&created["session"]);
        read.insert(
            mode,
            items(&document["paragraphs"])
                .iter()
                .map(|paragraph| {
                    json!([
                        paragraph["text"],
                        paragraph["list"]["kind"].as_str().unwrap_or(""),
                        paragraph["font"]["size"],
                        paragraph["style"],
                        super::truthy(&paragraph["font"]["bold"])
                    ])
                })
                .collect(),
        );
        live.close(&created["session"]);
    }
    let column = |mode: &str, indexes: &[usize], skip: usize| -> Vec<Value> {
        read[mode].iter().skip(skip).map(|entry| Value::Array(indexes.iter().map(|at| entry[*at].clone()).collect())).collect()
    };
    assert_eq!(column("background", &[0, 1], 0), column("portable", &[0, 1], 0));
    let sizes: Vec<Value> = read["background"].iter().skip(1).map(|entry| entry[2].clone()).collect();
    assert_eq!(Value::Array(sizes), json!([10.5, 10.5, 10.5, 10.5, 10.5, 10.5, 10.5, 12]));
    assert_eq!(column("background", &[3], 0), column("portable", &[3], 0));
    assert_eq!(column("background", &[4], 0), column("portable", &[4], 0));
    let last_two: Vec<Value> = read["background"].iter().rev().take(2).rev().map(|entry| entry[4].clone()).collect();
    assert_eq!(Value::Array(last_two), json!([true, false]));
}

// A phrase cut inside a word ("성장" of "성장했습니다") took the note's mark mid-word; a phrase ending on a sign ("92.8%" before "로")
// keeps it there, as the portable writer sets both.
#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_a_note_mark_goes_at_the_end_of_the_word_the_cited_phrase_ends_in() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "notes.docx",
        "docx",
        "background",
        json!([
            { "op": "append_text", "text": "부산 권역이 가장 크게 성장했습니다." },
            { "op": "add_note", "find": "가장 크게 성장", "text": "영업 시스템 추출 기준." },
            { "op": "append_text", "text": "정시 출고율은 92.8%로 내려갔습니다." },
            { "op": "add_note", "find": "92.8%", "text": "물류운영팀 집계." }
        ]),
    );
    // Word holds the note reference in the text as \x02; the paragraph reads as the page shows it.
    let read = live.document(&created["session"]);
    let texts: Vec<Value> = items(&read["paragraphs"]).iter().take(2).map(|paragraph| paragraph["text"].clone()).collect();
    assert_eq!(Value::Array(texts), json!(["부산 권역이 가장 크게 성장했습니다.", "정시 출고율은 92.8%로 내려갔습니다."]));
    assert_eq!(read["footnotes"][0]["text"], "영업 시스템 추출 기준.");
    live.close(&created["session"]);
    let document = live.package("notes.docx").text("word/document.xml");
    let before = |reference: &str| -> String {
        let at = document.find(reference).unwrap_or_else(|| panic!("no {reference}"));
        paragraph_text(&document[..at])
    };
    assert!(matches(r"성장했습니다$", "", &before(r#"<w:footnoteReference w:id="1"/>"#)));
    assert!(matches(r"92\.8%$", "", &before(r#"<w:footnoteReference w:id="2"/>"#)));
}

#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_excel_an_unlabelled_picture_is_reported_on_the_office_backend_as_it_is_portably() {
    let Some(live) = Live::start() else { return };
    let picture = live.path("logo.png");
    std::fs::write(&picture, png_pixel()).expect("the picture");
    let placed = [
        ("docx", json!([{ "op": "append_text", "text": "로고" }, { "op": "add_image", "path": picture, "width": 40 }])),
        (
            "xlsx",
            json!([{ "op": "set_cell", "sheet": "Sheet1", "cell": "A1", "value": "로고" }, { "op": "add_image", "sheet": "Sheet1", "path": picture, "cell": "C2", "width": 40 }]),
        ),
    ];
    for (format, operations) in placed {
        let created = live.create(&format!("picture.{format}"), format, "background", operations);
        let issues = live.call(json!({ "action": "issues", "session": created["session"] }));
        let codes: Vec<Value> = items(&issues["issues"]).iter().map(|entry| entry["code"].clone()).collect();
        assert!(codes.iter().any(|code| code == "missing_alt_text"), "{format}: {}", stringify(&Value::Array(codes.clone())));
        live.close(&created["session"]);
    }
}

#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_an_edit_of_a_table_of_contents_entry_says_what_to_edit_instead() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "toc.docx",
        "docx",
        "background",
        json!([
            { "op": "append_text", "text": "개요", "style": "Heading 1" },
            { "op": "append_text", "text": "본문" },
            { "op": "append_text", "text": "결론", "style": "Heading 1" },
            { "op": "insert_toc", "paragraph": 1 }
        ]),
    );
    // Paragraph 2 is the first entry of the contents Word filled in after the heading.
    let message = live.refused(json!({ "action": "batch", "session": created["session"], "operations": [{ "op": "remove_paragraph", "paragraph": 2 }] }));
    assert!(matches(r"table of contents.*edit the heading it lists", "", &message), "{message}");
    live.close(&created["session"]);
}

#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_name_sets_the_latin_face_alone_and_leaves_the_hangul_face_to_name_east_asia() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "faces.docx",
        "docx",
        "background",
        json!([
            { "op": "append_text", "text": "서울 매출" },
            // Font.Name given an East Asian face set the Hangul face too; the portable writer sets w:ascii alone.
            { "op": "set_font", "find": "서울", "properties": { "name": "Batang" } }
        ]),
    );
    live.close(&created["session"]);
    let xml = live.package("faces.docx").text("word/document.xml");
    let run = all_matches(r"<w:r\b[\s\S]*?</w:r>", &xml).into_iter().find(|run| run.contains("서울")).unwrap_or_default();
    let fonts = capture(r"<w:rFonts\b[^>]*/>", "", &run, 0).unwrap_or_default();
    assert!(matches(r#"w:ascii="(?:Batang|바탕)""#, "", &fonts), "{fonts}");
    assert!(!matches(r#"w:eastAsia="(?:Batang|바탕)""#, "", &fonts), "{fonts}");
}

#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_a_row_or_table_the_document_lacks_is_refused_with_the_tables_it_holds_as_the_portable_writer_says_it() {
    let Some(live) = Live::start() else { return };
    let tables = json!([
        { "op": "add_table", "values": [["184,200건", "+34%"], ["야간 처리량", "전년 대비"]] },
        { "op": "add_table", "values": [["권역", "처리량"], ["수도권", "82,400"], ["부산", "71,600"], ["합계", "154,000"]] }
    ]);
    let refusals = |mode: &str| -> (Vec<Option<String>>, Value) {
        let created = live.create(&format!("tables-{mode}.docx"), "docx", mode, tables.clone());
        let refused = |operation: Value| -> Option<String> {
            let op = operation["op"].clone();
            let result = live.raw(json!({ "action": "batch", "session": created["session"], "operations": [operation] }));
            assert_eq!(result["isError"], true, "{op} is refused");
            capture(r"DOCX table [^\n]*", "", &super::text_of(&result), 0)
        };
        let messages = vec![
            refused(json!({ "op": "insert_table_row", "table": 1, "row": 4 })),
            refused(json!({ "op": "set_table_cell", "table": 1, "row": 5, "col": 1, "text": "강원" })),
            refused(json!({ "op": "insert_table_row", "table": 3, "row": 1 })),
        ];
        // One past the last row adds a row at the end.
        let added = live.call(json!({ "action": "batch", "session": created["session"], "operations": [{ "op": "insert_table_row", "table": 2, "row": 5 }] }));
        live.close(&created["session"]);
        (messages, added["results"][0]["rows"].clone())
    };
    let (messages, rows) = refusals("background");
    let message = |at: usize| messages[at].clone().unwrap_or_default();
    assert!(matches(
        r#"DOCX table 1 is 2×2 starting "184,200건", so it has no row 4: insert_table_row row is the position the new row takes, 1 to 3"#,
        "",
        &message(0)
    ));
    assert!(matches(r#"DOCX table 1 is 2×2 starting "184,200건", so it has no row 5$"#, "", &message(1)));
    assert!(matches(r#"DOCX table 3 not found: the document holds 2 table\(s\) \(1: 2×2 starting "184,200건"; 2: 4×2 starting "권역"\)"#, "", &message(2)));
    assert_eq!(rows, 5);
    let (portable, _) = refusals("portable");
    assert_eq!(portable, messages);
}

// Right to left the two-level header comes out whole, and a cell named past the row's end is explained in the words the portable
// writer uses.
#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_a_two_level_header_merges_right_to_left_and_a_shifted_cell_is_explained() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "merged.docx",
        "docx",
        "background",
        json!([
            {
                "op": "add_table",
                "values": [["권역", "3분기 처리량", "", "", "지연률"], ["", "7월", "8월", "9월", ""], ["수도권", "26,100", "27,300", "29,000", "0.8%"]],
                "properties": { "headerRows": 2 }
            },
            { "op": "merge_table_cells", "table": 1, "row": 1, "col": 5, "rowSpan": 2 },
            { "op": "merge_table_cells", "table": 1, "row": 1, "col": 2, "colSpan": 3 },
            { "op": "merge_table_cells", "table": 1, "row": 1, "col": 1, "rowSpan": 2 }
        ]),
    );
    assert_eq!(items(&created["batch"]["results"]).iter().filter(|entry| entry["op"] == "merge_table_cells").count(), 3);
    let message = live.refused(
        json!({ "action": "batch", "session": created["session"], "operations": [{ "op": "set_table_cell", "table": 1, "row": 1, "col": 5, "text": "지연" }] }),
    );
    assert!(matches(r"row 1 holds 3 cell\(s\)[\s\S]*merge a row from its right end first", "", &message), "{message}");
    live.close(&created["session"]);
    // Both header rows are the header, as the portable writer sets them: bold, on their bottom edge, and repeated.
    let document = live.package("merged.docx").text("word/document.xml");
    let rows = all_matches(r"<w:tr\b[\s\S]*?</w:tr>", &document);
    let headers: Vec<bool> = rows.iter().map(|row| row.contains("<w:tblHeader/>")).collect();
    assert_eq!(headers, [true, true, false]);
    let month = capture(r"<w:tc>(?:(?!</w:tc>)[\s\S])*?<w:t>7월</w:t>", "", &rows[1], 0).unwrap_or_default();
    assert!(month.contains(r#"<w:vAlign w:val="bottom"/>"#), "{month}");
    assert!(month.contains("<w:b/>"), "{month}");
}

// A Word chart is the picture the PDF chart block draws, placed as add_image places one, so Word holds the same picture the
// portable writer does.
#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_a_chart_lands_as_a_picture_that_names_its_figures() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "charted.docx",
        "docx",
        "background",
        json!([
            { "op": "append_text", "text": "분기별 처리량" },
            { "op": "add_chart", "chartType": "column", "categories": ["1분기", "2분기", "3분기"], "values": [120, 150, 184.2], "unit": "천 건", "highlight": 2 }
        ]),
    );
    live.close(&created["session"]);
    let package = live.package("charted.docx");
    let document = package.text("word/document.xml");
    assert!(matches(r#"descr="1분기 120천 건, 2분기 150천 건, 3분기 184\.2천 건""#, "", &document));
    assert!(package.names().iter().any(|name| matches(r"^word/media/.+\.png$", "", name)), "the picture is in the package");
}

// A provenance comment names its source in the language the source is named in, as the portable writer writes it: Word's comment
// read "Source: 실적원장.xlsx#Raw!B8" beside the portable file's "출처: ...".
#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_a_provenance_comment_cites_its_source_in_the_copy_language() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "cited.docx",
        "docx",
        "background",
        json!([
            { "op": "append_text", "text": "3분기 매출은 86억 원입니다." },
            { "op": "add_provenance", "paragraph": 1, "source": { "document": "실적원장.xlsx", "target": "Raw!B8" } }
        ]),
    );
    let results = items(&created["batch"]["results"]);
    assert_eq!(results.last().map_or(Value::Null, |last| last["citation"].clone()), "출처: 실적원장.xlsx#Raw!B8");
    let read = live.document(&created["session"]);
    assert_eq!(read["comments"][0]["text"], "출처: 실적원장.xlsx#Raw!B8");
    live.close(&created["session"]);
}

// A display title's leading is held exactly when asked, as the portable writer sets it; without the rule it stays a minimum.
#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_a_paragraph_holds_an_exact_line_when_asked_and_a_minimum_otherwise() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "leading.docx",
        "docx",
        "background",
        json!([
            { "op": "append_text", "text": "가맹점 설정 오류를 먼저 알려 주는 안내 자동화", "style": "Title", "properties": { "size": 24, "lineSpacing": 30, "lineSpacingRule": "exact" } },
            { "op": "append_text", "text": "본문 한 줄", "properties": { "size": 10.5, "lineSpacing": 18 } }
        ]),
    );
    live.close(&created["session"]);
    let document = live.package("leading.docx").text("word/document.xml");
    assert!(matches(r#"<w:spacing\b[^>]*\bw:line="600" w:lineRule="exact""#, "", &document));
    assert!(matches(r#"<w:spacing\b[^>]*\bw:line="360" w:lineRule="atLeast""#, "", &document));
}

// A column of words that follows a column of figures takes room on its left, as the portable writer gives it: set right, "96" ran
// into "내부 인력 4명" across the cells' own padding alone.
#[test]
#[ignore = "starts Microsoft Word; MIXDOG_TEST_LIVE_OFFICE=1"]
fn word_a_column_of_words_after_a_column_of_figures_takes_a_gutter() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "budget.docx",
        "docx",
        "background",
        json!([{
            "op": "add_table",
            "values": [["항목", "금액 (백만 원)", "비고"], ["개발 인력", "96", "내부 인력 4명"], ["합계", "160", "예비비 포함"]],
            "properties": { "columnAlignments": ["left", "right", "left"] }
        }]),
    );
    live.close(&created["session"]);
    let document = live.package("budget.docx").text("word/document.xml");
    let rows = all_matches(r"<w:tr\b[\s\S]*?</w:tr>", &document);
    assert_eq!(rows.len(), 3);
    for row in &rows {
        let cells = all_matches(r"<w:tc>[\s\S]*?</w:tc>", row);
        let (figure, note) = (&cells[1], &cells[2]);
        assert!(!matches(r"<w:tcMar>[\s\S]*?<w:left\b", "", figure), "the figures keep their padding");
        assert!(matches(r#"<w:tcMar>[\s\S]*?<w:left w:w="268" w:type="dxa"/>"#, "", note), "the words take the gutter");
    }
}
