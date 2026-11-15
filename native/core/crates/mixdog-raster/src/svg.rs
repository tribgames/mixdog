//! SVG to pixels, the way the Office code asks sharp (libvips `svgload`, librsvg) for it, drawn by resvg.
//!
//! The Office stack hands sharp an SVG in three places: an SVG logo on a PDF page (rendered at up to 4 times its declared size and at most
//! 4000 pixels either way: [`rasterize_logo`]), the pptx kit's icons, gradients and motifs turned into PNG ([`rasterize`] at the default
//! density) and the SVG captures of the pptx HTML build (density 180, then a resize to the placed box: [`rasterize_to`]). All three go through
//! the rules below, which were recorded from sharp 0.35.5 (`fixtures/office-svg`):
//!
//! * the **density** is dots per inch, 72 by default (1 to 100000): physical units (`in`, `cm`, `mm`, `pt`, `pc`) become pixels at that
//!   density, and the whole picture is then scaled by `density / 72`, so `1in` at density 144 is 288 pixels;
//! * the **size** is the declared one: `width` and `height` when both are given in absolute units (percentages count as not given); with a
//!   `viewBox`, the side that is missing follows the viewBox aspect and neither side given is the viewBox size; without a `viewBox`, a side
//!   missing means the size of the drawing's ink (stroke included) and nothing is translated. A negative side is ignored, a zero side is
//!   an error; sizes are rounded half up after the density scale and a size that rounds to nothing is an error;
//! * the picture is drawn into that rounded size at the largest uniform scale that fits it, centred; a page that is the size of its ink is
//!   drawn at its own scale from the corner, and a viewBox without area draws nothing;
//! * a **resize** of an SVG re-renders it: sharp loads the vector at the scale that makes the smaller of the two size ratios exact and then
//!   resamples the (rounded) render to the asked size, which [`rasterize_to`] repeats;
//! * the error sentences are libvips's: `bad dimensions`, `zero-sized image`, the pixel limit, an unsupported format for bytes that are not
//!   SVG, and sharp's own density range sentence.
//!
//! Text is shaped by usvg through the faces of a [`SvgFonts`], which loads the `mixdog-fonts` registry (the one font source of the
//! product) into usvg's font database under the registry's family names; a family that is not registered falls to the registry's first
//! family, as the canvas does. Relative links to files are not followed (a buffer has no base URL); embedded `data:` images are drawn.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;

use mixdog_fonts::registry::FaceId;
use mixdog_fonts::registry::Registry;
use mixdog_fsio::ReadProof;
use mixdog_imaging::DEFAULT_PIXEL_LIMIT;
use mixdog_imaging::Format;
use mixdog_imaging::error::EMPTY_BUFFER;
use mixdog_imaging::error::PIXEL_LIMIT;
use mixdog_imaging::error::UNSUPPORTED_FORMAT;
use mixdog_imaging::error::corrupt_header;
use mixdog_rt::LaneToken;
use resvg::tiny_skia;
use resvg::usvg;
use usvg::fontdb;
use usvg::roxmltree;

use crate::Image;
use crate::RasterError;
use crate::ops::Kernel;
use crate::ops::resize_exact;

/// sharp's default SVG density.
pub const DEFAULT_DENSITY: f64 = 72.0;

/// The declared size the PDF page keeps for a logo, and the bounds of the raster drawn at it (`pdf-draw.mjs`).
const LOGO_SCALE: f64 = 4.0;
const LOGO_MAX_PIXELS: f64 = 4000.0;

/// The root `font-size` of an SVG without one, which `em` and `ex` lengths are taken from (usvg's default, librsvg's too).
const FONT_SIZE: f64 = 12.0;

/// What `sharp(svg, { density }).metadata()` answers for an SVG.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct SvgMetadata {
    pub width: u32,
    pub height: u32,
    /// The density the size was computed at.
    pub density: f64,
}

/// The faces SVG text is drawn with: a registry loaded into usvg's font database.
#[derive(Clone)]
pub struct SvgFonts {
    database: Arc<fontdb::Database>,
    default_family: Option<String>,
}

impl SvgFonts {
    /// No faces: SVG text draws nothing.
    pub fn none() -> Self {
        Self { database: Arc::new(fontdb::Database::new()), default_family: None }
    }

