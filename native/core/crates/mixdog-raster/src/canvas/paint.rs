//! Paint: CSS colours, fill and stroke styles (colour, gradient, pattern) and the composite operations.
//!
//! A gradient is described by the canvas calls (`createLinearGradient`, `createRadialGradient`, `addColorStop`) and
//! turned into a tiny-skia shader when it is drawn, in the space of the context's transform at that moment. tiny-skia's
//! radial gradient has a start radius of zero: that is the case of `createRadialGradient(x0, y0, 0, x1, y1, r1)`, and a
//! start radius on the same centre (a PDF radial shading with an inner circle) is the same gradient with its stops
//! moved into `r0/r1 .. 1` and the first colour kept inside. A start radius on another centre is drawn as a focal
//! gradient from the start point (its start radius is not modelled).

use std::sync::Arc;

use tiny_skia::BlendMode;
use tiny_skia::Color;
use tiny_skia::FilterQuality;
use tiny_skia::GradientStop;
use tiny_skia::LinearGradient;
use tiny_skia::Pixmap;
use tiny_skia::Point;
use tiny_skia::RadialGradient;
use tiny_skia::Shader;
use tiny_skia::SpreadMode;
use tiny_skia::Transform;

use crate::RasterError;

/// The CSS named colours, as `@napi-rs/canvas` resolves them (read back from the canvas itself).
const NAMED: &[(&str, u32)] = &[
    ("aliceblue", 0xf0f8ff),
    ("antiquewhite", 0xfaebd7),
    ("aqua", 0x00ffff),
    ("aquamarine", 0x7fffd4),
    ("azure", 0xf0ffff),
    ("beige", 0xf5f5dc),
    ("bisque", 0xffe4c4),
    ("black", 0x000000),
    ("blanchedalmond", 0xffebcd),
    ("blue", 0x0000ff),
    ("blueviolet", 0x8a2be2),
    ("brown", 0xa52a2a),
    ("burlywood", 0xdeb887),
    ("cadetblue", 0x5f9ea0),
    ("chartreuse", 0x7fff00),
    ("chocolate", 0xd2691e),
    ("coral", 0xff7f50),
    ("cornflowerblue", 0x6495ed),
    ("cornsilk", 0xfff8dc),
    ("crimson", 0xdc143c),
    ("cyan", 0x00ffff),
    ("darkblue", 0x00008b),
    ("darkcyan", 0x008b8b),
    ("darkgoldenrod", 0xb8860b),
    ("darkgray", 0xa9a9a9),
    ("darkgreen", 0x006400),
    ("darkgrey", 0xa9a9a9),
    ("darkkhaki", 0xbdb76b),
    ("darkmagenta", 0x8b008b),
    ("darkolivegreen", 0x556b2f),
    ("darkorange", 0xff8c00),
    ("darkorchid", 0x9932cc),
    ("darkred", 0x8b0000),
    ("darksalmon", 0xe9967a),
    ("darkseagreen", 0x8fbc8f),
    ("darkslateblue", 0x483d8b),
    ("darkslategray", 0x2f4f4f),
    ("darkslategrey", 0x2f4f4f),
    ("darkturquoise", 0x00ced1),
    ("darkviolet", 0x9400d3),
    ("deeppink", 0xff1493),
    ("deepskyblue", 0x00bfff),
    ("dimgray", 0x696969),
    ("dimgrey", 0x696969),
    ("dodgerblue", 0x1e90ff),
    ("firebrick", 0xb22222),
    ("floralwhite", 0xfffaf0),
    ("forestgreen", 0x228b22),
    ("fuchsia", 0xff00ff),
    ("gainsboro", 0xdcdcdc),
    ("ghostwhite", 0xf8f8ff),
    ("gold", 0xffd700),
    ("goldenrod", 0xdaa520),
    ("gray", 0x808080),
    ("green", 0x008000),
    ("greenyellow", 0xadff2f),
    ("grey", 0x808080),
    ("honeydew", 0xf0fff0),
    ("hotpink", 0xff69b4),
    ("indianred", 0xcd5c5c),
    ("indigo", 0x4b0082),
    ("ivory", 0xfffff0),
    ("khaki", 0xf0e68c),
    ("lavender", 0xe6e6fa),
    ("lavenderblush", 0xfff0f5),
    ("lawngreen", 0x7cfc00),
    ("lemonchiffon", 0xfffacd),
    ("lightblue", 0xadd8e6),
    ("lightcoral", 0xf08080),
    ("lightcyan", 0xe0ffff),
    ("lightgoldenrodyellow", 0xfafad2),
    ("lightgray", 0xd3d3d3),
    ("lightgreen", 0x90ee90),
    ("lightgrey", 0xd3d3d3),
    ("lightpink", 0xffb6c1),
    ("lightsalmon", 0xffa07a),
    ("lightseagreen", 0x20b2aa),
    ("lightskyblue", 0x87cefa),
    ("lightslategray", 0x778899),
    ("lightslategrey", 0x778899),
    ("lightsteelblue", 0xb0c4de),
    ("lightyellow", 0xffffe0),
    ("lime", 0x00ff00),
    ("limegreen", 0x32cd32),
    ("linen", 0xfaf0e6),
    ("magenta", 0xff00ff),
    ("maroon", 0x800000),
    ("mediumaquamarine", 0x66cdaa),
    ("mediumblue", 0x0000cd),
    ("mediumorchid", 0xba55d3),
    ("mediumpurple", 0x9370db),
    ("mediumseagreen", 0x3cb371),
    ("mediumslateblue", 0x7b68ee),
    ("mediumspringgreen", 0x00fa9a),
    ("mediumturquoise", 0x48d1cc),
    ("mediumvioletred", 0xc71585),
    ("midnightblue", 0x191970),
    ("mintcream", 0xf5fffa),
    ("mistyrose", 0xffe4e1),
    ("moccasin", 0xffe4b5),
    ("navajowhite", 0xffdead),
    ("navy", 0x000080),
    ("oldlace", 0xfdf5e6),
    ("olive", 0x808000),
    ("olivedrab", 0x6b8e23),
    ("orange", 0xffa500),
    ("orangered", 0xff4500),
    ("orchid", 0xda70d6),
    ("palegoldenrod", 0xeee8aa),
    ("palegreen", 0x98fb98),
    ("paleturquoise", 0xafeeee),
    ("palevioletred", 0xdb7093),
    ("papayawhip", 0xffefd5),
    ("peachpuff", 0xffdab9),
    ("peru", 0xcd853f),
    ("pink", 0xffc0cb),
    ("plum", 0xdda0dd),
    ("powderblue", 0xb0e0e6),
    ("purple", 0x800080),
    ("rebeccapurple", 0x663399),
    ("red", 0xff0000),
    ("rosybrown", 0xbc8f8f),
    ("royalblue", 0x4169e1),
    ("saddlebrown", 0x8b4513),
    ("salmon", 0xfa8072),
    ("sandybrown", 0xf4a460),
    ("seagreen", 0x2e8b57),
    ("seashell", 0xfff5ee),
    ("sienna", 0xa0522d),
    ("silver", 0xc0c0c0),
    ("skyblue", 0x87ceeb),
    ("slateblue", 0x6a5acd),
    ("slategray", 0x708090),
    ("slategrey", 0x708090),
    ("snow", 0xfffafa),
    ("springgreen", 0x00ff7f),
    ("steelblue", 0x4682b4),
    ("tan", 0xd2b48c),
    ("teal", 0x008080),
    ("thistle", 0xd8bfd8),
    ("tomato", 0xff6347),
    ("turquoise", 0x40e0d0),
    ("violet", 0xee82ee),
    ("wheat", 0xf5deb3),
    ("white", 0xffffff),
    ("whitesmoke", 0xf5f5f5),
    ("yellow", 0xffff00),
    ("yellowgreen", 0x9acd32),
];

