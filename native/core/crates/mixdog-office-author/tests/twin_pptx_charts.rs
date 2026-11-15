//! Twin test `pptx_charts`: the recording of pptxgenjs 4.0.1 and of `authoring/pptx-script-normalize.mjs`
//! (`native/core/fixtures/office-author-pptx-charts/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-author-pptx-charts.mjs`) against this crate's chart writer and
//! normaliser.
//!
//! The chart calls of every recorded case are replayed against `pptx_writer::Chart`: the chart part, its relationships,
//! every part of the embedded workbook and the graphic frame of the slide must equal the recorded ones after
//! canonicalisation (attribute order, white space between tags; the two timestamps of the workbook's core properties
//! are the moment of writing and the identifiers pptxgenjs draws at random are masked). A case whose deck pptxgenjs
//! failed to write must be refused with its text. The decks pptxgenjs wrote are run through `normalize_package`, and
//! the package that comes out must have the recorded entries in the recorded order, every part equal to the recorded
//! one exactly (an embedded workbook part by part) and the recorded counts.
//! Re-recording is `twin_live_pptx_charts` (ignored: it runs Node).

use base64::Engine;
use mixdog_office_author::normalize::normalize_package;
use mixdog_office_author::pptx_writer::{
    AxisCrossing, AxisStyle, Chart, ChartArea, ChartBorder, ChartData, ChartKind, ChartLayout, ChartOptions, ChartShadow, Dim, Fill, GridLine, Layout, PlotArea, TitlePos,
};
use mixdog_office_base::twin;
use mixdog_ooxml::zipio::Package;
use serde_json::Value;

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn flag_option(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

/// A position or size as JavaScript passes it: a number, or a percentage string.
fn dim(value: &Value, key: &str) -> Option<Dim> {
    match value.get(key)? {
        Value::Number(number) => number.as_f64().map(Dim::Number),
        Value::String(text) if text.contains('%') => text.trim_end_matches('%').parse().ok().map(Dim::Percent),
        Value::String(text) => Some(Dim::Number(text.parse().unwrap_or(f64::NAN))),
        _ => None,
    }
}

fn strings(value: &Value, key: &str) -> Option<Vec<String>> {
    value.get(key).and_then(Value::as_array).map(|list| list.iter().map(|item| item.as_str().unwrap_or("").to_owned()).collect())
}

fn border(value: &Value) -> Option<ChartBorder> {
    value.as_object().map(|_| ChartBorder { pt: number(value, "pt"), color: text(value, "color") })
}

fn fill(value: &Value) -> Option<Fill> {
    value.as_object().map(|_| Fill { kind: text(value, "type"), color: text(value, "color"), alpha: number(value, "alpha"), transparency: number(value, "transparency") })
}

fn grid_line(value: &Value) -> Option<GridLine> {
    value.as_object().map(|_| GridLine { size: number(value, "size"), color: text(value, "color"), style: text(value, "style"), cap: text(value, "cap") })
}

fn shadow(value: &Value) -> Option<ChartShadow> {
    value.as_object().map(|_| ChartShadow {
        kind: text(value, "type"),
        color: text(value, "color"),
        blur: number(value, "blur"),
        offset: number(value, "offset"),
        angle: number(value, "angle"),
        opacity: number(value, "opacity"),
        rotate_with_shape: flag_option(value, "rotateWithShape"),
    })
}

fn crossing(value: &Value, key: &str) -> Option<AxisCrossing> {
    match value.get(key)? {
        Value::Number(number) => number.as_f64().map(AxisCrossing::At),
        Value::String(mode) => Some(AxisCrossing::Mode(mode.clone())),
        _ => None,
    }
}

/// The options of one axis: `prefix` is `catAxis` or `valAxis`, `title_flag` the option that shows its title.
fn axis(options: &Value, prefix: &str, title_flag: &str) -> AxisStyle {
    let key = |suffix: &str| format!("{prefix}{suffix}");
    AxisStyle {
        hidden: flag(options, &key("Hidden")),
        orientation: text(options, &key("Orientation")),
        max_val: number(options, &key("MaxVal")),
        min_val: number(options, &key("MinVal")),
        show_title: flag(options, title_flag),
        title: text(options, &key("Title")),
        title_color: text(options, &key("TitleColor")),
        title_font_face: text(options, &key("TitleFontFace")),
        title_font_size: number(options, &key("TitleFontSize")),
        title_rotate: number(options, &key("TitleRotate")),
        major_tick_mark: text(options, &key("MajorTickMark")),
        minor_tick_mark: text(options, &key("MinorTickMark")),
        label_pos: text(options, &key("LabelPos")),
        line_show: flag_option(options, &key("LineShow")),
        line_size: number(options, &key("LineSize")),
        line_color: text(options, &key("LineColor")),
        line_style: text(options, &key("LineStyle")),
        label_rotate: number(options, &key("LabelRotate")),
        label_font_size: number(options, &key("LabelFontSize")),
        label_bold: flag(options, &key("LabelFontBold")),
        label_italic: flag(options, &key("LabelFontItalic")),
        label_color: text(options, &key("LabelColor")),
        label_font_face: text(options, &key("LabelFontFace")),
    }
}

fn chart_options(options: &Value) -> ChartOptions {
    let empty = Value::Null;
    let plot_area = options.get("plotArea").unwrap_or(&empty);
    let chart_area = options.get("chartArea").unwrap_or(&empty);
    ChartOptions {
        x: dim(options, "x"),
        y: dim(options, "y"),
        w: dim(options, "w"),
        h: dim(options, "h"),
        object_name: text(options, "objectName"),
        alt_text: text(options, "altText"),
        lang: text(options, "lang"),
        bar_dir: text(options, "barDir"),
        bar_grouping: text(options, "barGrouping"),
        bar_gap_width_pct: number(options, "barGapWidthPct"),
        bar_overlap_pct: number(options, "barOverlapPct"),
        show_title: flag(options, "showTitle"),
        title: text(options, "title"),
        title_color: text(options, "titleColor"),
        title_font_face: text(options, "titleFontFace"),
        title_font_size: number(options, "titleFontSize"),
        title_align: text(options, "titleAlign"),
        title_bold: flag(options, "titleBold"),
        title_pos: options.get("titlePos").map(|pos| TitlePos { x: number(pos, "x").unwrap_or(f64::NAN), y: number(pos, "y").unwrap_or(f64::NAN) }),
        title_rotate: number(options, "titleRotate"),
        show_legend: flag(options, "showLegend"),
        legend_pos: text(options, "legendPos"),
        legend_font_face: text(options, "legendFontFace"),
        legend_font_size: number(options, "legendFontSize"),
        legend_color: text(options, "legendColor"),
        show_value: flag(options, "showValue"),
        show_label: flag(options, "showLabel"),
        show_percent: flag(options, "showPercent"),
        show_ser_name: flag(options, "showSerName"),
        show_leader_lines: flag(options, "showLeaderLines"),
        data_label_position: text(options, "dataLabelPosition"),
        data_label_bkgrd_colors: flag(options, "dataLabelBkgrdColors"),
        data_label_format_code: text(options, "dataLabelFormatCode"),
        data_label_format_scatter: text(options, "dataLabelFormatScatter"),
        data_label_color: text(options, "dataLabelColor"),
        data_label_font_face: text(options, "dataLabelFontFace"),
        data_label_font_size: number(options, "dataLabelFontSize"),
        data_label_font_bold: flag(options, "dataLabelFontBold"),
        data_label_font_italic: flag(options, "dataLabelFontItalic"),
        line_size: number(options, "lineSize"),
        line_cap: text(options, "lineCap"),
        line_dash: text(options, "lineDash"),
        line_smooth: flag(options, "lineSmooth"),
        line_data_symbol: text(options, "lineDataSymbol"),
        line_data_symbol_size: number(options, "lineDataSymbolSize"),
        line_data_symbol_line_size: number(options, "lineDataSymbolLineSize"),
        line_data_symbol_line_color: text(options, "lineDataSymbolLineColor"),
        radar_style: text(options, "radarStyle"),
        display_blanks_as: text(options, "displayBlanksAs"),
        chart_colors: strings(options, "chartColors"),
        chart_colors_opacity: number(options, "chartColorsOpacity"),
        inverted_colors: strings(options, "invertedColors"),
        shadow: options.get("shadow").and_then(shadow),
        border: options.get("border").and_then(border),
        fill: text(options, "fill"),
        plot_area: PlotArea { border: plot_area.get("border").and_then(border), fill: plot_area.get("fill").and_then(fill) },
        chart_area: ChartArea { border: chart_area.get("border").and_then(border), fill: chart_area.get("fill").and_then(fill), rounded_corners: flag_option(chart_area, "roundedCorners") },
        data_border: options.get("dataBorder").and_then(border),
        data_no_effects: flag(options, "dataNoEffects"),
        layout: options.get("layout").map(|layout| ChartLayout { x: number(layout, "x"), y: number(layout, "y"), w: number(layout, "w"), h: number(layout, "h") }),
        show_data_table: flag(options, "showDataTable"),
        show_data_table_horz_border: flag(options, "showDataTableHorzBorder"),
        show_data_table_vert_border: flag(options, "showDataTableVertBorder"),
        show_data_table_outline: flag(options, "showDataTableOutline"),
        show_data_table_keys: flag(options, "showDataTableKeys"),
        data_table_font_size: number(options, "dataTableFontSize"),
        data_table_format_code: text(options, "dataTableFormatCode"),
        first_slice_ang: number(options, "firstSliceAng"),
        hole_size: number(options, "holeSize"),
        cat_axis: axis(options, "catAxis", "showCatAxisTitle"),
        val_axis: axis(options, "valAxis", "showValAxisTitle"),
        cat_grid_line: options.get("catGridLine").and_then(grid_line),
        val_grid_line: options.get("valGridLine").and_then(grid_line),
        cat_label_format_code: text(options, "catLabelFormatCode"),
        cat_axis_label_frequency: number(options, "catAxisLabelFrequency"),
        cat_axis_base_time_unit: text(options, "catAxisBaseTimeUnit"),
        cat_axis_major_time_unit: text(options, "catAxisMajorTimeUnit"),
        cat_axis_minor_time_unit: text(options, "catAxisMinorTimeUnit"),
        cat_axis_major_unit: number(options, "catAxisMajorUnit"),
        cat_axis_minor_unit: number(options, "catAxisMinorUnit"),
        cat_axis_multi_level_labels: flag(options, "catAxisMultiLevelLabels"),
        cat_axis_crosses_at: crossing(options, "catAxisCrossesAt"),
        val_axis_crosses_at: crossing(options, "valAxisCrossesAt"),
        val_axis_log_scale_base: number(options, "valAxisLogScaleBase"),
        val_axis_major_unit: number(options, "valAxisMajorUnit"),
        val_axis_label_format_code: text(options, "valAxisLabelFormatCode"),
        val_axis_display_unit: text(options, "valAxisDisplayUnit"),
        val_axis_display_unit_label: flag(options, "valAxisDisplayUnitLabel"),
        val_label_format_code: text(options, "valLabelFormatCode"),
    }
}

fn kind(name: &str) -> ChartKind {
    match name {
        "area" => ChartKind::Area,
        "bar" => ChartKind::Bar,
        "doughnut" => ChartKind::Doughnut,
        "line" => ChartKind::Line,
        "pie" => ChartKind::Pie,
        "radar" => ChartKind::Radar,
        "scatter" => ChartKind::Scatter,
        other => panic!("the replay does not know the chart type {other}"),
    }
}

fn chart_data(series: &Value) -> ChartData {
    let labels = match series.get("labels").and_then(Value::as_array) {
        // pptxgenjs wraps a flat list of labels in one group.
        Some(list) if list.first().is_some_and(Value::is_string) => vec![list.iter().map(|label| label.as_str().unwrap_or("").to_owned()).collect()],
        Some(groups) => groups.iter().map(|group| group.as_array().map_or_else(Vec::new, |group| group.iter().map(|label| label.as_str().unwrap_or("").to_owned()).collect())).collect(),
        None => Vec::new(),
    };
    ChartData {
        name: text(series, "name").unwrap_or_default(),
        labels,
        values: series.get("values").and_then(Value::as_array).map_or_else(Vec::new, |values| values.iter().map(Value::as_f64).collect()),
    }
}

/// What a replayed case holds: the charts in the order they were added, with the slide each is on and its place among
/// the slide's objects.
struct Replayed {
    charts: Vec<(usize, usize, Chart)>,
}

fn replay(calls: &[Value]) -> Result<Replayed, String> {
    let mut on_slide: Vec<usize> = Vec::new();
    let mut charts = Vec::new();
    for call in calls {
        match call["op"].as_str().expect("op") {
            "addSlide" => on_slide.push(0),
            "addChart" => {
                let slide = usize::try_from(call["slide"].as_u64().expect("slide")).expect("slide index");
                let data: Vec<ChartData> = call["data"].as_array().expect("data").iter().map(chart_data).collect();
                let before = on_slide[slide];
                let chart = Chart::new(kind(call["type"].as_str().expect("type")), data, chart_options(&call["options"]), charts.len() + 1, before + 1, before)?;
                on_slide[slide] += 1;
                charts.push((slide, before, chart));
            }
            other => panic!("the replay does not know the call {other}"),
        }
    }
    Ok(Replayed { charts })
}

/// The XML with the attributes of each tag in name order and the white space between tags gone.
fn canonical(xml: &str) -> String {
    let mut out = String::with_capacity(xml.len());
    let mut rest = xml;
    while let Some(open) = rest.find('<') {
        let between = &rest[..open];
        if !between.trim().is_empty() {
            out.push_str(between);
        }
        let tail = &rest[open..];
        let mut quote = None;
        let mut end = tail.len() - 1;
        for (at, ch) in tail.char_indices() {
            match (quote, ch) {
                (None, '"' | '\'') => quote = Some(ch),
                (Some(open_quote), found) if found == open_quote => quote = None,
                (None, '>') => {
                    end = at;
                    break;
                }
                _ => {}
            }
        }
        out.push_str(&canonical_tag(&tail[..=end]));
        rest = &tail[end + 1..];
    }
    if !rest.trim().is_empty() {
        out.push_str(rest);
    }
    out
}

fn canonical_tag(tag: &str) -> String {
    let inner = tag.trim_start_matches('<').trim_end_matches('>');
    let (inner, closing) = match inner.strip_suffix('/') {
        Some(inner) => (inner, "/"),
        None => match inner.strip_suffix('?') {
            Some(inner) => (inner, "?"),
            None => (inner, ""),
        },
    };
    let name_end = inner.find(|ch: char| ch.is_whitespace()).unwrap_or(inner.len());
    let (name, mut attributes_text) = inner.split_at(name_end);
    if name.starts_with('/') || name.starts_with('!') {
        return format!("<{}>", inner.trim());
    }
    let mut attributes = Vec::new();
    loop {
        attributes_text = attributes_text.trim_start();
        let Some(eq) = attributes_text.find('=') else { break };
        let key = attributes_text[..eq].trim();
        let after = attributes_text[eq + 1..].trim_start();
        let Some(quote) = after.chars().next() else { break };
        let Some(close) = after[1..].find(quote) else { break };
        attributes.push((key.to_owned(), after[1..=close].to_owned()));
        attributes_text = &after[close + 2..];
    }
    attributes.sort();
    let attributes: String = attributes.iter().map(|(key, value)| format!(" {key}=\"{value}\"")).collect();
    format!("<{name}{attributes}{closing}>")
}

/// Replaces what sits between `open` and `close` wherever `open` occurs.
fn masked_between(text: &str, open: &str, close: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find(open) {
        let from = at + open.len();
        let Some(len) = rest[from..].find(close) else { break };
        out.push_str(&rest[..from]);
        out.push_str("masked");
        rest = &rest[from + len..];
    }
    out.push_str(rest);
    out
}

/// A part with what pptxgenjs draws at random (the identifiers of a scatter chart's custom labels) and the moment of
/// writing (the workbook's core properties) masked.
fn masked(text: &str) -> String {
    let text = masked_between(text, "<c16:uniqueId val=\"{", "}\"");
    let text = masked_between(&text, "<a:fld id=\"{", "}\"");
    let text = masked_between(&text, "<dcterms:created xsi:type=\"dcterms:W3CDTF\">", "</dcterms:created>");
    masked_between(&text, "<dcterms:modified xsi:type=\"dcterms:W3CDTF\">", "</dcterms:modified>")
}

fn cut(text: &str, around: usize) -> String {
    let start = text.char_indices().map(|(at, _)| at).rfind(|at| *at <= around.saturating_sub(60)).unwrap_or(0);
    text[start..].chars().take(220).collect()
}

fn compare_xml(case: &str, part: &str, expected: &str, actual: &str, failures: &mut Vec<String>) {
    let (want, got) = (canonical(&masked(expected)), canonical(&masked(actual)));
    if want != got {
        let at = want.chars().zip(got.chars()).take_while(|(left, right)| left == right).count();
        failures.push(format!("{case}: {part} differs at {at}\n  recorded ...{}\n  produced ...{}", cut(&want, at), cut(&got, at)));
    }
}

fn blob<'a>(golden: &'a Value, id: &Value) -> &'a Value {
    &golden["blobs"][id.as_str().expect("blob id")]
}

