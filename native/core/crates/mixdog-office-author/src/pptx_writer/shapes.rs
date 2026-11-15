//! The drawing objects of a slide: the options of `addShape` and `addImage` as pptxgenjs reads them (defaults,
//! truthiness and the order things are applied in) and the `p:sp` and `p:pic` XML it writes for them.

use super::media::ImageFile;
use super::{Axis, Dim, EMU, Layout, encode_xml_entities, is_set, num, or, rotation_value, round, smart_parse, val_to_pts};

const DEFAULT_SHAPE_LINE_COLOR: &str = "333333";
const DEFAULT_TEXT_SHADOW_COLOR: &str = "000000";
const DEFAULT_FONT_COLOR: &str = "000000";
const SCHEME_COLORS: [&str; 10] = ["bg1", "bg2", "tx1", "tx2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"];

/// A colour with the options `genXmlColorSelection` reads: `type` (anything but `solid` writes nothing),
/// `color` (6-digit hex or a scheme colour), `alpha` (deprecated, percent transparent) and `transparency`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Fill {
    pub kind: Option<String>,
    pub color: Option<String>,
    pub alpha: Option<f64>,
    pub transparency: Option<f64>,
}

impl Fill {
    /// A plain colour (`fill: 'FF0000'`).
    pub fn color(color: &str) -> Self {
        Self { color: Some(color.to_owned()), ..Self::default() }
    }

    /// `{ type: 'none' }`: an object that writes no fill element at all.
    pub fn none() -> Self {
        Self { kind: Some("none".to_owned()), ..Self::default() }
    }
}

/// `ShapeLineProps`. An unset line is `{ type: 'none' }`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Line {
    pub kind: Option<String>,
    pub color: Option<String>,
    pub transparency: Option<f64>,
    pub width: Option<f64>,
    pub dash_type: Option<String>,
    pub begin_arrow_type: Option<String>,
    pub end_arrow_type: Option<String>,
}

impl Line {
    /// `{ type: 'none' }`.
    pub fn none() -> Self {
        Self { kind: Some("none".to_owned()), ..Self::default() }
    }

    /// The line `addShapeDefinition` keeps: a `none` line as given, any other with its defaults filled in.
    fn resolved(self) -> Self {
        if self.kind.as_deref() == Some("none") {
            return self;
        }
        Self {
            kind: Some(self.kind.filter(|kind| !kind.is_empty()).unwrap_or_else(|| "solid".to_owned())),
            color: Some(self.color.filter(|color| !color.is_empty()).unwrap_or_else(|| DEFAULT_SHAPE_LINE_COLOR.to_owned())),
            transparency: Some(or(self.transparency, 0.0)),
            width: Some(or(self.width, 1.0)),
            dash_type: Some(self.dash_type.filter(|dash| !dash.is_empty()).unwrap_or_else(|| "solid".to_owned())),
            begin_arrow_type: self.begin_arrow_type.filter(|arrow| !arrow.is_empty()),
            end_arrow_type: self.end_arrow_type.filter(|arrow| !arrow.is_empty()),
        }
    }
}

/// `ShadowProps`: `type` (`outer`, `inner`, `none`; an object without one is outer), blur and offset in points,
/// angle in degrees, opacity 0-1.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Shadow {
    pub kind: Option<String>,
    pub color: Option<String>,
    pub blur: Option<f64>,
    pub offset: Option<f64>,
    pub angle: Option<f64>,
    pub opacity: Option<f64>,
}

impl Shadow {
    /// `correctShadowOptions`, which `addImage` applies: a type other than outer, inner or none is outer, an angle
    /// outside 0-359 is 270, an opacity outside 0-1 is 0.75, a leading `#` of the colour is dropped.
    pub(crate) fn corrected(mut self) -> Self {
        if !matches!(self.kind.as_deref(), Some("outer" | "inner" | "none")) {
            self.kind = Some("outer".to_owned());
        }
        if let Some(angle) = self.angle.filter(|angle| is_set(Some(*angle))) {
            let angle = if (0.0..=359.0).contains(&angle) { angle } else { 270.0 };
            self.angle = Some(round(angle));
        }
        if let Some(opacity) = self.opacity.filter(|opacity| is_set(Some(*opacity))) {
            self.opacity = Some(if !(0.0..=1.0).contains(&opacity) { 0.75 } else { opacity });
        }
        if let Some(color) = self.color.as_mut().filter(|color| color.starts_with('#')) {
            *color = color.replacen('#', "", 1);
        }
        self
    }
}