fn named(name: &str) -> Option<(u8, u8, u8, u8)> {
    if name == "transparent" {
        return Some((0, 0, 0, 0));
    }
    let (_, rgb) = NAMED.iter().find(|(candidate, _)| *candidate == name)?;
    Some(((rgb >> 16) as u8, (rgb >> 8) as u8, *rgb as u8, 255))
}

fn hex(digits: &str) -> Option<(u8, u8, u8, u8)> {
    if !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let value = |at: usize, len: usize| u8::from_str_radix(&digits[at..at + len], 16).ok();
    let double = |at: usize| value(at, 1).map(|nibble| nibble * 17);
    match digits.len() {
        3 => Some((double(0)?, double(1)?, double(2)?, 255)),
        4 => Some((double(0)?, double(1)?, double(2)?, double(3)?)),
        6 => Some((value(0, 2)?, value(2, 2)?, value(4, 2)?, 255)),
        8 => Some((value(0, 2)?, value(2, 2)?, value(4, 2)?, value(6, 2)?)),
        _ => None,
    }
}

/// A number or a percentage: `(value, was_percent)`.
fn component(text: &str) -> Option<(f32, bool)> {
    let (number, percent) = match text.strip_suffix('%') {
        Some(number) => (number, true),
        None => (text, false),
    };
    let value: f32 = number.parse().ok()?;
    value.is_finite().then_some((value, percent))
}

