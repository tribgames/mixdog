//! The blank packages of `portable/portable-package.mjs`: a new docx, xlsx or pptx (and the template kinds dotx, xltx,
//! potx) as the parts a package of that kind starts from, and the one-sheet workbook a chart carries its data in. The
//! parts are returned in the order the Node builders listed them; [`Package::set`] adds them, creating the folder entries
//! above each part as jszip does.

use mixdog_js::{number_to_string, slice_utf16, value_to_string};
use mixdog_office_base::a1::column_label;
use serde_json::Value;

use crate::opc::PACKAGE_RELATIONSHIP_NS;
use crate::xml::{DRAWING_MAIN_NS, OFFICE_RELATIONSHIP_BASE, SPREADSHEET_MAIN, WORD_MAIN_NS, XML_HEADER, xml_encode};
use crate::zipio::{Package, utc_now};

const PRESENTATION_MAIN: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
const CORE_PROPERTY_TYPE: &str = "application/vnd.openxmlformats-package.core-properties+xml";
const CORE_PROPERTY_RELATIONSHIP: &str = "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties";
const RELATIONSHIPS_TYPE: &str = "application/vnd.openxmlformats-package.relationships+xml";
const SLIDE_WIDTH: u32 = 12_192_000;
const SLIDE_HEIGHT: u32 = 6_858_000;
const NOTES_WIDTH: u32 = 6_858_000;
const NOTES_HEIGHT: u32 = 9_144_000;

/// The kinds a package can be created as, with the family each is built from (`FILE_KIND_FAMILIES`).
pub const FILE_KIND_FAMILIES: [(&str, &str); 6] = [("docx", "docx"), ("dotx", "docx"), ("xlsx", "xlsx"), ("xltx", "xlsx"), ("pptx", "pptx"), ("potx", "pptx")];

/// `FILE_KIND_FAMILIES[kind]`.
pub fn kind_family(kind: &str) -> Option<&'static str> {
    FILE_KIND_FAMILIES.iter().find(|(known, _)| *known == kind).map(|(_, family)| *family)
}

/// `MAIN_PART_TYPES[kind]`: the content type of the main part.
fn main_part_type(kind: &str) -> &'static str {
    match kind {
        "dotx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        "xltx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
        "potx" => "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml",
        _ => "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    }
}

/// The parts of a package, in the order they are added.
pub type Parts = Vec<(String, String)>;

fn document(body: &str) -> String {
    format!("{XML_HEADER}{body}")
}

/// The relationship type of an Office document part: `<base>/<kind>`.
fn office(kind: &str) -> String {
    format!("{OFFICE_RELATIONSHIP_BASE}/{kind}")
}

fn relationships(entries: &[(&str, String, &str)]) -> String {
    let items: String = entries
        .iter()
        .map(|(id, relationship_type, target)| format!("<Relationship Id=\"{id}\" Type=\"{relationship_type}\" Target=\"{}\"/>", xml_encode(target)))
        .collect();
    document(&format!("<Relationships xmlns=\"{PACKAGE_RELATIONSHIP_NS}\">{items}</Relationships>"))
}