/// A hyperlink on a shape or a picture: a `url`, or a `slide` number, with an optional tooltip.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Hyperlink {
    pub url: Option<String>,
    pub slide: Option<f64>,
    pub tooltip: Option<String>,
}

impl Hyperlink {
    fn has_url(&self) -> bool {
        self.url.as_deref().is_some_and(|url| !url.is_empty())
    }

    fn has_slide(&self) -> bool {
        is_set(self.slide)
    }
}

/// What `addShape` is given.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ShapeOptions {
    pub x: Option<Dim>,
    pub y: Option<Dim>,
    pub w: Option<Dim>,
    pub h: Option<Dim>,
    pub fill: Option<Fill>,
    pub line: Option<Line>,
    /// The corner radius of a `roundRect`, in inches.
    pub rect_radius: Option<f64>,
    /// The two angles (degrees) of a pie, arc or block arc.
    pub angle_range: Option<[f64; 2]>,
    pub arc_thickness_ratio: Option<f64>,
    pub rotate: Option<f64>,
    pub flip_h: bool,
    pub flip_v: bool,
    pub shadow: Option<Shadow>,
    pub object_name: Option<String>,
    pub hyperlink: Option<Hyperlink>,
}

/// How a picture is fitted to its box (`sizing.type`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SizingKind {
    Cover,
    Contain,
    Crop,
}

/// `ImageProps.sizing`: the type and the box the picture is fitted to (the picture's own frame by default).
#[derive(Debug, Clone, PartialEq)]
pub struct ImageSizing {
    pub kind: SizingKind,
    pub x: Option<Dim>,
    pub y: Option<Dim>,
    pub w: Option<Dim>,
    pub h: Option<Dim>,
}

/// What `addImage` is given: the picture as a data URI or a file the caller read, and its place.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ImageOptions {
    pub data: Option<String>,
    pub file: Option<ImageFile>,
    pub x: Option<Dim>,
    pub y: Option<Dim>,
    pub w: Option<Dim>,
    pub h: Option<Dim>,
    pub alt_text: Option<String>,
    /// Clips the picture to an ellipse.
    pub rounding: bool,
    pub sizing: Option<ImageSizing>,
    pub rotate: Option<f64>,
    pub flip_h: bool,
    pub flip_v: bool,
    /// Percent transparent.
    pub transparency: Option<f64>,
    pub object_name: Option<String>,
    pub shadow: Option<Shadow>,
    pub hyperlink: Option<Hyperlink>,
}

/// A shape on a slide, after `addShapeDefinition`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ShapeObject {
    shape: String,
    options: ShapeOptions,
    object_name: String,
    link_rid: Option<usize>,
}

/// A picture on a slide, after `addImageDefinition`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ImageObject {
    image: String,
    rid: usize,
    x: Dim,
    y: Dim,
    w: Dim,
    h: Dim,
    alt_text: String,
    rounding: bool,
    sizing: Option<ImageSizing>,
    rotate: Option<f64>,
    flip_h: bool,
    flip_v: bool,
    transparency: Option<f64>,
    object_name: String,
    shadow: Option<Shadow>,
    link: Option<Hyperlink>,
    link_rid: Option<usize>,
}

/// `options.x || (options.x === 0 ? 0 : 1)`: an unset or NaN position or size is 1 inch.
fn shape_dim(value: Option<Dim>) -> Dim {
    match value {
        Some(dim) if dim.truthy() => dim,
        Some(Dim::Number(0.0)) => Dim::Number(0.0),
        _ => Dim::Number(1.0),
    }
}

