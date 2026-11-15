//! `portable/portable-chart-faults.mjs`: chart XML PowerPoint refuses although the schema accepts it. Script generators
//! (pptxgenjs and friends) emit both faults silently; LibreOffice and python-pptx open the result, so only a package scan
//! at finalize catches them. Each finding is the issue object the tools report: `severity`, `code`, `path`, `message`,
//! `source`.

use std::collections::HashSet;

use serde_json::{Value, json};

use crate::opc::{RelationshipMap, part_relationship_path, posix, relationship_map};
use crate::xml::compiled;
use crate::zipio::Package;

const STACKED: [&str; 2] = ["stacked", "percentStacked"];
const LEGAL_ON_STACKED: [&str; 3] = ["ctr", "inEnd", "inBase"];

/// How many axis ids a plot group must resolve against the axes its own part declares.
const AXIS_MINIMUM: [(&str, usize); 12] = [
    ("barChart", 2),
    ("lineChart", 2),
    ("areaChart", 2),
    ("scatterChart", 2),
    ("bubbleChart", 2),
    ("radarChart", 2),
    ("stockChart", 2),
    ("bar3DChart", 2),
    ("area3DChart", 2),
    ("surfaceChart", 2),
    ("line3DChart", 3),
    ("surface3DChart", 3),
];

fn strip_ext_lst(xml: &str) -> String {
    let without_empty = compiled(r"<c:extLst\b[^>]*\/>", "g").replace_all_with(xml, |_| String::new());
    compiled(r"<c:extLst\b[^>]*>[\s\S]*?<\/c:extLst>", "g").replace_all_with(&without_empty, |_| String::new())
}

/// Each plot group (`<c:barChart>` and kin) with its text up to its closing tag; a group never closed is left out.
fn plot_groups(xml: &str) -> Vec<(String, &str)> {
    let mut groups = Vec::new();
    for found in compiled(r"<c:(\w+Chart)\b[^>]*(?<!\/)>", "g").captures_iter(xml) {
        let name = found.get(1).unwrap_or("");
        let start = found.range().start;
        let Some(close) = xml[start..].find(&format!("</c:{name}>")) else { continue };
        groups.push((name.to_owned(), &xml[start..start + close]));
    }
    groups
}