fn blob_text<'a>(golden: &'a Value, id: &Value) -> &'a str {
    blob(golden, id)["text"].as_str().expect("a text blob")
}

fn layout() -> Layout {
    Layout { name: "screen16x9".to_owned(), width: 9_144_000.0, height: 5_143_500.0 }
}

fn every_chart_equals_the_recording() {
    let golden = twin::load_golden("office-author-pptx-charts");
    let cases = golden["charts"].as_array().expect("charts");
    assert!(cases.len() > 40, "the recording has {} chart cases", cases.len());
    let mut failures = Vec::new();
    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let replayed = replay(case["calls"].as_array().expect("calls")).unwrap_or_else(|error| panic!("{name}: the writer refused a chart: {error}"));
        if let Some(thrown) = case.get("thrown").and_then(Value::as_str) {
            let outcome = replayed.charts.iter().map(|(_, _, chart)| chart.parts()).find_map(Result::err);
            assert_eq!(outcome.as_deref(), Some(thrown), "{name}: the text of a deck pptxgenjs failed to write");
            continue;
        }
        let recorded = case["charts"].as_array().expect("recorded charts");
        if recorded.len() != replayed.charts.len() {
            failures.push(format!("{name}: {} charts recorded, {} replayed", recorded.len(), replayed.charts.len()));
            continue;
        }
        for (record, (_, _, chart)) in recorded.iter().zip(&replayed.charts) {
            let number = record["number"].as_u64().expect("number");
            let parts = chart.parts().unwrap_or_else(|error| panic!("{name}: {error}"));
            let part = |wanted: &str| parts.iter().find(|(part_name, _)| part_name == wanted).map(|(_, bytes)| bytes.clone()).unwrap_or_else(|| panic!("{name}: no part {wanted}"));
            let chart_part = format!("ppt/charts/chart{number}.xml");
            compare_xml(name, &chart_part, blob_text(&golden, &record["chart"]), &String::from_utf8_lossy(&part(&chart_part)), &mut failures);
            let rels_part = format!("ppt/charts/_rels/chart{number}.xml.rels");
            compare_xml(name, &rels_part, blob_text(&golden, &record["rels"]), &String::from_utf8_lossy(&part(&rels_part)), &mut failures);
            let workbook = Package::load(&part(&format!("ppt/embeddings/Microsoft_Excel_Worksheet{number}.xlsx"))).unwrap_or_else(|error| panic!("{name}: the workbook is no package: {error}"));
            let recorded_parts = record["workbook"].as_array().expect("workbook parts");
            let recorded_names: Vec<&str> = recorded_parts.iter().map(|part| part["name"].as_str().expect("part name")).collect();
            let produced_names = workbook.names();
            if recorded_names != produced_names.iter().map(String::as_str).collect::<Vec<_>>() {
                failures.push(format!("{name}: workbook entries\n  recorded {recorded_names:?}\n  produced {produced_names:?}"));
                continue;
            }
            for workbook_part in recorded_parts.iter().filter(|part| !part["dir"].as_bool().unwrap_or(false)) {
                let part_name = workbook_part["name"].as_str().expect("part name");
                compare_xml(name, &format!("chart{number} workbook {part_name}"), blob_text(&golden, &workbook_part["blob"]), &workbook.text(part_name), &mut failures);
            }
        }
        let frames = case["frames"].as_array().expect("frames");
        let mut produced: Vec<(usize, String)> = replayed.charts.iter().map(|(slide, index, chart)| (*slide, chart.frame_xml(*index, &layout()))).collect();
        produced.sort_by_key(|(slide, _)| *slide);
        if frames.len() != produced.len() {
            failures.push(format!("{name}: {} frames recorded, {} produced", frames.len(), produced.len()));
            continue;
        }
        for (frame, (slide, xml)) in frames.iter().zip(&produced) {
            assert_eq!(frame["slide"].as_u64(), Some(*slide as u64), "{name}: the slide of a frame");
            compare_xml(name, "graphic frame", blob_text(&golden, &frame["blob"]), xml, &mut failures);
        }
    }
    assert!(failures.is_empty(), "{} differences\n{}", failures.len(), failures.iter().take(4).cloned().collect::<Vec<_>>().join("\n"));
}