/// `opt.x || fallback`.
fn dim_or(value: Option<Dim>, fallback: f64) -> Dim {
    match value {
        Some(dim) if dim.truthy() => dim,
        _ => Dim::Number(fallback),
    }
}

impl ShapeObject {
    /// `addShapeDefinition` up to the hyperlink: `text_objects` counts the slide's text-type objects (a shape is
    /// one), which names an unnamed shape `Shape <n>`.
    pub(crate) fn new(shape: &str, options: ShapeOptions, text_objects: usize) -> Result<Self, String> {
        if shape.is_empty() {
            return Err("Missing/Invalid shape parameter! Example: `addShape(pptxgen.shapes.LINE, {x:1, y:1, w:1, h:1});`".to_owned());
        }
        let mut options = options;
        options.line = Some(options.line.take().unwrap_or_else(Line::none).resolved());
        options.x = Some(shape_dim(options.x));
        options.y = Some(shape_dim(options.y));
        options.w = Some(shape_dim(options.w));
        options.h = Some(shape_dim(options.h));
        let object_name = match options.object_name.as_deref() {
            Some(name) if !name.is_empty() => encode_xml_entities(name),
            _ => format!("Shape {text_objects}"),
        };
        Ok(Self { shape: shape.to_owned(), options, object_name, link_rid: None })
    }

    pub(crate) fn hyperlink(&self) -> Option<&Hyperlink> {
        self.options.hyperlink.as_ref().filter(|link| link.has_url() || link.has_slide())
    }

    pub(crate) fn set_link_rid(&mut self, rid: usize) {
        self.link_rid = Some(rid);
    }
}

impl ImageObject {
    /// `addImageDefinition` (steps 3 and 6): `picture_count` counts the slide's pictures, which names an unnamed one
    /// `Image <n>`; `rid` is the picture's relationship.
    pub(crate) fn new(options: ImageOptions, image: String, rid: usize, picture_count: usize) -> Self {
        let object_name = match options.object_name.as_deref() {
            Some(name) if !name.is_empty() => encode_xml_entities(name),
            _ => format!("Image {picture_count}"),
        };
        Self {
            image,
            rid,
            x: dim_or(options.x, 0.0),
            y: dim_or(options.y, 0.0),
            w: dim_or(options.w, 1.0),
            h: dim_or(options.h, 1.0),
            alt_text: options.alt_text.unwrap_or_default(),
            rounding: options.rounding,
            sizing: options.sizing,
            rotate: options.rotate,
            flip_h: options.flip_h,
            flip_v: options.flip_v,
            transparency: options.transparency,
            object_name,
            shadow: options.shadow.map(Shadow::corrected),
            link: options.hyperlink,
            link_rid: None,
        }
    }

    pub(crate) fn set_link_rid(&mut self, rid: usize) {
        self.link_rid = Some(rid);
    }
}

/// `genXmlColorSelection`.
pub(crate) fn color_selection(fill: &Fill) -> String {
    let fill_type = fill.kind.as_deref().filter(|kind| !kind.is_empty()).unwrap_or("solid");
    let color = fill.color.as_deref().unwrap_or("");
    let mut inner = String::new();
    if is_set(fill.alpha) {
        inner.push_str(&format!("<a:alpha val=\"{}\"/>", num(round((100.0 - fill.alpha.unwrap_or(0.0)) * 1000.0))));
    }
    if is_set(fill.transparency) {
        inner.push_str(&format!("<a:alpha val=\"{}\"/>", num(round((100.0 - fill.transparency.unwrap_or(0.0)) * 1000.0))));
    }
    if fill_type == "solid" { format!("<a:solidFill>{}</a:solidFill>", color_element(color, &inner)) } else { String::new() }
}

/// `genXmlColorSelection` of a plain colour string.
pub(crate) fn color_selection_of(color: &str) -> String {
    color_selection(&Fill::color(color))
}

