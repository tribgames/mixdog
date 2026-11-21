//! The operator list of a page (what the content stream asks, in order, with the transform in force where things are
//! painted), the viewable annotations with their actions, the outline with the page each entry opens, and named
//! destinations.

use mixdog_pdf::fontdraw::PageFonts;
use mixdog_pdf::oplist::{self, FontProvider, GStateValue, MarkedData, Op, PaintOp, TextItem};
use mixdog_pdf::outline_read::{self, Dest};
use mixdog_pdf::{Obj, Ref, annotations};

use crate::read_support::{FONT_RESOURCES, build, one_page, open, stream};

fn ops_of(content: &str, resources: &str, extra: &[(u32, Vec<u8>)]) -> Vec<(String, [f64; 6])> {
    let document = open(one_page(content, resources, extra));
    let page = document.page(0).expect("a page");
    let list = oplist::get_operator_list(&document, &page, None).expect("the operator list");
    list.with_transforms().into_iter().map(|(ctm, op)| (tag(op), ctm)).collect()
}

fn tag(op: &Op) -> String {
    match op {
        Op::Save => "save".into(),
        Op::Restore => "restore".into(),
        Op::Transform(_) => "cm".into(),
        Op::ConstructPath { paint, .. } => format!("path {paint:?}"),
        Op::SetLineWidth(_) => "w".into(),
        Op::SetDash { .. } => "d".into(),
        Op::SetFillRgbColor(hex) => format!("fill {hex}"),
        Op::SetStrokeRgbColor(hex) => format!("stroke {hex}"),
        Op::BeginText => "BT".into(),
        Op::EndText => "ET".into(),
        Op::SetFont { .. } => "Tf".into(),
        Op::ShowText(_) => "Tj".into(),
        Op::PaintImage(_) => "image".into(),
        Op::PaintInlineImage(_) => "inline image".into(),
        Op::FormBegin { .. } => "form begin".into(),
        Op::FormEnd => "form end".into(),
        Op::BeginMarkedContent(Some(tag)) => format!("BMC {tag}"),
        Op::BeginMarkedContentProps { tag, .. } => format!("BDC {tag}"),
        Op::EndMarkedContent => "EMC".into(),
        Op::SetGState(_) => "gs".into(),
        Op::Clip => "clip".into(),
        other => format!("{other:?}").split(['(', ' ', '{']).next().unwrap_or("").to_owned(),
    }
}

fn names(list: &[(String, [f64; 6])]) -> Vec<&str> {
    list.iter().map(|(name, _)| name.as_str()).collect()
}

const IDENTITY: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

#[test]
fn paths_colours_and_line_state_come_out_in_content_order_with_the_transform_in_force() {
    let list = ops_of("q 2 0 0 2 10 20 cm 1 0 0 rg 10 20 30 40 re f Q 3 w [4 2] 1 d 0 0 1 RG 0 0 m 50 50 l S", "<< >>", &[]);
    assert_eq!(names(&list), ["save", "cm", "fill #ff0000", "path Fill", "restore", "w", "d", "stroke #0000ff", "path Stroke"]);
    assert_eq!(list[3].1, [2.0, 0.0, 0.0, 2.0, 10.0, 20.0], "painted under the cm");
    assert_eq!(list[8].1, IDENTITY, "the restore dropped it");
}

#[test]
fn a_rectangle_is_a_closed_path_of_its_four_corners_with_its_bounds() {
    let document = open(one_page("10 20 30 40 re f", "<< >>", &[]));
    let page = document.page(0).unwrap();
    let list = oplist::get_operator_list(&document, &page, None).unwrap();
    let Some(Op::ConstructPath { paint: PaintOp::Fill, path: Some(path) }) = list.ops().first() else {
        panic!("a filled path first: {:?}", list.ops());
    };
    assert_eq!(path.min_max, [10.0, 20.0, 40.0, 60.0]);
    let subpaths = path.subpaths();
    assert_eq!(subpaths.len(), 1);
    assert_eq!(subpaths[0].points, vec![(10.0, 20.0), (40.0, 20.0), (40.0, 60.0), (10.0, 60.0)]);
    assert!(!subpaths[0].curved);
}

