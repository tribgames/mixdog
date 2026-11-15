//! The `[powerpoint]` profile: persistent PowerPoint sessions, and what PowerPoint reads and writes as the portable reader and
//! writer do.

use std::path::PathBuf;

use mixdog_ooxml::zipio::Package;
use mixdog_raster::image::Image;
use serde_json::{Value, json};

use super::{Live, all_captures, all_matches, capture, items, matches, mentions, number, stringify, strip, text_of};

/// The first shape of `slide` whose text holds `needle` (`shapes.find((shape) => shape.text?.includes(needle))`).
fn shape_with_text(slide: &Value, needle: &str) -> Value {
    items(&slide["shapes"]).iter().find(|shape| shape["text"].as_str().is_some_and(|text| text.contains(needle))).cloned().unwrap_or(Value::Null)
}

/// The first shape of `slide` that carries `key` (`shapes.find((shape) => shape.table)`).
fn shape_with(slide: &Value, key: &str) -> Value {
    items(&slide["shapes"]).iter().find(|shape| super::truthy(&shape[key])).cloned().unwrap_or(Value::Null)
}

/// The names of the series of a chart reading, in order.
fn series_names(chart: &Value) -> Value {
    Value::Array(items(&chart["series"]).iter().map(|series| series["name"].clone()).collect())
}

/// The part of `package` named like `^ppt/<folder>/<stem>\d+\.xml$`, first in package order.
fn part_like(package: &Package, folder: &str, stem: &str) -> String {
    let pattern = format!(r"^ppt/{folder}/{stem}\d+\.xml$");
    package.names().into_iter().find(|name| matches(&pattern, "", name)).unwrap_or_else(|| panic!("no {folder}/{stem} part"))
}

/// The `<p:sp>` shapes of the first slide part of the package at `path`.
fn slide_shapes(live: &Live, path: &str) -> Vec<String> {
    let package = live.package(path);
    all_matches(r"<p:sp>[\s\S]*?</p:sp>", &package.text(&part_like(&package, "slides", "slide")))
}