/// `createColorElement`: `srgbClr` for a 6-digit hex, `schemeClr` for a scheme colour, black for anything else.
pub(crate) fn color_element(color: &str, inner: &str) -> String {
    let value = color.replacen('#', "", 1);
    let hex = value.len() == 6 && value.chars().all(|ch| ch.is_ascii_hexdigit());
    let value = if hex || SCHEME_COLORS.contains(&value.as_str()) { value } else { DEFAULT_FONT_COLOR.to_owned() };
    let (tag, shown) = if value.len() == 6 && value.chars().all(|ch| ch.is_ascii_hexdigit()) { ("srgbClr", value.to_uppercase()) } else { ("schemeClr", value) };
    if inner.is_empty() { format!("<a:{tag} val=\"{shown}\"/>") } else { format!("<a:{tag} val=\"{shown}\">{inner}</a:{tag}>") }
}

/// The attributes of an `a:xfrm`: flips, then the rotation.
pub(crate) fn location_attributes(rotate: Option<f64>, flip_h: bool, flip_v: bool) -> String {
    let mut attributes = String::new();
    if flip_h {
        attributes.push_str(" flipH=\"1\"");
    }
    if flip_v {
        attributes.push_str(" flipV=\"1\"");
    }
    if is_set(rotate) {
        attributes.push_str(&format!(" rot=\"{}\"", num(rotation_value(rotate.unwrap_or(0.0)))));
    }
    attributes
}

/// The numbers of a shadow as the slide writes them (`blur` and `offset` in EMU, `angle` and `opacity` in
/// sixty-thousandths and hundred-thousandths), with the colour defaulted.
struct ShadowValues {
    kind: String,
    blur: f64,
    offset: f64,
    angle: f64,
    opacity: f64,
    color: String,
}

fn shadow_values(shadow: &Shadow) -> Option<ShadowValues> {
    if shadow.kind.as_deref() == Some("none") {
        return None;
    }
    Some(ShadowValues {
        kind: shadow.kind.clone().filter(|kind| !kind.is_empty()).unwrap_or_else(|| "outer".to_owned()),
        blur: val_to_pts(or(shadow.blur, 8.0)),
        offset: val_to_pts(or(shadow.offset, 4.0)),
        angle: round(or(shadow.angle, 270.0) * 60_000.0),
        opacity: round(or(shadow.opacity, 0.75) * 100_000.0),
        color: shadow.color.clone().filter(|color| !color.is_empty()).unwrap_or_else(|| DEFAULT_TEXT_SHADOW_COLOR.to_owned()),
    })
}

fn shadow_opening(values: &ShadowValues) -> String {
    let transform = if values.kind == "outer" { "sx=\"100000\" sy=\"100000\" kx=\"0\" ky=\"0\" algn=\"bl\" rotWithShape=\"0\"" } else { "" };
    format!("<a:{}Shdw {transform} blurRad=\"{}\" dist=\"{}\" dir=\"{}\">", values.kind, num(values.blur), num(values.offset), num(values.angle))
}

/// The shadow of a shape (`slideObjectToXml`, text/shape case): the element is closed as `a:outerShdw` whatever its
/// type, as pptxgenjs writes it.
pub(crate) fn shape_shadow_xml(shadow: &Shadow) -> String {
    let Some(values) = shadow_values(shadow) else { return String::new() };
    format!(
        "<a:effectLst> {} <a:srgbClr val=\"{}\"> <a:alpha val=\"{}\"/></a:srgbClr> </a:outerShdw></a:effectLst>",
        shadow_opening(&values),
        values.color,
        num(values.opacity)
    )
}

/// The shadow of a picture: closed with its own type.
fn picture_shadow_xml(shadow: &Shadow) -> String {
    let Some(values) = shadow_values(shadow) else { return String::new() };
    format!(
        "<a:effectLst>{}<a:srgbClr val=\"{}\"><a:alpha val=\"{}\"/></a:srgbClr></a:{}Shdw></a:effectLst>",
        shadow_opening(&values),
        values.color,
        num(values.opacity),
        values.kind
    )
}