#[test]
fn the_painting_operators_name_how_a_path_is_painted() {
    let document = open(one_page("0 0 5 5 re S 0 0 5 5 re f* 0 0 5 5 re B 0 0 5 5 re W n", "<< >>", &[]));
    let page = document.page(0).unwrap();
    let list = oplist::get_operator_list(&document, &page, None).unwrap();
    let paints: Vec<_> = list
        .ops()
        .iter()
        .filter_map(|op| match op {
            Op::ConstructPath { paint, .. } => Some(*paint),
            _ => None,
        })
        .collect();
    assert_eq!(paints, [PaintOp::Stroke, PaintOp::EoFill, PaintOp::FillStroke, PaintOp::EndPath]);
    assert!(list.ops().iter().any(|op| matches!(op, Op::Clip)));
}

#[test]
fn text_operators_keep_the_size_and_the_glyphs_and_adjustments_of_a_show() {
    let document = open(one_page("BT /F1 12 Tf [(A) -250 (B)] TJ ET", FONT_RESOURCES, &[]));
    let page = document.page(0).unwrap();
    let fonts = PageFonts::new(&document);
    let list = oplist::get_operator_list(&document, &page, Some(&fonts as &dyn FontProvider)).unwrap();
    let mut seen = Vec::new();
    for op in list.ops() {
        match op {
            Op::SetFont { size, .. } => seen.push(format!("font {}", size.as_num().unwrap())),
            Op::ShowText(items) => {
                let glyphs = items.iter().filter(|i| matches!(i, TextItem::Glyph(_))).count();
                let adjusts: Vec<f64> = items
                    .iter()
                    .filter_map(|i| match i {
                        TextItem::Adjust(by) => Some(*by),
                        _ => None,
                    })
                    .collect();
                seen.push(format!("show {glyphs} glyphs {adjusts:?}"));
            }
            _ => {}
        }
    }
    assert_eq!(seen, ["font 12", "show 2 glyphs [-250.0]"]);
}

#[test]
fn marked_content_keeps_its_tag_and_its_identifier() {
    let list = ops_of("/Artifact BMC EMC /P << /MCID 3 >> BDC EMC", "<< >>", &[]);
    assert_eq!(names(&list), ["BMC Artifact", "EMC", "BDC P", "EMC"]);
    let document = open(one_page("/P << /MCID 3 >> BDC EMC", "<< >>", &[]));
    let page = document.page(0).unwrap();
    let list = oplist::get_operator_list(&document, &page, None).unwrap();
    assert!(matches!(
        &list.ops()[0],
        Op::BeginMarkedContentProps { tag, data: MarkedData::Mcid(Obj::Num(n)) } if tag == "P" && *n == 3.0
    ));
}

#[test]
fn an_image_xobject_and_an_inline_image_are_painted_under_their_matrix() {
    let image = stream("/Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8", &[0, 255]);
    let list = ops_of(
        "q 20 0 0 10 5 5 cm /Im0 Do Q q 4 0 0 4 0 0 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \u{1}\u{2}\u{3}\u{4} EI Q",
        "<< /XObject << /Im0 6 0 R >> >>",
        &[(6, image)],
    );
    assert_eq!(names(&list), ["save", "cm", "image", "restore", "save", "cm", "inline image", "restore"]);
    assert_eq!(list[2].1, [20.0, 0.0, 0.0, 10.0, 5.0, 5.0]);
    assert_eq!(list[6].1, [4.0, 0.0, 0.0, 4.0, 0.0, 0.0]);

    let document = open(one_page(
        "/Im0 Do",
        "<< /XObject << /Im0 6 0 R >> >>",
        &[(6, stream("/Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8", &[0, 255]))],
    ));
    let page = document.page(0).unwrap();
    let list = oplist::get_operator_list(&document, &page, None).unwrap();
    let Some(Op::PaintImage(image)) = list.ops().first() else { panic!("an image: {:?}", list.ops()) };
    assert_eq!((image.width, image.height), (2.0, 1.0));
}