    /// Every face of `registry` that can be read, under the family name it is registered under (a registry alias is not a name here). A face that cannot
    /// be read or parsed is not part of the set.
    pub fn from_registry<P: ReadProof>(proof: &P, registry: &Registry) -> Self {
        let mut database = fontdb::Database::new();
        // What the font parser says of each distinct file, by the file's bytes and the face's index in it.
        let mut parsed: HashMap<(usize, u32), fontdb::FaceInfo> = HashMap::new();
        let mut files: HashSet<usize> = HashSet::new();
        let mut order: Vec<(FaceId, (usize, u32))> = Vec::new();
        for id in 0..registry.len() {
            let face = registry.face(id);
            let Ok(data) = face.ensure_loaded(proof) else { continue };
            let file = data.as_ptr() as usize;
            if files.insert(file) {
                for loaded in database.load_font_source(fontdb::Source::Binary(Arc::new(SharedBytes(Arc::clone(data))))) {
                    if let Some(info) = database.face(loaded) {
                        parsed.insert((file, info.index), info.clone());
                    }
                    database.remove_face(loaded);
                }
            }
            order.push((id, (file, face.index())));
        }
        for (id, key) in order {
            if let Some(info) = parsed.get(&key) {
                let mut info = info.clone();
                info.families = vec![(registry.family_of(id).to_owned(), fontdb::Language::English_UnitedStates)];
                database.push_face_info(info);
            }
        }
        let default_family = registry.family_names().next().map(str::to_owned);
        if let Some(default) = &default_family {
            let serif = registry.family(database.family_name(&fontdb::Family::Serif)).is_none();
            let sans = registry.family(database.family_name(&fontdb::Family::SansSerif)).is_none();
            let cursive = registry.family(database.family_name(&fontdb::Family::Cursive)).is_none();
            let fantasy = registry.family(database.family_name(&fontdb::Family::Fantasy)).is_none();
            let monospace = registry.family(database.family_name(&fontdb::Family::Monospace)).is_none();
            if serif {
                database.set_serif_family(default.clone());
            }
            if sans {
                database.set_sans_serif_family(default.clone());
            }
            if cursive {
                database.set_cursive_family(default.clone());
            }
            if fantasy {
                database.set_fantasy_family(default.clone());
            }
            if monospace {
                database.set_monospace_family(default.clone());
            }
        }
        Self { database: Arc::new(database), default_family }
    }
}

/// Font bytes shared with the registry, as the font database's binary source.
struct SharedBytes(Arc<[u8]>);