#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn persistent_powerpoint_sessions_create_save_and_read_unicode_content() {
    let Some(live) = Live::start() else { return };
    let powerpoint = live.call(json!({ "action": "create", "path": live.path("발표.pptx"), "format": "pptx", "mode": "background" }));
    let isolation = &powerpoint["backgroundIsolation"];
    assert_eq!(isolation["strict"], true, "{}", stringify(&powerpoint));
    assert_eq!(isolation["isolatedProcess"], true, "{}", stringify(&powerpoint));
    assert_eq!(isolation["observedVisibleWindows"], json!([]), "{}", stringify(&powerpoint));
    assert_eq!(isolation["visibleOwnedWindows"], 0, "{}", stringify(&powerpoint));
    assert_eq!(isolation["ownedForeground"], false, "{}", stringify(&powerpoint));
    let session = powerpoint["session"].clone();
    let batch = live.call(json!({
        "action": "batch",
        "session": session,
        "operations": [
            { "op": "add_slide" },
            { "op": "add_textbox", "slide": 1, "text": "{{ title }} 한글-日本語-中文", "properties": { "left": 90, "top": 80, "width": 500, "height": 120, "fontSize": 24 } },
            {
                "op": "add_shape",
                "slide": 1,
                "shapeType": "rounded_rectangle",
                "paragraphs": [
                    { "text": "Card", "bold": true, "fontSize": 20, "color": "FFFFFF" },
                    { "text": "Bullet item", "bullet": true, "level": 0, "fontSize": 14, "color": "FFFFFF" }
                ],
                "properties": { "left": 40, "top": 240, "width": 180, "height": 80, "fillColor": "E8F0FE", "lineColor": "3367D6" }
            },
            { "op": "add_table", "slide": 1, "values": [["Metric", "Value"], ["Users", 42]], "left": 240, "top": 240, "width": 280, "height": 100 },
            {
                "op": "set_table_data",
                "slide": 1,
                "shape": 3,
                "values": [["Metric", "Actual", "Plan", "Status"], ["Users", 42, 45, "Track"], ["Calls", 18, 20, "Track"], ["Errors", 0, 0, "Pass"]]
            },
            { "op": "add_chart", "slide": 1, "chartType": "column", "title": "Initial", "left": 540, "top": 220, "width": 300, "height": 180 },
            {
                "op": "set_chart_data",
                "slide": 1,
                "shape": 4,
                "title": "Metrics",
                "categories": ["A", "B"],
                "series": [{ "name": "Actual", "values": [10, 20] }, { "name": "Plan", "values": [12, 18] }]
            },
            { "op": "set_chart_series", "slide": 1, "shape": 4, "series": 2, "chartType": "line", "secondaryAxis": true },
            { "op": "set_chart_trendline", "slide": 1, "shape": 4, "series": 1, "type": "linear" },
            { "op": "set_chart_error_bars", "slide": 1, "shape": 4, "series": 1, "amount": 2, "direction": "y" },
            { "op": "set_chart_data_labels", "slide": 1, "shape": 4, "series": 1, "showValue": true },
            { "op": "set_transition", "slide": 1, "effect": "fade", "duration": 1, "advanceOnTime": false },
            { "op": "add_animation", "slide": 1, "shape": 2, "effect": "fade", "trigger": "afterprevious", "duration": 0.5 },
            { "op": "set_shape", "slide": 1, "shape": 2, "properties": { "fillTransparency": 0.1, "marginLeft": 8, "marginRight": 8, "paragraphSpacing": 3 } },
            { "op": "add_comment", "slide": 1, "text": "차트와 전환 검토", "author": "Mixdog", "initials": "MD" },
            { "op": "align_shapes", "slide": 1, "shapes": [2, 3], "align": "top" },
            { "op": "set_hyperlink", "slide": 1, "shape": 2, "address": "https://mix.dog" },
            { "op": "z_order", "slide": 1, "shape": 2, "command": "front" },
            {
                "op": "add_chart",
                "slide": 1,
                "chartType": "column",
                "title": "One series",
                "categories": ["May", "June", "July"],
                "series": [{ "name": "Revenue", "values": [10, 12, 15] }],
                "left": 540,
                "top": 410,
                "width": 300,
                "height": 120
            },
            { "op": "set_notes", "slide": 1, "text": "Owner {{owner}}" },
            { "op": "fill_template", "tokens": { "title": "실제 템플릿", "owner": "Mixdog" }, "strict": true }
        ]
    }));
    let isolation = &batch["backgroundIsolation"];
    assert_eq!(isolation["strict"], true, "{}", stringify(&batch));
    assert_eq!(isolation["observedVisibleWindows"], json!([]), "{}", stringify(&batch));
    assert_eq!(isolation["visibleOwnedWindows"], 0, "{}", stringify(&batch));
    assert_eq!(isolation["ownedForeground"], false, "{}", stringify(&batch));
    assert_eq!(isolation["hiddenWindows"], 0, "{}", stringify(&batch));
    assert_eq!(isolation["focusRestorations"], 0, "{}", stringify(&batch));
    let snapshot = live.call(json!({ "action": "snapshot", "session": session }));
    let document = &snapshot["document"];
    assert!(mentions(document, "한글-日本語-中文"));
    assert!(mentions(document, "실제 템플릿"));
    assert_eq!(document["slides"][0]["notes"], "Owner Mixdog");
    // replace_text scoped to a slide reaches its speaker notes, as the portable writer's does.
    let scoped = live.call(json!({ "action": "batch", "session": session, "operations": [{ "op": "replace_text", "slide": 1, "find": "Owner", "replace": "Lead" }] }));
    assert_eq!(scoped["results"][0]["count"], 1);
    // A batch is atomic: a background deck has no window for PowerPoint's Undo, so the edit before a failed operation stayed in the
    // deck. It now reloads from the copy the batch started from.
    let failed = live.raw(json!({
        "action": "batch",
        "session": session,
        "operations": [{ "op": "replace_text", "slide": 1, "find": "실제 템플릿", "replace": "되돌려질 문구" }, { "op": "set_text", "slide": 1, "shape": 99, "text": "missing" }]
    }));
    assert_eq!(failed["isError"], true);
    let after_failure = live.call(json!({ "action": "snapshot", "session": session }));
    assert!(!mentions(&after_failure["document"], "되돌려질 문구"));
    assert!(mentions(&after_failure["document"], "실제 템플릿"));
    assert_eq!(after_failure["document"]["slides"][0]["notes"], "Lead Mixdog");
    assert!(number(&document["layoutCount"]) > 0.0);
    let slide = &document["slides"][0];
    let textbox = shape_with_text(slide, "실제 템플릿");
    assert_eq!(number(&textbox["left"]), 90.0);
    assert_eq!(number(&textbox["top"]), 80.0);
    assert_eq!(number(&textbox["width"]), 500.0);
    assert_eq!(number(&textbox["height"]), 120.0);
    assert_eq!(number(&textbox["font"]["size"]), 24.0);
    let table = shape_with(slide, "table");
    // The table grew from two columns to four inside the width it was given, as the portable writer sets it.
    assert_eq!(number(&table["width"]).round(), 280.0);
    assert_eq!(table["table"]["values"], json!([["Metric", "Actual", "Plan", "Status"], ["Users", "42", "45", "Track"], ["Calls", "18", "20", "Track"], ["Errors", "0", "0", "Pass"]]));
    let chart = shape_with(slide, "chart");
    assert_eq!(chart["chart"]["title"], "Metrics");
    assert_eq!(chart["chart"]["seriesCount"], 2);
    assert_eq!(chart["chart"]["series"][0]["trendlineCount"], 1);
    assert_eq!(chart["chart"]["series"][0]["hasErrorBars"], true);
    // Named as the portable reader and set_chart_series name it, not by Excel's enumeration number.
    assert_eq!(chart["chart"]["series"][1]["chartType"], "line");
    assert_eq!(chart["chart"]["series"][1]["axisGroup"], 2);
    let one_series = items(&slide["shapes"]).iter().find(|shape| shape["chart"]["title"] == "One series").cloned().unwrap_or(Value::Null);
    assert_eq!(one_series["chart"]["seriesCount"], 1);
    assert_eq!(items(&slide["comments"]).len(), 1);
    assert_eq!(items(&slide["animations"]).len(), 1);
    assert_ne!(slide["transition"]["effect"], 0);
    assert!(number(&document["designCount"]) > 0.0);
    assert!(matches(r"Bullet item", "", shape_with_text(slide, "Card")["text"].as_str().unwrap_or_default()));
    live.call(json!({
        "action": "batch",
        "session": session,
        "operations": [{
            "op": "add_provenance",
            "slide": 1,
            "shape": 1,
            "source": { "document": "source-model.xlsx", "target": "/sheet[Inputs]/cell[C3]", "label": "Revenue" }
        }]
    }));
    let sourced = live.document(&session);
    assert!(matches(r"Source: source-model\.xlsx#/sheet\[Inputs\]/cell\[C3\]", "", sourced["slides"][0]["notes"].as_str().unwrap_or_default()));
    let issues = live.call(json!({ "action": "issues", "session": session }));
    assert!(items(&issues["issues"]).iter().any(|issue| issue["code"] == "low_contrast"));
    let validation = live.call(json!({ "action": "validate", "session": session }));
    assert_eq!(validation["ok"], true, "{}", stringify(&validation));
    assert_eq!(validation["native"]["opened"], true);
    live.close(&session);

    let persisted = live.call(json!({ "action": "open", "path": live.path("발표.pptx"), "output": live.path("발표-재열기.pptx"), "mode": "background" }));
    let persisted_document = live.document(&persisted["session"]);
    let persisted_slide = &persisted_document["slides"][0];
    let persisted_chart = shape_with(persisted_slide, "chart");
    assert_eq!(persisted_chart["chart"]["seriesCount"], 2);
    assert_eq!(series_names(&persisted_chart["chart"]), json!(["Actual", "Plan"]));
    let persisted_one = items(&persisted_slide["shapes"]).iter().find(|shape| shape["chart"]["title"] == "One series").cloned().unwrap_or(Value::Null);
    assert_eq!(persisted_one["chart"]["seriesCount"], 1);
    assert_eq!(series_names(&persisted_one["chart"]), json!(["Revenue"]));
    live.close(&persisted["session"]);

    let imported = live.call(json!({ "action": "create", "path": live.path("가져오기.pptx"), "format": "pptx", "mode": "background" }));
    let imported_batch = live.call(json!({
        "action": "batch",
        "session": imported["session"],
        "operations": [{ "op": "import_slides", "path": live.path("발표.pptx"), "after": 0, "slides": [1] }]
    }));
    assert_eq!(imported_batch["results"][0]["count"], 1);
    let imported_snapshot = live.call(json!({ "action": "snapshot", "session": imported["session"] }));
    assert_eq!(imported_snapshot["document"]["slideCount"], 1, "{}", stringify(&json!({ "batch": imported_batch, "snapshot": imported_snapshot })));
    assert!(mentions(&imported_snapshot["document"]["slides"][0], "실제 템플릿"));
    assert_ne!(imported_snapshot["document"]["slides"][0]["transition"]["effect"], 0);
    live.close(&imported["session"]);
}