/// `<a:hlinkClick .../>` of a hyperlink, with the relationship id it was given.
pub(crate) fn link_click_xml(link: &Hyperlink, rid: impl std::fmt::Display) -> String {
    let tooltip = link.tooltip.as_deref().filter(|tooltip| !tooltip.is_empty()).map(encode_xml_entities).unwrap_or_default();
    let mut xml = String::new();
    if link.has_url() {
        xml.push_str(&format!("<a:hlinkClick r:id=\"rId{rid}\" tooltip=\"{tooltip}\"/>"));
    }
    if link.has_slide() {
        xml.push_str(&format!("<a:hlinkClick r:id=\"rId{rid}\" tooltip=\"{tooltip}\" action=\"ppaction://hlinksldjump\"/>"));
    }
    xml
}

/// The `a:ln` of a shape.
pub(crate) fn line_xml(line: &Line) -> String {
    let mut xml = if is_set(line.width) { format!("<a:ln w=\"{}\">", num(val_to_pts(line.width.unwrap_or(0.0)))) } else { "<a:ln>".to_owned() };
    if line.color.as_deref().is_some_and(|color| !color.is_empty()) {
        xml.push_str(&color_selection(&Fill { kind: line.kind.clone(), color: line.color.clone(), alpha: None, transparency: line.transparency }));
    }
    if let Some(dash) = line.dash_type.as_deref().filter(|dash| !dash.is_empty()) {
        xml.push_str(&format!("<a:prstDash val=\"{dash}\"/>"));
    }
    if let Some(arrow) = line.begin_arrow_type.as_deref().filter(|arrow| !arrow.is_empty()) {
        xml.push_str(&format!("<a:headEnd type=\"{arrow}\"/>"));
    }
    if let Some(arrow) = line.end_arrow_type.as_deref().filter(|arrow| !arrow.is_empty()) {
        xml.push_str(&format!("<a:tailEnd type=\"{arrow}\"/>"));
    }
    xml.push_str("</a:ln>");
    xml
}

/// The `a:gd` adjustments of a preset geometry: a corner radius, else the angles of an arc.
pub(crate) fn adjustments_xml(options: &ShapeOptions, cx: f64, cy: f64) -> String {
    if is_set(options.rect_radius) {
        let radius = options.rect_radius.unwrap_or(0.0);
        let value = round(radius * EMU * 100_000.0 / mixdog_js::math::min(cx, cy));
        return format!("<a:gd name=\"adj\" fmla=\"val {}\"/>", num(value));
    }
    let Some(angles) = options.angle_range else { return String::new() };
    let mut xml = String::new();
    for (index, angle) in angles.iter().enumerate() {
        xml.push_str(&format!("<a:gd name=\"adj{}\" fmla=\"val {}\" />", index + 1, num(rotation_value(*angle))));
    }
    if is_set(options.arc_thickness_ratio) {
        xml.push_str(&format!("<a:gd name=\"adj3\" fmla=\"val {}\" />", num(round(options.arc_thickness_ratio.unwrap_or(0.0) * 50_000.0))));
    }
    xml
}