fn alpha_component(text: Option<&str>) -> Option<f32> {
    let Some(text) = text else { return Some(1.0) };
    let (value, percent) = component(text)?;
    Some((if percent { value / 100.0 } else { value }).clamp(0.0, 1.0))
}

fn hue_degrees(text: &str) -> Option<f32> {
    for (suffix, per_turn) in [("deg", 360.0), ("grad", 400.0), ("rad", std::f32::consts::TAU), ("turn", 1.0)] {
        if let Some(number) = text.strip_suffix(suffix) {
            let value: f32 = number.parse().ok()?;
            return value.is_finite().then_some(value / per_turn * 360.0);
        }
    }
    let value: f32 = text.parse().ok()?;
    value.is_finite().then_some(value)
}

fn hsl_to_rgb(hue: f32, saturation: f32, lightness: f32) -> (f32, f32, f32) {
    let hue = hue.rem_euclid(360.0) / 60.0;
    let chroma = (1.0 - (2.0 * lightness - 1.0).abs()) * saturation;
    let x = chroma * (1.0 - (hue % 2.0 - 1.0).abs());
    let (r, g, b) = match hue as u32 {
        0 => (chroma, x, 0.0),
        1 => (x, chroma, 0.0),
        2 => (0.0, chroma, x),
        3 => (0.0, x, chroma),
        4 => (x, 0.0, chroma),
        _ => (chroma, 0.0, x),
    };
    let m = lightness - chroma / 2.0;
    (r + m, g + m, b + m)
}

fn to_byte(value: f32) -> u8 {
    (value * 255.0).round().clamp(0.0, 255.0) as u8
}

fn function(name: &str, arguments: &str) -> Option<(u8, u8, u8, u8)> {
    let parts: Vec<&str> = arguments.split([',', ' ', '/', '\t']).filter(|part| !part.is_empty()).collect();
    if parts.len() < 3 || parts.len() > 4 {
        return None;
    }
    let alpha = alpha_component(parts.get(3).copied())?;
    match name {
        "rgb" | "rgba" => {
            let channel = |text: &str| -> Option<u8> {
                let (value, percent) = component(text)?;
                Some((if percent { value * 255.0 / 100.0 } else { value }).round().clamp(0.0, 255.0) as u8)
            };
            Some((channel(parts[0])?, channel(parts[1])?, channel(parts[2])?, to_byte(alpha)))
        }
        "hsl" | "hsla" => {
            let fraction = |text: &str| -> Option<f32> {
                let (value, percent) = component(text)?;
                Some((if percent { value / 100.0 } else { value }).clamp(0.0, 1.0))
            };
            let (r, g, b) = hsl_to_rgb(hue_degrees(parts[0])?, fraction(parts[1])?, fraction(parts[2])?);
            Some((to_byte(r), to_byte(g), to_byte(b), to_byte(alpha)))
        }
        _ => None,
    }
}

/// A CSS colour as the canvas reads `fillStyle`, `strokeStyle` and `addColorStop` colours: a name, `#rgb`, `#rgba`,
/// `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`, `hsl()` or `hsla()` (comma or space separated, percentages, a `/` alpha),
/// any case. `None` when it is none of these (the canvas then keeps the old style).
pub fn parse_color(text: &str) -> Option<Color> {
    let lower = text.trim().to_ascii_lowercase();
    let (r, g, b, a) = if let Some(digits) = lower.strip_prefix('#') {
        hex(digits)?
    } else if let Some(open) = lower.find('(') {
        let inner = lower[open + 1..].strip_suffix(')')?;
        function(lower[..open].trim(), inner)?
    } else {
        named(&lower)?
    };
    Some(Color::from_rgba8(r, g, b, a))
}