impl AsRef<[u8]> for SharedBytes {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

/// An SVG logo rasterised for a PDF page: the pixels, and the size the page places it at (its declared size at the default density).
pub struct Logo {
    pub image: Image,
    pub width: u32,
    pub height: u32,
    /// The density the raster was drawn at.
    pub density: u32,
}

/// The size of `bytes` at `density`: `sharp(bytes, { density }).metadata()` width and height.
pub fn metadata(fonts: &SvgFonts, bytes: &[u8], density: f64) -> Result<SvgMetadata, RasterError> {
    let document = Document::open(fonts, bytes, density)?;
    let (width, height) = document.pixel_size(density / DEFAULT_DENSITY)?;
    Ok(SvgMetadata { width, height, density })
}

/// `sharp(bytes, { density })` as pixels: the picture at its declared size scaled by `density / 72`.
pub fn rasterize(fonts: &SvgFonts, bytes: &[u8], density: f64) -> Result<Image, RasterError> {
    let document = Document::open(fonts, bytes, density)?;
    let (width, height) = document.pixel_size(density / DEFAULT_DENSITY)?;
    document.render(width, height)
}

/// `sharp(bytes, { density }).resize(width, height, { fit: 'fill' })`: the vector is re-rendered at the scale that makes the smaller size
/// ratio exact, and that render is resampled to exactly `width` x `height`.
pub fn rasterize_to(fonts: &SvgFonts, bytes: &[u8], density: f64, width: u32, height: u32) -> Result<Image, RasterError> {
    if width == 0 || height == 0 {
        return Err(RasterError::new("Expected positive integer for width and height"));
    }
    let document = Document::open(fonts, bytes, density)?;
    let factor = density / DEFAULT_DENSITY;
    let (natural_width, natural_height) = document.pixel_size(factor)?;
    let shrink = (f64::from(natural_width) / f64::from(width)).min(f64::from(natural_height) / f64::from(height));
    let (loaded_width, loaded_height) = document.pixel_size(factor / shrink)?;
    let loaded = document.render(loaded_width, loaded_height)?;
    if (loaded_width, loaded_height) == (width, height) { Ok(loaded) } else { Ok(resize_exact(&loaded, width, height, Kernel::Lanczos3)) }
}

/// `pdf-draw.mjs` `rasterizeSvg`: the declared size from the metadata at the default density, and the picture drawn at density
/// `round(72 * scale)` where the scale is 4 (never below 1) cut down so that neither side passes 4000 pixels.
pub fn rasterize_logo(fonts: &SvgFonts, bytes: &[u8]) -> Result<Logo, RasterError> {
    let declared = metadata(fonts, bytes, DEFAULT_DENSITY)?;
    let density = logo_density(declared.width, declared.height);
    let image = rasterize(fonts, bytes, f64::from(density))?;
    Ok(Logo { image, width: declared.width, height: declared.height, density })
}

fn logo_density(width: u32, height: u32) -> u32 {
    let scale = LOGO_SCALE.min(LOGO_MAX_PIXELS / f64::from(width)).min(LOGO_MAX_PIXELS / f64::from(height)).max(1.0);
    round_half_up(DEFAULT_DENSITY * scale) as u32
}

/// [`rasterize`] as a lane job.
pub async fn rasterize_on<L: LaneToken>(lane: L, fonts: SvgFonts, bytes: Vec<u8>, density: f64) -> Result<Image, RasterError> {
    crate::on_lane(lane, move || rasterize(&fonts, &bytes, density)).await?
}

/// [`rasterize_to`] as a lane job.
pub async fn rasterize_to_on<L: LaneToken>(lane: L, fonts: SvgFonts, bytes: Vec<u8>, density: f64, width: u32, height: u32) -> Result<Image, RasterError> {
    crate::on_lane(lane, move || rasterize_to(&fonts, &bytes, density, width, height)).await?
}

/// [`rasterize_logo`] as a lane job.
pub async fn rasterize_logo_on<L: LaneToken>(lane: L, fonts: SvgFonts, bytes: Vec<u8>) -> Result<Logo, RasterError> {
    crate::on_lane(lane, move || rasterize_logo(&fonts, &bytes)).await?
}

/// JavaScript's `Math.round`.
fn round_half_up(value: f64) -> f64 {
    (value + 0.5).floor()
}

fn bad_dimensions() -> RasterError {
    RasterError::new(corrupt_header("svgload_buffer: bad dimensions"))
}

fn invalid_svg() -> RasterError {
    RasterError::new(corrupt_header("invalid SVG data"))
}

/// A side of a page stated without a viewBox.
#[derive(Clone, Copy, PartialEq, Debug)]
enum InkSide {
    Pixels(f64),
    /// A share of the raster's side (`50%` is 0.5).
    Share(f64),
}

impl InkSide {
    fn of(self, raster: u32) -> f64 {
        match self {
            Self::Pixels(pixels) => pixels,
            Self::Share(share) => share * f64::from(raster),
        }
    }
}

/// A parsed SVG, with the size of its page in pixels at the density it was opened at (before the `density / 72` scale).
struct Document {
    tree: usvg::Tree,
    width: f64,
    height: f64,
    /// The page has no size of its own (the raster is the size of its ink): the sides it does state, each a length in pixels or a share of the
    /// raster's own side. A side it does not state is the raster's own, so a page that states none is drawn at its own scale from the corner,
    /// whatever the density.
    ink: Option<(Option<InkSide>, Option<InkSide>)>,
    /// The root's viewBox is stated and has no area: nothing is drawn.
    blank: bool,
}

impl Document {
    fn open(fonts: &SvgFonts, bytes: &[u8], density: f64) -> Result<Self, RasterError> {
        if !(1.0..=100_000.0).contains(&density) {
            return Err(RasterError::new(format!("Expected number between 1 and 100000 for density but received {density} of type number")));
        }
        if bytes.is_empty() {
            return Err(RasterError::new(EMPTY_BUFFER));
        }
        if Format::sniff(bytes) != Some(Format::Svg) {
            return Err(RasterError::new(UNSUPPORTED_FORMAT));
        }
        let unzipped;
        let source = if bytes.starts_with(&[0x1f, 0x8b]) {
            unzipped = usvg::decompress_svgz(bytes).map_err(|_| invalid_svg())?;
            &unzipped[..]
        } else {
            bytes
        };
        let text = std::str::from_utf8(source).map_err(|_| invalid_svg())?;
        let options = options(fonts, density);
        let document = parse(text)?;
        let root = document.root_element();
        if root.tag_name().name() != "svg" {
            return Err(invalid_svg());
        }
        let blank = root.attribute("viewBox").is_some_and(|text| view_box_without_area(text));
        match extent(&root, density)? {
            Extent::Declared => {
                let tree = build(&document, &options)?;
                let size = tree.size();
                Ok(Self { width: f64::from(size.width()), height: f64::from(size.height()), tree, ink: None, blank })
            }
            Extent::Derived { width, height, rewrite } => {
                let tree = if rewrite {
                    let text = with_size(text, &root, width, height);
                    build(&parse(&text)?, &options)?
                } else {
                    build(&document, &options)?
                };
                Ok(Self { tree, width, height, ink: None, blank })
            }
            Extent::Ink { unusable, stated } => {
                // A side that is negative or a percentage is no size here and usvg refuses it: the page is the ink without it.
                let stripped;
                let tree = if unusable.is_empty() {
                    build(&document, &options)?
                } else {
                    stripped = without_attributes(text, &root, &unusable);
                    build(&parse(&stripped)?, &options)?
                };
                let ink = tree.root().abs_stroke_bounding_box();
                let (width, height) = (f64::from(ink.width()), f64::from(ink.height()));
                if width <= 0.0 || height <= 0.0 {
                    return Err(bad_dimensions());
                }
                Ok(Self { tree, width, height, ink: Some(stated), blank })
            }
        }
    }

    /// The raster size at `factor` times the page: rounded half up, checked as libvips checks it.
    fn pixel_size(&self, factor: f64) -> Result<(u32, u32), RasterError> {
        let (width, height) = (round_half_up(self.width * factor), round_half_up(self.height * factor));
        if width >= f64::from(i32::MAX) || height >= f64::from(i32::MAX) {
            return Err(RasterError::new(corrupt_header("svgload_buffer: zero-sized image")));
        }
        if width < 1.0 || height < 1.0 {
            return Err(bad_dimensions());
        }
        let (width, height) = (width as u32, height as u32);
        if u64::from(width) * u64::from(height) > DEFAULT_PIXEL_LIMIT {
            return Err(RasterError::new(PIXEL_LIMIT));
        }
        Ok((width, height))
    }

