//! The workbook behind a chart: the embedded `ppt/embeddings/Microsoft_Excel_Worksheet<n>.xlsx` pptxgenjs 4.0.1 writes
//! (`createExcelWorksheet`), built on `mixdog_ooxml`'s package container. The package parts that never change are the
//! text pptxgenjs carries; the shared strings, the table and the sheet are written from the chart's data in the three
//! shapes pptxgenjs has: a scatter chart (an X column and one column per Y series), a category chart with one label
//! column per label group, and a category chart with several label levels (one row per category, a label cell only
//! where the level has a label). The cell quirks of the library are kept as they are: a zero in a category chart's
//! value column is an empty cell, the table range of a category chart ends in a stray quote, and every label cell of a
//! row names the same shared string.

use std::time::{SystemTime, UNIX_EPOCH};

use mixdog_ooxml::zipio::Package;

use super::charts::{ChartData, ChartKind};
use super::{encode_xml_entities, num};

/// `[Content_Types].xml` as pptxgenjs writes it.
const CONTENT_TYPES: &str = r##"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>  <Default Extension="xml" ContentType="application/xml"/>  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>  <Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>  <Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>
"##;

/// `_rels/.rels` as pptxgenjs writes it.
const ROOT_RELS: &str = r##"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>
"##;

/// `docProps/app.xml` as pptxgenjs writes it.
const APP: &str = r##"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Microsoft Macintosh Excel</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>Sheet1</vt:lpstr></vt:vector></TitlesOfParts><Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0300</AppVersion></Properties>
"##;

/// `docProps/core.xml` as pptxgenjs writes it.
const CORE: &str = r##"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>PptxGenJS</dc:creator><cp:lastModifiedBy>PptxGenJS</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">@@TIME@@</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">@@TIME@@</dcterms:modified></cp:coreProperties>"##;

/// `xl/_rels/workbook.xml.rels` as pptxgenjs writes it.
const WORKBOOK_RELS: &str = r##"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>"##;

/// `xl/styles.xml` as pptxgenjs writes it.
const STYLES: &str = r##"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="0" formatCode="General"/></numFmts><fonts count="4"><font><sz val="9"/><color indexed="8"/><name val="Geneva"/></font><font><sz val="9"/><color indexed="8"/><name val="Geneva"/></font><font><sz val="10"/><color indexed="8"/><name val="Geneva"/></font><font><sz val="18"/><color indexed="8"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><dxfs count="0"/><tableStyles count="0"/><colors><indexedColors><rgbColor rgb="ff000000"/><rgbColor rgb="ffffffff"/><rgbColor rgb="ffff0000"/><rgbColor rgb="ff00ff00"/><rgbColor rgb="ff0000ff"/><rgbColor rgb="ffffff00"/><rgbColor rgb="ffff00ff"/><rgbColor rgb="ff00ffff"/><rgbColor rgb="ff000000"/><rgbColor rgb="ffffffff"/><rgbColor rgb="ff878787"/><rgbColor rgb="fff9f9f9"/></indexedColors></colors></styleSheet>
"##;