/// The compositing of a drawing operation (`globalCompositeOperation`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum CompositeOperation {
    #[default]
    SourceOver,
    SourceIn,
    SourceOut,
    SourceAtop,
    DestinationOver,
    DestinationIn,
    DestinationOut,
    DestinationAtop,
    Lighter,
    Copy,
    Xor,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    ColorDodge,
    ColorBurn,
    HardLight,
    SoftLight,
    Difference,
    Exclusion,
    Hue,
    Saturation,
    Color,
    Luminosity,
}

impl CompositeOperation {
    /// The operation a `globalCompositeOperation` string names; `None` for any other string (the canvas ignores it).
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "source-over" => Self::SourceOver,
            "source-in" => Self::SourceIn,
            "source-out" => Self::SourceOut,
            "source-atop" => Self::SourceAtop,
            "destination-over" => Self::DestinationOver,
            "destination-in" => Self::DestinationIn,
            "destination-out" => Self::DestinationOut,
            "destination-atop" => Self::DestinationAtop,
            "lighter" => Self::Lighter,
            "copy" => Self::Copy,
            "xor" => Self::Xor,
            "multiply" => Self::Multiply,
            "screen" => Self::Screen,
            "overlay" => Self::Overlay,
            "darken" => Self::Darken,
            "lighten" => Self::Lighten,
            "color-dodge" => Self::ColorDodge,
            "color-burn" => Self::ColorBurn,
            "hard-light" => Self::HardLight,
            "soft-light" => Self::SoftLight,
            "difference" => Self::Difference,
            "exclusion" => Self::Exclusion,
            "hue" => Self::Hue,
            "saturation" => Self::Saturation,
            "color" => Self::Color,
            "luminosity" => Self::Luminosity,
            _ => return None,
        })
    }

    /// True for the operations that change the canvas outside the shape too, because a transparent source gives a
    /// different result than leaving the destination alone.
    pub fn clears_outside_shape(self) -> bool {
        matches!(self, Self::SourceIn | Self::SourceOut | Self::DestinationIn | Self::DestinationAtop | Self::Copy)
    }

    pub fn blend_mode(self) -> BlendMode {
        match self {
            Self::SourceOver => BlendMode::SourceOver,
            Self::SourceIn => BlendMode::SourceIn,
            Self::SourceOut => BlendMode::SourceOut,
            Self::SourceAtop => BlendMode::SourceAtop,
            Self::DestinationOver => BlendMode::DestinationOver,
            Self::DestinationIn => BlendMode::DestinationIn,
            Self::DestinationOut => BlendMode::DestinationOut,
            Self::DestinationAtop => BlendMode::DestinationAtop,
            Self::Lighter => BlendMode::Plus,
            Self::Copy => BlendMode::Source,
            Self::Xor => BlendMode::Xor,
            Self::Multiply => BlendMode::Multiply,
            Self::Screen => BlendMode::Screen,
            Self::Overlay => BlendMode::Overlay,
            Self::Darken => BlendMode::Darken,
            Self::Lighten => BlendMode::Lighten,
            Self::ColorDodge => BlendMode::ColorDodge,
            Self::ColorBurn => BlendMode::ColorBurn,
            Self::HardLight => BlendMode::HardLight,
            Self::SoftLight => BlendMode::SoftLight,
            Self::Difference => BlendMode::Difference,
            Self::Exclusion => BlendMode::Exclusion,
            Self::Hue => BlendMode::Hue,
            Self::Saturation => BlendMode::Saturation,
            Self::Color => BlendMode::Color,
            Self::Luminosity => BlendMode::Luminosity,
        }
    }
}

/// How `drawImage` and patterns filter pixels (`imageSmoothingQuality`; `imageSmoothingEnabled` switches it off).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SmoothingQuality {
    Low,
    Medium,
    High,
}

impl SmoothingQuality {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            _ => None,
        }
    }

    /// The tiny-skia filter: bilinear for low and medium (Skia's medium differs by its mip maps, which tiny-skia does
    /// not have), bicubic for high, nearest when smoothing is off.
    pub(crate) fn filter(self, enabled: bool) -> FilterQuality {
        match (enabled, self) {
            (false, _) => FilterQuality::Nearest,
            (true, Self::High) => FilterQuality::Bicubic,
            (true, _) => FilterQuality::Bilinear,
        }
    }
}

