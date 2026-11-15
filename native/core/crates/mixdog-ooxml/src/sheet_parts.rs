//! `portable/portable-sheet-parts.mjs`: the parts a worksheet owns besides its cells: the sheet-protection password hash,
//! the drawing part a chart or a picture sits on, and the comments (notes) part with its legacy VML shapes.

use mixdog_js::{number_to_string, utf16_len};
use mixdog_office_base::a1::{CellRef, column_number, parse_cell_ref};

use crate::cells::Sheet;
use crate::opc::{
    add_package_relationship, ensure_content_type_override, ensure_default_content_type, part_relationship_path, posix,
    relationship_target_by_type,
};
use crate::sheet_xml::upsert_worksheet_section;
use crate::xml::{
    DRAWING_MAIN_NS, OFFICE_RELATIONSHIP_BASE, SPREADSHEET_DRAWING_NS, SPREADSHEET_MAIN, XML_HEADER, compiled, xml_decode,
    xml_encode,
};
use crate::zipio::Package;

/// `excelPasswordHash(password)`: the 16-bit hash a worksheet's `sheetProtection password` attribute holds, four upper-case
/// hex digits.
pub fn excel_password_hash(password: &str) -> String {
    let units: Vec<u16> = password.encode_utf16().collect();
    let rotate = |hash: i32| ((hash >> 14) & 0x01) | ((hash << 1) & 0x7fff);
    let mut hash: i32 = 0;
    for unit in units.iter().rev() {
        hash = rotate(hash);
        hash ^= i32::from(*unit);
    }
    hash = rotate(hash);
    hash ^= utf16_len(password) as i32;
    hash ^= 0xce4b;
    format!("{hash:04X}")
}

/// The drawing part of a worksheet and the worksheet XML that points at it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorksheetDrawing {
    pub part: String,
    pub worksheet: String,
}

/// The first `{stem}{n}{extension}` (n from 1) that the package does not hold.
fn free_part(zip: &Package, stem: &str, extension: &str) -> String {
    let mut ordinal = 1_u64;
    while zip.file(&format!("{stem}{ordinal}{extension}")).is_some() {
        ordinal += 1;
    }
    format!("{stem}{ordinal}{extension}")
}

/// `ensureWorksheetDrawing(zip, sheet, worksheetXml)`: the drawing part the worksheet is linked to, created (with its content
/// type, its relationship and the `drawing` element of the worksheet) when it has none.
pub fn ensure_worksheet_drawing(zip: &mut Package, sheet: &Sheet, worksheet_xml: &str) -> WorksheetDrawing {
    let relationships = part_relationship_path(&sheet.path);
    let directory = posix::dirname(&sheet.path);
    let linked = relationship_target_by_type(&zip.text(&relationships), "drawing");
    if !linked.is_empty() {
        return WorksheetDrawing { part: posix::normalize(&posix::join(&[directory.as_str(), linked.as_str()])), worksheet: worksheet_xml.to_owned() };
    }
    let part = free_part(zip, "xl/drawings/drawing", ".xml");
    zip.set(
        &part,
        format!("{XML_HEADER}<xdr:wsDr xmlns:xdr=\"{SPREADSHEET_DRAWING_NS}\" xmlns:a=\"{DRAWING_MAIN_NS}\" xmlns:r=\"{OFFICE_RELATIONSHIP_BASE}\"></xdr:wsDr>"),
    );
    ensure_content_type_override(zip, &format!("/{part}"), "application/vnd.openxmlformats-officedocument.drawing+xml");
    let relationship_id =
        add_package_relationship(zip, &relationships, &format!("{OFFICE_RELATIONSHIP_BASE}/drawing"), &posix::relative(&directory, &part), "");
    let worksheet = upsert_worksheet_section(worksheet_xml, "drawing", &format!("<drawing r:id=\"{relationship_id}\"/>"));
    WorksheetDrawing { part, worksheet }
}

const SHEET_COMMENTS_CONTENT_TYPE: &str = "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml";

