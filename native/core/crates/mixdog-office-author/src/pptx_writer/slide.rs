//! A slide: its objects and relationships as `Slide` holds them in pptxgenjs, and the XML of `ppt/slides/slide<n>.xml`,
//! its relationships and its notes slide. The `p:cSld` writer is shared by the slide, the slide layout and the slide
//! master (`slideObjectToXml`).

use super::media::{ImageFile, MediaRel, background_rel, image_extension, picture_rel};
use super::shapes::{Fill, ImageObject, ImageOptions, ShapeObject, ShapeOptions, color_selection, color_selection_of, image_xml, shape_xml};
use super::theme;
use super::{Axis, CRLF, Dim, Layout, encode_xml_entities, num, or, smart_parse, val_to_pts};

/// `BackgroundProps`: a colour (`fill` is the same, and wins), a transparency, or a picture.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Background {
    pub color: Option<String>,
    pub fill: Option<String>,
    pub transparency: Option<f64>,
    pub data: Option<String>,
    pub file: Option<ImageFile>,
}

/// The margin of a slide number: four values (top, right, bottom, left, in points) or one for all.
#[derive(Debug, Clone, PartialEq)]
pub enum SlideNumberMargin {
    All(f64),
    Each(Vec<f64>),
}

/// `SlideNumberProps`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SlideNumber {
    pub x: Option<Dim>,
    pub y: Option<Dim>,
    pub w: Option<Dim>,
    pub h: Option<Dim>,
    pub margin: Option<SlideNumberMargin>,
    pub valign: Option<String>,
    pub align: Option<String>,
    pub font_face: Option<String>,
    pub font_size: Option<f64>,
    pub color: Option<String>,
    pub bold: bool,
}

/// What a slide holds in order: shapes and pictures draw, a notes object only takes a place (it is one of the
/// slide's objects, so it counts in the ids of the ones after it).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum SlideObject {
    Shape(ShapeObject),
    Image(ImageObject),
    Notes(String),
}

/// A hyperlink relationship (`type: 'hyperlink'` of `slide._rels`).
#[derive(Debug, Clone, PartialEq)]
struct HyperlinkRel {
    rid: usize,
    /// A link to a slide of the deck: the target is the slide number.
    to_slide: bool,
    target: String,
}

/// A slide of a presentation (`PresSlide`).
#[derive(Debug, Clone)]
pub struct Slide {
    name: String,
    number: usize,
    pub(crate) id: usize,
    pub(crate) rid: usize,
    layout: Layout,
    hidden: bool,
    background: Option<Background>,
    background_rid: Option<usize>,
    pub(crate) slide_number: Option<SlideNumber>,
    objects: Vec<SlideObject>,
    rels: Vec<HyperlinkRel>,
    pub(crate) rels_media: Vec<MediaRel>,
}

impl Slide {
    pub(crate) fn new(number: usize, layout: Layout) -> Self {
        Self {
            name: format!("Slide {number}"),
            number,
            id: number + 255,
            rid: number + 1,
            layout,
            hidden: false,
            background: None,
            background_rid: None,
            slide_number: None,
            objects: Vec::new(),
            rels: Vec::new(),
            rels_media: Vec::new(),
        }
    }

    /// `getNewRelId`: one more than the relationships of the slide.
    fn next_rel_id(&self) -> usize {
        self.rels.len() + self.rels_media.len() + 1
    }

    /// `slide.hidden = value`.
    pub fn set_hidden(&mut self, hidden: bool) {
        self.hidden = hidden;
    }

    /// `slide.background = props`: a colour, or a picture that takes a media relationship.
    pub fn set_background(&mut self, mut props: Background) {
        if props.fill.as_deref().is_some_and(|fill| !fill.is_empty()) {
            props.color.clone_from(&props.fill);
        }
        if props.data.as_deref().is_some_and(|data| !data.is_empty()) || props.file.is_some() {
            let rel = background_rel(&self.rels_media, &self.name, props.data.as_deref(), props.file.as_ref());
            self.background_rid = Some(rel.rid);
            self.rels_media.push(rel);
        }
        self.background = Some(props);
    }