// PowerPoint's InsertFromFile gives an imported slide the deck's own design and dropped the background the slide had: the
// template's dark quote page arrived on the deck's light paper, its white words unreadable. The page keeps its template
// background, as the portable import keeps it.
#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn powerpoint_a_template_page_keeps_its_own_background_on_import() {
    let Some(live) = Live::start() else { return };
    let created = live.call(json!({ "action": "create", "path": live.path("quote.pptx"), "format": "pptx", "mode": "background" }));
    let template = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../mixdog-office-design/assets/templates/mixdog-executive.pptx");
    live.call(json!({
        "action": "batch",
        "session": created["session"],
        "operations": [{
            "op": "use_template_page",
            "path": template.to_string_lossy(),
            "slide": 14,
            "after": 0,
            "title": "설정이 잘못됐다고 바로 알려 주니 가맹점이 먼저 고쳤습니다."
        }]
    }));
    let document = live.document(&created["session"]);
    let page = &document["slides"][0];
    assert_eq!(page["background"]["color"].as_str().unwrap_or_default().to_uppercase(), "254E70", "{}", stringify(&page["background"]));
    live.close(&created["session"]);
}

// set_chart_data read its numbers and title and set nothing else under PowerPoint, where the portable writer takes the fields
// beside them: a refresh asking for value labels and a zero base line came back bare.
#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn powerpoint_new_chart_numbers_take_the_label_and_base_line_fields_beside_them() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "labels.pptx",
        "pptx",
        "background",
        json!([
            { "op": "add_slide" },
            {
                "op": "add_chart",
                "slide": 1,
                "chartType": "column",
                "categories": ["6월", "7월", "8월"],
                "series": [{ "name": "가동률 (%)", "values": [96.2, 97.1, 98.4] }],
                "left": 60,
                "top": 80,
                "width": 480,
                "height": 280
            },
            {
                "op": "set_chart_data",
                "slide": 1,
                "shape": 1,
                "categories": ["7월", "8월", "9월"],
                "series": [{ "name": "가동률 (%)", "values": [97.1, 98.4, 98.9] }],
                "showValues": true,
                "zeroBaseline": true,
                "valueNumberFormat": "0.0"
            }
        ]),
    );
    let document = live.document(&created["session"]);
    let chart = &shape_with(&document["slides"][0], "chart")["chart"];
    assert_eq!(chart["series"][0]["hasDataLabels"], true, "{}", stringify(&chart["series"][0]));
    assert_eq!(chart["series"][0]["dataLabels"]["numberFormat"], "0.0");
    let value_axis = items(&chart["axes"]).iter().find(|axis| axis["type"] == "value").cloned().unwrap_or(Value::Null);
    assert_eq!(value_axis["minimum"], 0, "{}", stringify(&chart["axes"]));
    live.close(&created["session"]);
}