/// The `p:sp` of a shape (`slideObjectToXml`, text/shape case). `index` is the object's place on the slide.
pub(crate) fn shape_xml(object: &ShapeObject, index: usize, layout: &Layout) -> String {
    let options = &object.options;
    let value = |dim: Option<Dim>, axis: Axis| smart_parse(dim.unwrap_or(Dim::Number(1.0)), axis, layout);
    let (x, y) = (value(options.x, Axis::X), value(options.y, Axis::Y));
    let (cx, cy) = (value(options.w, Axis::X), value(options.h, Axis::Y));
    let mut xml = String::from("<p:sp>");
    xml.push_str(&format!("<p:nvSpPr><p:cNvPr id=\"{}\" name=\"{}\">", index + 2, object.object_name));
    if let (Some(link), Some(rid)) = (object.hyperlink(), object.link_rid) {
        xml.push_str(&link_click_xml(link, rid));
    }
    xml.push_str("</p:cNvPr>");
    xml.push_str("<p:cNvSpPr/>");
    xml.push_str("<p:nvPr></p:nvPr>");
    xml.push_str("</p:nvSpPr><p:spPr>");
    xml.push_str(&format!("<a:xfrm{}>", location_attributes(options.rotate, options.flip_h, options.flip_v)));
    xml.push_str(&format!("<a:off x=\"{}\" y=\"{}\"/>", num(x), num(y)));
    xml.push_str(&format!("<a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm>", num(cx), num(cy)));
    xml.push_str(&format!("<a:prstGeom prst=\"{}\"><a:avLst>{}</a:avLst></a:prstGeom>", object.shape, adjustments_xml(options, cx, cy)));
    match &options.fill {
        Some(fill) => xml.push_str(&color_selection(fill)),
        None => xml.push_str("<a:noFill/>"),
    }
    if let Some(line) = &options.line {
        xml.push_str(&line_xml(line));
    }
    if let Some(shadow) = &options.shadow {
        xml.push_str(&shape_shadow_xml(shadow));
    }
    xml.push_str("</p:spPr>");
    xml.push_str("</p:sp>");
    xml
}

/// `ImageSizingXml`: the source rectangle of a fitted picture.
fn sizing_xml(kind: SizingKind, image: (f64, f64), view: (f64, f64, f64, f64)) -> String {
    let (img_w, img_h) = image;
    let (box_x, box_y, box_w, box_h) = view;
    let percent = |value: f64| num(round(value));
    let (left, right, top, bottom) = match kind {
        SizingKind::Cover | SizingKind::Contain => {
            let image_ratio = img_h / img_w;
            let box_ratio = box_h / box_w;
            let first = box_ratio > image_ratio;
            let (width, height) = if kind == SizingKind::Cover {
                (if first { box_h / image_ratio } else { box_w }, if first { box_h } else { box_w * image_ratio })
            } else {
                (if first { box_w } else { box_h / image_ratio }, if first { box_w * image_ratio } else { box_h })
            };
            let horizontal = 1e5 * 0.5 * (1.0 - box_w / width);
            let vertical = 1e5 * 0.5 * (1.0 - box_h / height);
            (horizontal, horizontal, vertical, vertical)
        }
        SizingKind::Crop => {
            let (l, r) = (box_x, img_w - (box_x + box_w));
            let (t, b) = (box_y, img_h - (box_y + box_h));
            (1e5 * (l / img_w), 1e5 * (r / img_w), 1e5 * (t / img_h), 1e5 * (b / img_h))
        }
    };
    format!("<a:srcRect l=\"{}\" r=\"{}\" t=\"{}\" b=\"{}\"/><a:stretch/>", percent(left), percent(right), percent(top), percent(bottom))
}