/// `xl/theme/theme1.xml` as pptxgenjs writes it.
const THEME: &str = r##"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light" panose="020F0302020204030204"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Jpan" typeface="Yu Gothic Light"/><a:font script="Hang" typeface="맑은 고딕"/><a:font script="Hans" typeface="DengXian Light"/><a:font script="Hant" typeface="新細明體"/><a:font script="Arab" typeface="Times New Roman"/><a:font script="Hebr" typeface="Times New Roman"/><a:font script="Thai" typeface="Tahoma"/><a:font script="Ethi" typeface="Nyala"/><a:font script="Beng" typeface="Vrinda"/><a:font script="Gujr" typeface="Shruti"/><a:font script="Khmr" typeface="MoolBoran"/><a:font script="Knda" typeface="Tunga"/><a:font script="Guru" typeface="Raavi"/><a:font script="Cans" typeface="Euphemia"/><a:font script="Cher" typeface="Plantagenet Cherokee"/><a:font script="Yiii" typeface="Microsoft Yi Baiti"/><a:font script="Tibt" typeface="Microsoft Himalaya"/><a:font script="Thaa" typeface="MV Boli"/><a:font script="Deva" typeface="Mangal"/><a:font script="Telu" typeface="Gautami"/><a:font script="Taml" typeface="Latha"/><a:font script="Syrc" typeface="Estrangelo Edessa"/><a:font script="Orya" typeface="Kalinga"/><a:font script="Mlym" typeface="Kartika"/><a:font script="Laoo" typeface="DokChampa"/><a:font script="Sinh" typeface="Iskoola Pota"/><a:font script="Mong" typeface="Mongolian Baiti"/><a:font script="Viet" typeface="Times New Roman"/><a:font script="Uigh" typeface="Microsoft Uighur"/><a:font script="Geor" typeface="Sylfaen"/></a:majorFont><a:minorFont><a:latin typeface="Calibri" panose="020F0502020204030204"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Jpan" typeface="Yu Gothic"/><a:font script="Hang" typeface="맑은 고딕"/><a:font script="Hans" typeface="DengXian"/><a:font script="Hant" typeface="新細明體"/><a:font script="Arab" typeface="Arial"/><a:font script="Hebr" typeface="Arial"/><a:font script="Thai" typeface="Tahoma"/><a:font script="Ethi" typeface="Nyala"/><a:font script="Beng" typeface="Vrinda"/><a:font script="Gujr" typeface="Shruti"/><a:font script="Khmr" typeface="DaunPenh"/><a:font script="Knda" typeface="Tunga"/><a:font script="Guru" typeface="Raavi"/><a:font script="Cans" typeface="Euphemia"/><a:font script="Cher" typeface="Plantagenet Cherokee"/><a:font script="Yiii" typeface="Microsoft Yi Baiti"/><a:font script="Tibt" typeface="Microsoft Himalaya"/><a:font script="Thaa" typeface="MV Boli"/><a:font script="Deva" typeface="Mangal"/><a:font script="Telu" typeface="Gautami"/><a:font script="Taml" typeface="Latha"/><a:font script="Syrc" typeface="Estrangelo Edessa"/><a:font script="Orya" typeface="Kalinga"/><a:font script="Mlym" typeface="Kartika"/><a:font script="Laoo" typeface="DokChampa"/><a:font script="Sinh" typeface="Iskoola Pota"/><a:font script="Mong" typeface="Mongolian Baiti"/><a:font script="Viet" typeface="Arial"/><a:font script="Uigh" typeface="Microsoft Uighur"/><a:font script="Geor" typeface="Sylfaen"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="103000"/><a:tint val="73000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:satMod val="110000"/><a:lumMod val="100000"/><a:shade val="100000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="120000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/><a:extLst><a:ext uri="{05A4C25C-085E-4340-85A3-A5531E510DB2}"><thm15:themeFamily xmlns:thm15="http://schemas.microsoft.com/office/thememl/2012/main" name="Office Theme" id="{62F939B6-93AF-4DB8-9C6B-D6C7DFDC589F}" vid="{4A3C46E8-61CC-4603-A589-7422A47A8E4A}"/></a:ext></a:extLst></a:theme>"##;

/// `xl/workbook.xml` as pptxgenjs writes it.
const WORKBOOK: &str = r##"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x15" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main"><fileVersion appName="xl" lastEdited="7" lowestEdited="6" rupBuild="10507"/><workbookPr/><bookViews><workbookView xWindow="0" yWindow="500" windowWidth="20960" windowHeight="15960"/></bookViews><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="0" concurrentCalc="0"/></workbook>
"##;

/// `xl/worksheets/_rels/sheet1.xml.rels` as pptxgenjs writes it.
const SHEET_RELS: &str = r##"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>
"##;

const XML_DECLARATION: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>";
const MAIN_NAMESPACE: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/// `LETTERS[at]`: a letter, or what a template string prints for an index past the alphabet.
fn letter(at: i64) -> String {
    match u8::try_from(at) {
        Ok(at) if at < 26 => char::from(b'A' + at).to_string(),
        _ => "undefined".to_owned(),
    }
}

/// `getExcelColName`: the column of a 1-based index (`1` is `A`, `27` is `AA`).
pub(super) fn column_name(index: usize) -> String {
    let at = i64::try_from(index).unwrap_or(i64::MAX) - 1;
    if at <= 25 {
        return letter(at);
    }
    let tens = (at as f64 / 26.0 - 1.0).floor() as i64;
    format!("{}{}", letter(tens), letter(at % 26))
}