// A bar chart's reading order turns over on categoryOrder and a refresh that leaves it bottom-up says so, as the portable writer
// does: a template's monthly bars had read 9월 to 6월 from the top on both backends.
#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn powerpoint_a_bar_chart_reads_top_down_or_bottom_up_as_category_order_asks_and_says_when_it_reads_bottom_up() {
    let Some(live) = Live::start() else { return };
    let created = live.call(json!({ "action": "create", "path": live.path("bars.pptx"), "format": "pptx", "mode": "background" }));
    let batch = |operations: Value| -> Value { live.call(json!({ "action": "batch", "session": created["session"], "operations": operations }))["results"].clone() };
    let data = |extra: Value| -> Value {
        let mut operation = json!({
            "op": "set_chart_data",
            "slide": 1,
            "shape": 1,
            "categories": ["6월", "7월", "8월", "9월"],
            "series": [{ "name": "오류 (건)", "values": [8200, 5900, 3100, 2700] }]
        });
        if let (Some(map), Some(more)) = (operation.as_object_mut(), extra.as_object()) {
            map.extend(more.clone());
        }
        operation
    };
    batch(json!([
        { "op": "add_slide" },
        { "op": "add_chart", "slide": 1, "chartType": "bar", "categories": ["6월", "7월"], "series": [{ "name": "오류 (건)", "values": [8200, 5900] }], "left": 60, "top": 80, "width": 480, "height": 280 }
    ]));
    // The runtime's own bar chart already reads top-down.
    assert!(batch(json!([data(json!({}))]))[0]["readingOrder"].is_null());
    batch(json!([data(json!({ "categoryOrder": "bottomUp" }))]));
    let left = batch(json!([data(json!({}))]))[0].clone();
    assert_eq!(left["readingOrder"], "bottomUp", "{}", stringify(&left));
    assert!(matches(r"categoryOrder:'topDown'", "", left["note"].as_str().unwrap_or_default()));
    batch(json!([data(json!({ "categoryOrder": "topDown" }))]));
    assert!(batch(json!([data(json!({}))]))[0]["readingOrder"].is_null());
    live.close(&created["session"]);
}

// ---- decks the Node tests had pptxgenjs write ---------------------------------------------------------------------------------

const NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main""#;
const RELS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