fn declared_axis_ids(xml: &str) -> HashSet<String> {
    compiled(r#"<c:(?:catAx|valAx|serAx|dateAx)\b[^>]*>\s*<c:axId\b[^>]*\bval="(-?\d+)""#, "g")
        .captures_iter(xml)
        .map(|found| found.get(1).unwrap_or("").to_owned())
        .collect()
}

fn issue(severity: &str, code: &str, part: &str, message: String) -> Value {
    json!({ "severity": severity, "code": code, "path": format!("/{part}"), "message": message, "source": "chart-scan" })
}

fn stacked_label_faults(part: &str, block: &str, name: &str) -> Vec<Value> {
    let grouping = compiled(r#"<c:grouping\b[^>]*\bval="(\w+)""#, "").captures(block).and_then(|found| found.get(1).map(str::to_owned));
    let Some(grouping) = grouping.filter(|value| STACKED.contains(&value.as_str())) else { return Vec::new() };
    let outside = compiled(r#"<c:dLblPos\b[^>]*\bval="(\w+)""#, "g")
        .captures_iter(block)
        .filter(|found| found.get(1) == Some("outEnd"))
        .count();
    if outside == 0 {
        return Vec::new();
    }
    vec![issue(
        "error",
        "chart_stacked_label_position",
        part,
        format!(
            "{outside} data label(s) use dLblPos=\"outEnd\" on a {grouping} {name}; PowerPoint allows only {} there and refuses the file. Use dataLabelPosition 'ctr', 'inEnd', or 'inBase' in the script.",
            LEGAL_ON_STACKED.join(", ")
        ),
    )]
}

fn axis_reference_faults(part: &str, block: &str, name: &str, declared: &HashSet<String>) -> Vec<Value> {
    let Some(&(_, minimum)) = AXIS_MINIMUM.iter().find(|(known, _)| *known == name) else { return Vec::new() };
    let ids: Vec<String> =
        compiled(r#"<c:axId\b[^>]*\bval="(-?\d+)""#, "g").captures_iter(block).map(|found| found.get(1).unwrap_or("").to_owned()).collect();
    let live = ids.iter().filter(|id| declared.contains(*id)).count();
    if live >= 2 {
        return Vec::new();
    }
    let dead: Vec<&str> = ids.iter().filter(|id| !declared.contains(*id)).map(String::as_str).collect();
    let detail = if ids.is_empty() {
        format!("declares no <c:axId>; a plot group needs {minimum}")
    } else if !dead.is_empty() {
        format!("references axId {}, of which {} name no axis this part declares", ids.join(", "), dead.join(", "))
    } else {
        format!("references only {} axis id(s)", ids.len())
    };
    vec![issue(
        "error",
        "chart_axis_undeclared",
        part,
        format!(
            "<c:{name}> {detail}, leaving fewer than two live axes; PowerPoint discards the chart and reports the file as corrupt. A secondary-axis combo needs both valAxes and catAxes with two entries each."
        ),
    )]
}

/// The faults one chart part carries by its own text: data labels PowerPoint does not allow on a stacked group, and a
/// plot group that does not resolve enough of the axes the part declares.
pub fn chart_faults_in_xml(part: &str, xml: &str) -> Vec<Value> {
    let cleaned = strip_ext_lst(xml);
    let declared = declared_axis_ids(&cleaned);
    let mut issues = Vec::new();
    for (name, block) in plot_groups(&cleaned) {
        issues.extend(stacked_label_faults(part, block, &name));
        issues.extend(axis_reference_faults(part, block, &name, &declared));
    }
    issues
}

/// A chart keeps its numbers in the workbook the package carries: "Edit Data" opens that part, and a chart without it is a
/// drawing of the series. The file opens and prints, so this is what the reader loses on the next revision, not a fault
/// PowerPoint refuses. `relationships` are the chart part's own, `has_part` says whether the package holds a part.
pub fn chart_data_link_faults(part: &str, xml: &str, relationships: &RelationshipMap, has_part: &dyn Fn(&str) -> bool) -> Vec<Value> {
    let cleaned = strip_ext_lst(xml);
    if !compiled(r"<c:ser\b", "").is_match(&cleaned) {
        return Vec::new();
    }
    let id = compiled(r#"<c:externalData\b[^>]*\br:id="([^"]+)""#, "").captures(&cleaned).and_then(|found| found.get(1).map(str::to_owned));
    let target = id.as_deref().and_then(|id| relationships.get(id)).unwrap_or("");
    let resolved = if target.is_empty() { String::new() } else { posix::normalize(&posix::join(&[posix::dirname(part).as_str(), target])) };
    if !resolved.is_empty() && has_part(&resolved) {
        return Vec::new();
    }
    let detail = match id.as_deref() {
        None => "declares no <c:externalData>".to_owned(),
        Some(id) if target.is_empty() => format!("names relationship {id}, which its own relationship part does not define"),
        Some(_) => format!("points at {resolved}, which the package does not contain"),
    };
    vec![issue(
        "warning",
        "chart_data_unlinked",
        part,
        format!(
            "The chart {detail}, so Edit Data opens nothing and the series can only be changed by drawing the chart again. Write it with add_chart / set_chart_data, which keeps the workbook in the package."
        ),
    )]
}

/// Every chart part of a presentation package (`ppt/charts/chartN.xml`, in the order of N) scanned for both kinds of fault.
pub fn chart_fault_issues(package: &Package) -> Vec<Value> {
    let chart_part = compiled(r"^ppt\/charts\/chart(\d+)\.xml$", "");
    let mut parts: Vec<(f64, String)> = package
        .names()
        .into_iter()
        .filter_map(|name| {
            let number = chart_part.captures(&name)?.get(1)?.parse::<f64>().ok()?;
            Some((number, name))
        })
        .collect();
    parts.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut issues = Vec::new();
    for (_, part) in parts {
        let xml = package.text(&part);
        if xml.is_empty() {
            continue;
        }
        issues.extend(chart_faults_in_xml(&part, &xml));
        let relationships = relationship_map(&package.text(&part_relationship_path(&part)));
        issues.extend(chart_data_link_faults(&part, &xml, &relationships, &|name| package.file(name).is_some()));
    }
    issues
}

#[cfg(test)]
mod tests {
    use super::*;

    fn axes(cat: &str, val: &str) -> String {
        format!(r#"<c:catAx><c:axId val="{cat}"/><c:crossAx val="{val}"/></c:catAx><c:valAx><c:axId val="{val}"/><c:crossAx val="{cat}"/></c:valAx>"#)
    }

    fn bar(grouping: &str, label: &str, ids: &[&str]) -> String {
        let ax: String = ids.iter().map(|id| format!(r#"<c:axId val="{id}"/>"#)).collect();
        format!(
            r#"<c:barChart><c:barDir val="col"/><c:grouping val="{grouping}"/><c:ser><c:idx val="0"/><c:dLbls><c:dLblPos val="{label}"/><c:showVal val="1"/></c:dLbls></c:ser>{ax}</c:barChart>"#
        )
    }

    fn clustered() -> String {
        bar("clustered", "outEnd", &["1", "2"])
    }

    fn chart(body: &str, tail: &str) -> String {
        format!("<c:chartSpace><c:chart><c:plotArea>{body}</c:plotArea></c:chart>{tail}</c:chartSpace>")
    }

    fn external(id: &str) -> String {
        format!(r#"<c:externalData r:id="{id}"><c:autoUpdate val="0"/></c:externalData>"#)
    }

    fn summary(issues: &[Value]) -> Vec<(String, String, String)> {
        issues
            .iter()
            .map(|issue| (issue["code"].as_str().unwrap_or("").to_owned(), issue["severity"].as_str().unwrap_or("").to_owned(), issue["path"].as_str().unwrap_or("").to_owned()))
            .collect()
    }

    fn no_part(_: &str) -> bool {
        false
    }

    #[test]
    fn clustered_charts_with_declared_axes_and_out_end_labels_pass() {
        let xml = chart(&format!("{}{}", clustered(), axes("1", "2")), "");
        assert!(chart_faults_in_xml("ppt/charts/chart1.xml", &xml).is_empty());
    }

    #[test]
    fn out_end_labels_on_a_stacked_bar_are_reported_as_a_powerpoint_refused_fault() {
        let stacked = chart(&format!("{}{}", bar("stacked", "outEnd", &["1", "2"]), axes("1", "2")), "");
        let issues = chart_faults_in_xml("ppt/charts/chart1.xml", &stacked);
        assert_eq!(summary(&issues), [("chart_stacked_label_position".to_owned(), "error".to_owned(), "/ppt/charts/chart1.xml".to_owned())]);
        assert!(issues[0]["message"].as_str().unwrap_or("").contains("ctr, inEnd, inBase"));
        let legal = chart(&format!("{}{}", bar("percentStacked", "ctr", &["1", "2"]), axes("1", "2")), "");
        assert!(chart_faults_in_xml("ppt/charts/chart2.xml", &legal).is_empty());
    }

    #[test]
    fn a_plot_group_pointing_at_axes_the_part_never_declares_is_reported() {
        let combo = chart(
            &format!(r#"{}<c:lineChart><c:grouping val="standard"/><c:axId val="3"/><c:axId val="4"/></c:lineChart>{}"#, clustered(), axes("1", "2")),
            "",
        );
        let issues = chart_faults_in_xml("ppt/charts/chart3.xml", &combo);
        assert_eq!(issues.iter().map(|issue| issue["code"].as_str().unwrap_or("")).collect::<Vec<_>>(), ["chart_axis_undeclared"]);
        let message = issues[0]["message"].as_str().unwrap_or("");
        assert!(message.contains("axId 3, 4, of which 3, 4 name no axis"), "{message}");
        assert!(message.contains("valAxes and catAxes"));
    }

    #[test]
    fn ids_inside_ext_lst_never_count_and_pie_charts_have_no_axis_contract() {
        let noisy = chart(
            &format!(
                r#"<c:pieChart><c:varyColors val="1"/></c:pieChart>{}<c:extLst><c:ext><c:barChart><c:grouping val="stacked"/><c:dLblPos val="outEnd"/><c:axId val="9"/></c:barChart></c:ext></c:extLst>{}"#,
                bar("stacked", "ctr", &["1", "2"]),
                axes("1", "2")
            ),
            "",
        );
        assert!(chart_faults_in_xml("ppt/charts/chart4.xml", &noisy).is_empty());
    }

    #[test]
    fn a_chart_whose_embedded_workbook_is_in_the_package_keeps_its_data_link() {
        let xml = chart(&format!("{}{}", clustered(), axes("1", "2")), &external("rId1"));
        let relationships = relationship_map(r#"<Relationships><Relationship Id="rId1" Target="../embeddings/chartData1.xlsx"/></Relationships>"#);
        assert!(chart_data_link_faults("ppt/charts/chart1.xml", &xml, &relationships, &|name| name == "ppt/embeddings/chartData1.xlsx").is_empty());
    }

    #[test]
    fn a_chart_with_series_but_no_workbook_behind_them_is_reported_as_unlinked_data() {
        let none = RelationshipMap::default();
        let bare = chart(&format!("{}{}", clustered(), axes("1", "2")), "");
        let missing = chart_data_link_faults("ppt/charts/chart2.xml", &bare, &none, &no_part);
        assert_eq!(summary(&missing), [("chart_data_unlinked".to_owned(), "warning".to_owned(), "/ppt/charts/chart2.xml".to_owned())]);
        assert!(missing[0]["message"].as_str().unwrap_or("").contains("declares no <c:externalData>"));
        let dangling = relationship_map(r#"<Relationship Id="rId1" Target="../embeddings/chartData7.xlsx"/>"#);
        let linked = chart(&format!("{}{}", clustered(), axes("1", "2")), &external("rId1"));
        let points = chart_data_link_faults("ppt/charts/chart3.xml", &linked, &dangling, &no_part);
        assert!(points[0]["message"].as_str().unwrap_or("").contains("points at ppt/embeddings/chartData7.xlsx"));
        let unknown = chart(&format!("{}{}", clustered(), axes("1", "2")), &external("rId9"));
        let names = chart_data_link_faults("ppt/charts/chart4.xml", &unknown, &none, &no_part);
        assert!(names[0]["message"].as_str().unwrap_or("").contains("names relationship rId9"));
    }

    #[test]
    fn a_chart_part_with_no_series_is_a_template_not_a_broken_data_link() {
        let template = chart(r#"<c:pieChart><c:varyColors val="1"/></c:pieChart>"#, "");
        assert!(chart_data_link_faults("ppt/charts/chart5.xml", &template, &RelationshipMap::default(), &no_part).is_empty());
    }

    #[test]
    fn a_package_scan_reads_the_charts_in_number_order_with_their_own_relationships() {
        let mut package = Package::new();
        package.set("ppt/charts/chart10.xml", chart(&format!("{}{}", clustered(), axes("1", "2")), ""));
        package.set("ppt/charts/chart2.xml", chart(&format!("{}{}", clustered(), axes("1", "2")), &external("rId1")));
        package.set("ppt/charts/_rels/chart2.xml.rels", r#"<Relationships><Relationship Id="rId1" Target="../embeddings/w.xlsx"/></Relationships>"#);
        package.set("ppt/embeddings/w.xlsx", "x");
        package.set("ppt/charts/chartstyle.xml", "<c:chartStyle/>");
        let issues = chart_fault_issues(&package);
        assert_eq!(summary(&issues), [("chart_data_unlinked".to_owned(), "warning".to_owned(), "/ppt/charts/chart10.xml".to_owned())]);
    }
}