const VML_SHELL: &str = "<xml xmlns:v=\"urn:schemas-microsoft-com:vml\" xmlns:o=\"urn:schemas-microsoft-com:office:office\" \
xmlns:x=\"urn:schemas-microsoft-com:office:excel\">\
<o:shapelayout v:ext=\"edit\"><o:idmap v:ext=\"edit\" data=\"1\"/></o:shapelayout>\
<v:shapetype id=\"_x0000_t202\" coordsize=\"21600,21600\" o:spt=\"202\" path=\"m,l,21600r21600,l21600,xe\">\
<v:stroke joinstyle=\"miter\"/><v:path gradientshapeok=\"t\" o:connecttype=\"rect\"/></v:shapetype>\
</xml>";

fn vml_note_shape(id: usize, parsed: &CellRef) -> String {
    let column = column_number(&parsed.col) - 1.0;
    let row = parsed.row as f64 - 1.0;
    let (column_1, column_3) = (number_to_string(column + 1.0), number_to_string(column + 3.0));
    let (row_text, row_3) = (number_to_string(row), number_to_string(row + 3.0));
    format!(
        "<v:shape id=\"_x0000_s{id}\" type=\"#_x0000_t202\" \
style=\"position:absolute;margin-left:60pt;margin-top:2pt;width:120pt;height:60pt;z-index:1;visibility:hidden\" \
fillcolor=\"#ffffe1\" o:insetmode=\"auto\">\
<v:fill color2=\"#ffffe1\"/><v:shadow on=\"t\" color=\"black\" obscured=\"t\"/><v:path o:connecttype=\"none\"/>\
<v:textbox style=\"mso-direction-alt:auto\"><div style=\"text-align:left\"></div></v:textbox>\
<x:ClientData ObjectType=\"Note\"><x:MoveWithCells/><x:SizeWithCells/>\
<x:Anchor>{column_1},15,{row_text},2,{column_3},15,{row_3},16</x:Anchor>\
<x:AutoFill>False</x:AutoFill><x:Row>{row_text}</x:Row><x:Column>{}</x:Column></x:ClientData>\
</v:shape>",
        number_to_string(column)
    )
}

/// The comments part and the VML drawing a worksheet's notes live in, and the worksheet XML that points at them.
struct WorksheetComments {
    comments_part: String,
    vml_part: String,
    worksheet: String,
}

fn ensure_worksheet_comments(zip: &mut Package, sheet: &Sheet, worksheet_xml: &str) -> WorksheetComments {
    let relationships = part_relationship_path(&sheet.path);
    let rels = zip.text(&relationships);
    let directory = posix::dirname(&sheet.path);
    let resolve = |target: String| if target.is_empty() { target } else { posix::normalize(&posix::join(&[directory.as_str(), target.as_str()])) };
    let mut comments_part = resolve(relationship_target_by_type(&rels, "comments"));
    let mut vml_part = resolve(relationship_target_by_type(&rels, "vmlDrawing"));
    let mut worksheet = worksheet_xml.to_owned();
    if comments_part.is_empty() {
        comments_part = free_part(zip, "xl/comments", ".xml");
        zip.set(
            &comments_part,
            format!("{XML_HEADER}<comments xmlns=\"{SPREADSHEET_MAIN}\"><authors><author>Mixdog</author></authors><commentList></commentList></comments>"),
        );
        ensure_content_type_override(zip, &format!("/{comments_part}"), SHEET_COMMENTS_CONTENT_TYPE);
        add_package_relationship(
            zip,
            &relationships,
            &format!("{OFFICE_RELATIONSHIP_BASE}/comments"),
            &posix::relative(&directory, &comments_part),
            "",
        );
    }
    if vml_part.is_empty() {
        vml_part = free_part(zip, "xl/drawings/vmlDrawing", ".vml");
        zip.set(&vml_part, VML_SHELL);
        ensure_default_content_type(zip, "vml", "application/vnd.openxmlformats-officedocument.vmlDrawing");
        let relationship_id = add_package_relationship(
            zip,
            &relationships,
            &format!("{OFFICE_RELATIONSHIP_BASE}/vmlDrawing"),
            &posix::relative(&directory, &vml_part),
            "",
        );
        worksheet = upsert_worksheet_section(&worksheet, "legacyDrawing", &format!("<legacyDrawing r:id=\"{relationship_id}\"/>"));
    }
    WorksheetComments { comments_part, vml_part, worksheet }
}