    /// The page drawn into `width` x `height` at the largest uniform scale that fits, centred; straight RGBA.
    fn render(&self, width: u32, height: u32) -> Result<Image, RasterError> {
        if self.blank {
            return Ok(Image::from_rgba(width, height, 4, vec![0; width as usize * height as usize * 4]));
        }
        let (scale, left, top) = if let Some((stated_width, stated_height)) = self.ink {
            let (page_width, page_height) = (stated_width.map_or(f64::from(width), |side| side.of(width)), stated_height.map_or(f64::from(height), |side| side.of(height)));
            let scale = (f64::from(width) / page_width).min(f64::from(height) / page_height);
            (scale, (f64::from(width) - page_width * scale) / 2.0, (f64::from(height) - page_height * scale) / 2.0)
        } else {
            let scale = (f64::from(width) / self.width).min(f64::from(height) / self.height);
            (scale, (f64::from(width) - self.width * scale) / 2.0, (f64::from(height) - self.height * scale) / 2.0)
        };
        // The rasterizer covers an edge in quarters of a pixel (four sub-scanlines of quarter-pixel runs), the SVG renderer sharp uses by
        // exact area. The picture is drawn `factor` times larger in each direction and each pixel is the mean of the `factor` x `factor`
        // block it stands for, which brings an edge within a few levels of exact coverage; a raster too large for that within
        // `SUPERSAMPLE_PIXELS` is drawn as it is.
        let factor = supersample_factor(width, height);
        let (big_width, big_height) = (width * factor, height * factor);
        let mut pixmap = tiny_skia::Pixmap::new(big_width, big_height).ok_or_else(|| RasterError::new("cannot allocate the SVG raster"))?;
        let k = f64::from(factor);
        let transform = tiny_skia::Transform::from_row((scale * k) as f32, 0.0, 0.0, (scale * k) as f32, (left * k) as f32, (top * k) as f32);
        resvg::render(&self.tree, transform, &mut pixmap.as_mut());
        let premultiplied: Vec<[u8; 4]> = if factor == 1 {
            pixmap.pixels().iter().map(|pixel| [pixel.red(), pixel.green(), pixel.blue(), pixel.alpha()]).collect()
        } else {
            mean_of_blocks(pixmap.pixels(), width as usize, height as usize, factor as usize)
        };
        // The straight colour is the premultiplied byte over the alpha, truncated: what libvips writes when it takes the rasterizer's
        // premultiplied pixels back to straight alpha.
        let data = premultiplied
            .iter()
            .flat_map(|pixel| {
                let alpha = u32::from(pixel[3]);
                let straight = |channel: u8| if alpha == 0 { 0 } else { (u32::from(channel) * 255 / alpha).min(255) as u8 };
                [straight(pixel[0]), straight(pixel[1]), straight(pixel[2]), pixel[3]]
            })
            .collect();
        Ok(Image::from_rgba(width, height, 4, data))
    }
}

/// The pixels a supersampled raster may have, and the most it is drawn larger by.
const SUPERSAMPLE_PIXELS: u64 = 4_000_000;
const SUPERSAMPLE_MAX: u32 = 8;

/// How many times larger in each direction a raster of `width` x `height` is drawn before it is averaged down (1 when it is too large).
fn supersample_factor(width: u32, height: u32) -> u32 {
    let pixels = u64::from(width) * u64::from(height);
    let mut factor = SUPERSAMPLE_MAX;
    while factor > 1 && pixels * u64::from(factor) * u64::from(factor) > SUPERSAMPLE_PIXELS {
        factor -= 1;
    }
    factor
}

/// The premultiplied pixels of a raster `factor` times larger than `width` x `height`, each the rounded mean of its block.
fn mean_of_blocks(big: &[tiny_skia::PremultipliedColorU8], width: usize, height: usize, factor: usize) -> Vec<[u8; 4]> {
    let big_width = width * factor;
    let area = (factor * factor) as u32;
    let mut out = Vec::with_capacity(width * height);
    for y in 0..height {
        for x in 0..width {
            let mut sum = [0u32; 4];
            for row in 0..factor {
                let start = (y * factor + row) * big_width + x * factor;
                for pixel in &big[start..start + factor] {
                    sum[0] += u32::from(pixel.red());
                    sum[1] += u32::from(pixel.green());
                    sum[2] += u32::from(pixel.blue());
                    sum[3] += u32::from(pixel.alpha());
                }
            }
            out.push(sum.map(|total| ((total + area / 2) / area) as u8));
        }
    }
    out
}

fn options(fonts: &SvgFonts, density: f64) -> usvg::Options<'static> {
    let mut options = usvg::Options {
        dpi: density as f32,
        fontdb: Arc::clone(&fonts.database),
        // A buffer has no base URL: relative links are not followed; `data:` images are.
        image_href_resolver: usvg::ImageHrefResolver { resolve_string: Box::new(|_, _| None), ..usvg::ImageHrefResolver::default() },
        ..usvg::Options::default()
    };
    if let Some(family) = &fonts.default_family {
        options.font_family = family.clone();
    }
    options
}