/// `new Date().toISOString()`.
fn iso_millis_now() -> String {
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis());
    let seconds = i64::try_from(millis / 1_000).unwrap_or(0);
    let days = seconds / 86_400;
    let of_day = seconds % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z", of_day / 3_600, of_day % 3_600 / 60, of_day % 60, millis % 1_000)
}

/// `${value}` of a number that may be missing: JavaScript prints `undefined` for a hole.
fn printed(value: Option<f64>) -> String {
    value.map_or_else(|| "undefined".to_owned(), num)
}

/// `value || ''`: a zero, a hole and NaN are an empty cell.
fn or_empty(value: Option<f64>) -> String {
    value.filter(|value| *value != 0.0 && !value.is_nan()).map_or_else(String::new, num)
}

/// `value || value === 0 ? value : ''`: only a hole and NaN are empty.
fn or_empty_keeping_zero(value: Option<f64>) -> String {
    value.filter(|value| !value.is_nan()).map_or_else(String::new, num)
}

/// `value || 0`.
fn or_zero(value: Option<f64>) -> String {
    value.filter(|value| *value != 0.0 && !value.is_nan()).map_or_else(|| "0".to_owned(), num)
}

fn value_at(series: &ChartData, index: usize) -> Option<f64> {
    series.values.get(index).copied().flatten()
}

fn label_present(label: &str) -> bool {
    !label.is_empty()
}

/// `xl/sharedStrings.xml`: the blank string, the series names, then the labels of every group, last group first.
fn shared_strings(kind: ChartKind, data: &[ChartData]) -> String {
    let series = data.len();
    let mut xml = XML_DECLARATION.to_owned();
    if kind == ChartKind::Scatter {
        xml.push_str(&format!("<sst xmlns=\"{MAIN_NAMESPACE}\" count=\"{series}\" uniqueCount=\"{series}\">"));
    } else if data[0].labels.len() > 1 {
        let total = series + data[0].labels.iter().map(|group| group.iter().filter(|label| label_present(label)).count()).sum::<usize>();
        xml.push_str(&format!("<sst xmlns=\"{MAIN_NAMESPACE}\" count=\"{total}\" uniqueCount=\"{total}\">"));
        xml.push_str("<si><t/></si>");
    } else {
        let groups = data[0].labels.len();
        let total = series + groups * data[0].labels[0].len() + groups;
        let unique = series + groups * data[0].labels[0].len() + 1;
        xml.push_str(&format!("<sst xmlns=\"{MAIN_NAMESPACE}\" count=\"{total}\" uniqueCount=\"{unique}\">"));
        xml.push_str("<si><t xml:space=\"preserve\"></t></si>");
    }
    for item in data {
        let name = if item.name.is_empty() { " " } else { item.name.as_str() };
        xml.push_str(&format!("<si><t>{}</t></si>", encode_xml_entities(&name.replacen("X-Axis", "X-Values", 1))));
    }
    if kind != ChartKind::Scatter {
        for group in data[0].labels.iter().rev() {
            for label in group.iter().filter(|label| label_present(label)) {
                xml.push_str(&format!("<si><t>{}</t></si>", encode_xml_entities(label)));
            }
        }
    }
    xml.push_str("</sst>\n");
    xml
}