/// How a pattern repeats (`createPattern`'s second argument).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Repetition {
    Repeat,
    RepeatX,
    RepeatY,
    NoRepeat,
}

impl Repetition {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "repeat" | "" => Some(Self::Repeat),
            "repeat-x" => Some(Self::RepeatX),
            "repeat-y" => Some(Self::RepeatY),
            "no-repeat" => Some(Self::NoRepeat),
            _ => None,
        }
    }
}

/// A `CanvasPattern`: an image (premultiplied pixels) that repeats, with its own transform (`setTransform`).
#[derive(Clone, Debug)]
pub struct PatternStyle {
    pub(crate) pixmap: Arc<Pixmap>,
    pub(crate) repetition: Repetition,
    pub(crate) transform: Transform,
}

impl PatternStyle {
    pub fn new(bitmap: &super::Bitmap, repetition: Repetition) -> Self {
        Self { pixmap: Arc::new(bitmap.pixmap().clone()), repetition, transform: Transform::identity() }
    }

    /// `pattern.setTransform(matrix)`.
    pub fn set_transform(&mut self, a: f32, b: f32, c: f32, d: f32, e: f32, f: f32) {
        self.transform = Transform::from_row(a, b, c, d, e, f);
    }

    /// The region of pattern space the fill is cut to when the pattern does not repeat both ways: `(x, y, width,
    /// height)`.
    pub(crate) fn band(&self) -> Option<(f32, f32, f32, f32)> {
        const FAR: f32 = 1.0e7;
        let (width, height) = (self.pixmap.width() as f32, self.pixmap.height() as f32);
        match self.repetition {
            Repetition::Repeat => None,
            Repetition::RepeatX => Some((-FAR, 0.0, 2.0 * FAR, height)),
            Repetition::RepeatY => Some((0.0, -FAR, width, 2.0 * FAR)),
            Repetition::NoRepeat => Some((0.0, 0.0, width, height)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum GradientKind {
    Linear { x0: f32, y0: f32, x1: f32, y1: f32 },
    Radial { x0: f32, y0: f32, r0: f32, x1: f32, y1: f32, r1: f32 },
}

/// A `CanvasGradient`.
#[derive(Clone, Debug, PartialEq)]
pub struct Gradient {
    kind: GradientKind,
    stops: Vec<(f32, Color)>,
}

impl Gradient {
    pub fn linear(x0: f32, y0: f32, x1: f32, y1: f32) -> Self {
        Self { kind: GradientKind::Linear { x0, y0, x1, y1 }, stops: Vec::new() }
    }

    pub fn radial(x0: f32, y0: f32, r0: f32, x1: f32, y1: f32, r1: f32) -> Self {
        Self { kind: GradientKind::Radial { x0, y0, r0, x1, y1, r1 }, stops: Vec::new() }
    }

    /// `addColorStop(offset, colour)`: an offset outside 0..1 or a colour that does not parse is an error. Stops of the
    /// same offset keep the order they were added in.
    pub fn add_color_stop(&mut self, offset: f32, color: &str) -> Result<(), RasterError> {
        if !(0.0..=1.0).contains(&offset) {
            return Err(RasterError::new("the offset of a colour stop is outside 0 to 1"));
        }
        let color = parse_color(color).ok_or_else(|| RasterError::new(format!("`{color}` is not a colour")))?;
        let at = self.stops.partition_point(|(existing, _)| *existing <= offset);
        self.stops.insert(at, (offset, color));
        Ok(())
    }

    /// The colour glyph coverage is corrected for when this gradient paints text: the mean of the stops (Skia's
    /// `asLuminanceColor` of a gradient shader).
    pub(crate) fn luminance_color(&self) -> Color {
        let count = self.stops.len().max(1) as f32;
        let sum = self.stops.iter().fold([0.0_f32; 3], |sum, (_, color)| [sum[0] + color.red(), sum[1] + color.green(), sum[2] + color.blue()]);
        Color::from_rgba(sum[0] / count, sum[1] / count, sum[2] / count, 1.0).unwrap_or(Color::BLACK)
    }

    /// The shader in the space the canvas was in when the gradient is used, with `opacity` (`globalAlpha`) applied.
    /// `None` draws nothing (no stop, or a gradient tiny-skia refuses).
    pub(crate) fn shader(&self, opacity: f32) -> Option<Shader<'static>> {
        if self.stops.is_empty() {
            return None;
        }
        let stops = |list: &[(f32, Color)]| list.iter().map(|(position, color)| GradientStop::new(*position, *color)).collect::<Vec<_>>();
        let mut shader = match self.kind {
            GradientKind::Linear { x0, y0, x1, y1 } => {
                LinearGradient::new(Point::from_xy(x0, y0), Point::from_xy(x1, y1), stops(&self.stops), SpreadMode::Pad, Transform::identity())?
            }
            GradientKind::Radial { x0, y0, r0, x1, y1, r1 } => {
                let same_centre = (x0 - x1).abs() < f32::EPSILON && (y0 - y1).abs() < f32::EPSILON;
                if r0 > 0.0 && same_centre && r0 != r1 {
                    // Rings about one centre: the gradient runs from the smaller radius to the larger; inside the
                    // smaller one the colour is that of the first stop.
                    let (inner, outer, ordered): (f32, f32, Vec<(f32, Color)>) = if r0 < r1 {
                        (r0, r1, self.stops.clone())
                    } else {
                        (r1, r0, self.stops.iter().rev().map(|(position, color)| (1.0 - position, *color)).collect())
                    };
                    let from = inner / outer;
                    let mut moved: Vec<(f32, Color)> = vec![(0.0, ordered[0].1)];
                    moved.extend(ordered.iter().map(|(position, color)| (from + position * (1.0 - from), *color)));
                    let centre = Point::from_xy(x1, y1);
                    RadialGradient::new(centre, centre, outer, stops(&moved), SpreadMode::Pad, Transform::identity())?
                } else {
                    RadialGradient::new(Point::from_xy(x0, y0), Point::from_xy(x1, y1), r1, stops(&self.stops), SpreadMode::Pad, Transform::identity())?
                }
            }
        };
        shader.apply_opacity(opacity);
        Some(shader)
    }
}

/// What a fill or stroke is painted with.
#[derive(Clone, Debug)]
pub enum Style {
    Color(Color),
    Gradient(Gradient),
    Pattern(PatternStyle),
}

impl Style {
    /// The colour the coverage of glyphs painted with this style is corrected for (a pattern: black).
    pub(crate) fn luminance_color(&self) -> Color {
        match self {
            Self::Color(color) => *color,
            Self::Gradient(gradient) => gradient.luminance_color(),
            Self::Pattern(_) => Color::BLACK,
        }
    }
}

impl Default for Style {
    /// `#000000`, the initial `fillStyle` and `strokeStyle`.
    fn default() -> Self {
        Self::Color(Color::BLACK)
    }
}

impl Style {
    /// The `fillStyle = "..."` colour; `None` (the canvas keeps the old style) when the text is no colour.
    pub fn from_css(text: &str) -> Option<Self> {
        parse_color(text).map(Self::Color)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgba(text: &str) -> Option<[u8; 4]> {
        parse_color(text).map(|color| {
            let c = color.to_color_u8();
            [c.red(), c.green(), c.blue(), c.alpha()]
        })
    }

    #[test]
    fn colours_parse_as_the_canvas_reads_them() {
        assert_eq!(rgba("#f00"), Some([255, 0, 0, 255]));
        assert_eq!(rgba("#FF000080"), Some([255, 0, 0, 128]));
        assert_eq!(rgba("#0f08"), Some([0, 255, 0, 136]));
        assert_eq!(rgba("  Rebeccapurple "), Some([102, 51, 153, 255]));
        assert_eq!(rgba("transparent"), Some([0, 0, 0, 0]));
        assert_eq!(rgba("rgb(10, 20, 30)"), Some([10, 20, 30, 255]));
        assert_eq!(rgba("rgba(10 20 30 / 50%)"), Some([10, 20, 30, 128]));
        assert_eq!(rgba("rgb(100%, 0%, 50%)"), Some([255, 0, 128, 255]));
        assert_eq!(rgba("rgb(300, -4, 30)"), Some([255, 0, 30, 255]));
        assert_eq!(rgba("hsl(120, 100%, 50%)"), Some([0, 255, 0, 255]));
        assert_eq!(rgba("hsla(0, 100%, 50%, 0.5)"), Some([255, 0, 0, 128]));
        assert_eq!(rgba("hsl(0.5turn 50% 50%)"), Some([64, 191, 191, 255]));
    }

    #[test]
    fn text_that_is_no_colour_is_refused() {
        for text in ["", "#12", "#gggggg", "rgb(1, 2)", "rgb(a, b, c)", "notacolour", "rgb(1,2,3", "lab(1 2 3)"] {
            assert_eq!(rgba(text), None, "{text}");
        }
    }

    #[test]
    fn every_composite_operation_name_maps_and_unknown_names_do_not() {
        for name in [
            "source-over",
            "source-in",
            "source-out",
            "source-atop",
            "destination-over",
            "destination-in",
            "destination-out",
            "destination-atop",
            "lighter",
            "copy",
            "xor",
            "multiply",
            "screen",
            "overlay",
            "darken",
            "lighten",
            "color-dodge",
            "color-burn",
            "hard-light",
            "soft-light",
            "difference",
            "exclusion",
            "hue",
            "saturation",
            "color",
            "luminosity",
        ] {
            assert!(CompositeOperation::parse(name).is_some(), "{name}");
        }
        assert_eq!(CompositeOperation::parse("lighter").map(CompositeOperation::blend_mode), Some(BlendMode::Plus));
        assert_eq!(CompositeOperation::parse("copy").map(CompositeOperation::blend_mode), Some(BlendMode::Source));
        assert_eq!(CompositeOperation::parse("Source-Over"), None);
    }

    #[test]
    fn five_operations_reach_beyond_the_shape() {
        let reaching: Vec<&str> = ["source-over", "source-in", "source-out", "source-atop", "destination-over", "destination-in", "destination-out", "destination-atop", "lighter", "copy", "xor", "multiply"]
            .into_iter()
            .filter(|name| CompositeOperation::parse(name).is_some_and(CompositeOperation::clears_outside_shape))
            .collect();
        assert_eq!(reaching, ["source-in", "source-out", "destination-in", "destination-atop", "copy"]);
    }

    #[test]
    fn colour_stops_are_checked_and_kept_in_offset_order() {
        let mut gradient = Gradient::linear(0.0, 0.0, 10.0, 0.0);
        assert!(gradient.add_color_stop(1.5, "red").is_err());
        assert!(gradient.add_color_stop(0.5, "nope").is_err());
        gradient.add_color_stop(1.0, "blue").unwrap();
        gradient.add_color_stop(0.0, "red").unwrap();
        gradient.add_color_stop(1.0, "lime").unwrap();
        let offsets: Vec<f32> = gradient.stops.iter().map(|(offset, _)| *offset).collect();
        assert_eq!(offsets, [0.0, 1.0, 1.0]);
        assert_eq!(gradient.stops[2].1, parse_color("lime").unwrap(), "equal offsets keep the order they were added in");
        assert!(gradient.shader(1.0).is_some());
        assert!(Gradient::linear(0.0, 0.0, 1.0, 0.0).shader(1.0).is_none(), "no stop, nothing to draw");
    }

    #[test]
    fn a_ring_gradient_on_one_centre_has_a_shader() {
        let mut gradient = Gradient::radial(5.0, 5.0, 2.0, 5.0, 5.0, 8.0);
        gradient.add_color_stop(0.0, "white").unwrap();
        gradient.add_color_stop(1.0, "black").unwrap();
        assert!(gradient.shader(0.5).is_some());
        let mut reversed = Gradient::radial(5.0, 5.0, 8.0, 5.0, 5.0, 2.0);
        reversed.add_color_stop(0.0, "white").unwrap();
        reversed.add_color_stop(1.0, "black").unwrap();
        assert!(reversed.shader(1.0).is_some());
    }

    #[test]
    fn smoothing_picks_the_filter() {
        assert_eq!(SmoothingQuality::Low.filter(false), FilterQuality::Nearest);
        assert_eq!(SmoothingQuality::Low.filter(true), FilterQuality::Bilinear);
        assert_eq!(SmoothingQuality::Medium.filter(true), FilterQuality::Bilinear);
        assert_eq!(SmoothingQuality::High.filter(true), FilterQuality::Bicubic);
    }
}