    /// `slide.addShape(shape, options)`: `shape` is the preset geometry name (`rect`, `roundRect`, `ellipse`, `line`...).
    pub fn add_shape(&mut self, shape: &str, options: ShapeOptions) -> Result<(), String> {
        let text_objects = self.objects.iter().filter(|object| matches!(object, SlideObject::Shape(_))).count();
        let mut object = ShapeObject::new(shape, options, text_objects)?;
        if let Some(link) = object.hyperlink() {
            let rid = self.next_rel_id();
            let encoded = link.url.as_deref().map(encode_xml_entities).unwrap_or_default();
            let target = if encoded.is_empty() { num(link.slide.unwrap_or(0.0)) } else { encoded };
            self.rels.push(HyperlinkRel { rid, to_slide: link.slide.is_some_and(|slide| slide != 0.0 && !slide.is_nan()), target });
            object.set_link_rid(rid);
        }
        self.objects.push(SlideObject::Shape(object));
        Ok(())
    }

    /// `slide.addImage(options)`. An error is what pptxgenjs reports on the console before it adds nothing (no
    /// picture given, a data text without its base64 header) or throws (a hyperlink with neither url nor slide); an
    /// SVG picture is not carried by this writer.
    pub fn add_image(&mut self, options: ImageOptions) -> Result<(), String> {
        let data = options.data.clone().unwrap_or_default();
        let file = options.file.clone();
        if data.is_empty() && file.as_ref().is_none_or(|file| file.path.is_empty()) {
            return Err("ERROR: addImage() requires either 'data' or 'path' parameter!".to_owned());
        }
        if !data.is_empty() && !data.to_lowercase().contains("base64,") {
            return Err("ERROR: Image `data` value lacks a base64 header! Ex: 'image/png;base64,NMP[...]')".to_owned());
        }
        let path = file.as_ref().map_or("", |file| file.path.as_str());
        if image_extension(&data, path) == "svg" {
            return Err("SVG pictures are not carried by the pptx writer: draw the picture as a PNG".to_owned());
        }
        let rid = self.next_rel_id();
        let rel = picture_rel(&self.rels_media, self.number, rid, &data, file.as_ref());
        let pictures = self.objects.iter().filter(|object| matches!(object, SlideObject::Image(_))).count();
        let name = file.as_ref().map_or_else(|| "preencoded.png".to_owned(), |file| file.path.clone());
        let link = options.hyperlink.clone();
        let mut object = ImageObject::new(options, name, rid, pictures);
        // pptxgenjs has stored the picture's relationship when it finds the link unusable and throws.
        self.rels_media.push(rel);
        if let Some(link) = link {
            let url = link.url.filter(|url| !url.is_empty());
            let slide = link.slide.filter(|slide| *slide != 0.0 && !slide.is_nan());
            if url.is_none() && slide.is_none() {
                return Err("ERROR: `hyperlink` option requires either: `url` or `slide`".to_owned());
            }
            object.set_link_rid(rid + 1);
            self.rels.push(HyperlinkRel { rid: rid + 1, to_slide: slide.is_some(), target: url.unwrap_or_else(|| num(slide.unwrap_or(0.0))) });
        }
        self.objects.push(SlideObject::Image(object));
        Ok(())
    }

    /// `slide.addNotes(notes)`.
    pub fn add_notes(&mut self, notes: &str) {
        self.objects.push(SlideObject::Notes(notes.to_owned()));
    }

    /// The `p:sld` part.
    pub(crate) fn xml(&self) -> String {
        let backdrop = match (self.background_rid, &self.background) {
            (Some(rid), _) => Backdrop::Picture(rid),
            (None, Some(background)) if background.color.as_deref().is_some_and(|color| !color.is_empty()) => {
                Backdrop::Colour(Fill { color: background.color.clone(), transparency: background.transparency, ..Fill::default() })
            }
            _ => Backdrop::Plain,
        };
        let csld = csld_xml(&Csld {
            name: Some(&self.name),
            backdrop,
            objects: &self.objects,
            slide_number: self.slide_number.as_ref(),
            slide_number_text: self.number.to_string(),
            layout: &self.layout,
        });
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>{CRLF}<p:sld xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"{}>{csld}<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>",
            if self.hidden { " show=\"0\"" } else { "" }
        )
    }

    /// `ppt/slides/_rels/slide<n>.xml.rels`: the slide's own relationships, then the layout and the notes slide.
    pub(crate) fn rels_xml(&self) -> String {
        let mut xml = format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>{CRLF}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">");
        let mut last = 0;
        for rel in &self.rels {
            last = last.max(rel.rid);
            if rel.to_slide {
                xml.push_str(&format!("<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slide{}.xml\"/>", rel.rid, rel.target));
            } else {
                xml.push_str(&format!(
                    "<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\" Target=\"{}\" TargetMode=\"External\"/>",
                    rel.rid, rel.target
                ));
            }
        }
        for rel in &self.rels_media {
            last = last.max(rel.rid);
            xml.push_str(&format!("<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"{}\"/>", rel.rid, rel.target));
        }
        xml.push_str(&format!("<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/>", last + 1));
        xml.push_str(&format!("<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide\" Target=\"../notesSlides/notesSlide{}.xml\"/>", last + 2, self.number));
        xml.push_str("</Relationships>");
        xml
    }

    /// The text of the slide's notes (`getNotesFromSlide`): every notes call, line breaks as CRLF.
    fn notes_text(&self) -> String {
        let joined: String = self
            .objects
            .iter()
            .filter_map(|object| match object {
                SlideObject::Notes(text) => Some(text.as_str()),
                _ => None,
            })
            .collect();
        let mut out = String::with_capacity(joined.len());
        let mut carriage_returns = 0;
        for ch in joined.chars() {
            match ch {
                '\r' => carriage_returns += 1,
                '\n' => {
                    carriage_returns = 0;
                    out.push_str(CRLF);
                }
                other => {
                    out.extend(std::iter::repeat_n('\r', carriage_returns));
                    carriage_returns = 0;
                    out.push(other);
                }
            }
        }
        out.extend(std::iter::repeat_n('\r', carriage_returns));
        out
    }

    /// `ppt/notesSlides/notesSlide<n>.xml`: every slide has one, empty when it has no notes.
    pub(crate) fn notes_xml(&self) -> String {
        theme::notes_slide_xml(&encode_xml_entities(&self.notes_text()), self.number)
    }
}