#[test]
fn a_form_is_bracketed_and_its_matrix_applies_inside_it() {
    let form = stream("/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Matrix [1 0 0 1 5 0]", b"0 0 4 4 re f");
    let list = ops_of("2 0 0 2 0 0 cm /Fm0 Do 0 0 1 1 re f", "<< /XObject << /Fm0 6 0 R >> >>", &[(6, form)]);
    assert_eq!(names(&list), ["cm", "form begin", "path Fill", "form end", "path Fill"]);
    assert_eq!(list[2].1, [2.0, 0.0, 0.0, 2.0, 10.0, 0.0]);
    assert_eq!(list[4].1, [2.0, 0.0, 0.0, 2.0, 0.0, 0.0]);
}

#[test]
fn a_graphics_state_dictionary_becomes_its_entries() {
    let document = open(one_page("/GS0 gs", "<< /ExtGState << /GS0 << /LW 5 /CA 0.5 >> >> >>", &[]));
    let page = document.page(0).unwrap();
    let list = oplist::get_operator_list(&document, &page, None).unwrap();
    let Some(Op::SetGState(entries)) = list.ops().first() else { panic!("gs: {:?}", list.ops()) };
    assert!(entries.iter().any(|(key, value)| key == "LW" && matches!(value, GStateValue::Number(n) if *n == 5.0)));
    assert!(entries.iter().any(|(key, _)| key == "CA"));
}