/// A note to put on a cell.
#[derive(Debug, Clone)]
pub struct NoteRequest<'a> {
    pub cell: &'a str,
    pub text: &'a str,
    pub author: &'a str,
    /// Add the text to the note the cell already has (a note that already holds it is left as it is).
    pub append: bool,
}

impl<'a> NoteRequest<'a> {
    /// A note by the default author that replaces what the cell has.
    pub fn new(cell: &'a str, text: &'a str) -> Self {
        Self { cell, text, author: "Mixdog", append: false }
    }
}

/// What [`write_worksheet_note`] answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteWritten {
    pub worksheet: String,
    pub changed: bool,
    /// The cell reference as written; `None` when nothing changed.
    pub cell: Option<String>,
}

/// `writeWorksheetNote(zip, sheet, worksheetXml, { cell, text, author, append })`: the note of a cell written to the
/// worksheet's comments part, with its VML shape when the cell had none.
pub fn write_worksheet_note(zip: &mut Package, sheet: &Sheet, worksheet_xml: &str, request: &NoteRequest<'_>) -> Result<NoteWritten, String> {
    let parsed = parse_cell_ref(request.cell)?;
    let context = ensure_worksheet_comments(zip, sheet, worksheet_xml);
    let mut comments = zip.text(&context.comments_part);
    let mut authors: Vec<String> = compiled(r"<author>([\s\S]*?)<\/author>", "g")
        .captures_iter(&comments)
        .map(|found| xml_decode(found.get(1).unwrap_or("")))
        .collect();
    let author_id = match authors.iter().position(|author| author == request.author) {
        Some(found) => found,
        None => {
            authors.push(request.author.to_owned());
            let list: String = authors.iter().map(|entry| format!("<author>{}</author>", xml_encode(entry))).collect();
            let replacement = format!("<authors>{list}</authors>");
            if let Some(range) = compiled(r"<authors>[\s\S]*?<\/authors>", "").find(&comments) {
                comments = format!("{}{replacement}{}", &comments[..range.start], &comments[range.end..]);
            }
            authors.len() - 1
        }
    };
    let pattern = compiled(&format!(r#"<comment\b[^>]*\bref="{}"[^>]*>[\s\S]*?<\/comment>"#, parsed.reference), "");
    let existing = pattern.find(&comments);
    let previous: String = match &existing {
        Some(range) => compiled(r"<t(?:\s[^>]*)?>([\s\S]*?)<\/t>", "g")
            .captures_iter(&comments[range.clone()])
            .map(|found| xml_decode(found.get(1).unwrap_or("")))
            .collect(),
        None => String::new(),
    };
    if request.append && previous.contains(request.text) {
        return Ok(NoteWritten { worksheet: context.worksheet, changed: false, cell: None });
    }
    let body = if request.append && !previous.is_empty() { format!("{previous}\n{}", request.text) } else { request.text.to_owned() };
    if let Some(range) = &existing {
        comments = format!("{}{}", &comments[..range.start], &comments[range.end..]);
    }
    let entry = format!(
        "<comment ref=\"{}\" authorId=\"{author_id}\"><text><r><t xml:space=\"preserve\">{}</t></r></text></comment>",
        parsed.reference,
        xml_encode(&body)
    );
    zip.set(&context.comments_part, comments.replacen("</commentList>", &format!("{entry}</commentList>"), 1));
    if existing.is_none() {
        let vml = zip.text(&context.vml_part);
        let shape_id = 1025 + compiled(r"<v:shape\b", "g").find_iter(&vml).count();
        zip.set(&context.vml_part, vml.replacen("</xml>", &format!("{}</xml>", vml_note_shape(shape_id, &parsed)), 1));
    }
    Ok(NoteWritten { worksheet: context.worksheet, changed: true, cell: Some(parsed.reference) })
}

#[cfg(test)]
mod tests {
    use super::*;

    // `$$`, `$&`, `$'` and "$`" are String.replace patterns: user text that holds them must land in the file exactly as
    // written.
    const DOLLARS: &str = "math $$x$$ cost $& and $' or $` then $1";

    fn workbook() -> (Package, Sheet) {
        let mut zip = Package::new();
        zip.set("[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"></Types>");
        zip.set("xl/worksheets/sheet1.xml", "<worksheet><sheetData/></worksheet>");
        let sheet = Sheet { name: "S".to_owned(), path: "xl/worksheets/sheet1.xml".to_owned(), rid: "rId1".to_owned(), visibility: "visible" };
        (zip, sheet)
    }

    #[test]
    fn the_protection_hash_is_excels() {
        assert_eq!(excel_password_hash(""), "CE4B");
        assert_eq!(excel_password_hash("a"), "CE88");
        assert_eq!(excel_password_hash("password"), "83AF");
        assert_eq!(excel_password_hash("가"), "964A");
        assert_eq!(excel_password_hash("😀x"), "85F1");
    }

    #[test]
    fn a_drawing_is_created_once_and_found_again() {
        let (mut zip, sheet) = workbook();
        let first = ensure_worksheet_drawing(&mut zip, &sheet, "<worksheet><sheetData/></worksheet>");
        assert_eq!(first.part, "xl/drawings/drawing1.xml");
        assert_eq!(first.worksheet, "<worksheet><sheetData/><drawing r:id=\"rId1\"/></worksheet>");
        assert!(zip.text("[Content_Types].xml").contains("PartName=\"/xl/drawings/drawing1.xml\""));
        assert!(zip.text("xl/worksheets/_rels/sheet1.xml.rels").contains("Target=\"../drawings/drawing1.xml\""));
        let again = ensure_worksheet_drawing(&mut zip, &sheet, &first.worksheet);
        assert_eq!(again, WorksheetDrawing { part: "xl/drawings/drawing1.xml".to_owned(), worksheet: first.worksheet });
    }

    #[test]
    fn a_note_keeps_dollar_patterns_and_appends_once() {
        let (mut zip, sheet) = workbook();
        let first = write_worksheet_note(&mut zip, &sheet, "<worksheet><sheetData/></worksheet>", &NoteRequest::new("b2", DOLLARS)).unwrap();
        assert_eq!((first.changed, first.cell.as_deref()), (true, Some("B2")));
        assert!(first.worksheet.contains("<legacyDrawing r:id=\"rId2\"/>"));
        assert!(zip.text("xl/comments1.xml").contains(&xml_encode(DOLLARS)));
        assert!(zip.text("xl/drawings/vmlDrawing1.vml").contains("<x:Anchor>2,15,1,2,4,15,4,16</x:Anchor>"));
        let mut append = NoteRequest::new("B2", "second");
        append.append = true;
        append.author = "Ann";
        let second = write_worksheet_note(&mut zip, &sheet, &first.worksheet, &append).unwrap();
        assert!(second.changed);
        let comments = zip.text("xl/comments1.xml");
        assert!(comments.contains("<authors><author>Mixdog</author><author>Ann</author></authors>"));
        assert!(comments.contains(&format!("<comment ref=\"B2\" authorId=\"1\"><text><r><t xml:space=\"preserve\">{}\nsecond</t></r></text></comment>", xml_encode(DOLLARS))));
        assert_eq!(comments.matches("<comment ref=").count(), 1);
        let repeat = write_worksheet_note(&mut zip, &sheet, &second.worksheet, &append).unwrap();
        assert_eq!((repeat.changed, repeat.cell), (false, None));
        assert_eq!(zip.text("xl/drawings/vmlDrawing1.vml").matches("<v:shape id=").count(), 1);
        assert_eq!(write_worksheet_note(&mut zip, &sheet, &first.worksheet, &NoteRequest::new("0", "x")).unwrap_err(), "Invalid cell reference: 0");
    }

    #[test]
    fn package_parts_keep_dollar_patterns_in_content_types_and_relationship_targets() {
        let mut zip = Package::new();
        zip.set("[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"></Types>");
        zip.set("_rels/.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>");
        ensure_content_type_override(&mut zip, "/p$$q.xml", "text/$1$`x");
        ensure_default_content_type(&mut zip, "a$$b", "text/$1$`x");
        let types = zip.text("[Content_Types].xml");
        assert!(types.contains("PartName=\"/p$$q.xml\" ContentType=\"text/$1$`x\""));
        assert!(types.contains("Extension=\"a$$b\" ContentType=\"text/$1$`x\""));
        add_package_relationship(&mut zip, "_rels/.rels", "http://example.test/rel", "files/$$x$`y.xml", "");
        assert!(zip.text("_rels/.rels").contains("Target=\"files/$$x$`y.xml\""));
    }
}