/// What lies behind a slide's objects.
pub(crate) enum Backdrop {
    /// Nothing is written.
    Plain,
    /// The layout's own: the theme's first background.
    Theme,
    Colour(Fill),
    Picture(usize),
}

/// The inputs of `slideObjectToXml`.
pub(crate) struct Csld<'a> {
    pub name: Option<&'a str>,
    pub backdrop: Backdrop,
    pub objects: &'a [SlideObject],
    pub slide_number: Option<&'a SlideNumber>,
    /// What the slide number field shows (the slide's number as pptxgenjs holds it, `null` on the master).
    pub slide_number_text: String,
    pub layout: &'a Layout,
}

/// `slideObjectToXml`: the `p:cSld` of a slide, layout or master.
pub(crate) fn csld_xml(input: &Csld<'_>) -> String {
    let mut xml = match input.name {
        Some(name) => format!("<p:cSld name=\"{name}\">"),
        None => "<p:cSld>".to_owned(),
    };
    match &input.backdrop {
        Backdrop::Picture(rid) => xml.push_str(&format!(
            "<p:bg><p:bgPr><a:blipFill dpi=\"0\" rotWithShape=\"1\"><a:blip r:embed=\"rId{rid}\"><a:lum/></a:blip><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>"
        )),
        Backdrop::Colour(fill) => xml.push_str(&format!("<p:bg><p:bgPr>{}</p:bgPr></p:bg>", color_selection(fill))),
        Backdrop::Theme => xml.push_str("<p:bg><p:bgRef idx=\"1001\"><a:schemeClr val=\"bg1\"/></p:bgRef></p:bg>"),
        Backdrop::Plain => {}
    }
    xml.push_str("<p:spTree>");
    xml.push_str("<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>");
    xml.push_str("<p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/>");
    xml.push_str("<a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>");
    for (index, object) in input.objects.iter().enumerate() {
        match object {
            SlideObject::Shape(shape) => xml.push_str(&shape_xml(shape, index, input.layout)),
            SlideObject::Image(image) => xml.push_str(&image_xml(image, index, input.layout)),
            SlideObject::Notes(_) => {}
        }
    }
    if let Some(number) = input.slide_number {
        xml.push_str(&slide_number_xml(number, input.layout, &input.slide_number_text));
    }
    xml.push_str("</p:spTree>");
    xml.push_str("</p:cSld>");
    xml
}