fn linked_document() -> mixdog_pdf::document::Document {
    let objects: Vec<(u32, Vec<u8>)> = vec![
        (1, b"<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R /Names << /Dests << /Names [(sec) [3 0 R /XYZ 0 0 null]] >> >> >>".to_vec()),
        (2, b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>".to_vec()),
        (
            3,
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [
                << /Type /Annot /Subtype /Link /Rect [100 100 10 10] /A << /S /URI /URI (https://example.com/a) >> >>
                << /Type /Annot /Subtype /Link /Rect [0 0 5 5] /F 32 /Contents (no view) >>
                << /Type /Annot /Subtype /Link /Rect [20 20 30 30] /F 2 /Dest [4 0 R /Fit] /Contents (hidden) >>
                << /Type /Annot /Subtype /Link /Rect [40 40 50 50] /F 1 /Contents (invisible flag) >>
                << /Type /Annot /Subtype /Link /Rect [60 60 70 70] /F 4 /Contents (print only) >>
                << /Type /Annot /Subtype /Foo /Rect [80 80 90 90] /F 1 /Contents (unknown subtype, invisible) >>
              ] >>"
                .to_vec(),
        ),
        (4, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>".to_vec()),
        (6, b"<< /Type /Outlines /First 7 0 R /Last 10 0 R /Count 3 >>".to_vec()),
        (7, b"<< /Title (Chapter 1) /Parent 6 0 R /Next 8 0 R /First 9 0 R /Last 9 0 R /Count 1 /Dest [3 0 R /Fit] /F 3 /C [1 0 0] >>".to_vec()),
        (8, b"<< /Title (Chapter 2) /Parent 6 0 R /Prev 7 0 R /Next 10 0 R /Dest [4 0 R /Fit] >>".to_vec()),
        (9, b"<< /Title (Section 1.1) /Parent 7 0 R /Dest (sec) >>".to_vec()),
        (10, b"<< /Title (Web) /Parent 6 0 R /Prev 8 0 R /A << /S /URI /URI (https://example.org/x) >> >>".to_vec()),
    ];
    open(build(&objects))
}

#[test]
fn the_annotation_list_drops_only_what_is_not_viewable_and_links_carry_their_action() {
    let document = linked_document();
    let page = document.page(0).unwrap();
    let list = annotations::get_annotations(&document, &page).expect("annotations");
    // Viewable is: not NoView (32), and not Invisible (1) unless the subtype is one the reader has no class for.
    // Hidden (2) and print-only (4) annotations stay in the data; Hidden ones are only not drawn (next test).
    let contents: Vec<&str> = list.iter().map(|a| a.contents.as_str()).collect();
    assert_eq!(contents, ["", "hidden", "invisible flag", "print only"]);
    // A link's own Invisible flag is cleared when it is read; the others are kept as written.
    let flags: Vec<i64> = list.iter().map(|a| a.annotation_flags).collect();
    assert_eq!(flags, [0, 2, 0, 4]);
    assert_eq!(list[0].subtype.as_deref(), Some("Link"));
    assert_eq!(list[0].rect, Some([10.0, 10.0, 100.0, 100.0]), "a rectangle is normalised");
    assert_eq!(list[0].action.url.as_deref(), Some("https://example.com/a"));
    let Some(Dest::Explicit(dest)) = &list[1].action.dest else { panic!("an explicit destination") };
    assert!(matches!(dest[0], Obj::Ref(r) if r == Ref::new(4, 0)));
    assert_eq!(outline_read::get_page_index(&document, Ref::new(4, 0)).unwrap(), 1);
}

#[test]
fn link_actions_are_read_by_their_type() {
    let link = |action: &str| format!("<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /A << {action} >> >>").into_bytes();
    let objects: Vec<(u32, Vec<u8>)> = vec![
        (1, b"<< /Type /Catalog /Pages 2 0 R >>".to_vec()),
        (2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec()),
        (3, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [6 0 R 7 0 R 8 0 R 9 0 R 10 0 R 11 0 R] >>".to_vec()),
        (6, link("/S /ResetForm /Fields [(name) 12 0 R] /Flags 1")),
        (7, link("/S /SetOCGState /State [/OFF 12 0 R] /PreserveRB false")),
        (8, link("/S /JavaScript /JS (app.launchURL(\"https://example.com/js\", true))")),
        (9, link("/S /GoToR /F (other.pdf) /NewWindow true")),
        (10, link("/S /Named /N /NextPage")),
        (11, link("/S /URI /URI (https://example.com/u)")),
        (12, b"<< /Type /OCG /Name (layer) >>".to_vec()),
    ];
    let document = open(build(&objects));
    let page = document.page(0).unwrap();
    let list = annotations::get_annotations(&document, &page).expect("annotations");
    assert_eq!(list.len(), 6);
    let reset = list[0].action.reset_form.as_ref().expect("a reset form");
    assert_eq!((reset.fields.as_slice(), reset.refs.as_slice(), reset.include), (["name".to_owned()].as_slice(), ["12R".to_owned()].as_slice(), false));
    let ocg = list[1].action.set_ocg_state.as_ref().expect("an OCG state");
    assert_eq!((ocg.state.as_slice(), ocg.preserve_rb), (["OFF".to_owned(), "12R".to_owned()].as_slice(), false));
    assert_eq!((list[2].action.url.as_deref(), list[2].action.new_window), (Some("https://example.com/js"), Some(true)));
    assert_eq!((list[3].action.unsafe_url.as_deref(), list[3].action.new_window), (Some("other.pdf"), Some(true)));
    assert_eq!(list[4].action.action.as_deref(), Some("NextPage"));
    assert_eq!(list[5].action.url.as_deref(), Some("https://example.com/u"));
}

#[test]
fn quote_operators_move_to_the_next_line_and_set_spacing_before_the_show() {
    let document = open(one_page("BT /F1 12 Tf (A) ' 3 4 (B) \" ET", FONT_RESOURCES, &[]));
    let page = document.page(0).unwrap();
    let fonts = PageFonts::new(&document);
    let list = oplist::get_operator_list(&document, &page, Some(&fonts as &dyn FontProvider)).unwrap();
    let kinds: Vec<String> = list
        .ops()
        .iter()
        .map(|op| match op {
            Op::Param(param, _) => format!("{param:?}"),
            Op::ShowText(items) => format!("show {}", items.len()),
            other => tag(other),
        })
        .collect();
    assert_eq!(kinds, ["BT", "Tf", "NextLine", "show 1", "NextLine", "SetWordSpacing", "SetCharSpacing", "show 1", "ET"]);
}

#[test]
fn optional_content_marked_content_keeps_its_properties() {
    let document = open(one_page("/OC /MC0 BDC EMC", "<< /Properties << /MC0 6 0 R >> >>", &[(6, b"<< /Type /OCG /Name (layer) >>".to_vec())]));
    let page = document.page(0).unwrap();
    let list = oplist::get_operator_list(&document, &page, None).unwrap();
    assert!(matches!(
        &list.ops()[0],
        Op::BeginMarkedContentProps { tag, data: MarkedData::OptionalContent(Some(_)) } if tag == "OC"
    ));
}

#[test]
fn a_hidden_annotation_is_not_drawn_but_a_print_only_one_is() {
    let appearance = |content: &str| stream("/Type /XObject /Subtype /Form /BBox [0 0 10 10]", content.as_bytes());
    let objects: Vec<(u32, Vec<u8>)> = vec![
        (1, b"<< /Type /Catalog /Pages 2 0 R >>".to_vec()),
        (2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec()),
        (3, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [6 0 R 7 0 R 8 0 R] >>".to_vec()),
        (6, b"<< /Type /Annot /Subtype /Square /Rect [0 0 10 10] /F 2 /AP << /N 9 0 R >> >>".to_vec()),
        (7, b"<< /Type /Annot /Subtype /Square /Rect [20 0 30 10] /F 4 /AP << /N 10 0 R >> >>".to_vec()),
        (8, b"<< /Type /Annot /Subtype /Square /Rect [40 0 50 10] /F 32 /AP << /N 11 0 R >> >>".to_vec()),
        (9, appearance("0 0 5 5 re S")),
        (10, appearance("0 0 5 5 re f")),
        (11, appearance("0 0 5 5 re B")),
    ];
    let document = open(build(&objects));
    let page = document.page(0).unwrap();
    let list = oplist::get_operator_list_with_annotations(&document, &page, None).unwrap();
    let paints: Vec<PaintOp> = list
        .ops()
        .iter()
        .filter_map(|op| match op {
            Op::ConstructPath { paint, .. } => Some(*paint),
            _ => None,
        })
        .collect();
    assert_eq!(paints, [PaintOp::Fill], "only the print-only square is painted");
}

#[test]
fn the_outline_is_a_tree_of_titles_with_style_colour_and_destination() {
    let document = linked_document();
    let outline = outline_read::get_outline(&document).expect("outline").expect("an outline");
    let titles: Vec<&str> = outline.iter().map(|item| item.title.as_str()).collect();
    assert_eq!(titles, ["Chapter 1", "Chapter 2", "Web"]);
    assert_eq!(outline[0].color, [255, 0, 0]);
    assert!(outline[0].italic && outline[0].bold);
    assert_eq!(outline[1].color, [0, 0, 0]);
    assert!(!outline[1].bold && !outline[1].italic);
    assert_eq!(outline[0].items.len(), 1);
    assert_eq!(outline[0].items[0].title, "Section 1.1");
    assert!(matches!(&outline[0].items[0].dest, Some(Dest::Named(name)) if name == "sec"));
    let Some(Dest::Explicit(dest)) = &outline[1].dest else { panic!("explicit") };
    let Obj::Ref(page) = dest[0] else { panic!("a page reference") };
    assert_eq!(outline_read::get_page_index(&document, page).unwrap(), 1);
    assert_eq!(outline[2].url.as_deref(), Some("https://example.org/x"));
}

#[test]
fn a_named_destination_is_found_in_the_name_tree_and_an_unknown_one_is_not() {
    let document = linked_document();
    let dest = outline_read::get_destination(&document, "sec").expect("lookup").expect("found");
    assert!(matches!(dest[0], Obj::Ref(r) if r == Ref::new(3, 0)));
    assert!(matches!(&dest[1], Obj::Name(name) if &**name == "XYZ"));
    assert_eq!(outline_read::get_page_index(&document, Ref::new(3, 0)).unwrap(), 0);
    assert!(outline_read::get_destination(&document, "missing").expect("lookup").is_none());
}

#[test]
fn a_document_without_an_outline_has_none() {
    let document = open(one_page("", "<< >>", &[]));
    assert!(outline_read::get_outline(&document).expect("outline").is_none());
}
