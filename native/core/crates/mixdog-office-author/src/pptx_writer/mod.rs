//! The pptx writer: the package the `pptxgenjs` 4.0.1 library writes (`dist/pptxgen.cjs.js`) for the calls
//! `authoring/pptx-html-build.mjs` makes, built on `mixdog_ooxml`'s package container instead of `jszip`. A
//! [`Presentation`] is the `PptxGenJS` object (layout, `defineLayout`, `addSlide`, the document properties and the
//! theme fonts); a [`Slide`] takes `addShape` (any preset geometry: fill, outline, shadow, corner radius, rotation,
//! flips, hyperlink), `addImage` (data or file pictures with sizing, rounding, transparency, shadow), `addNotes`, the
//! background (colour or picture), the slide number and `hidden`. The package has pptxgenjs's own part names, content
//! types, relationships, media names (`image-<slide>-<n>.<ext>`), `docProps`, presentation, theme, slide master, the
//! one slide layout, notes master and notes slides, in its entry order, so a deck from here equals a deck from there
//! part by part.
//!
//! Text boxes (`addText`) and tables (`addTable`) are written by `text` and `table`; charts belong to the chart writer,
//! which adds to the objects and rels held here. Not carried: `addMedia` (audio and video), SVG pictures (pptxgenjs's own
//! preview of one is a broken-image placeholder, and the build rasterises SVG itself), `defineSlideMaster`,
//! sections and the custom geometry points, the 3D bar, the bubble chart and combo charts with a secondary axis (the chart
//! writer of charts.rs carries area, bar and column, line, pie, doughnut, radar and scatter).

mod chart_workbook;
mod charts;
mod media;
mod presentation;
mod shapes;
mod slide;
mod table;
mod text;
mod theme;

use mixdog_js::{math, number_to_string};

pub use charts::{
    AxisCrossing, AxisStyle, Chart, ChartArea, ChartBorder, ChartData, ChartKind, ChartLayout, ChartOptions, ChartShadow, GridLine, PlotArea, TitlePos,
};
pub use media::ImageFile;
pub use presentation::Presentation;
pub use shapes::{Fill, Hyperlink, ImageOptions, ImageSizing, Line, Shadow, ShapeOptions, SizingKind};
pub use slide::{Background, Slide, SlideNumber, SlideNumberMargin};
pub use table::{ColWidths, RowHeights, TableCell, TableOptions};
pub use text::{Border, Borders, Bullet, BulletSpec, Glow, Margin, Outline, Strike, TabStop, TextContent, TextOptions, TextRun, Underline};
pub use theme::ThemeFonts;

/// One inch in EMU.
pub(crate) const EMU: f64 = 914_400.0;
/// One point in EMU.
pub(crate) const ONE_PT: f64 = 12_700.0;
/// The line break pptxgenjs writes after an XML declaration.
pub(crate) const CRLF: &str = "\r\n";

/// A slide size in EMU (`PresLayout`).
#[derive(Debug, Clone, PartialEq)]
pub struct Layout {
    pub name: String,
    pub width: f64,
    pub height: f64,
}

/// A position or size option: a number (inches below 100, EMU from 100 up) or a percentage of the slide.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Dim {
    Number(f64),
    Percent(f64),
}

impl Dim {
    /// Whether `value || fallback` keeps the value: a percentage is a non-empty string, a number is not 0 or NaN.
    pub(crate) fn truthy(self) -> bool {
        match self {
            Dim::Number(value) => value != 0.0 && !value.is_nan(),
            Dim::Percent(_) => true,
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Axis {
    X,
    Y,
}

/// `getSmartParseNumber`: the EMU of a position or size.
pub(crate) fn smart_parse(size: Dim, axis: Axis, layout: &Layout) -> f64 {
    match size {
        Dim::Number(value) if value < 100.0 => inch_to_emu(value),
        Dim::Number(value) if value >= 100.0 => value,
        Dim::Number(_) => 0.0,
        Dim::Percent(percent) => {
            let along = match axis {
                Axis::X => layout.width,
                Axis::Y => layout.height,
            };
            round(percent / 100.0 * along)
        }
    }
}

/// `inch2Emu` of a number: a value over 100 is taken to be EMU already.
pub(crate) fn inch_to_emu(inches: f64) -> f64 {
    if inches > 100.0 { inches } else { round(EMU * inches) }
}

/// `valToPts`: points as EMU.
pub(crate) fn val_to_pts(points: f64) -> f64 {
    if points.is_nan() { 0.0 } else { round(points * ONE_PT) }
}

/// `convertRotationDegrees`: degrees as the `rot` value (sixty-thousandths of a degree).
pub(crate) fn rotation_value(degrees: f64) -> f64 {
    let degrees = if degrees.is_nan() { 0.0 } else { degrees };
    round((if degrees > 360.0 { degrees - 360.0 } else { degrees }) * 60_000.0)
}

/// `Math.round`.
pub(crate) fn round(value: f64) -> f64 {
    math::round(value)
}

/// A number as JavaScript prints it into a template string.
pub(crate) fn num(value: f64) -> String {
    number_to_string(value)
}

/// `value || fallback` for a number option: unset, 0 and NaN take the fallback.
pub(crate) fn or(value: Option<f64>, fallback: f64) -> f64 {
    match value {
        Some(value) if value != 0.0 && !value.is_nan() => value,
        _ => fallback,
    }
}

/// Whether a number option is set to something truthy.
pub(crate) fn is_set(value: Option<f64>) -> bool {
    value.is_some_and(|value| value != 0.0 && !value.is_nan())
}

/// `encodeXmlEntities`.
pub(crate) fn encode_xml_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            other => out.push(other),
        }
    }
    out
}