/// The slide number placeholder every slide, layout and master with a number carries.
fn slide_number_xml(props: &SlideNumber, layout: &Layout, shown: &str) -> String {
    let place = |dim: Option<Dim>, axis: Axis| dim.map_or(0.0, |dim| smart_parse(dim, axis, layout));
    let size = |dim: Option<Dim>, axis: Axis, fallback: &str| match dim {
        Some(dim) if dim.truthy() => num(smart_parse(dim, axis, layout)),
        _ => fallback.to_owned(),
    };
    let mut xml = String::from("<p:sp>");
    xml.push_str(" <p:nvSpPr>");
    xml.push_str("  <p:cNvPr id=\"25\" name=\"Slide Number Placeholder 0\"/><p:cNvSpPr><a:spLocks noGrp=\"1\"/></p:cNvSpPr>");
    xml.push_str("  <p:nvPr><p:ph type=\"sldNum\" sz=\"quarter\" idx=\"4294967295\"/></p:nvPr>");
    xml.push_str(" </p:nvSpPr>");
    xml.push_str(" <p:spPr>");
    xml.push_str(&format!(
        "<a:xfrm><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm> <a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom> <a:extLst><a:ext uri=\"{{C572A759-6A51-4108-AA02-DFA0A04FC94B}}\"><ma14:wrappingTextBoxFlag val=\"0\" xmlns:ma14=\"http://schemas.microsoft.com/office/mac/drawingml/2011/main\"/></a:ext></a:extLst></p:spPr>",
        num(place(props.x, Axis::X)),
        num(place(props.y, Axis::Y)),
        size(props.w, Axis::X, "800000"),
        size(props.h, Axis::Y, "300000")
    ));
    xml.push_str("<p:txBody>");
    xml.push_str("<a:bodyPr");
    match &props.margin {
        Some(SlideNumberMargin::Each(margin)) => {
            let at = |index: usize| num(val_to_pts(or(margin.get(index).copied(), 0.0)));
            xml.push_str(&format!(" lIns=\"{}\" tIns=\"{}\" rIns=\"{}\" bIns=\"{}\"", at(3), at(0), at(1), at(2)));
        }
        Some(SlideNumberMargin::All(margin)) => {
            let all = num(val_to_pts(or(Some(*margin), 0.0)));
            xml.push_str(&format!(" lIns=\"{all}\" tIns=\"{all}\" rIns=\"{all}\" bIns=\"{all}\""));
        }
        None => {}
    }
    if let Some(valign) = props.valign.as_deref().filter(|valign| !valign.is_empty()) {
        xml.push_str(&format!(" anchor=\"{}\"", valign.replacen("top", "t", 1).replacen("middle", "ctr", 1).replacen("bottom", "b", 1)));
    }
    xml.push_str("/>");
    xml.push_str("  <a:lstStyle><a:lvl1pPr>");
    let font_face = props.font_face.as_deref().filter(|face| !face.is_empty());
    let color = props.color.as_deref().filter(|color| !color.is_empty());
    if font_face.is_some() || super::is_set(props.font_size) || color.is_some() {
        xml.push_str(&format!("<a:defRPr sz=\"{}\">", num(super::round(or(props.font_size, 12.0) * 100.0))));
        if let Some(color) = color {
            xml.push_str(&color_selection_of(color));
        }
        if let Some(face) = font_face {
            xml.push_str(&format!("<a:latin typeface=\"{face}\"/><a:ea typeface=\"{face}\"/><a:cs typeface=\"{face}\"/>"));
        }
        xml.push_str("</a:defRPr>");
    }
    xml.push_str("</a:lvl1pPr></a:lstStyle>");
    xml.push_str("<a:p>");
    let align = props.align.as_deref().filter(|align| !align.is_empty()).unwrap_or("left");
    xml.push_str(match align.chars().next() {
        Some('c') => "<a:pPr algn=\"ctr\"/>",
        Some('r') => "<a:pPr algn=\"r\"/>",
        _ => "<a:pPr algn=\"l\"/>",
    });
    xml.push_str(&format!(
        "<a:fld id=\"{{F7021451-1387-4CA6-816F-3879F97B5CBC}}\" type=\"slidenum\"><a:rPr b=\"{}\" lang=\"en-US\"/>",
        u8::from(props.bold)
    ));
    xml.push_str(&format!("<a:t>{shown}</a:t></a:fld><a:endParaRPr lang=\"en-US\"/></a:p>"));
    xml.push_str("</p:txBody></p:sp>");
    xml
}

#[cfg(test)]
mod tests {
    use super::super::shapes::{Hyperlink, ShapeOptions};
    use super::*;

    fn fresh() -> Slide {
        Slide::new(2, Layout { name: "custom".to_owned(), width: 12_192_000.0, height: 6_858_000.0 })
    }

    #[test]
    fn notes_objects_take_a_place_in_the_ids_of_the_shapes_after_them() {
        let mut slide = fresh();
        slide.add_notes("first");
        slide.add_shape("rect", ShapeOptions::default()).expect("shape");
        let xml = slide.xml();
        assert!(xml.contains("<p:cNvPr id=\"3\" name=\"Shape 0\">"));
        assert!(xml.contains("<p:cSld name=\"Slide 2\"><p:spTree>"));
    }