fn parse(text: &str) -> Result<roxmltree::Document<'_>, RasterError> {
    roxmltree::Document::parse_with_options(text, roxmltree::ParsingOptions { allow_dtd: true, ..roxmltree::ParsingOptions::default() })
        .map_err(|_| invalid_svg())
}

fn build(document: &roxmltree::Document<'_>, options: &usvg::Options<'_>) -> Result<usvg::Tree, RasterError> {
    usvg::Tree::from_xmltree(document, options).map_err(|error| match error {
        usvg::Error::InvalidSize => bad_dimensions(),
        _ => invalid_svg(),
    })
}

/// How the size of the page is found.
enum Extent {
    /// Both sides are declared in absolute units: usvg's own size is the page.
    Declared,
    /// The page follows the viewBox. usvg reads a missing or percentage side as 100 percent of the viewBox side, which is not what librsvg
    /// does, so when the root states a width or a height they are replaced by these sizes before usvg reads the tree.
    Derived { width: f64, height: f64, rewrite: bool },
    /// Nothing usable is declared: the size of the ink. `unusable` names the root's `width` and `height` that are stated and cannot be a size.
    Ink { unusable: Vec<&'static str>, stated: (Option<InkSide>, Option<InkSide>) },
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Unit {
    None,
    Px,
    In,
    Cm,
    Mm,
    Pt,
    Pc,
    Em,
    Ex,
    Percent,
}

/// An SVG length: a number and a unit (none of those SVG knows is an invalid length).
fn parse_length(text: &str) -> Option<(f64, Unit)> {
    let text = text.trim();
    let bytes = text.as_bytes();
    let digits = |from: usize| bytes[from..].iter().take_while(|byte| byte.is_ascii_digit()).count();
    let mut end = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    end += digits(end);
    if bytes.get(end) == Some(&b'.') {
        end += 1;
        end += digits(end);
    }
    // An exponent needs digits after it: `2em` is two ems.
    if matches!(bytes.get(end), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(bytes.get(end + 1), Some(b'+' | b'-')));
        let count = digits(end + 1 + sign);
        if count > 0 {
            end += 1 + sign + count;
        }
    }
    let number: f64 = text[..end].parse().ok()?;
    let unit = match &text[end..] {
        "" => Unit::None,
        "px" => Unit::Px,
        "in" => Unit::In,
        "cm" => Unit::Cm,
        "mm" => Unit::Mm,
        "pt" => Unit::Pt,
        "pc" => Unit::Pc,
        "em" => Unit::Em,
        "ex" => Unit::Ex,
        "%" => Unit::Percent,
        _ => return None,
    };
    Some((number, unit))
}

/// The pixels of an absolute length at `dpi`.
fn to_pixels(number: f64, unit: Unit, dpi: f64) -> f64 {
    match unit {
        Unit::None | Unit::Px | Unit::Percent => number,
        Unit::In => number * dpi,
        Unit::Cm => number * dpi / 2.54,
        Unit::Mm => number * dpi / 25.4,
        Unit::Pt => number * dpi / 72.0,
        Unit::Pc => number * dpi / 6.0,
        Unit::Em => number * FONT_SIZE,
        Unit::Ex => number * FONT_SIZE / 2.0,
    }
}

/// The size of a `viewBox` (four numbers; a width or height of nothing is no viewBox).
fn view_box(text: &str) -> Option<(f64, f64)> {
    let numbers: Vec<f64> = text.split(|c: char| c.is_whitespace() || c == ',').filter(|part| !part.is_empty()).map(|part| part.parse::<f64>().ok()).collect::<Option<_>>()?;
    match numbers[..] {
        [_, _, width, height] if width > 0.0 && height > 0.0 => Some((width, height)),
        _ => None,
    }
}

/// Whether a `viewBox` is four numbers of which the width or the height is not above zero: librsvg draws nothing for it.
fn view_box_without_area(text: &str) -> bool {
    let numbers: Option<Vec<f64>> = text.split(|c: char| c.is_whitespace() || c == ',').filter(|part| !part.is_empty()).map(|part| part.parse::<f64>().ok()).collect();
    matches!(numbers.as_deref(), Some([_, _, width, height]) if !(*width > 0.0 && *height > 0.0))
}

/// librsvg's rule for the size of a page, from the root element's `width`, `height` and `viewBox`.
fn extent(root: &roxmltree::Node<'_, '_>, dpi: f64) -> Result<Extent, RasterError> {
    let side = |name: &str| -> Result<Option<f64>, RasterError> {
        let Some((number, unit)) = root.attribute(name).and_then(parse_length) else { return Ok(None) };
        // A negative side is as good as not given; a percentage is relative to a container there is not.
        if number < 0.0 || unit == Unit::Percent {
            return Ok(None);
        }
        if number == 0.0 {
            return Err(bad_dimensions());
        }
        Ok(Some(to_pixels(number, unit, dpi)))
    };
    let (width, height) = (side("width")?, side("height")?);
    let view = root.attribute("viewBox").and_then(view_box);
    match (width, height, view) {
        (Some(_), Some(_), _) => Ok(Extent::Declared),
        (width, height, Some((view_width, view_height))) => {
            let (width, height) = match (width, height) {
                (Some(width), None) => (width, width * view_height / view_width),
                (None, Some(height)) => (height * view_width / view_height, height),
                _ => (view_width, view_height),
            };
            let rewrite = root.has_attribute("width") || root.has_attribute("height");
            Ok(Extent::Derived { width, height, rewrite })
        }
        _ => {
            let unusable = ["width", "height"].into_iter().filter(|name| root.has_attribute(*name) && !matches!(side(name), Ok(Some(_)))).collect();
            let stated = |name: &str, pixels: Option<f64>| match (pixels, root.attribute(name).and_then(parse_length)) {
                (Some(pixels), _) => Some(InkSide::Pixels(pixels)),
                (None, Some((number, Unit::Percent))) if number >= 0.0 => Some(InkSide::Share(number / 100.0)),
                _ => None,
            };
            Ok(Extent::Ink { unusable, stated: (stated("width", width), stated("height", height)) })
        }
    }
}

/// `text` without the named attributes of the root element.
fn without_attributes(text: &str, root: &roxmltree::Node<'_, '_>, names: &[&str]) -> String {
    let mut ranges: Vec<std::ops::Range<usize>> = names.iter().filter_map(|name| root.attribute_node(*name).map(|attribute| attribute.range())).collect();
    ranges.sort_by_key(|range| std::cmp::Reverse(range.start));
    let mut out = text.to_owned();
    for range in ranges {
        out.replace_range(range, "");
    }
    out
}

/// `text` with the root element's `width` and `height` set to `width` and `height` pixels.
fn with_size(text: &str, root: &roxmltree::Node<'_, '_>, width: f64, height: f64) -> String {
    let start = root.range().start;
    let name_end = text[start + 1..].find(|c: char| c.is_whitespace() || c == '/' || c == '>').map_or(text.len(), |at| start + 1 + at);
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    for (name, value) in [("width", width), ("height", height)] {
        match root.attribute_node(name) {
            Some(attribute) => {
                let range = attribute.range_value();
                edits.push((range.start, range.end, value.to_string()));
            }
            None => edits.push((name_end, name_end, format!(" {name}=\"{value}\""))),
        }
    }
    edits.sort_by_key(|edit| std::cmp::Reverse(edit.0));
    let mut out = text.to_owned();
    for (from, to, replacement) in edits {
        out.replace_range(from..to, &replacement);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const NS: &str = "xmlns=\"http://www.w3.org/2000/svg\"";

    fn svg(attributes: &str, inner: &str) -> Vec<u8> {
        format!("<svg {NS} {attributes}>{inner}</svg>").into_bytes()
    }

    fn size(bytes: &[u8], density: f64) -> (u32, u32) {
        let meta = metadata(&SvgFonts::none(), bytes, density).unwrap();
        (meta.width, meta.height)
    }

    fn error(result: Result<impl Sized, RasterError>) -> String {
        result.err().expect("an error").message().to_owned()
    }

    #[test]
    fn pixel_sizes_scale_with_the_density_and_round_half_up() {
        assert_eq!(size(&svg("width=\"10\" height=\"20\"", ""), 72.0), (10, 20));
        assert_eq!(size(&svg("width=\"10\" height=\"20\"", ""), 100.0), (14, 28));
        assert_eq!(size(&svg("width=\"10.5\" height=\"20.4\"", ""), 72.0), (11, 20));
        assert_eq!(size(&svg("width=\"10.5\" height=\"20.4\"", ""), 180.0), (26, 51));
    }

    #[test]
    fn physical_units_are_taken_at_the_density_and_scaled_again() {
        let inch = svg("width=\"1in\" height=\"0.5in\"", "");
        assert_eq!(size(&inch, 72.0), (72, 36));
        assert_eq!(size(&inch, 100.0), (139, 69));
        assert_eq!(size(&inch, 144.0), (288, 144));
        assert_eq!(size(&svg("width=\"100pt\" height=\"50pt\"", ""), 180.0), (625, 313));
        assert_eq!(size(&svg("width=\"3cm\" height=\"2mm\"", ""), 100.0), (164, 11));
        assert_eq!(size(&svg("width=\"6pc\" height=\"12pc\"", ""), 144.0), (288, 576));
        // em and ex are pixels at 12 px, whatever the density asks of inches.
        assert_eq!(size(&svg("width=\"2em\" height=\"3ex\"", ""), 100.0), (33, 25));
    }

    #[test]
    fn the_view_box_gives_the_side_that_is_missing() {
        assert_eq!(size(&svg("viewBox=\"0 0 24.4 10.6\"", ""), 72.0), (24, 11));
        assert_eq!(size(&svg("width=\"40\" viewBox=\"0 0 20 10\"", ""), 72.0), (40, 20));
        assert_eq!(size(&svg("height=\"30\" viewBox=\"0 0 20 10\"", ""), 144.0), (120, 60));
        // Percentages are no sizes: the viewBox is the page.
        assert_eq!(size(&svg("width=\"50%\" height=\"50%\" viewBox=\"0 0 40 30\"", ""), 72.0), (40, 30));
        assert_eq!(size(&svg("width=\"1in\" height=\"50%\" viewBox=\"0 0 10 10\"", ""), 72.0), (72, 72));
        // A viewBox of nothing is none.
        assert_eq!(size(&svg("viewBox=\"0 0 0 0\" width=\"5\" height=\"5\"", ""), 144.0), (10, 10));
    }

    #[test]
    fn a_page_without_a_usable_size_is_the_size_of_its_ink_and_is_not_moved() {
        let offset = svg("", "<rect x=\"3\" y=\"4\" width=\"5\" height=\"6\" fill=\"#000\"/>");
        assert_eq!(size(&offset, 72.0), (5, 6));
        assert_eq!(size(&svg("width=\"40\"", "<rect width=\"5\" height=\"5\"/>"), 72.0), (5, 5));
        let image = rasterize(&SvgFonts::none(), &offset, 72.0).unwrap();
        // The rectangle lies at x 3..8, y 4..10 of a page that is 5 x 6: only its corner is inside.
        let alpha = |x: usize, y: usize| image.rgba()[(y * 5 + x) * 4 + 3];
        assert_eq!((alpha(0, 0), alpha(3, 4), alpha(4, 5), alpha(2, 5)), (0, 255, 255, 0));
        let stroked = svg("", "<rect x=\"3\" y=\"4\" width=\"5\" height=\"6\" fill=\"none\" stroke=\"#000\" stroke-width=\"2\"/>");
        assert_eq!(size(&stroked, 72.0), (7, 8));
    }

    #[test]
    fn sizes_that_cannot_be_drawn_are_libvips_errors() {
        let fonts = SvgFonts::none();
        assert_eq!(error(metadata(&fonts, &svg("width=\"0\" height=\"10\"", ""), 72.0)), "Input buffer has corrupt header: svgload_buffer: bad dimensions");
        assert_eq!(error(metadata(&fonts, &svg("width=\"0.2\" height=\"0.2\"", ""), 72.0)), "Input buffer has corrupt header: svgload_buffer: bad dimensions");
        assert_eq!(error(metadata(&fonts, format!("<svg {NS}/>").as_bytes(), 72.0)), "Input buffer has corrupt header: svgload_buffer: bad dimensions");
        assert_eq!(error(metadata(&fonts, &svg("width=\"30000\" height=\"30000\"", ""), 72.0)), "Input image exceeds pixel limit");
        assert_eq!(error(metadata(&fonts, &svg("width=\"1e10\" height=\"10\"", ""), 72.0)), "Input buffer has corrupt header: svgload_buffer: zero-sized image");
        assert_eq!(error(metadata(&fonts, b"hello", 72.0)), "Input buffer contains unsupported image format");
        assert_eq!(error(metadata(&fonts, b"", 72.0)), "Input Buffer is empty");
        assert!(error(metadata(&fonts, format!("<svg {NS}><rect").as_bytes(), 72.0)).starts_with("Input buffer has corrupt header"));
        // A negative side is ignored: the ink is the page.
        assert_eq!(size(&svg("width=\"-5\" height=\"10\"", "<rect width=\"10\" height=\"10\"/>"), 72.0), (10, 10));
    }

    #[test]
    fn the_density_is_one_to_one_hundred_thousand() {
        let bytes = svg("width=\"10\" height=\"10\"", "");
        assert_eq!(error(rasterize(&SvgFonts::none(), &bytes, 0.5)), "Expected number between 1 and 100000 for density but received 0.5 of type number");
        assert_eq!(error(rasterize(&SvgFonts::none(), &bytes, 100_001.0)), "Expected number between 1 and 100000 for density but received 100001 of type number");
        assert!(error(rasterize(&SvgFonts::none(), &bytes, f64::NAN)).starts_with("Expected number between 1 and 100000 for density"));
    }

    #[test]
    fn a_page_that_rounds_up_is_drawn_centred_at_its_own_scale() {
        // 10.5 px wide rounds to 11: the rectangle keeps its size and leaves a quarter pixel each side.
        let wide = svg("width=\"10.5\" height=\"10\"", "<rect width=\"10.5\" height=\"10\" fill=\"#000\"/>");
        let image = rasterize(&SvgFonts::none(), &wide, 72.0).unwrap();
        assert_eq!((image.width(), image.height()), (11, 10));
        let row: Vec<u8> = (0..11).map(|x| image.rgba()[x * 4 + 3]).collect();
        assert_eq!(row[1..10], [255; 9]);
        assert!(row[0].abs_diff(191) <= 2 && row[10].abs_diff(191) <= 2, "{row:?}");
        // 10.4 px rounds down to 10: the page shrinks to fit, leaving a fifth of a pixel above and below.
        let narrow = svg("width=\"10.4\" height=\"10\"", "<rect width=\"10.4\" height=\"10\" fill=\"#000\"/>");
        let image = rasterize(&SvgFonts::none(), &narrow, 72.0).unwrap();
        assert_eq!((image.width(), image.height()), (10, 10));
        assert!(image.rgba()[3].abs_diff(207) <= 2);
        assert_eq!(image.rgba()[5 * 40 + 20 + 3], 255);
    }

    #[test]
    fn the_straight_colour_of_a_translucent_fill_is_kept() {
        let half = svg("width=\"2\" height=\"2\"", "<rect width=\"2\" height=\"2\" fill=\"#336699\" fill-opacity=\"0.5\"/>");
        let image = rasterize(&SvgFonts::none(), &half, 72.0).unwrap();
        assert_eq!(image.channels(), 4);
        assert!(image.has_alpha());
        let pixel = &image.rgba()[..4];
        assert!(pixel[3].abs_diff(128) <= 1 && pixel[0].abs_diff(0x33) <= 2 && pixel[1].abs_diff(0x66) <= 2 && pixel[2].abs_diff(0x99) <= 2, "{pixel:?}");
    }

    #[test]
    fn a_resize_renders_the_vector_at_the_scale_of_the_smaller_ratio() {
        let fonts = SvgFonts::none();
        let bytes = svg("width=\"20\" height=\"10\" viewBox=\"0 0 20 10\"", "<circle cx=\"10\" cy=\"5\" r=\"4\" fill=\"#d33\"/>");
        // Exactly 4 times the size is a render at density 288: no resampling.
        let direct = rasterize(&fonts, &bytes, 288.0).unwrap();
        assert_eq!(rasterize_to(&fonts, &bytes, 72.0, 80, 40).unwrap(), direct);
        // The render at the smaller ratio is 25 x 13 (12.5 rounds up) and is resampled to the asked 25 x 12.
        let loaded = rasterize(&fonts, &bytes, 90.0).unwrap();
        assert_eq!((loaded.width(), loaded.height()), (25, 13));
        let resized = rasterize_to(&fonts, &bytes, 180.0, 25, 12).unwrap();
        assert_eq!(resized, resize_exact(&loaded, 25, 12, Kernel::Lanczos3));
        assert_eq!(error(rasterize_to(&fonts, &bytes, 72.0, 0, 5)), "Expected positive integer for width and height");
    }

    #[test]
    fn a_resize_keeps_physical_units_at_the_density_and_scales_the_render_linearly() {
        let fonts = SvgFonts::none();
        let inch = svg("width=\"1in\" height=\"0.5in\" viewBox=\"0 0 20 10\"", "<rect width=\"20\" height=\"10\" fill=\"#000\"/>");
        assert_eq!(size(&inch, 100.0), (139, 69));
        let resized = rasterize_to(&fonts, &inch, 100.0, 50, 20).unwrap();
        assert_eq!((resized.width(), resized.height()), (50, 20));
    }

    #[test]
    fn the_pdf_logo_density_is_four_times_cut_to_four_thousand_pixels() {
        assert_eq!(logo_density(120, 40), 288);
        assert_eq!(logo_density(1000, 10), 288);
        assert_eq!(logo_density(1500, 120), 192);
        assert_eq!(logo_density(40, 1400), 206);
        assert_eq!(logo_density(2600, 100), 111);
        // Larger than 4000 pixels: the scale never goes below one.
        assert_eq!(logo_density(5000, 100), 72);
        let logo = rasterize_logo(&SvgFonts::none(), &svg("width=\"120\" height=\"40\"", "<rect width=\"120\" height=\"40\" fill=\"#0B1B3A\"/>")).unwrap();
        assert_eq!((logo.width, logo.height, logo.density), (120, 40, 288));
        assert_eq!((logo.image.width(), logo.image.height()), (480, 160));
    }

    #[test]
    fn lengths_read_numbers_exponents_and_units() {
        assert_eq!(parse_length(" 10px "), Some((10.0, Unit::Px)));
        assert_eq!(parse_length("2em"), Some((2.0, Unit::Em)));
        assert_eq!(parse_length("1e1"), Some((10.0, Unit::None)));
        assert_eq!(parse_length("2.5e+1pt"), Some((25.0, Unit::Pt)));
        assert_eq!(parse_length("-.5in"), Some((-0.5, Unit::In)));
        assert_eq!(parse_length("50%"), Some((50.0, Unit::Percent)));
        assert_eq!(parse_length("10furlong"), None);
        assert_eq!(parse_length("wide"), None);
    }

    #[test]
    fn the_root_size_is_rewritten_in_place() {
        let text = format!("<svg {NS} width=\"40\" viewBox=\"0 0 20 10\"><g/></svg>");
        let document = roxmltree::Document::parse(&text).unwrap();
        // The width keeps its place; a missing height is put right after the tag name.
        assert_eq!(with_size(&text, &document.root_element(), 40.0, 20.0), format!("<svg height=\"20\" {NS} width=\"40\" viewBox=\"0 0 20 10\"><g/></svg>"));
        let single = "<svg width='7'/>";
        let document = roxmltree::Document::parse(single).unwrap();
        assert_eq!(with_size(single, &document.root_element(), 8.5, 3.0), "<svg height=\"3\" width='8.5'/>");
    }
}