fn relationships(items: &[(&str, &str, &str)]) -> String {
    let rows: String = items.iter().map(|(id, kind, target)| format!(r#"<Relationship Id="{id}" Type="{RELS}/{kind}" Target="{target}"/>"#)).collect();
    format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rows}</Relationships>"#)
}

fn theme() -> String {
    let colors = ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
    let palette = ["000000", "FFFFFF", "1F2933", "F5F7FA", "2563EB", "2E7D4F", "8A5A00", "7C3AED", "DB2777", "0EA5E9", "2563EB", "7C3AED"];
    let scheme: String = colors.iter().zip(palette).map(|(name, value)| format!(r#"<a:{name}><a:srgbClr val="{value}"/></a:{name}>"#)).collect();
    let fill = r#"<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>"#;
    let line = r#"<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>"#;
    let effect = "<a:effectStyle><a:effectLst/></a:effectStyle>";
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Plain"><a:themeElements><a:clrScheme name="Plain">{scheme}</a:clrScheme><a:fontScheme name="Plain"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Plain"><a:fillStyleLst>{fill}{fill}{fill}</a:fillStyleLst><a:lnStyleLst>{line}{line}{line}</a:lnStyleLst><a:effectStyleLst>{effect}{effect}{effect}</a:effectStyleLst><a:bgFillStyleLst>{fill}{fill}{fill}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>"#
    )
}

/// A one-slide 16:9 deck (13.33 x 7.5 in, `LAYOUT_WIDE`) whose only master and layout hold no placeholder at all, the slide holding
/// `shapes`: what a pptxgenjs deck with `defineSlideMaster({ objects: [] })` is.
fn plain_deck(shapes: &str) -> Vec<u8> {
    let empty_tree = r#"<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>"#;
    let types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>"#;
    let mut package = Package::new();
    package.set("[Content_Types].xml", types);
    package.set("_rels/.rels", relationships(&[("rId1", "officeDocument", "ppt/presentation.xml")]));
    package.set(
        "ppt/presentation.xml",
        format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation {NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>"#),
    );
    package.set("ppt/_rels/presentation.xml.rels", relationships(&[("rId1", "slideMaster", "slideMasters/slideMaster1.xml"), ("rId2", "slide", "slides/slide1.xml"), ("rId3", "theme", "theme/theme1.xml")]));
    package.set(
        "ppt/slideMasters/slideMaster1.xml",
        format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster {NS}>{empty_tree}<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>"#),
    );
    package.set("ppt/slideMasters/_rels/slideMaster1.xml.rels", relationships(&[("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"), ("rId2", "theme", "../theme/theme1.xml")]));
    package.set(
        "ppt/slideLayouts/slideLayout1.xml",
        format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout {NS} preserve="1" userDrawn="1"><p:cSld name="PLAIN"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"#),
    );
    package.set("ppt/slideLayouts/_rels/slideLayout1.xml.rels", relationships(&[("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")]));
    package.set("ppt/theme/theme1.xml", theme());
    package.set(
        "ppt/slides/slide1.xml",
        format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld {NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>{shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"#),
    );
    package.set("ppt/slides/_rels/slide1.xml.rels", relationships(&[("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml")]));
    package.generate().expect("the deck packs")
}

/// One table cell: `text` in a run of bold or regular type and an ink colour.
fn cell(text: &str, bold: bool, color: &str) -> String {
    let weight = if bold { r#" b="1""# } else { "" };
    format!(r#"<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ko-KR" sz="1600"{weight}><a:solidFill><a:srgbClr val="{color}"/></a:solidFill></a:rPr><a:t>{text}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>"#)
}

/// The options table of the Node test, written where pptxgenjs wrote it: 8 x 2.4 in, two columns of 4 in, rows of 0.6 in.
fn options_deck() -> Vec<u8> {
    let rows = [
        (cell("안", true, "52606D"), cell("판정", true, "52606D")),
        (cell("주간 전용", true, "1F2933"), cell("보류", false, "8A5A00")),
        (cell("야간 전용", true, "1F2933"), cell("채택", false, "2E7D4F")),
    ];
    let body: String = rows.iter().map(|(left, right)| format!(r#"<a:tr h="548640">{left}{right}</a:tr>"#)).collect();
    let frame = format!(
        r#"<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="2" name="Table 1"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="548640" y="1097280"/><a:ext cx="7315200" cy="1645920"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="3657600"/><a:gridCol w="3657600"/></a:tblGrid>{body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>"#
    );
    plain_deck(&frame)
}

/// The footerless deck of the Node test: one text box, on a layout with no footer placeholder.
fn footerless_deck() -> Vec<u8> {
    let shape = r#"<p:sp><p:nvSpPr><p:cNvPr id="2" name="Text 1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="548640" y="548640"/><a:ext cx="5486400" cy="548640"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p><a:r><a:rPr lang="ko-KR" sz="2400"/><a:t>처리량</a:t></a:r></a:p></p:txBody></p:sp>"#;
    plain_deck(shape)
}

/// A deck written to `name` in the scratch folder, closed again as the Node tests' author call left it (nothing open).
fn write_deck(live: &Live, name: &str, bytes: &[u8]) -> String {
    let path = live.path(name);
    std::fs::write(&path, bytes).expect("the deck");
    path
}

// A table grown by set_table_data: PowerPoint's Rows.Add copied the last row's cells but not their runs, and the added row read in
// black regular type under bold names and toned verdicts, where the portable writer repeats the row.
#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn powerpoint_a_row_set_table_data_adds_takes_the_type_of_the_last_row_as_the_portable_writer_repeats_it() {
    let Some(live) = Live::start() else { return };
    let source = write_deck(&live, "options.pptx", &options_deck());
    let added_row = |mode: &str| -> Value {
        let output = live.path(&format!("{mode}.pptx"));
        let opened = live.call(json!({ "action": "open", "path": source, "mode": mode, "output": output }));
        live.call(json!({
            "action": "batch",
            "session": opened["session"],
            "operations": [{
                "op": "set_table_data",
                "slide": 1,
                "shape": 1,
                "values": [["안", "판정"], ["주간 전용", "보류"], ["야간 전용", "채택"], ["외주 위탁", "보류"]]
            }]
        }));
        let slide_xml = || -> String {
            live.call(json!({ "action": "save", "session": opened["session"] }));
            let package = live.package(&output);
            package.text("ppt/slides/slide1.xml")
        };
        let last_row = |slide: &str| -> Vec<Value> {
            let rows = all_matches(r"<a:tr\b[\s\S]*?</a:tr>", slide);
            all_matches(r"<a:tc\b[\s\S]*?</a:tc>", &rows[3])
                .iter()
                .map(|cell| {
                    let run = capture(r"<a:rPr\b[^>]*?(?:/>|>[\s\S]*?</a:rPr>)", "", cell, 0).unwrap_or_default();
                    // The cell's own fill, not one of its borders' (each border line carries a fill of its own).
                    let tc_pr = strip(r"<a:ln\w*\b[^>]*?(?:/>|>[\s\S]*?</a:ln\w*>)", &capture(r"<a:tcPr\b[^>]*/>|<a:tcPr\b[^>]*>[\s\S]*?</a:tcPr>", "", cell, 0).unwrap_or_default());
                    json!({
                        "bold": matches(r#"\bb="1""#, "", &run),
                        "color": capture(r#"<a:srgbClr val="([0-9A-F]{6})""#, "i", &run, 1).unwrap_or_default().to_uppercase(),
                        "fill": capture(r#"<a:solidFill>\s*<a:srgbClr val="([0-9A-F]{6})""#, "i", &tc_pr, 1).unwrap_or_default().to_uppercase()
                    })
                })
                .collect()
        };
        let added = last_row(&slide_xml());
        // The added row copied the adopted verdict's green; set_table_cell_style retones it as the hold it is.
        live.call(json!({
            "action": "batch",
            "session": opened["session"],
            "operations": [{ "op": "set_table_cell_style", "slide": 1, "shape": 1, "row": 4, "col": 2, "properties": { "fillColor": "F5ECD9", "color": "8A5A00", "bold": true } }]
        }));
        let retoned = last_row(&slide_xml());
        live.close(&opened["session"]);
        let weight = |entry: &Value| json!({ "bold": entry["bold"], "color": entry["color"] });
        json!({ "added": added.iter().map(weight).collect::<Vec<_>>(), "retoned": retoned[1] })
    };
    let office = added_row("background");
    assert_eq!(office["added"], json!([{ "bold": true, "color": "1F2933" }, { "bold": false, "color": "2E7D4F" }]));
    assert_eq!(office["retoned"], json!({ "bold": true, "color": "8A5A00", "fill": "F5ECD9" }));
    assert_eq!(added_row("portable"), office);
}

// A layout without a footer placeholder refused HeadersFooters ("Invalid request") and failed the batch, where the portable writer
// places the footer itself; both now set the same quiet line along the foot.
#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn powerpoint_set_footer_on_a_layout_without_a_footer_placeholder_lands_where_the_portable_writer_puts_it() {
    let Some(live) = Live::start() else { return };
    let source = write_deck(&live, "footerless.pptx", &footerless_deck());
    let footer = |mode: &str| -> Option<Vec<i64>> {
        let opened = live.call(json!({ "action": "open", "path": source, "mode": mode, "output": live.path(&format!("{mode}.pptx")) }));
        live.call(json!({ "action": "batch", "session": opened["session"], "operations": [{ "op": "set_footer", "slide": 1, "text": "운영팀 · 대외비" }] }));
        let snapshot = live.call(json!({ "action": "snapshot", "session": opened["session"], "pages": [1] }));
        live.close(&opened["session"]);
        let line = shape_with_text(&snapshot["document"]["slides"][0], "대외비");
        (!line.is_null()).then(|| ["left", "top", "width", "height"].iter().map(|key| number(&line[*key]).round() as i64).collect())
    };
    let powerpoint = footer("background");
    assert_eq!(powerpoint, Some(vec![58, 500, 720, 24]));
    assert_eq!(footer("portable"), powerpoint);
}

// set_shape with a colour of null takes the fill or the outline away on both backends; PowerPoint had skipped null and kept the
// outline where the portable writer drew none.
#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn powerpoint_set_shape_null_takes_the_fill_and_the_outline_away_as_the_portable_writer_does() {
    let Some(live) = Live::start() else { return };
    let cleared = |mode: &str| -> Value {
        let name = format!("clear-{mode}.pptx");
        let created = live.create(
            &name,
            "pptx",
            mode,
            json!([
                { "op": "add_slide" },
                {
                    "op": "add_shape",
                    "slide": 1,
                    "shapeType": "rectangle",
                    "text": "요약",
                    "left": 100,
                    "top": 100,
                    "width": 300,
                    "height": 100,
                    "properties": { "fillColor": "E8F0FE", "lineColor": "3367D6", "lineWidth": 2 }
                },
                { "op": "set_shape", "slide": 1, "shape": 1, "properties": { "fillColor": null, "lineColor": null } }
            ]),
        );
        live.call(json!({ "action": "save", "session": created["session"] }));
        live.close(&created["session"]);
        let package = live.package(&name);
        let slide = package.text("ppt/slides/slide1.xml");
        let first = capture(r"<p:sp>[\s\S]*?</p:sp>", "", &slide, 0).unwrap_or_default();
        let sp_pr = capture(r"<p:spPr\b[\s\S]*?</p:spPr>", "", &first, 0).unwrap_or_default();
        let line = if matches(r"<a:ln\b[\s\S]*?<a:noFill/>", "", &sp_pr) {
            "noFill"
        } else if matches(r"<a:ln\b", "", &sp_pr) {
            "line"
        } else {
            "inherited"
        };
        let fill = capture(r"<p:spPr[^>]*>(?:(?!<a:ln\b)[\s\S])*?<a:(noFill|solidFill)", "", &sp_pr, 1).unwrap_or_else(|| "inherited".to_owned());
        json!({ "fill": fill, "line": line })
    };
    let powerpoint = cleared("background");
    assert_eq!(powerpoint, json!({ "fill": "noFill", "line": "noFill" }));
    assert_eq!(cleared("portable"), powerpoint);
}

// A monthly refresh that adds a period: the accent marked the latest point, and PowerPoint kept it on the old last point by index,
// under a title about the new one. It follows the last point; the point it left takes the series colour.
#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn powerpoint_a_data_refresh_moves_a_last_point_accent_to_the_new_last_point() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "accent.pptx",
        "pptx",
        "background",
        json!([
            { "op": "add_slide", "layout": "Title Only" },
            {
                "op": "add_chart",
                "slide": 1,
                "chartType": "column",
                "categories": ["Jan", "Feb"],
                "series": [{ "name": "Visits", "values": [10, 20], "color": "D0CBC8", "pointColors": ["D0CBC8", "1C6FE3"] }]
            }
        ]),
    );
    live.call(json!({
        "action": "batch",
        "session": created["session"],
        "operations": [{ "op": "set_chart_data", "slide": 1, "shape": 2, "categories": ["Jan", "Feb", "Mar"], "series": [{ "name": "Visits", "values": [10, 20, 30] }] }]
    }));
    live.close(&created["session"]);
    let package = live.package("accent.pptx");
    let chart = package.text(&part_like(&package, "charts", "chart"));
    let fills: Vec<(i64, String)> = all_captures(r#"<c:dPt>[\s\S]*?<c:idx val="(\d+)"/>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})""#, &chart, 2)
        .into_iter()
        .map(|found| (found[1].parse().unwrap_or(-1), found[2].to_uppercase()))
        .collect();
    let fill_of = |index: i64| fills.iter().rev().find(|entry| entry.0 == index).map(|entry| entry.1.clone());
    assert_eq!(fill_of(2).as_deref(), Some("1C6FE3"), "the new last point carries the accent: {fills:?}");
    assert_ne!(fill_of(1).as_deref(), Some("1C6FE3"), "the point it left no longer does");
}

#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn powerpoint_a_data_refresh_that_names_no_categories_keeps_the_charts_own_as_the_portable_writer_does() {
    let Some(live) = Live::start() else { return };
    let read = |mode: &str| -> Value {
        let name = format!("refresh-{mode}.pptx");
        let created = live.create(
            &name,
            "pptx",
            mode,
            json!([
                { "op": "add_slide", "layout": "Blank" },
                { "op": "add_chart", "slide": 1, "chartType": "column", "categories": ["2024", "2025", "2026 전망"], "series": [{ "name": "수요", "values": [21, 27, 33] }] }
            ]),
        );
        live.call(json!({
            "action": "batch",
            "session": created["session"],
            "operations": [{ "op": "set_chart_data", "slide": 1, "shape": 1, "series": [{ "name": "수요", "values": [21, 28, 35] }] }]
        }));
        live.close(&created["session"]);
        let package = live.package(&name);
        let chart = package.text(&part_like(&package, "charts", "chart"));
        let cache = |tag: &str| -> Vec<String> {
            let block = capture(&format!(r"<c:{tag}>[\s\S]*?</c:{tag}>"), "", &chart, 0).unwrap_or_default();
            super::all_groups(r"<c:v>([^<]*)</c:v>", &block, 1)
        };
        let values: Vec<f64> = cache("val").iter().map(|text| text.parse().unwrap_or(f64::NAN)).collect();
        json!({ "categories": cache("cat"), "values": values })
    };
    // Refreshed without categories, PowerPoint's own had put Item 1, Item 2, Item 3 under the bars.
    let powerpoint = read("background");
    assert_eq!(powerpoint["categories"], json!(["2024", "2025", "2026 전망"]));
    let values: Vec<f64> = items(&powerpoint["values"]).iter().map(number).collect();
    assert_eq!(values, [21.0, 28.0, 35.0]);
    assert_eq!(powerpoint, read("portable"));
}

#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn powerpoint_default_layout_and_data_label_names_work_in_any_powerpoint_language() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "layouts.pptx",
        "pptx",
        "background",
        json!([
            { "op": "add_slide", "layout": "Title Only" },
            { "op": "add_slide", "layout": "title and content" },
            {
                "op": "add_chart",
                "slide": 1,
                "chartType": "column",
                "categories": ["A", "B"],
                "series": [{ "name": "S1", "values": [1, 2] }, { "name": "S2", "values": [3, 4] }]
            }
        ]),
    );
    let labelled = live.call(json!({
        "action": "batch",
        "session": created["session"],
        "operations": [{ "op": "set_chart_data_labels", "slide": 1, "shape": 2, "position": "outside_end" }]
    }));
    assert_eq!(labelled["results"][0]["series"], "all");
    live.close(&created["session"]);
    let package = live.package("layouts.pptx");
    let layout_type = |slide: usize| -> String {
        let rels = package.text(&format!("ppt/slides/_rels/slide{slide}.xml.rels"));
        let layout = capture(r"slideLayouts/(slideLayout\d+\.xml)", "", &rels, 1).expect("the slide's layout");
        capture(r#"<p:sldLayout\b[^>]*\btype="(\w+)""#, "", &package.text(&format!("ppt/slideLayouts/{layout}")), 1).expect("the layout's type")
    };
    assert_eq!([layout_type(1), layout_type(2)], ["titleOnly", "obj"]);
    let chart = package.text(&part_like(&package, "charts", "chart"));
    assert!(all_matches(r#"<c:dLblPos val="outEnd"/>"#, &chart).len() >= 2, "both series carry the named position");
}

#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn powerpoint_a_large_glyph_its_box_holds_is_not_an_overflow_words_past_the_box_still_are() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "glyph.pptx",
        "pptx",
        "background",
        json!([
            { "op": "add_slide", "layout": "blank" },
            // The kit's quotation mark: 120 pt in a box its ink fills, 30 pt short of PowerPoint's BoundWidth.
            { "op": "add_textbox", "slide": 1, "text": "\u{201c}", "left": 227, "top": 153, "width": 66, "height": 148, "fontSize": 120, "fontName": "Noto Serif KR" },
            { "op": "add_textbox", "slide": 1, "text": "넘치는 긴 문장이 좁은 상자를 벗어난다", "left": 400, "top": 60, "width": 80, "height": 24, "fontSize": 18 }
        ]),
    );
    let issues = live.call(json!({ "action": "issues", "session": created["session"] }));
    let overflowing: Vec<Value> = items(&issues["issues"]).iter().filter(|entry| entry["code"] == "text_overflow").map(|entry| entry["path"].clone()).collect();
    let shown = stringify(&Value::Array(overflowing.clone()));
    assert!(!overflowing.iter().any(|path| path == "/slide[1]/shape[1]"), "{shown}");
    assert!(overflowing.iter().any(|path| path == "/slide[1]/shape[2]"), "{shown}");
    live.close(&created["session"]);
}

#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn powerpoint_qa_repairs_a_box_past_the_slide_edge_after_fitting_another() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "qa.pptx",
        "pptx",
        "background",
        json!([
            { "op": "add_slide", "layout": "blank" },
            { "op": "add_textbox", "slide": 1, "text": "넘치는 문장 ".repeat(8), "left": 40, "top": 40, "width": 200, "height": 40, "fontSize": 24 },
            { "op": "add_textbox", "slide": 1, "text": "밖으로 나간 상자", "left": 900, "top": 480, "width": 200, "height": 60, "fontSize": 18 }
        ]),
    );
    // The second fit_text set a width computed as a Double after the first had set one as a Single; PowerShell's COM binder refused
    // it and qa returned an error in place of its repairs.
    let qa = live.call(json!({ "action": "qa", "session": created["session"], "autoFix": true, "render": false }));
    assert_eq!(items(&qa["fixes"]).len(), 2, "{}", stringify(&qa["fixes"]));
    assert!(!items(&qa["issuesAfter"]).iter().any(|entry| entry["code"] == "text_outside_slide"), "{}", stringify(&qa["issuesAfter"]));
    live.close(&created["session"]);
}

#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn powerpoint_trendline_codes_and_error_bar_sides_read_as_the_portable_writer_reads_them() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "kinds.pptx",
        "pptx",
        "background",
        json!([
            { "op": "add_slide", "layout": "blank" },
            {
                "op": "add_chart",
                "slide": 1,
                "chartType": "line",
                "categories": ["1월", "2월", "3월"],
                "series": [{ "name": "A", "values": [1, 3, 9] }, { "name": "B", "values": [2, 4, 8] }]
            },
            // 'exp' was drawn as a straight line on the first series alone.
            { "op": "set_chart_trendline", "slide": 1, "shape": 1, "type": "exp" },
            { "op": "set_chart_error_bars", "slide": 1, "shape": 1, "amount": 1, "endStyle": "plus" }
        ]),
    );
    let both = json!({ "op": "set_chart_error_bars", "slide": 1, "shape": 1, "amount": 1, "direction": "both" });
    let refused = live.raw(json!({ "action": "batch", "session": created["session"], "operations": [both] }));
    assert!(matches(r"direction must be x or y", "", &text_of(&refused)), "{}", text_of(&refused));
    live.close(&created["session"]);
    let package = live.package("kinds.pptx");
    let chart = package.text(&part_like(&package, "charts", "chart"));
    assert_eq!(all_matches(r#"<c:trendlineType val="exp"/>"#, &chart).len(), 2);
    assert_eq!(all_matches(r#"<c:errBarType val="plus"/>"#, &chart).len(), 2);
}

#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn powerpoint_a_named_face_a_transparency_and_paragraph_spacing_are_written_as_the_portable_file_writes_them() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "faces.pptx",
        "pptx",
        "background",
        json!([
            { "op": "add_slide", "layout": "blank" },
            // Font.Name alone set the Latin face; the Hangul stayed in the theme's East Asian font. A text box's fill, outline and
            // description were not read either.
            { "op": "add_textbox", "slide": 1, "text": "매출 증가", "fontName": "Batang", "properties": { "paragraphSpacing": 6, "fillColor": "F2F2F2", "lineColor": "1F3A5F", "altText": "요약" } },
            // The shadow set_shape draws was dropped by add_shape.
            { "op": "add_shape", "slide": 1, "shapeType": "rect", "text": "핵심", "fillColor": "EAF2F8", "properties": { "shadow": true } },
            // A fraction here: 30 was not the 30% add_shape and the portable writer read.
            { "op": "set_shape", "slide": 1, "shape": 2, "properties": { "fillTransparency": 30, "paragraphSpacing": 4, "fontName": "Batang" } }
        ]),
    );
    live.close(&created["session"]);
    let shapes = slide_shapes(&live, "faces.pptx");
    let (box_xml, card) = (&shapes[0], &shapes[1]);
    for shape in [box_xml, card] {
        assert!(matches(r#"<a:ea typeface="Batang""#, "", shape), "{shape}");
    }
    assert!(box_xml.contains(r#"<a:spcBef><a:spcPts val="600"/></a:spcBef>"#));
    assert!(box_xml.contains(r#"descr="요약""#));
    assert!(matches(r#"<p:spPr>[\s\S]*<a:solidFill><a:srgbClr val="F2F2F2"/>[\s\S]*<a:ln\b[^>]*><a:solidFill><a:srgbClr val="1F3A5F""#, "", box_xml));
    assert!(card.contains(r#"<a:spcBef><a:spcPts val="400"/></a:spcBef>"#));
    assert!(card.contains(r#"<a:srgbClr val="EAF2F8"><a:alpha val="70000"/>"#));
    assert!(card.contains(r#"<a:outerShdw blurRad="63500""#));
}

#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn powerpoint_a_footer_and_page_number_on_a_dark_slide_take_the_portable_writers_quiet_ink_and_place() {
    let Some(live) = Live::start() else { return };
    let created = live.create(
        "footer.pptx",
        "pptx",
        "background",
        json!([
            { "op": "add_slide", "layout": "blank" },
            { "op": "set_slide_background", "slide": 1, "color": "172C2C" },
            // The theme's 12 pt grey 767676 read 3.2:1 on this field.
            { "op": "set_footer", "slide": 1, "text": "모아페이 · 2025 IR" },
            { "op": "set_slide_number", "slide": 1, "visible": true }
        ]),
    );
    live.close(&created["session"]);
    let shapes = slide_shapes(&live, "footer.pptx");
    let footer = shapes.iter().find(|shape| matches(r#"<p:ph\b[^>]*type="ftr""#, "", shape)).expect("a footer").clone();
    let number = shapes.iter().find(|shape| matches(r#"<p:ph\b[^>]*type="sldNum""#, "", shape)).expect("a slide number").clone();
    for shape in [&footer, &number] {
        assert!(matches(r#"\bsz="1000""#, "", shape));
        assert!(shape.contains(r#"<a:srgbClr val="A9B1B9"/>"#));
    }
    assert!(footer.contains(r#"<a:off x="736600""#), "the footer starts 58 pt from the left edge");
    assert!(number.contains(r#"<a:off x="10185400""#), "the number box ends 58 pt from the right edge");
}

#[test]
#[ignore = "starts Microsoft PowerPoint; MIXDOG_TEST_LIVE_OFFICE=1"]
fn powerpoint_a_cover_picture_is_cropped_about_its_focus_centred_by_default() {
    let Some(live) = Live::start() else { return };
    let wide = live.path("wide.png");
    std::fs::write(&wide, Image::create(200, 100, 3, [0x25, 0x63, 0xEB, 0xFF]).expect("an image").to_png().expect("a PNG")).expect("the picture");
    let created = live.create(
        "cover.pptx",
        "pptx",
        "background",
        json!([
            { "op": "add_slide", "layout": "blank" },
            // The focus was rounded to 0 or 1, so the crop took the whole excess from the right.
            { "op": "add_image", "slide": 1, "path": wide, "left": 40, "top": 40, "width": 200, "height": 200, "fit": "cover" },
            { "op": "add_image", "slide": 1, "path": wide, "left": 300, "top": 40, "width": 200, "height": 200, "fit": "cover", "focusX": 0.3 }
        ]),
    );
    live.close(&created["session"]);
    let package = live.package("cover.pptx");
    let crops = all_matches(r"<a:srcRect\b[^>]*/>", &package.text(&part_like(&package, "slides", "slide")));
    assert!(matches(r#"\bl="25000""#, "", &crops[0]), "{}", crops[0]);
    assert!(matches(r#"\br="25000""#, "", &crops[0]), "{}", crops[0]);
    // Half the picture shows; its centre sits at 0.3 of the width: 5% off the left, 45% off the right.
    assert!(matches(r#"\bl="5000""#, "", &crops[1]), "{}", crops[1]);
    assert!(matches(r#"\br="45000""#, "", &crops[1]), "{}", crops[1]);
}