/// A package from the parts of a recording, in its order.
fn package_of(golden: &Value, parts: &[Value]) -> Package {
    let mut package = Package::new();
    for part in parts {
        let name = part["name"].as_str().expect("part name");
        if part["dir"].as_bool().unwrap_or(false) {
            package.folder(name);
            continue;
        }
        let body = blob(golden, &part["blob"]);
        match body["text"].as_str() {
            Some(text) => package.set(name, text),
            None => package.set(name, base64::engine::general_purpose::STANDARD.decode(body["base64"].as_str().expect("base64")).expect("base64 bytes")),
        }
    }
    package
}

fn compare_part(case: &str, golden: &Value, part: &Value, package: &Package, failures: &mut Vec<String>) {
    let name = part["name"].as_str().expect("part name");
    if part["dir"].as_bool().unwrap_or(false) {
        if !package.entry(name).is_some_and(|entry| entry.dir) {
            failures.push(format!("{case}: {name} is a folder"));
        }
        return;
    }
    let Some(bytes) = package.file(name) else {
        failures.push(format!("{case}: {name} has no content"));
        return;
    };
    let body = blob(golden, &part["blob"]);
    match body["text"].as_str() {
        Some(expected) => {
            let got = String::from_utf8_lossy(bytes);
            if expected != got {
                let at = expected.chars().zip(got.chars()).take_while(|(left, right)| left == right).count();
                failures.push(format!("{case}: {name} differs at {at}\n  recorded ...{}\n  produced ...{}", cut(expected, at), cut(&got, at)));
            }
        }
        None if name.ends_with(".xlsx") => {
            let recorded = Package::load(&base64::engine::general_purpose::STANDARD.decode(body["base64"].as_str().expect("base64")).expect("base64 bytes")).expect("a recorded workbook");
            let produced = Package::load(bytes).expect("a produced workbook");
            if recorded.names() != produced.names() {
                failures.push(format!("{case}: {name} entries differ"));
                return;
            }
            for entry in recorded.entries().into_iter().filter(|entry| !entry.dir) {
                if recorded.text(&entry.name) != produced.text(&entry.name) {
                    failures.push(format!("{case}: {name} part {} differs", entry.name));
                }
            }
        }
        None => {
            let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
            if body["base64"].as_str() != Some(encoded.as_str()) {
                failures.push(format!("{case}: {name} bytes differ"));
            }
        }
    }
}