/// `xl/tables/table1.xml`.
fn table(kind: ChartKind, data: &[ChartData]) -> String {
    let series = data.len();
    let mut xml = XML_DECLARATION.to_owned();
    if kind == ChartKind::Scatter {
        xml.push_str(&format!(
            "<table xmlns=\"{MAIN_NAMESPACE}\" id=\"1\" name=\"Table1\" displayName=\"Table1\" ref=\"A1:{}{}\" totalsRowShown=\"0\">",
            column_name(series),
            data[0].values.len() + 1
        ));
        xml.push_str(&format!("<tableColumns count=\"{series}\">"));
        for index in 0..series {
            xml.push_str(&format!("<tableColumn id=\"{}\" name=\"{}{index}\"/>", index + 1, if index == 0 { "X-Values" } else { "Y-Value " }));
        }
    } else {
        let groups = data[0].labels.len();
        // The stray quote after the row number is in pptxgenjs's own range.
        xml.push_str(&format!(
            "<table xmlns=\"{MAIN_NAMESPACE}\" id=\"1\" name=\"Table1\" displayName=\"Table1\" ref=\"A1:{}{}'\" totalsRowShown=\"0\">",
            column_name(series + groups),
            data[0].labels[0].len() + 1
        ));
        xml.push_str(&format!("<tableColumns count=\"{}\">", series + groups));
        for index in 0..groups {
            xml.push_str(&format!("<tableColumn id=\"{}\" name=\"Column{}\"/>", index + 1, index + 1));
        }
        for (index, item) in data.iter().enumerate() {
            xml.push_str(&format!("<tableColumn id=\"{}\" name=\"{}\"/>", index + groups + 1, encode_xml_entities(&item.name)));
        }
    }
    xml.push_str("</tableColumns>");
    xml.push_str("<tableStyleInfo showFirstColumn=\"0\" showLastColumn=\"0\" showRowStripes=\"1\" showColumnStripes=\"0\"/>");
    xml.push_str("</table>");
    xml
}

/// The rows of a scatter chart: the X values down column A, one column per Y series.
fn scatter_rows(data: &[ChartData]) -> String {
    let series = data.len();
    let mut xml = format!("<row r=\"1\" spans=\"1:{series}\">");
    for index in 0..series {
        xml.push_str(&format!("<c r=\"{}1\" t=\"s\"><v>{index}</v></c>", column_name(index + 1)));
    }
    xml.push_str("</row>");
    for (index, x) in data[0].values.iter().enumerate() {
        let row = index + 2;
        xml.push_str(&format!("<row r=\"{row}\" spans=\"1:{series}\">"));
        xml.push_str(&format!("<c r=\"A{row}\"><v>{}</v></c>", printed(*x)));
        for column in 1..series {
            xml.push_str(&format!("<c r=\"{}{row}\"><v>{}</v></c>", column_name(column + 1), or_empty_keeping_zero(value_at(&data[column], index))));
        }
        xml.push_str("</row>");
    }
    xml
}

/// The rows of a category chart with one label group: the group's cells name the string of the row (the same index in
/// every label column), then the values.
fn category_rows(data: &[ChartData]) -> String {
    let series = data.len();
    let groups = data[0].labels.len();
    let mut xml = format!("<row r=\"1\" spans=\"1:{}\">", series + groups);
    for index in 0..groups {
        xml.push_str(&format!("<c r=\"{}1\" t=\"s\"><v>0</v></c>", column_name(index + 1)));
    }
    for index in 0..series {
        xml.push_str(&format!("<c r=\"{}1\" t=\"s\"><v>{}</v></c>", column_name(index + 1 + groups), index + 1));
    }
    xml.push_str("</row>");
    for index in 0..data[0].labels[0].len() {
        let row = index + 2;
        xml.push_str(&format!("<row r=\"{row}\" spans=\"1:{}\">", series + groups));
        for group in (0..groups).rev() {
            xml.push_str(&format!("<c r=\"{}{row}\" t=\"s\">", column_name(groups - group)));
            xml.push_str(&format!("<v>{}</v>", series + index + 1));
            xml.push_str("</c>");
        }
        for (column, item) in data.iter().enumerate() {
            xml.push_str(&format!("<c r=\"{}{row}\"><v>{}</v></c>", column_name(groups + column + 1), or_empty(value_at(item, index))));
        }
        xml.push_str("</row>");
    }
    xml
}