/// The `p:pic` of a picture (`slideObjectToXml`, image case).
pub(crate) fn image_xml(object: &ImageObject, index: usize, layout: &Layout) -> String {
    let x = smart_parse(object.x, Axis::X, layout);
    let y = smart_parse(object.y, Axis::Y, layout);
    let cx = smart_parse(object.w, Axis::X, layout);
    let cy = smart_parse(object.h, Axis::Y, layout);
    let (mut image_width, mut image_height) = (cx, cy);
    let mut xml = String::from("<p:pic>");
    xml.push_str("  <p:nvPicPr>");
    let description = if object.alt_text.is_empty() { &object.image } else { &object.alt_text };
    xml.push_str(&format!("<p:cNvPr id=\"{}\" name=\"{}\" descr=\"{}\">", index + 2, object.object_name, encode_xml_entities(description)));
    if let (Some(link), Some(rid)) = (&object.link, object.link_rid) {
        xml.push_str(&link_click_xml(link, rid));
    }
    xml.push_str("    </p:cNvPr>");
    xml.push_str("    <p:cNvPicPr><a:picLocks noChangeAspect=\"1\"/></p:cNvPicPr>");
    xml.push_str("    <p:nvPr></p:nvPr>");
    xml.push_str("  </p:nvPicPr>");
    xml.push_str("<p:blipFill>");
    xml.push_str(&format!("<a:blip r:embed=\"rId{}\">", object.rid));
    if is_set(object.transparency) {
        xml.push_str(&format!("<a:alphaModFix amt=\"{}\"/>", num(round((100.0 - object.transparency.unwrap_or(0.0)) * 1000.0))));
    }
    xml.push_str("</a:blip>");
    match &object.sizing {
        Some(sizing) => {
            let box_w = sizing.w.filter(|dim| dim.truthy()).map_or(cx, |dim| smart_parse(dim, Axis::X, layout));
            let box_h = sizing.h.filter(|dim| dim.truthy()).map_or(cy, |dim| smart_parse(dim, Axis::Y, layout));
            let box_x = smart_parse(dim_or(sizing.x, 0.0), Axis::X, layout);
            let box_y = smart_parse(dim_or(sizing.y, 0.0), Axis::Y, layout);
            xml.push_str(&sizing_xml(sizing.kind, (image_width, image_height), (box_x, box_y, box_w, box_h)));
            image_width = box_w;
            image_height = box_h;
        }
        None => xml.push_str("  <a:stretch><a:fillRect/></a:stretch>"),
    }
    xml.push_str("</p:blipFill>");
    xml.push_str("<p:spPr>");
    xml.push_str(&format!(" <a:xfrm{}>", location_attributes(object.rotate, object.flip_h, object.flip_v)));
    xml.push_str(&format!("  <a:off x=\"{}\" y=\"{}\"/>", num(x), num(y)));
    xml.push_str(&format!("  <a:ext cx=\"{}\" cy=\"{}\"/>", num(image_width), num(image_height)));
    xml.push_str(" </a:xfrm>");
    xml.push_str(&format!(" <a:prstGeom prst=\"{}\"><a:avLst/></a:prstGeom>", if object.rounding { "ellipse" } else { "rect" }));
    if let Some(shadow) = &object.shadow {
        xml.push_str(&picture_shadow_xml(shadow));
    }
    xml.push_str("</p:spPr>");
    xml.push_str("</p:pic>");
    xml
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wide() -> Layout {
        Layout { name: "custom".to_owned(), width: 12_192_000.0, height: 6_858_000.0 }
    }

    #[test]
    fn a_shape_without_a_line_writes_an_empty_ln_and_a_no_fill() {
        let object = ShapeObject::new("rect", ShapeOptions { x: Some(Dim::Number(1.0)), y: Some(Dim::Number(2.0)), w: Some(Dim::Number(3.0)), h: Some(Dim::Number(0.5)), ..ShapeOptions::default() }, 0).expect("shape");
        let xml = shape_xml(&object, 0, &wide());
        assert!(xml.contains("<p:cNvPr id=\"2\" name=\"Shape 0\"></p:cNvPr>"));
        assert!(xml.contains("<a:off x=\"914400\" y=\"1828800\"/><a:ext cx=\"2743200\" cy=\"457200\"/>"));
        assert!(xml.contains("<a:prstGeom prst=\"rect\"><a:avLst></a:avLst></a:prstGeom><a:noFill/><a:ln></a:ln></p:spPr>"));
    }

    #[test]
    fn a_fill_of_type_none_writes_nothing_and_a_transparent_fill_an_alpha() {
        assert_eq!(color_selection(&Fill::none()), "");
        let fill = Fill { color: Some("1f2e3d".to_owned()), transparency: Some(30.0), ..Fill::default() };
        assert_eq!(color_selection(&fill), "<a:solidFill><a:srgbClr val=\"1F2E3D\"><a:alpha val=\"70000\"/></a:srgbClr></a:solidFill>");
        assert_eq!(color_selection_of("accent2"), "<a:solidFill><a:schemeClr val=\"accent2\"/></a:solidFill>");
        assert_eq!(color_selection_of("nonsense"), "<a:solidFill><a:srgbClr val=\"000000\"/></a:solidFill>");
    }

    #[test]
    fn a_line_takes_its_defaults_and_points_become_emu() {
        let line = Line { color: Some("ABCDEF".to_owned()), width: Some(2.5), ..Line::default() }.resolved();
        assert_eq!(line_xml(&line), "<a:ln w=\"31750\"><a:solidFill><a:srgbClr val=\"ABCDEF\"/></a:solidFill><a:prstDash val=\"solid\"/></a:ln>");
        assert_eq!(line_xml(&Line::none()), "<a:ln></a:ln>");
    }

    #[test]
    fn a_rounded_corner_and_a_rotation_are_written() {
        let options = ShapeOptions { w: Some(Dim::Number(2.0)), h: Some(Dim::Number(1.0)), rect_radius: Some(0.25), rotate: Some(15.0), flip_h: true, ..ShapeOptions::default() };
        let xml = shape_xml(&ShapeObject::new("roundRect", options, 3).expect("shape"), 1, &wide());
        assert!(xml.contains("name=\"Shape 3\""));
        assert!(xml.contains("<a:xfrm flipH=\"1\" rot=\"900000\">"));
        assert!(xml.contains("<a:gd name=\"adj\" fmla=\"val 25000\"/>"));
    }

    #[test]
    fn a_shape_shadow_closes_as_outer_whatever_its_type() {
        let shadow = Shadow { kind: Some("inner".to_owned()), blur: Some(4.0), angle: Some(90.0), opacity: Some(0.5), ..Shadow::default() };
        let xml = shape_shadow_xml(&shadow);
        assert!(xml.starts_with("<a:effectLst> <a:innerShdw  blurRad=\"50800\" dist=\"50800\" dir=\"5400000\">"));
        assert!(xml.ends_with("<a:alpha val=\"50000\"/></a:srgbClr> </a:outerShdw></a:effectLst>"));
        assert_eq!(shape_shadow_xml(&Shadow { kind: Some("none".to_owned()), ..Shadow::default() }), "");
    }

    #[test]
    fn a_picture_shadow_is_corrected_and_closed_by_its_type() {
        let options = ImageOptions { shadow: Some(Shadow { kind: Some("weird".to_owned()), angle: Some(400.0), color: Some("#112233".to_owned()), ..Shadow::default() }), ..ImageOptions::default() };
        let object = ImageObject::new(options, "preencoded.png".to_owned(), 1, 0);
        let xml = image_xml(&object, 0, &wide());
        assert!(xml.contains("<a:outerShdw sx=\"100000\" sy=\"100000\" kx=\"0\" ky=\"0\" algn=\"bl\" rotWithShape=\"0\" blurRad=\"101600\" dist=\"50800\" dir=\"16200000\">"));
        assert!(xml.contains("<a:srgbClr val=\"112233\"><a:alpha val=\"75000\"/></a:srgbClr></a:outerShdw>"));
    }

    #[test]
    fn a_covering_picture_crops_its_overflow() {
        let options = ImageOptions {
            w: Some(Dim::Number(4.0)),
            h: Some(Dim::Number(2.0)),
            sizing: Some(ImageSizing { kind: SizingKind::Cover, x: None, y: None, w: Some(Dim::Number(2.0)), h: Some(Dim::Number(2.0)) }),
            ..ImageOptions::default()
        };
        let xml = image_xml(&ImageObject::new(options, "preencoded.png".to_owned(), 2, 0), 0, &wide());
        assert!(xml.contains("<a:srcRect l=\"25000\" r=\"25000\" t=\"0\" b=\"0\"/><a:stretch/>"));
        assert!(xml.contains("<a:ext cx=\"1828800\" cy=\"1828800\"/>"));
        assert!(xml.contains("<a:blip r:embed=\"rId2\"></a:blip>"));
        assert!(xml.contains("name=\"Image 0\" descr=\"preencoded.png\""));
    }
}