    #[test]
    fn notes_are_joined_with_crlf_line_breaks_and_escaped() {
        let mut slide = fresh();
        slide.add_notes("a < b\r\n\nc");
        slide.add_notes("!");
        assert_eq!(slide.notes_text(), "a < b\r\n\r\nc!");
        assert!(slide.notes_xml().contains("<a:t>a &lt; b\r\n\r\nc!</a:t>"));
    }

    #[test]
    fn a_picture_background_wins_over_a_colour_and_takes_the_first_relationship() {
        let mut slide = fresh();
        slide.set_background(Background { color: Some("112233".to_owned()), data: Some("image/jpeg;base64,QUJD".to_owned()), ..Background::default() });
        let xml = slide.xml();
        assert!(xml.contains("<p:bg><p:bgPr><a:blipFill dpi=\"0\" rotWithShape=\"1\"><a:blip r:embed=\"rId1\">"));
        assert_eq!(slide.rels_media[0].target, "../media/Slide-2-image-1.png");
        let mut plain = fresh();
        plain.set_background(Background { fill: Some("abcdef".to_owned()), transparency: Some(20.0), ..Background::default() });
        assert!(plain.xml().contains("<p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"ABCDEF\"><a:alpha val=\"80000\"/></a:srgbClr></a:solidFill></p:bgPr></p:bg>"));
    }

    #[test]
    fn relationships_list_links_then_pictures_then_layout_and_notes() {
        let mut slide = fresh();
        slide
            .add_shape("rect", ShapeOptions { hyperlink: Some(Hyperlink { url: Some("https://x.test/?a=1&b=2".to_owned()), ..Hyperlink::default() }), ..ShapeOptions::default() })
            .expect("shape");
        slide.add_image(ImageOptions { data: Some("image/png;base64,QUJD".to_owned()), ..ImageOptions::default() }).expect("image");
        let rels = slide.rels_xml();
        let at = |needle: &str| rels.find(needle).unwrap_or_else(|| panic!("{needle} in {rels}"));
        assert!(at("hyperlink\" Target=\"https://x.test/?a=1&amp;b=2\" TargetMode=\"External\"") < at("relationships/image\" Target=\"../media/image-2-1.png\""));
        assert!(at("slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"") < at("notesSlide\" Target"));
        assert!(rels.contains("Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\""));
        assert!(rels.contains("Id=\"rId4\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide\" Target=\"../notesSlides/notesSlide2.xml\""));
    }

    #[test]
    fn a_picture_needs_its_data_and_its_header() {
        let mut slide = fresh();
        assert!(slide.add_image(ImageOptions::default()).is_err());
        assert!(slide.add_image(ImageOptions { data: Some("QUJD".to_owned()), ..ImageOptions::default() }).is_err());
        assert!(slide.add_image(ImageOptions { data: Some("image/svg+xml;base64,QUJD".to_owned()), ..ImageOptions::default() }).is_err());
        assert!(slide.objects.is_empty());
    }

    #[test]
    fn a_slide_number_names_its_place_font_and_alignment() {
        let props = SlideNumber {
            x: Some(Dim::Number(12.0)),
            y: Some(Dim::Number(7.0)),
            margin: Some(SlideNumberMargin::Each(vec![1.0, 2.0])),
            valign: Some("middle".to_owned()),
            align: Some("right".to_owned()),
            font_face: Some("Arial".to_owned()),
            font_size: Some(10.0),
            color: Some("808080".to_owned()),
            bold: true,
            ..SlideNumber::default()
        };
        let xml = slide_number_xml(&props, &fresh().layout, "2");
        assert!(xml.contains("<a:off x=\"10972800\" y=\"6400800\"/><a:ext cx=\"800000\" cy=\"300000\"/>"));
        assert!(xml.contains("<a:bodyPr lIns=\"0\" tIns=\"12700\" rIns=\"25400\" bIns=\"0\" anchor=\"ctr\"/>"));
        assert!(xml.contains("<a:defRPr sz=\"1000\"><a:solidFill><a:srgbClr val=\"808080\"/></a:solidFill><a:latin typeface=\"Arial\"/>"));
        assert!(xml.contains("<a:pPr algn=\"r\"/><a:fld id=\"{F7021451-1387-4CA6-816F-3879F97B5CBC}\" type=\"slidenum\"><a:rPr b=\"1\" lang=\"en-US\"/><a:t>2</a:t>"));
    }
}