/// The rows of a category chart with several label levels: a label cell only where the level has a label, and the
/// shared string it names counted up through the levels.
fn multi_level_rows(data: &[ChartData]) -> String {
    let series = data.len();
    let levels = data[0].labels.len();
    let mut xml = format!("<row r=\"1\" spans=\"1:{}\">", series + levels);
    for index in 0..levels {
        xml.push_str(&format!("<c r=\"{}1\" t=\"s\"><v>0</v></c>", column_name(index + 1)));
    }
    for index in (levels - 1)..(series + levels - 1) {
        xml.push_str(&format!("<c r=\"{}1\" t=\"s\"><v>{index}</v></c>", column_name(index + levels)));
    }
    xml.push_str("</row>");
    let reversed: Vec<&Vec<String>> = data[0].labels.iter().rev().collect();
    for index in 0..data[0].labels[0].len() {
        let row = index + 2;
        xml.push_str(&format!("<row r=\"{row}\" spans=\"1:{}\">", series + levels));
        let mut shared = series;
        for (level, group) in reversed.iter().enumerate() {
            if !group.get(index).is_some_and(|label| label_present(label)) {
                continue;
            }
            shared += if level == 0 { 1 } else { reversed[level - 1].iter().filter(|label| label_present(label)).count() };
            xml.push_str(&format!("<c r=\"{}{row}\" t=\"s\"><v>{shared}</v></c>", column_name(index + 1 + level)));
        }
        for (column, item) in data.iter().enumerate() {
            xml.push_str(&format!("<c r=\"{}{row}\"><v>{}</v></c>", column_name(levels + column + 1), or_zero(value_at(item, index))));
        }
        xml.push_str("</row>");
    }
    xml
}

/// `xl/worksheets/sheet1.xml`.
fn sheet(kind: ChartKind, data: &[ChartData]) -> String {
    let mut xml = XML_DECLARATION.to_owned();
    xml.push_str(&format!(
        "<worksheet xmlns=\"{MAIN_NAMESPACE}\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" mc:Ignorable=\"x14ac\" xmlns:x14ac=\"http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac\">"
    ));
    let columns = if kind == ChartKind::Scatter { data.len() } else { data.len() + 1 };
    xml.push_str(&format!("<dimension ref=\"A1:{}{}\"/>", column_name(columns), data[0].values.len() + 1));
    xml.push_str("<sheetViews><sheetView tabSelected=\"1\" workbookViewId=\"0\"><selection activeCell=\"B1\" sqref=\"B1\"/></sheetView></sheetViews>");
    xml.push_str("<sheetFormatPr baseColWidth=\"10\" defaultRowHeight=\"16\"/>");
    xml.push_str("<sheetData>");
    if kind == ChartKind::Scatter {
        xml.push_str(&scatter_rows(data));
    } else if data[0].labels.len() > 1 {
        xml.push_str(&multi_level_rows(data));
    } else {
        xml.push_str(&category_rows(data));
    }
    xml.push_str("</sheetData>");
    xml.push_str("<pageMargins left=\"0.7\" right=\"0.7\" top=\"0.75\" bottom=\"0.75\" header=\"0.3\" footer=\"0.3\"/>");
    xml.push_str("</worksheet>\n");
    xml
}