fn every_normalised_deck_equals_the_recording() {
    let golden = twin::load_golden("office-author-pptx-charts");
    let decks = golden["normalize"].as_array().expect("normalize");
    assert!(decks.len() > 40, "the recording has {} decks", decks.len());
    let mut failures = Vec::new();
    for deck in decks {
        let name = deck["name"].as_str().expect("deck name");
        let mut package = package_of(&golden, deck["input"].as_array().expect("input"));
        let result = normalize_package(&mut package).unwrap_or_else(|error| panic!("{name}: {error}"));
        let recorded = &deck["result"];
        let count = |key: &str| usize::try_from(recorded[key].as_u64().expect("count")).expect("count fits");
        let wanted = (count("removed"), count("changedParts"), count("mergedCharts"), count("gradients"), count("vectorIcons"));
        let got = (result.removed, result.changed_parts, result.merged_charts, result.gradients, result.vector_icons);
        if wanted != got {
            failures.push(format!("{name}: counts (removed, changed parts, merged charts, gradients, icons)\n  recorded {wanted:?}\n  produced {got:?}"));
        }
        let output = deck["output"].as_array().expect("output");
        let recorded_names: Vec<&str> = output.iter().map(|part| part["name"].as_str().expect("part name")).collect();
        let produced_names = package.names();
        if recorded_names != produced_names.iter().map(String::as_str).collect::<Vec<_>>() {
            failures.push(format!("{name}: entries\n  recorded {recorded_names:?}\n  produced {produced_names:?}"));
            continue;
        }
        for part in output {
            compare_part(name, &golden, part, &package, &mut failures);
        }
    }
    assert!(failures.is_empty(), "{} differences\n{}", failures.len(), failures.iter().take(4).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn every_chart_equals_the_recorded_one() {
    every_chart_equals_the_recording();
}

#[test]
fn every_normalised_deck_equals_the_recorded_one() {
    every_normalised_deck_equals_the_recording();
}

#[test]
fn the_canonical_form_sorts_attributes_and_drops_the_white_space_between_tags() {
    assert_eq!(canonical("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\r\n<a:x b=\"2\"  a=\"1\">\n\t<a:y z='3'/> text </a:x>"), "<?xml encoding=\"UTF-8\" version=\"1.0\"?><a:x a=\"1\" b=\"2\"><a:y z=\"3\"/> text </a:x>");
}

#[test]
fn what_pptxgenjs_draws_at_random_is_masked() {
    let uuid = "<c16:uniqueId val=\"{00000001-ABCD-4000-8000-000000000001}\"/><a:fld id=\"{12345678-1234-4234-8234-123456789012}\" type=\"XVALUE\">";
    assert_eq!(masked(uuid), "<c16:uniqueId val=\"{masked}\"/><a:fld id=\"{masked}\" type=\"XVALUE\">");
}

/// Records again with Node and compares: `cargo test -p mixdog-office-author --test twin_pptx_charts -- --ignored`.
#[test]
#[ignore = "re-records through Node (pptxgenjs and the product's normaliser)"]
fn twin_live_pptx_charts() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-author-pptx-charts.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_chart_equals_the_recording();
    every_normalised_deck_equals_the_recording();
}