fn content_types(defaults: &[(&str, &str)], overrides: &[(&str, &str)]) -> String {
    let mut default_entries: Vec<(&str, &str)> = vec![("rels", RELATIONSHIPS_TYPE), ("xml", "application/xml")];
    default_entries.extend_from_slice(defaults);
    let defaults_text: String =
        default_entries.iter().map(|(extension, kind)| format!("<Default Extension=\"{extension}\" ContentType=\"{kind}\"/>")).collect();
    let overrides_text: String = overrides.iter().map(|(part, kind)| format!("<Override PartName=\"{part}\" ContentType=\"{kind}\"/>")).collect();
    document(&format!("<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">{defaults_text}{overrides_text}</Types>"))
}

/// The date written as `toISOString` does, without the fraction of a second.
fn stamp() -> String {
    let now = utc_now();
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", now.year, now.month, now.day, now.hour, now.minute, now.second)
}

fn core_properties(title: &str) -> String {
    let stamp = stamp();
    document(&format!(
        "<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:dcmitype=\"http://purl.org/dc/dcmitype/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"><dc:title>{}</dc:title><dc:creator>Mixdog</dc:creator><cp:lastModifiedBy>Mixdog</cp:lastModifiedBy><dcterms:created xsi:type=\"dcterms:W3CDTF\">{stamp}</dcterms:created><dcterms:modified xsi:type=\"dcterms:W3CDTF\">{stamp}</dcterms:modified></cp:coreProperties>",
        xml_encode(title)
    ))
}

fn word_heading_style(id: &str, name: &str, outline: u32, size: u32, spacing_before: u32) -> String {
    format!(
        "<w:style w:type=\"paragraph\" w:styleId=\"{id}\"><w:name w:val=\"{name}\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before=\"{spacing_before}\" w:after=\"120\"/><w:outlineLvl w:val=\"{outline}\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"{size}\"/><w:szCs w:val=\"{size}\"/></w:rPr></w:style>"
    )
}

/// The styles part a new document starts from; an existing document borrows a definition from it that it lacks.
pub fn word_styles() -> String {
    let border: String = ["top", "left", "bottom", "right", "insideH", "insideV"]
        .iter()
        .map(|edge| format!("<w:{edge} w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"BFBFBF\"/>"))
        .collect();
    let headings = [
        word_heading_style("Heading1", "heading 1", 0, 32, 240),
        word_heading_style("Heading2", "heading 2", 1, 28, 200),
        word_heading_style("Heading3", "heading 3", 2, 26, 160),
        word_heading_style("Heading4", "heading 4", 3, 24, 160),
    ]
    .concat();
    let open = format!("<w:styles xmlns:w=\"{WORD_MAIN_NS}\">");
    let table_grid = format!("<w:tblPr><w:tblBorders>{border}</w:tblBorders></w:tblPr></w:style>");
    document(&[
        open.as_str(),
        "<w:docDefaults>",
        "<w:rPrDefault><w:rPr>",
        "<w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\" w:eastAsia=\"Malgun Gothic\" w:cs=\"Arial\"/>",
        "<w:sz w:val=\"22\"/><w:szCs w:val=\"22\"/>",
        "</w:rPr></w:rPrDefault>",
        // wordWrap on keeps a Hangul word whole at the line end: Korean Word's own Normal style writes wordWrap="0" and
        // breaks a word at the margin. Word's own defaults open a gap between Hangul and the Latin text or digits beside
        // it, so autoSpaceDE and autoSpaceDN are off: both renderers set the same text.
        "<w:pPrDefault><w:pPr><w:wordWrap w:val=\"1\"/><w:autoSpaceDE w:val=\"0\"/><w:autoSpaceDN w:val=\"0\"/>",
        "<w:spacing w:after=\"160\" w:line=\"259\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault>",
        "</w:docDefaults>",
        "<w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/></w:style>",
        "<w:style w:type=\"paragraph\" w:styleId=\"Title\"><w:name w:val=\"Title\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/>",
        "<w:pPr><w:spacing w:after=\"120\"/><w:contextualSpacing/></w:pPr>",
        "<w:rPr><w:b/><w:sz w:val=\"56\"/><w:szCs w:val=\"56\"/></w:rPr></w:style>",
        "<w:style w:type=\"paragraph\" w:styleId=\"Subtitle\"><w:name w:val=\"Subtitle\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/>",
        "<w:pPr><w:spacing w:after=\"240\"/></w:pPr>",
        "<w:rPr><w:color w:val=\"595959\"/><w:sz w:val=\"28\"/><w:szCs w:val=\"28\"/></w:rPr></w:style>",
        headings.as_str(),
        "<w:style w:type=\"paragraph\" w:styleId=\"ListParagraph\"><w:name w:val=\"List Paragraph\"/><w:basedOn w:val=\"Normal\"/><w:qFormat/>",
        "<w:pPr><w:ind w:left=\"720\"/><w:contextualSpacing/></w:pPr></w:style>",
        "<w:style w:type=\"paragraph\" w:styleId=\"Quote\"><w:name w:val=\"Quote\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/>",
        "<w:pPr><w:ind w:left=\"720\" w:right=\"720\"/></w:pPr><w:rPr><w:i/><w:color w:val=\"404040\"/></w:rPr></w:style>",
        "<w:style w:type=\"paragraph\" w:styleId=\"Caption\"><w:name w:val=\"caption\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/>",
        "<w:pPr><w:spacing w:after=\"200\"/></w:pPr><w:rPr><w:color w:val=\"595959\"/><w:sz w:val=\"18\"/><w:szCs w:val=\"18\"/></w:rPr></w:style>",
        "<w:style w:type=\"table\" w:default=\"1\" w:styleId=\"TableNormal\"><w:name w:val=\"Normal Table\"/>",
        "<w:tblPr><w:tblInd w:w=\"0\" w:type=\"dxa\"/>",
        "<w:tblCellMar><w:top w:w=\"0\" w:type=\"dxa\"/><w:left w:w=\"108\" w:type=\"dxa\"/><w:bottom w:w=\"0\" w:type=\"dxa\"/><w:right w:w=\"108\" w:type=\"dxa\"/></w:tblCellMar>",
        "</w:tblPr></w:style>",
        "<w:style w:type=\"table\" w:styleId=\"TableGrid\"><w:name w:val=\"Table Grid\"/><w:basedOn w:val=\"TableNormal\"/>",
        "<w:pPr><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr>",
        table_grid.as_str(),
        "</w:styles>",
    ]
    .concat())
}

fn word_document() -> String {
    document(&format!(
        "<w:document xmlns:w=\"{WORD_MAIN_NS}\" xmlns:r=\"{OFFICE_RELATIONSHIP_BASE}\"><w:body><w:p/><w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1418\" w:right=\"1418\" w:bottom=\"1418\" w:left=\"1418\" w:header=\"709\" w:footer=\"709\" w:gutter=\"0\"/><w:cols w:space=\"708\"/><w:docGrid w:linePitch=\"360\"/></w:sectPr></w:body></w:document>"
    ))
}

/// A package that names no compatibility mode opens in Word as a Word 2007 document ("Compatibility Mode" in the title
/// bar, the old layout engine): a new document declares the current mode, as Word's own do.
fn word_settings() -> String {
    document(&format!(
        "<w:settings xmlns:w=\"{WORD_MAIN_NS}\"><w:compat><w:compatSetting w:name=\"compatibilityMode\" w:uri=\"http://schemas.microsoft.com/office/word\" w:val=\"15\"/></w:compat></w:settings>"
    ))
}

fn part(name: &str, content: String) -> (String, String) {
    (name.to_owned(), content)
}

fn docx_package(title: &str, file_kind: &str) -> Parts {
    vec![
        part(
            "[Content_Types].xml",
            content_types(
                &[],
                &[
                    ("/word/document.xml", main_part_type(file_kind)),
                    ("/word/styles.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"),
                    ("/word/settings.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"),
                    ("/docProps/core.xml", CORE_PROPERTY_TYPE),
                ],
            ),
        ),
        part(
            "_rels/.rels",
            relationships(&[("rId1", office("officeDocument"), "word/document.xml"), ("rId2", CORE_PROPERTY_RELATIONSHIP.to_owned(), "docProps/core.xml")]),
        ),
        part("docProps/core.xml", core_properties(title)),
        part("word/document.xml", word_document()),
        part("word/_rels/document.xml.rels", relationships(&[("rId1", office("styles"), "styles.xml"), ("rId2", office("settings"), "settings.xml")])),
        part("word/styles.xml", word_styles()),
        part("word/settings.xml", word_settings()),
    ]
}

fn sheet_styles() -> String {
    document(&format!(
        "<styleSheet xmlns=\"{SPREADSHEET_MAIN}\"><fonts count=\"1\"><font><sz val=\"11\"/><color rgb=\"FF000000\"/><name val=\"Calibri\"/><family val=\"2\"/></font></fonts><fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills><borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/></cellXfs><cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles></styleSheet>"
    ))
}

fn xlsx_package(title: &str, file_kind: &str, sheet_name: &str) -> Parts {
    let name = slice_utf16(if sheet_name.is_empty() { "Sheet1" } else { sheet_name }, 31);
    vec![
        part(
            "[Content_Types].xml",
            content_types(
                &[],
                &[
                    ("/xl/workbook.xml", main_part_type(file_kind)),
                    ("/xl/worksheets/sheet1.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"),
                    ("/xl/styles.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"),
                    ("/xl/sharedStrings.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"),
                    ("/docProps/core.xml", CORE_PROPERTY_TYPE),
                ],
            ),
        ),
        part(
            "_rels/.rels",
            relationships(&[("rId1", office("officeDocument"), "xl/workbook.xml"), ("rId2", CORE_PROPERTY_RELATIONSHIP.to_owned(), "docProps/core.xml")]),
        ),
        part("docProps/core.xml", core_properties(title)),
        part(
            "xl/workbook.xml",
            document(&format!(
                "<workbook xmlns=\"{SPREADSHEET_MAIN}\" xmlns:r=\"{OFFICE_RELATIONSHIP_BASE}\"><bookViews><workbookView xWindow=\"0\" yWindow=\"0\" windowWidth=\"20000\" windowHeight=\"12000\"/></bookViews><sheets><sheet name=\"{}\" sheetId=\"1\" r:id=\"rId1\"/></sheets><calcPr calcId=\"191029\" fullCalcOnLoad=\"1\"/></workbook>",
                xml_encode(&name)
            )),
        ),
        part(
            "xl/_rels/workbook.xml.rels",
            relationships(&[
                ("rId1", office("worksheet"), "worksheets/sheet1.xml"),
                ("rId2", office("styles"), "styles.xml"),
                ("rId3", office("sharedStrings"), "sharedStrings.xml"),
            ]),
        ),
        part(
            "xl/worksheets/sheet1.xml",
            document(&format!(
                "<worksheet xmlns=\"{SPREADSHEET_MAIN}\" xmlns:r=\"{OFFICE_RELATIONSHIP_BASE}\"><sheetViews><sheetView workbookViewId=\"0\"/></sheetViews><sheetFormatPr defaultRowHeight=\"15\"/><sheetData/></worksheet>"
            )),
        ),
        part("xl/styles.xml", sheet_styles()),
        part("xl/sharedStrings.xml", document(&format!("<sst xmlns=\"{SPREADSHEET_MAIN}\" count=\"0\" uniqueCount=\"0\"/>"))),
    ]
}

fn theme_fill(modifiers: &str) -> String {
    if modifiers.is_empty() {
        "<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>".to_owned()
    } else {
        format!("<a:solidFill><a:schemeClr val=\"phClr\">{modifiers}</a:schemeClr></a:solidFill>")
    }
}

fn theme_line(width: u32) -> String {
    format!(
        "<a:ln w=\"{width}\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:prstDash val=\"solid\"/><a:miter lim=\"800000\"/></a:ln>"
    )
}

fn presentation_theme() -> String {
    let colours: String = [
        ("dk1", "<a:sysClr val=\"windowText\" lastClr=\"000000\"/>"),
        ("lt1", "<a:sysClr val=\"window\" lastClr=\"FFFFFF\"/>"),
        ("dk2", "<a:srgbClr val=\"1F2933\"/>"),
        ("lt2", "<a:srgbClr val=\"F4F6F8\"/>"),
        ("accent1", "<a:srgbClr val=\"1B4965\"/>"),
        ("accent2", "<a:srgbClr val=\"5FA8D3\"/>"),
        ("accent3", "<a:srgbClr val=\"62B6CB\"/>"),
        ("accent4", "<a:srgbClr val=\"CAE9FF\"/>"),
        ("accent5", "<a:srgbClr val=\"BEE9E8\"/>"),
        ("accent6", "<a:srgbClr val=\"F4A259\"/>"),
        ("hlink", "<a:srgbClr val=\"0B6BCB\"/>"),
        ("folHlink", "<a:srgbClr val=\"6B47B8\"/>"),
    ]
    .iter()
    .map(|(slot, value)| format!("<a:{slot}>{value}</a:{slot}>"))
    .collect();
    let open = format!("<a:theme xmlns:a=\"{DRAWING_MAIN_NS}\" name=\"Mixdog\">");
    let colour_scheme = format!("<a:clrScheme name=\"Mixdog\">{colours}</a:clrScheme>");
    let fills = [
        theme_fill(""),
        theme_fill("<a:lumMod val=\"110000\"/><a:satMod val=\"105000\"/><a:tint val=\"67000\"/>"),
        theme_fill("<a:lumMod val=\"105000\"/><a:satMod val=\"103000\"/><a:tint val=\"73000\"/>"),
    ]
    .concat();
    let lines = format!("<a:lnStyleLst>{}{}{}</a:lnStyleLst>", theme_line(6350), theme_line(12700), theme_line(19050));
    let background_fills =
        [theme_fill(""), theme_fill("<a:tint val=\"95000\"/><a:satMod val=\"170000\"/>"), theme_fill("<a:shade val=\"90000\"/><a:satMod val=\"150000\"/>")]
            .concat();
    document(
        &[
            open.as_str(),
            "<a:themeElements>",
            colour_scheme.as_str(),
            "<a:fontScheme name=\"Mixdog\">",
            "<a:majorFont><a:latin typeface=\"Calibri Light\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/></a:majorFont>",
            "<a:minorFont><a:latin typeface=\"Calibri\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/></a:minorFont>",
            "</a:fontScheme>",
            "<a:fmtScheme name=\"Mixdog\">",
            "<a:fillStyleLst>",
            fills.as_str(),
            "</a:fillStyleLst>",
            lines.as_str(),
            "<a:effectStyleLst>",
            "<a:effectStyle><a:effectLst/></a:effectStyle>",
            "<a:effectStyle><a:effectLst/></a:effectStyle>",
            "<a:effectStyle><a:effectLst/></a:effectStyle>",
            "</a:effectStyleLst>",
            "<a:bgFillStyleLst>",
            background_fills.as_str(),
            "</a:bgFillStyleLst>",
            "</a:fmtScheme>",
            "</a:themeElements>",
            "</a:theme>",
        ]
        .concat(),
    )
}

fn empty_shape_tree() -> &'static str {
    "<p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr></p:spTree>"
}

fn presentation_namespaces() -> String {
    format!("xmlns:a=\"{DRAWING_MAIN_NS}\" xmlns:r=\"{OFFICE_RELATIONSHIP_BASE}\" xmlns:p=\"{PRESENTATION_MAIN}\"")
}

fn slide_master() -> String {
    let colour_map = "bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"";
    let open = format!("<p:sldMaster {}>", presentation_namespaces());
    let colours = format!("<p:clrMap {colour_map}/>");
    document(&[
        open.as_str(),
        "<p:cSld>",
        "<p:bg><p:bgPr><a:solidFill><a:schemeClr val=\"bg1\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>",
        empty_shape_tree(),
        "</p:cSld>",
        colours.as_str(),
        "<p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst>",
        "<p:txStyles>",
        "<p:titleStyle><a:lvl1pPr algn=\"l\"><a:defRPr sz=\"4000\" b=\"1\"/></a:lvl1pPr></p:titleStyle>",
        "<p:bodyStyle><a:lvl1pPr marL=\"285750\" indent=\"-285750\"><a:buFont typeface=\"Arial\"/><a:buChar char=\"&#8226;\"/><a:defRPr sz=\"1800\"/></a:lvl1pPr></p:bodyStyle>",
        "<p:otherStyle><a:lvl1pPr><a:defRPr sz=\"1800\"/></a:lvl1pPr></p:otherStyle>",
        "</p:txStyles>",
        "</p:sldMaster>",
    ]
    .concat())
}

fn slide_layout() -> String {
    let open = format!("<p:sldLayout {} type=\"blank\" preserve=\"1\">", presentation_namespaces());
    let shapes = format!("<p:cSld name=\"Blank\">{}</p:cSld>", empty_shape_tree());
    document(&[open.as_str(), shapes.as_str(), "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>", "</p:sldLayout>"].concat())
}

fn pptx_package(title: &str, file_kind: &str) -> Parts {
    vec![
        part(
            "[Content_Types].xml",
            content_types(
                &[("jpeg", "image/jpeg"), ("png", "image/png")],
                &[
                    ("/ppt/presentation.xml", main_part_type(file_kind)),
                    ("/ppt/slideMasters/slideMaster1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"),
                    ("/ppt/slideLayouts/slideLayout1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"),
                    ("/ppt/theme/theme1.xml", "application/vnd.openxmlformats-officedocument.theme+xml"),
                    ("/docProps/core.xml", CORE_PROPERTY_TYPE),
                ],
            ),
        ),
        part(
            "_rels/.rels",
            relationships(&[("rId1", office("officeDocument"), "ppt/presentation.xml"), ("rId2", CORE_PROPERTY_RELATIONSHIP.to_owned(), "docProps/core.xml")]),
        ),
        part("docProps/core.xml", core_properties(title)),
        part(
            "ppt/presentation.xml",
            document(&format!(
                "<p:presentation {} saveSubsetFonts=\"1\"><p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst><p:sldIdLst/><p:sldSz cx=\"{SLIDE_WIDTH}\" cy=\"{SLIDE_HEIGHT}\"/><p:notesSz cx=\"{NOTES_WIDTH}\" cy=\"{NOTES_HEIGHT}\"/></p:presentation>",
                presentation_namespaces()
            )),
        ),
        part(
            "ppt/_rels/presentation.xml.rels",
            relationships(&[("rId1", office("slideMaster"), "slideMasters/slideMaster1.xml"), ("rId2", office("theme"), "theme/theme1.xml")]),
        ),
        part("ppt/slideMasters/slideMaster1.xml", slide_master()),
        part(
            "ppt/slideMasters/_rels/slideMaster1.xml.rels",
            relationships(&[("rId1", office("slideLayout"), "../slideLayouts/slideLayout1.xml"), ("rId2", office("theme"), "../theme/theme1.xml")]),
        ),
        part("ppt/slideLayouts/slideLayout1.xml", slide_layout()),
        part("ppt/slideLayouts/_rels/slideLayout1.xml.rels", relationships(&[("rId1", office("slideMaster"), "../slideMasters/slideMaster1.xml")])),
        part("ppt/theme/theme1.xml", presentation_theme()),
    ]
}

/// The parts of a new package of a family (`docx`, `xlsx` or `pptx`) written as `file_kind`; `title` is the document title
/// and `sheet_name` the first sheet of a workbook (cut to 31 characters, `Sheet1` when empty).
pub fn blank_parts(family: &str, title: &str, file_kind: &str, sheet_name: &str) -> Option<Parts> {
    match family {
        "docx" => Some(docx_package(title, file_kind)),
        "xlsx" => Some(xlsx_package(title, file_kind, sheet_name)),
        "pptx" => Some(pptx_package(title, file_kind)),
        _ => None,
    }
}

/// A [`Package`] holding the parts.
pub fn package_of(parts: &Parts) -> Package {
    let mut package = Package::new();
    for (name, content) in parts {
        package.set(name, content.as_bytes());
    }
    package
}

fn worksheet_with_rows(rows: &[Value]) -> String {
    let mut body = String::new();
    for (row_index, row) in rows.iter().enumerate() {
        let mut cells = String::new();
        if let Value::Array(values) = row {
            for (column_index, value) in values.iter().enumerate() {
                if value.is_null() || value.as_str() == Some("") {
                    continue;
                }
                let reference = format!("{}{}", column_label((column_index + 1) as f64), row_index + 1);
                match value {
                    Value::Number(number) => {
                        let text = number_to_string(number.as_f64().unwrap_or(f64::NAN));
                        cells.push_str(&format!("<c r=\"{reference}\"><v>{text}</v></c>"));
                    }
                    other => {
                        cells.push_str(&format!("<c r=\"{reference}\" t=\"inlineStr\"><is><t>{}</t></is></c>", xml_encode(&value_to_string(other))));
                    }
                }
            }
        }
        if !cells.is_empty() {
            body.push_str(&format!("<row r=\"{}\">{cells}</row>", row_index + 1));
        }
    }
    document(&format!(
        "<worksheet xmlns=\"{SPREADSHEET_MAIN}\" xmlns:r=\"{OFFICE_RELATIONSHIP_BASE}\"><sheetViews><sheetView workbookViewId=\"0\"/></sheetViews><sheetFormatPr defaultRowHeight=\"15\"/><sheetData>{body}</sheetData></worksheet>"
    ))
}

/// `createPortableChartWorkbook(rows, { sheetName })`: the package bytes of the one-sheet workbook a chart reads its data
/// from; each row is an array of values, and a null or empty value leaves its cell out.
pub fn chart_workbook(rows: &[Value], sheet_name: &str) -> Result<Vec<u8>, String> {
    let mut parts = xlsx_package("Chart data", "xlsx", sheet_name);
    if let Some(sheet) = parts.iter_mut().find(|(name, _)| name == "xl/worksheets/sheet1.xml") {
        sheet.1 = worksheet_with_rows(rows);
    }
    package_of(&parts).generate()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_blank_document_starts_from_the_parts_word_needs() {
        let parts = blank_parts("docx", "Memo & plan", "dotx", "").expect("docx");
        let names: Vec<&str> = parts.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(
            names,
            [
                "[Content_Types].xml",
                "_rels/.rels",
                "docProps/core.xml",
                "word/document.xml",
                "word/_rels/document.xml.rels",
                "word/styles.xml",
                "word/settings.xml"
            ]
        );
        assert!(parts[0].1.contains("wordprocessingml.template.main+xml"));
        assert!(parts[2].1.contains("<dc:title>Memo &amp; plan</dc:title>"));
        assert!(parts[3].1.starts_with(XML_HEADER));
        assert!(parts[3].1.contains("<w:body><w:p/><w:sectPr>"));
    }

    #[test]
    fn a_blank_workbook_names_its_first_sheet_cut_to_31_characters() {
        let parts = blank_parts("xlsx", "T", "xlsx", &"s".repeat(40)).expect("xlsx");
        let workbook = &parts.iter().find(|(name, _)| name == "xl/workbook.xml").expect("workbook").1;
        assert!(workbook.contains(&format!("<sheet name=\"{}\" sheetId=\"1\" r:id=\"rId1\"/>", "s".repeat(31))));
        let default = blank_parts("xlsx", "T", "xlsx", "").expect("xlsx");
        assert!(default.iter().any(|(_, text)| text.contains("<sheet name=\"Sheet1\"")));
    }

    #[test]
    fn a_blank_deck_has_a_master_a_layout_and_a_theme() {
        let parts = blank_parts("pptx", "Deck", "potx", "").expect("pptx");
        assert_eq!(parts.len(), 10);
        assert!(parts[0].1.contains("<Default Extension=\"jpeg\" ContentType=\"image/jpeg\"/><Default Extension=\"png\""));
        let package = package_of(&parts);
        assert!(package.contains("ppt/theme/"));
        assert!(package.text("ppt/presentation.xml").contains("<p:sldSz cx=\"12192000\" cy=\"6858000\"/>"));
        assert_eq!(blank_parts("csv", "", "csv", ""), None);
    }

    #[test]
    fn the_chart_workbook_holds_the_rows_as_cells() {
        let rows = [json!(["Region", "Sales"]), json!(["North", 12.5]), json!(null), json!(["", 3])];
        let bytes = chart_workbook(&rows, "Data").expect("workbook");
        let package = Package::load(&bytes).expect("load");
        assert_eq!(
            package.text("xl/worksheets/sheet1.xml"),
            format!(
                "{XML_HEADER}<worksheet xmlns=\"{SPREADSHEET_MAIN}\" xmlns:r=\"{OFFICE_RELATIONSHIP_BASE}\"><sheetViews><sheetView workbookViewId=\"0\"/></sheetViews><sheetFormatPr defaultRowHeight=\"15\"/><sheetData><row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>Region</t></is></c><c r=\"B1\" t=\"inlineStr\"><is><t>Sales</t></is></c></row><row r=\"2\"><c r=\"A2\" t=\"inlineStr\"><is><t>North</t></is></c><c r=\"B2\"><v>12.5</v></c></row><row r=\"4\"><c r=\"B4\"><v>3</v></c></row></sheetData></worksheet>"
            )
        );
        assert!(package.text("xl/workbook.xml").contains("<sheet name=\"Data\""));
    }
}