/// The embedded `.xlsx` of a chart (the data must already be checked: a scatter chart has its X series, any other kind
/// has label groups on every series it draws).
pub(super) fn workbook_bytes(kind: ChartKind, data: &[ChartData]) -> Result<Vec<u8>, String> {
    let mut zip = Package::new();
    for folder in ["_rels", "docProps", "xl/_rels", "xl/tables", "xl/theme", "xl/worksheets", "xl/worksheets/_rels"] {
        zip.folder(folder);
    }
    zip.set("[Content_Types].xml", CONTENT_TYPES);
    zip.set("_rels/.rels", ROOT_RELS);
    zip.set("docProps/app.xml", APP);
    zip.set("docProps/core.xml", CORE.replace("@@TIME@@", &iso_millis_now()));
    zip.set("xl/_rels/workbook.xml.rels", WORKBOOK_RELS);
    zip.set("xl/styles.xml", STYLES);
    zip.set("xl/theme/theme1.xml", THEME);
    zip.set("xl/workbook.xml", WORKBOOK);
    zip.set("xl/worksheets/_rels/sheet1.xml.rels", SHEET_RELS);
    zip.set("xl/sharedStrings.xml", shared_strings(kind, data));
    zip.set("xl/tables/table1.xml", table(kind, data));
    zip.set("xl/worksheets/sheet1.xml", sheet(kind, data));
    zip.generate()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn series(name: &str, labels: &[&str], values: &[Option<f64>]) -> ChartData {
        ChartData { name: name.to_owned(), labels: vec![labels.iter().map(|label| (*label).to_owned()).collect()], values: values.to_vec() }
    }

    #[test]
    fn columns_are_lettered_as_the_library_letters_them() {
        assert_eq!(column_name(1), "A");
        assert_eq!(column_name(26), "Z");
        assert_eq!(column_name(27), "AA");
        assert_eq!(column_name(28), "AB");
        assert_eq!(column_name(52), "AZ");
        assert_eq!(column_name(53), "BA");
    }

    #[test]
    fn a_category_sheet_leaves_a_zero_empty_and_names_one_string_for_each_row() {
        let data = [series("Sales", &["Jan", "Feb"], &[Some(5.0), Some(0.0)]), series("Cost", &["Jan", "Feb"], &[Some(1.5), None])];
        let rows = sheet(ChartKind::Bar, &data);
        assert!(rows.contains("<dimension ref=\"A1:C3\"/>"));
        assert!(rows.contains("<row r=\"1\" spans=\"1:3\"><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\" t=\"s\"><v>1</v></c><c r=\"C1\" t=\"s\"><v>2</v></c></row>"));
        assert!(rows.contains("<row r=\"2\" spans=\"1:3\"><c r=\"A2\" t=\"s\"><v>3</v></c><c r=\"B2\"><v>5</v></c><c r=\"C2\"><v>1.5</v></c></row>"));
        assert!(rows.contains("<row r=\"3\" spans=\"1:3\"><c r=\"A3\" t=\"s\"><v>4</v></c><c r=\"B3\"><v></v></c><c r=\"C3\"><v></v></c></row>"));
        let strings = shared_strings(ChartKind::Bar, &data);
        assert!(strings.contains("count=\"5\" uniqueCount=\"5\""));
        assert!(strings.contains("<si><t xml:space=\"preserve\"></t></si><si><t>Sales</t></si><si><t>Cost</t></si><si><t>Jan</t></si><si><t>Feb</t></si>"));
        let columns = table(ChartKind::Bar, &data);
        assert!(columns.contains("ref=\"A1:C3'\""), "the stray quote of the range pptxgenjs writes");
        assert!(columns.contains("<tableColumns count=\"3\"><tableColumn id=\"1\" name=\"Column1\"/><tableColumn id=\"2\" name=\"Sales\"/><tableColumn id=\"3\" name=\"Cost\"/>"));
    }

    #[test]
    fn a_scatter_sheet_has_the_x_column_first_and_keeps_zeros() {
        let data = [
            ChartData { name: "X-Axis".to_owned(), labels: Vec::new(), values: vec![Some(1.0), Some(2.0)] },
            ChartData { name: "Y".to_owned(), labels: Vec::new(), values: vec![Some(0.0), None] },
        ];
        let rows = sheet(ChartKind::Scatter, &data);
        assert!(rows.contains("<dimension ref=\"A1:B3\"/>"));
        assert!(rows.contains("<row r=\"2\" spans=\"1:2\"><c r=\"A2\"><v>1</v></c><c r=\"B2\"><v>0</v></c></row>"));
        assert!(rows.contains("<c r=\"B3\"><v></v></c>"));
        assert!(shared_strings(ChartKind::Scatter, &data).contains("<si><t>X-Values</t></si><si><t>Y</t></si>"));
        assert!(table(ChartKind::Scatter, &data).contains("<tableColumn id=\"1\" name=\"X-Values0\"/><tableColumn id=\"2\" name=\"Y-Value 1\"/>"));
    }

    #[test]
    fn the_workbook_is_a_package_with_the_parts_of_the_library() {
        let data = [series("Sales", &["Jan"], &[Some(1.0)])];
        let workbook = Package::load(&workbook_bytes(ChartKind::Line, &data).expect("a workbook")).expect("a package");
        let names = workbook.names();
        assert_eq!(names.first().map(String::as_str), Some("_rels/"));
        for part in ["[Content_Types].xml", "xl/workbook.xml", "xl/sharedStrings.xml", "xl/tables/table1.xml", "xl/worksheets/sheet1.xml", "xl/theme/theme1.xml", "docProps/core.xml"] {
            assert!(names.iter().any(|name| name == part), "{part}");
        }
        assert!(!workbook.text("docProps/core.xml").contains("@@TIME@@"));
    }
}
