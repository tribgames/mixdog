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

mod cairo_pen;

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
    /// The same picture parsed with the smooth image filter, when it has embedded raster images.
    smooth: Option<usvg::Tree>,
}

impl Document {
    /// Opens `bytes`. A picture with embedded raster images is parsed a second time with the smooth image filter: which of the two draws it is
    /// decided at the scale it is rendered at ([`Document::tree_for`]).
    fn open(fonts: &SvgFonts, bytes: &[u8], density: f64) -> Result<Self, RasterError> {
        let mut document = Self::open_with(fonts, bytes, density, usvg::ImageRendering::OptimizeSpeed)?;
        if has_raster_image(document.tree.root()) {
            document.smooth = Some(Self::open_with(fonts, bytes, density, usvg::ImageRendering::Smooth)?.tree);
        }
        Ok(document)
    }

    fn open_with(fonts: &SvgFonts, bytes: &[u8], density: f64, rendering: usvg::ImageRendering) -> Result<Self, RasterError> {
        if !(1.0..=100_000.0).contains(&density) {
            return Err(RasterError::new(format!("Expected number between 1 and 100000 for density but received {density} of type number")));
        }
        if bytes.is_empty() {
            return Err(RasterError::new(EMPTY_BUFFER));
        }
        if Format::sniff(bytes) != Some(Format::Svg) {
            return Err(RasterError::new(UNSUPPORTED_FORMAT));
        }
        // Gzip is inflated to the workspace's one bound (`mixdog_imaging::svg_limits`), not without end.
        let document_text = mixdog_imaging::svg_limits::document_text(bytes).map_err(|_| invalid_svg())?;
        let text: &str = &document_text;
        let options = options(fonts, density, rendering);
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
                Ok(Self { width: f64::from(size.width()), height: f64::from(size.height()), tree, ink: None, blank, smooth: None })
            }
            Extent::Derived { width, height, rewrite } => {
                let tree = if rewrite {
                    let text = with_size(text, &root, width, height);
                    build(&parse(&text)?, &options)?
                } else {
                    build(&document, &options)?
                };
                Ok(Self { tree, width, height, ink: None, blank, smooth: None })
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
                Ok(Self { tree, width, height, ink: Some(stated), blank, smooth: None })
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

    /// The tree to draw at `scale`: the smooth-filtered one when an embedded image is drawn larger than its own pixels (the bilinear filter
    /// of cairo), else the one that keeps the pixels (an image placed at its own size is laid as it is, one drawn smaller is averaged).
    fn tree_for(&self, scale: f64) -> &usvg::Tree {
        match &self.smooth {
            Some(smooth) if magnifies_an_image(self.tree.root(), scale) => smooth,
            _ => &self.tree,
        }
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
        let tree = self.tree_for(scale);
        let premultiplied = if needs_whole_tree(tree.root()) {
            whole_tree(tree, width, height, factor, scale, left, top)?
        } else {
            paint_shapes(tree, width as usize, height as usize, factor as usize, scale, left, top)?
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

/// Whether the tree has a unit shape-by-shape painting cannot lay on its own: a group blended with what is under it (its mode needs the
/// backdrop), or a pattern-painted shape without area (`resvg::render_node` has no box for it and would drop it).
fn needs_whole_tree(group: &usvg::Group) -> bool {
    group.children().iter().any(|node| match node {
        usvg::Node::Group(inner) => inner.blend_mode() != usvg::BlendMode::Normal || (!inner.should_isolate() && needs_whole_tree(inner)),
        usvg::Node::Path(path) => {
            let pattern = |paint: &usvg::Paint| matches!(paint, usvg::Paint::Pattern(_));
            node.abs_layer_bounding_box().is_none()
                && (path.fill().is_some_and(|fill| pattern(fill.paint())) || path.stroke().is_some_and(|stroke| pattern(stroke.paint())))
        }
        _ => false,
    })
}

/// The premultiplied pixels of the whole tree drawn at once, `factor` times larger and averaged.
fn whole_tree(tree: &usvg::Tree, width: u32, height: u32, factor: u32, scale: f64, left: f64, top: f64) -> Result<Vec<[u8; 4]>, RasterError> {
    let (big_width, big_height) = (width * factor, height * factor);
    let mut pixmap = tiny_skia::Pixmap::new(big_width, big_height).ok_or_else(|| RasterError::new("cannot allocate the SVG raster"))?;
    let k = f64::from(factor);
    let transform = tiny_skia::Transform::from_row((scale * k) as f32, 0.0, 0.0, (scale * k) as f32, (left * k) as f32, (top * k) as f32);
    resvg::render(tree, transform, &mut pixmap.as_mut());
    Ok(if factor == 1 {
        pixmap.pixels().iter().map(|pixel| [pixel.red(), pixel.green(), pixel.blue(), pixel.alpha()]).collect()
    } else {
        mean_of_blocks(pixmap.pixels(), width as usize, height as usize, factor as usize)
    })
}

/// Whether the tree has a raster image (not an SVG one) anywhere.
fn has_raster_image(group: &usvg::Group) -> bool {
    group.children().iter().any(|node| match node {
        usvg::Node::Group(inner) => has_raster_image(inner),
        usvg::Node::Image(image) => !matches!(image.kind(), usvg::ImageKind::SVG(_)),
        _ => false,
    })
}

/// Whether a raster image of the tree is drawn larger than its own pixels at `scale`.
fn magnifies_an_image(group: &usvg::Group, scale: f64) -> bool {
    group.children().iter().any(|node| match node {
        usvg::Node::Group(inner) => magnifies_an_image(inner, scale),
        usvg::Node::Image(image) => {
            let ts = image.abs_transform();
            f64::from(ts.sx).hypot(f64::from(ts.ky)) * scale > 1.0 + 1e-6
        }
        _ => false,
    })
}

/// The units the rasterizer paints one at a time: a shape, an image, a text or a group that is drawn as a whole (opacity, clip, mask, filter),
/// each with the absolute transform of the group it lies in. Plain groups are looked through.
fn paint_units<'a>(group: &'a usvg::Group, out: &mut Vec<(&'a usvg::Node, tiny_skia::Transform)>) {
    for node in group.children() {
        match node {
            usvg::Node::Group(inner) if !inner.should_isolate() => paint_units(inner, out),
            _ => out.push((node, group.abs_transform())),
        }
    }
}

/// The premultiplied pixels of the tree at `width` x `height`, drawn the way cairo draws it: every shape is covered by its own anti-aliased
/// coverage and laid over what is there (so two shapes with one edge leave a pixel less covered than a union would), while the coverage of
/// each shape is taken from a raster `factor` times larger and averaged, which is exact to within a few levels.
fn paint_shapes(tree: &usvg::Tree, width: usize, height: usize, factor: usize, scale: f64, left: f64, top: f64) -> Result<Vec<[u8; 4]>, RasterError> {
    let k = factor as f64;
    let mut units = Vec::new();
    paint_units(tree.root(), &mut units);
    let mut out = vec![[0u8; 4]; width * height];
    for (node, parent) in units {
        let layer = node.abs_layer_bounding_box();
        // The box in final pixels, widened by two for the edge pixels.
        let stroke = match node {
            // The box usvg keeps for an image is moved a second time by the placement of the image: the box is the image rectangle at its
            // absolute transform.
            usvg::Node::Image(image) => image.size().to_rect(0.0, 0.0).and_then(|rect| rect.transform(image.abs_transform())).unwrap_or_else(|| node.abs_stroke_bounding_box()),
            _ => node.abs_stroke_bounding_box(),
        };
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (f64::from(stroke.left()), f64::from(stroke.top()), f64::from(stroke.right()), f64::from(stroke.bottom()));
        if let (Some(bbox), false) = (layer, matches!(node, usvg::Node::Image(_))) {
            (min_x, min_y) = (min_x.min(f64::from(bbox.left())), min_y.min(f64::from(bbox.top())));
            (max_x, max_y) = (max_x.max(f64::from(bbox.right())), max_y.max(f64::from(bbox.bottom())));
        }
        let x0 = ((min_x * scale + left).floor() as i64 - 2).max(0);
        let y0 = ((min_y * scale + top).floor() as i64 - 2).max(0);
        let x1 = ((max_x * scale + left).ceil() as i64 + 2).min(width as i64);
        let y1 = ((max_y * scale + top).ceil() as i64 + 2).min(height as i64);
        if x1 <= x0 || y1 <= y0 {
            continue;
        }
        let (region_width, region_height) = ((x1 - x0) as usize, (y1 - y0) as usize);
        if let usvg::Node::Path(path) = node {
            let base = tiny_skia::Transform::from_row(scale as f32, 0.0, 0.0, scale as f32, left as f32, top as f32).pre_concat(parent);
            if cairo_path(path, base, &mut out, width, (x0 as usize, y0 as usize, region_width, region_height)) {
                continue;
            }
        }
        let mut pixmap = tiny_skia::Pixmap::new((region_width * factor) as u32, (region_height * factor) as u32).ok_or_else(|| RasterError::new("cannot allocate the SVG raster"))?;
        let base = tiny_skia::Transform::from_row((scale * k) as f32, 0.0, 0.0, (scale * k) as f32, ((left - x0 as f64) * k) as f32, ((top - y0 as f64) * k) as f32).pre_concat(parent);
        // The tolerance cairo flattens a curve at, 0.1 of a device pixel, in the units the path is written in.
        let device = f64::from(parent.sx).hypot(f64::from(parent.ky)) * scale;
        let drawn = match node {
            usvg::Node::Path(path) if device > 0.0 => draw_path(path, base, &mut pixmap, (0.1 / device) as f32),
            _ => false,
        };
        if !drawn {
            match (layer, node) {
                // `resvg::render_node` puts the node layer box at the corner: the translation by the box undoes that.
                (Some(bbox), _) => {
                    if resvg::render_node(node, base.pre_translate(bbox.x(), bbox.y()), &mut pixmap.as_mut()).is_none() {
                        continue;
                    }
                }
                (None, _) => continue,
            }
        }
        let layer: Vec<[u8; 4]> = if factor == 1 {
            pixmap.pixels().iter().map(|pixel| [pixel.red(), pixel.green(), pixel.blue(), pixel.alpha()]).collect()
        } else {
            mean_of_blocks(pixmap.pixels(), region_width, region_height, factor)
        };
        for row in 0..region_height {
            let target = (y0 as usize + row) * width + x0 as usize;
            for (column, source) in layer[row * region_width..(row + 1) * region_width].iter().enumerate() {
                if source[3] == 0 {
                    continue;
                }
                let below = &mut out[target + column];
                let keep = 255 - u32::from(source[3]);
                for channel in 0..4 {
                    let product = u32::from(below[channel]) * keep + 128;
                    below[channel] = (u32::from(source[channel]) + ((product + (product >> 8)) >> 8)).min(255) as u8;
                }
            }
        }
    }
    Ok(out)
}

/// The paint of a fill or a stroke: a colour or a gradient (a pattern is `None`: it is drawn by `resvg` itself).
fn paint_of(paint: &usvg::Paint, opacity: usvg::Opacity, anti_alias: bool) -> Option<tiny_skia::Paint<'static>> {
    let stops_of = |gradient: &usvg::BaseGradient| -> (Vec<tiny_skia::GradientStop>, tiny_skia::SpreadMode) {
        let mode = match gradient.spread_method() {
            usvg::SpreadMethod::Pad => tiny_skia::SpreadMode::Pad,
            usvg::SpreadMethod::Reflect => tiny_skia::SpreadMode::Reflect,
            usvg::SpreadMethod::Repeat => tiny_skia::SpreadMode::Repeat,
        };
        let stops = gradient
            .stops()
            .iter()
            .map(|stop| {
                let alpha = stop.opacity() * opacity;
                tiny_skia::GradientStop::new(stop.offset().get(), tiny_skia::Color::from_rgba8(stop.color().red, stop.color().green, stop.color().blue, alpha.to_u8()))
            })
            .collect();
        (stops, mode)
    };
    let mut made = tiny_skia::Paint::default();
    match paint {
        usvg::Paint::Color(c) => made.set_color_rgba8(c.red, c.green, c.blue, opacity.to_u8()),
        usvg::Paint::LinearGradient(gradient) => {
            let (stops, mode) = stops_of(gradient);
            made.shader = tiny_skia::LinearGradient::new((gradient.x1(), gradient.y1()).into(), (gradient.x2(), gradient.y2()).into(), stops, mode, gradient.transform())?;
        }
        usvg::Paint::RadialGradient(gradient) => {
            let (stops, mode) = stops_of(gradient);
            made.shader = tiny_skia::RadialGradient::new((gradient.fx(), gradient.fy()).into(), (gradient.cx(), gradient.cy()).into(), gradient.r().get(), stops, mode, gradient.transform())?;
        }
        usvg::Paint::Pattern(_) => return None,
    }
    made.anti_alias = anti_alias;
    Some(made)
}

/// The path as cairo walks it: every curve is cut into straight lines until none of its control points is more than `tolerance` (0.1 of a
/// device pixel in cairo) from the chord, so a curve smaller than a few pixels is drawn as the coarse polygon cairo draws.
fn flatten(path: &tiny_skia::Path, tolerance: f32) -> Option<tiny_skia::Path> {
    fn error_squared(a: (f32, f32), b: (f32, f32), c: (f32, f32), d: (f32, f32)) -> f32 {
        let (mut bx, mut by, mut cx, mut cy) = (b.0 - a.0, b.1 - a.1, c.0 - a.0, c.1 - a.1);
        if a != d {
            let (dx, dy) = (d.0 - a.0, d.1 - a.1);
            let v = dx * dx + dy * dy;
            let along = |x: &mut f32, y: &mut f32| {
                let u = *x * dx + *y * dy;
                if u >= v {
                    *x -= dx;
                    *y -= dy;
                } else if u > 0.0 {
                    *x -= u / v * dx;
                    *y -= u / v * dy;
                }
            };
            along(&mut bx, &mut by);
            along(&mut cx, &mut cy);
        }
        (bx * bx + by * by).max(cx * cx + cy * cy)
    }
    fn cubic(out: &mut tiny_skia::PathBuilder, p: [(f32, f32); 4], tolerance_squared: f32, depth: u32) {
        if depth >= 16 || error_squared(p[0], p[1], p[2], p[3]) < tolerance_squared {
            out.line_to(p[3].0, p[3].1);
            return;
        }
        let mid = |u: (f32, f32), v: (f32, f32)| ((u.0 + v.0) / 2.0, (u.1 + v.1) / 2.0);
        let (ab, bc, cd) = (mid(p[0], p[1]), mid(p[1], p[2]), mid(p[2], p[3]));
        let (abc, bcd) = (mid(ab, bc), mid(bc, cd));
        let middle = mid(abc, bcd);
        cubic(out, [p[0], ab, abc, middle], tolerance_squared, depth + 1);
        cubic(out, [middle, bcd, cd, p[3]], tolerance_squared, depth + 1);
    }
    let tolerance_squared = tolerance * tolerance;
    let mut out = tiny_skia::PathBuilder::new();
    let mut at = (0.0f32, 0.0f32);
    for segment in path.segments() {
        match segment {
            tiny_skia::PathSegment::MoveTo(p) => {
                out.move_to(p.x, p.y);
                at = (p.x, p.y);
            }
            tiny_skia::PathSegment::LineTo(p) => {
                out.line_to(p.x, p.y);
                at = (p.x, p.y);
            }
            tiny_skia::PathSegment::QuadTo(c, p) => {
                // The quadratic as the cubic with the same curve.
                let c1 = (at.0 + 2.0 / 3.0 * (c.x - at.0), at.1 + 2.0 / 3.0 * (c.y - at.1));
                let c2 = (p.x + 2.0 / 3.0 * (c.x - p.x), p.y + 2.0 / 3.0 * (c.y - p.y));
                cubic(&mut out, [at, c1, c2, (p.x, p.y)], tolerance_squared, 0);
                at = (p.x, p.y);
            }
            tiny_skia::PathSegment::CubicTo(c1, c2, p) => {
                cubic(&mut out, [at, (c1.x, c1.y), (c2.x, c2.y), (p.x, p.y)], tolerance_squared, 0);
                at = (p.x, p.y);
            }
            tiny_skia::PathSegment::Close => out.close(),
        }
    }
    out.finish()
}

/// A shape laid the way cairo lays it: its curves flattened at `tolerance` (in the units of its own coordinates), then filled and stroked with a
/// colour or a gradient. `false` for a shape `resvg` has to draw (a pattern paint).
fn draw_path(path: &usvg::Path, transform: tiny_skia::Transform, pixmap: &mut tiny_skia::Pixmap, tolerance: f32) -> bool {
    let anti_alias = path.rendering_mode().use_shape_antialiasing();
    let fill = match path.fill() {
        Some(fill) => match paint_of(fill.paint(), fill.opacity(), anti_alias) {
            Some(paint) => Some((fill, paint)),
            None => return false,
        },
        None => None,
    };
    let stroke = match path.stroke() {
        Some(stroke) => match paint_of(stroke.paint(), stroke.opacity(), anti_alias) {
            Some(paint) => Some((stroke, paint)),
            None => return false,
        },
        None => None,
    };
    if !path.is_visible() {
        return true;
    }
    let Some(flat) = flatten(path.data(), tolerance) else { return true };
    let fill_it = |pixmap: &mut tiny_skia::Pixmap| {
        if let Some((fill, paint)) = &fill {
            let bounds = path.data().bounds();
            if bounds.width() != 0.0 && bounds.height() != 0.0 {
                let rule = match fill.rule() {
                    usvg::FillRule::NonZero => tiny_skia::FillRule::Winding,
                    usvg::FillRule::EvenOdd => tiny_skia::FillRule::EvenOdd,
                };
                pixmap.fill_path(&flat, paint, rule, transform, None);
            }
        }
    };
    let stroke_it = |pixmap: &mut tiny_skia::Pixmap| {
        if let Some((stroke, paint)) = &stroke {
            pixmap.stroke_path(&flat, paint, &stroke.to_tiny_skia(), transform, None);
        }
    };
    if path.paint_order() == usvg::PaintOrder::FillAndStroke {
        fill_it(pixmap);
        stroke_it(pixmap);
    } else {
        stroke_it(pixmap);
        fill_it(pixmap);
    }
    true
}

/// The tolerance (device pixels) cairo flattens a curve at.
const CAIRO_TOLERANCE: f32 = 0.1;
/// The scan converter of cairo's image backend (`cairo-tor-scan-converter.c`): 256 sub-samples across a pixel and 15 sub-rows down it.
const GRID_X: i64 = 256;
const GRID_Y: i64 = 15;

/// A polygon edge in cairo's grid: `x` in 1/256 of a pixel, `y` in 1/15 of a pixel (rounded as `INPUT_TO_GRID_Y` does), top to bottom.
struct GridEdge {
    x: i64,
    y: i64,
    dx: i64,
    bottom: i64,
    direction: i32,
    fixed_y: i64,
    fixed_dy: i64,
}

/// The path as cairo's path holds it: every point rounded to 24.8 fixed point, every curve cut into lines by `_cairo_spline_decompose` (the
/// same halving, in fixed point, until no control point is more than 0.1 pixel from the chord) and every sub-path a list of points that
/// closes by itself.
fn fixed_polygon(path: &tiny_skia::Path) -> Vec<Vec<(i64, i64)>> {
    type Point = (i64, i64);
    let fixed = |value: f32| (f64::from(value) * 256.0).round_ties_even() as i64;
    fn half(a: Point, b: Point) -> Point {
        (a.0 + ((b.0 - a.0) >> 1), a.1 + ((b.1 - a.1) >> 1))
    }
    // `_cairo_spline_error_squared`, in pixels.
    fn error_squared(a: Point, b: Point, c: Point, d: Point) -> f64 {
        let to_pixels = |v: i64| v as f64 / 256.0;
        let (mut bx, mut by) = (to_pixels(b.0 - a.0), to_pixels(b.1 - a.1));
        let (mut cx, mut cy) = (to_pixels(c.0 - a.0), to_pixels(c.1 - a.1));
        if a != d {
            let (dx, dy) = (to_pixels(d.0 - a.0), to_pixels(d.1 - a.1));
            let v = dx * dx + dy * dy;
            let along = |x: &mut f64, y: &mut f64| {
                let u = *x * dx + *y * dy;
                if u <= 0.0 {
                } else if v <= u {
                    *x -= dx;
                    *y -= dy;
                } else {
                    let w = u / v;
                    *x -= w * dx;
                    *y -= w * dy;
                }
            };
            along(&mut bx, &mut by);
            along(&mut cx, &mut cy);
        }
        (bx * bx + by * by).max(cx * cx + cy * cy)
    }
    fn decompose(out: &mut Vec<Point>, p: [Point; 4], tolerance_squared: f64, depth: u32) {
        if depth >= 24 || error_squared(p[0], p[1], p[2], p[3]) < tolerance_squared {
            out.push(p[3]);
            return;
        }
        let (ab, bc, cd) = (half(p[0], p[1]), half(p[1], p[2]), half(p[2], p[3]));
        let (abc, bcd) = (half(ab, bc), half(bc, cd));
        let middle = half(abc, bcd);
        decompose(out, [p[0], ab, abc, middle], tolerance_squared, depth + 1);
        decompose(out, [middle, bcd, cd, p[3]], tolerance_squared, depth + 1);
    }
    let tolerance_squared = f64::from(CAIRO_TOLERANCE) * f64::from(CAIRO_TOLERANCE);
    let mut subpaths: Vec<Vec<Point>> = Vec::new();
    let mut current: Vec<Point> = Vec::new();
    let mut at: Point = (0, 0);
    for segment in path.segments() {
        match segment {
            tiny_skia::PathSegment::MoveTo(p) => {
                if current.len() > 1 {
                    subpaths.push(std::mem::take(&mut current));
                }
                current.clear();
                at = (fixed(p.x), fixed(p.y));
                current.push(at);
            }
            tiny_skia::PathSegment::LineTo(p) => {
                at = (fixed(p.x), fixed(p.y));
                current.push(at);
            }
            tiny_skia::PathSegment::QuadTo(c, p) => {
                let (q, end) = ((fixed(c.x), fixed(c.y)), (fixed(p.x), fixed(p.y)));
                // The quadratic as the cubic with the same curve.
                let third = |from: i64, control: i64| from + (2 * (control - from) + 1).div_euclid(3);
                let b = (third(at.0, q.0), third(at.1, q.1));
                let c2 = (third(end.0, q.0), third(end.1, q.1));
                decompose(&mut current, [at, b, c2, end], tolerance_squared, 0);
                at = end;
            }
            tiny_skia::PathSegment::CubicTo(c1, c2, p) => {
                let end = (fixed(p.x), fixed(p.y));
                decompose(&mut current, [at, (fixed(c1.x), fixed(c1.y)), (fixed(c2.x), fixed(c2.y)), end], tolerance_squared, 0);
                at = end;
            }
            tiny_skia::PathSegment::Close => {
                if current.len() > 1 {
                    let first = current[0];
                    subpaths.push(std::mem::take(&mut current));
                    at = first;
                    current = vec![first];
                }
            }
        }
    }
    if current.len() > 1 {
        subpaths.push(current);
    }
    subpaths
}

/// The edges of a flattened device-space path as cairo's polygon holds them: every sub-path closed, horizontal edges dropped, and each edge's
/// rows taken on the 1/15 grid (an edge that spans no row is dropped).
fn grid_edges(polygon: &[Vec<(i64, i64)>]) -> Vec<GridEdge> {
    let grid_y = |fixed_y: i64| (fixed_y * GRID_Y + 128) >> 8;
    let mut edges = Vec::new();
    let mut add = |from: (i64, i64), to: (i64, i64)| {
        if from.1 == to.1 {
            return;
        }
        let (top, bottom, direction) = if from.1 < to.1 { (from, to, 1) } else { (to, from, -1) };
        let (top_y, bottom_y) = (grid_y(top.1), grid_y(bottom.1));
        if top_y >= bottom_y {
            return;
        }
        edges.push(GridEdge { x: top.0, y: top_y, dx: bottom.0 - top.0, bottom: bottom_y, direction, fixed_y: top.1, fixed_dy: bottom.1 - top.1 });
    };
    for points in polygon {
        for pair in points.windows(2) {
            add(pair[0], pair[1]);
        }
        add(points[points.len() - 1], points[0]);
    }
    edges
}

/// A rectilinear polygon (every edge vertical or horizontal in 24.8 fixed point) as cairo fills it: `_cairo_path_fixed_fill_rectilinear_to_boxes`
/// turns it into boxes and the rectangular scan converter covers a pixel by the product of the box's fractions of it, in 256ths
/// (`coverage = x * y >> 8`, and 256 is written as 255). The coverage of the union is taken slab by slab between the edges' y values.
/// `None` when an edge is neither vertical nor horizontal.
fn rectilinear_coverage(polygon: &[Vec<(i64, i64)>], even_odd: bool, left: usize, top: usize, width: usize, height: usize) -> Option<Vec<u8>> {
    // Vertical edges: (x, top y, bottom y, direction), all in fixed point.
    let mut verticals: Vec<(i64, i64, i64, i32)> = Vec::new();
    let mut add = |from: (i64, i64), to: (i64, i64)| -> bool {
        if from.1 == to.1 {
            return true;
        }
        if from.0 != to.0 {
            return false;
        }
        verticals.push(if from.1 < to.1 { (from.0, from.1, to.1, 1) } else { (from.0, to.1, from.1, -1) });
        true
    };
    for points in polygon {
        for pair in points.windows(2) {
            if !add(pair[0], pair[1]) {
                return None;
            }
        }
        if !add(points[points.len() - 1], points[0]) {
            return None;
        }
    }
    let mut mask = vec![0u8; width * height];
    let mut area = vec![0i64; width];
    let mut breaks: Vec<i64> = Vec::new();
    let mut crossings: Vec<(i64, i32)> = Vec::new();
    for row in 0..height {
        let row_top = (top + row) as i64 * 256;
        let row_bottom = row_top + 256;
        breaks.clear();
        breaks.push(row_top);
        breaks.push(row_bottom);
        for &(_, y0, y1, _) in &verticals {
            for y in [y0, y1] {
                if y > row_top && y < row_bottom {
                    breaks.push(y);
                }
            }
        }
        breaks.sort_unstable();
        breaks.dedup();
        area.iter_mut().for_each(|v| *v = 0);
        let mut touched = false;
        for slab in breaks.windows(2) {
            let (ya, yb) = (slab[0], slab[1]);
            crossings.clear();
            for &(x, y0, y1, direction) in &verticals {
                if y0 <= ya && yb <= y1 {
                    crossings.push((x - left as i64 * 256, direction));
                }
            }
            crossings.sort_by_key(|c| c.0);
            let mut winding = 0i32;
            let mut span_start = 0i64;
            for &(x, direction) in &crossings {
                let was_inside = if even_odd { winding & 1 != 0 } else { winding != 0 };
                winding += direction;
                let inside = if even_odd { winding & 1 != 0 } else { winding != 0 };
                if !was_inside && inside {
                    span_start = x;
                } else if was_inside && !inside {
                    let (a, b) = (span_start.clamp(0, width as i64 * 256), x.clamp(0, width as i64 * 256));
                    let mut at = a;
                    while at < b {
                        let column = (at / 256) as usize;
                        let next = ((at / 256 + 1) * 256).min(b);
                        area[column] += (next - at) * (yb - ya);
                        touched = true;
                        at = next;
                    }
                }
            }
        }
        if !touched {
            continue;
        }
        for column in 0..width {
            let coverage = (area[column] >> 8).min(256);
            mask[row * width + column] = (coverage - (coverage >> 8)) as u8;
        }
    }
    Some(mask)
}

/// The coverage (0 to 255) of `edges` over the `width` x `height` pixels at (`left`, `top`) as cairo's scan converter gives it: 15 sub-rows
/// per pixel, each row's spans cut at the edges' x on the 1/256 grid by the fill rule, the covered length of a pixel summed over the rows
/// and expanded to 8 bits (`GRID_AREA_TO_ALPHA`).
fn cairo_coverage(edges: &[GridEdge], even_odd: bool, left: usize, top: usize, width: usize, height: usize) -> Vec<u8> {
    let mut mask = vec![0u8; width * height];
    let area = GRID_X * GRID_Y;
    let right = width as i64 * GRID_X;
    let mut sums = vec![0i64; width + 1];
    let mut steps = vec![0i64; width + 2];
    let mut crossings: Vec<(i64, i32)> = Vec::new();
    for row in 0..height {
        sums.iter_mut().for_each(|v| *v = 0);
        steps.iter_mut().for_each(|v| *v = 0);
        let mut touched = false;
        for sub in 0..GRID_Y {
            let y = (top + row) as i64 * GRID_Y + sub;
            crossings.clear();
            for edge in edges {
                if edge.y <= y && y < edge.bottom {
                    let x = edge.x + (((2 * y + 1) * 128 - GRID_Y * edge.fixed_y) * edge.dx).div_euclid(GRID_Y * edge.fixed_dy);
                    crossings.push((x - left as i64 * GRID_X, edge.direction));
                }
            }
            if crossings.is_empty() {
                continue;
            }
            crossings.sort_by_key(|c| c.0);
            let mut winding = 0i32;
            let mut span_start = 0i64;
            for &(x, direction) in &crossings {
                let was_inside = if even_odd { winding & 1 != 0 } else { winding != 0 };
                winding += direction;
                let inside = if even_odd { winding & 1 != 0 } else { winding != 0 };
                if !was_inside && inside {
                    span_start = x;
                } else if was_inside && !inside {
                    let (a, b) = (span_start.clamp(0, right), x.clamp(0, right));
                    if b > a {
                        touched = true;
                        let (ia, ib) = ((a / GRID_X) as usize, (b / GRID_X) as usize);
                        if ia == ib {
                            sums[ia] += b - a;
                        } else {
                            sums[ia] += GRID_X - (a % GRID_X);
                            sums[ib] += b % GRID_X;
                            steps[ia + 1] += GRID_X;
                            steps[ib] -= GRID_X;
                        }
                    }
                }
            }
        }
        if !touched {
            continue;
        }
        let mut run = 0i64;
        for column in 0..width {
            run += steps[column];
            let total = sums[column] + run;
            mask[row * width + column] = ((total * 255 + area / 2) / area).min(255) as u8;
        }
    }
    mask
}

/// pixman's `MUL_UN8`.
fn mul_un8(a: u32, b: u32) -> u32 {
    let t = a * b + 128;
    (t + (t >> 8)) >> 8
}

/// Lays one anti-aliased coverage mask of a paint over the picture the way pixman composites a solid or gradient source through an a8 mask.
fn lay(out: &mut [[u8; 4]], width: usize, region: (usize, usize, usize, usize), mask: &[u8], source: &dyn Fn(usize, usize) -> [u8; 4]) {
    let (left, top, region_width, region_height) = region;
    for row in 0..region_height {
        for column in 0..region_width {
            let cover = u32::from(mask[row * region_width + column]);
            if cover == 0 {
                continue;
            }
            let src = source(column, row);
            let below = &mut out[(top + row) * width + left + column];
            let covered_alpha = mul_un8(u32::from(src[3]), cover);
            for channel in 0..4 {
                below[channel] = (mul_un8(u32::from(src[channel]), cover) + mul_un8(u32::from(below[channel]), 255 - covered_alpha)).min(255) as u8;
            }
        }
    }
}

type Source = Box<dyn Fn(usize, usize) -> [u8; 4]>;

/// A fill or a stroke of a path drawn as cairo draws it: the path in device space flattened at 0.1 pixel, scan-converted on cairo's grid and
/// composited over `out`. `false` when the shape is not drawn here (a pattern paint, an aliased shape, a transform that cannot be inverted):
/// nothing has been drawn then.
fn cairo_path(path: &usvg::Path, transform: tiny_skia::Transform, out: &mut [[u8; 4]], width: usize, region: (usize, usize, usize, usize)) -> bool {
    if !path.rendering_mode().use_shape_antialiasing() {
        return false;
    }
    let fill = path.fill().map(|fill| (fill, paint_of(fill.paint(), fill.opacity(), true)));
    let stroke = path.stroke().map(|stroke| (stroke, paint_of(stroke.paint(), stroke.opacity(), true)));
    if fill.as_ref().is_some_and(|(_, paint)| paint.is_none()) || stroke.as_ref().is_some_and(|(_, paint)| paint.is_none()) {
        return false;
    }
    if !path.is_visible() {
        return true;
    }
    let (left, top, region_width, region_height) = region;
    let local = transform.post_translate(-(left as f32), -(top as f32));
    let Some(inverse) = local.invert() else { return false };
    let Some(device_region) = tiny_skia::Rect::from_xywh(0.0, 0.0, region_width as f32, region_height as f32) else { return false };
    let Some(user_region) = device_region.transform(inverse) else { return false };
    let device_scale = f64::from(transform.sx).hypot(f64::from(transform.ky)).max(f64::from(transform.kx).hypot(f64::from(transform.sy)));

    // The source of a paint at the pixel (column, row) of the region: a solid colour or the shader at the pixel centre.
    let source_of = |paint: &tiny_skia::Paint<'static>, color: Option<(usvg::Color, f32)>| -> Option<Source> {
        if let Some((c, opacity)) = color {
            let alpha16 = (f64::from(opacity) * 65535.0).round() as u32;
            let premultiplied = |channel: u8| ((((f64::from(channel) / 255.0) * f64::from(opacity) * 65535.0).round() as u32) >> 8) as u8;
            let solid = [premultiplied(c.red), premultiplied(c.green), premultiplied(c.blue), (alpha16 >> 8) as u8];
            return Some(Box::new(move |_, _| solid));
        }
        let mut pixmap = tiny_skia::Pixmap::new(region_width as u32, region_height as u32)?;
        pixmap.fill_rect(user_region, paint, local, None);
        Some(Box::new(move |column, row| {
            let pixel = pixmap.pixel(column as u32, row as u32).expect("inside");
            [pixel.red(), pixel.green(), pixel.blue(), pixel.alpha()]
        }))
    };
    let color_of = |paint: &usvg::Paint, opacity: usvg::Opacity| -> Option<(usvg::Color, f32)> { match paint {
        usvg::Paint::Color(c) => Some((*c, opacity.get())),
        _ => None,
    } };

    let fill_it = |out: &mut [[u8; 4]]| {
        let Some((fill, Some(paint))) = &fill else { return };
        let bounds = path.data().bounds();
        if bounds.width() == 0.0 || bounds.height() == 0.0 {
            return;
        }
        let Some(device) = path.data().clone().transform(transform) else { return };
        let polygon = fixed_polygon(&device);
        let even_odd = fill.rule() == usvg::FillRule::EvenOdd;
        let mask = rectilinear_coverage(&polygon, even_odd, left, top, region_width, region_height)
            .unwrap_or_else(|| cairo_coverage(&grid_edges(&polygon), even_odd, left, top, region_width, region_height));
        if let Some(source) = source_of(paint, color_of(fill.paint(), fill.opacity())) {
            lay(out, width, region, &mask, &*source);
        }
    };
    let stroke_it = |out: &mut [[u8; 4]]| {
        let Some((stroke, Some(paint))) = &stroke else { return };
        let styled = stroke.to_tiny_skia();
        let resolution = device_scale.max(f64::EPSILON) as f32;
        // Cairo's compositor drops a one-vertex transformed pen before stroking.
        // Thin strokes which survive that test still participate in scan conversion.
        if cairo_pen::stroke_is_empty(f64::from(styled.width), [transform.sx, transform.ky, transform.kx, transform.sy].map(f64::from)) {
            return;
        }
        // The stroker is given the curve already cut into lines (at 0.1 pixel), dashed, and offsets those.
        let Some(centre) = flatten(path.data(), CAIRO_TOLERANCE / resolution) else { return };
        let dashed;
        let basis = match &styled.dash {
            Some(dash) => match centre.dash(dash, resolution) {
                Some(done) => {
                    dashed = done;
                    &dashed
                }
                None => return,
            },
            None => &centre,
        };
        let Some(outline) = basis.stroke(&styled, resolution) else { return };
        let Some(device) = outline.transform(transform) else { return };
        let polygon = fixed_polygon(&device);
        let mask = cairo_coverage(&grid_edges(&polygon), false, left, top, region_width, region_height);
        if let Some(source) = source_of(paint, color_of(stroke.paint(), stroke.opacity())) {
            lay(out, width, region, &mask, &*source);
        }
    };
    if path.paint_order() == usvg::PaintOrder::FillAndStroke {
        fill_it(out);
        stroke_it(out);
    } else {
        stroke_it(out);
        fill_it(out);
    }
    true
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

fn options(fonts: &SvgFonts, density: f64, rendering: usvg::ImageRendering) -> usvg::Options<'static> {
    let mut options = usvg::Options {
        dpi: density as f32,
        image_rendering: rendering,
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
    let document = roxmltree::Document::parse_with_options(text, mixdog_imaging::svg_limits::parsing_options()).map_err(|_| invalid_svg())?;
    mixdog_imaging::svg_limits::check_depth(&document).map_err(|_| invalid_svg())?;
    Ok(document)
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

/// Whether a `viewBox` is four numbers with a width or height of zero (and neither negative): librsvg draws nothing for it.
/// A negative side makes librsvg refuse the attribute, and the page is drawn as if it had none.
fn view_box_without_area(text: &str) -> bool {
    let numbers: Option<Vec<f64>> = text.split(|c: char| c.is_whitespace() || c == ',').filter(|part| !part.is_empty()).map(|part| part.parse::<f64>().ok()).collect();
    matches!(numbers.as_deref(), Some([_, _, width, height]) if *width >= 0.0 && *height >= 0.0 && (*width == 0.0 || *height == 0.0))
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
    fn a_box_edge_is_covered_by_its_fixed_point_fraction() {
        // A page of 40 by 24 drawn into 7 by 4 is 7 by 4 centred at its own scale: the box edges fall at 1/6 of a pixel, 43/256 in fixed point, so
        // the edge row covers 213/256 of the pixel and is written 213.
        let page = svg("width=\"40\" height=\"24\" viewBox=\"0 0 40 24\"", "<rect width=\"40\" height=\"24\" fill=\"#36c\"/>");
        let image = rasterize_to(&SvgFonts::none(), &page, 72.0, 7, 4).unwrap();
        assert_eq!(image.rgba()[3], 213);
        assert_eq!(image.rgba()[(7 + 3) * 4 + 3], 255);
    }

    #[test]
    fn a_collapsed_pen_leaves_nothing_but_the_normal_size_draws() {
        let page = svg("width=\"40\" height=\"24\" viewBox=\"0 0 40 24\"", "<path d=\"M0 24 L40 0\" stroke=\"#d33\" stroke-width=\"1\"/>");
        let thin = rasterize_to(&SvgFonts::none(), &page, 180.0, 2, 1).unwrap();
        assert!(thin.rgba().chunks_exact(4).all(|pixel| pixel[3] == 0), "{:?}", thin.rgba());
        let drawn = rasterize(&SvgFonts::none(), &page, 72.0).unwrap();
        assert!(drawn.rgba().chunks_exact(4).any(|pixel| pixel[3] > 0));
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


    #[test]
    fn thin_diagonal_strokes_are_kept_and_leave_a_faint_even_tint() {
        let mut paths = String::new();
        for x in (-120..=120).step_by(4) {
            paths.push_str(&format!("<path d=\"M{x} 0L{} 128\"/>", x + 128));
        }
        let page = svg("width=\"128\" height=\"128\"", &format!(
            "<rect width=\"128\" height=\"128\" fill=\"white\"/><g fill=\"none\" stroke=\"black\" stroke-width=\"0.05\">{paths}</g>"
        ));
        let image = rasterize(&SvgFonts::none(), &page, 72.0).expect("SVG");
        assert_eq!((image.width(), image.height()), (128, 128));
        let rgba = image.rgba();
        // Each of 16 horizontal bands is a little darker than white but far from black: the hairlines are drawn, not dropped.
        for band in 0..16 {
            let rows = band * 8..band * 8 + 8;
            let sum: u64 = rows.clone().flat_map(|y| (0..128).map(move |x| (y * 128 + x) * 4)).map(|at| u64::from(rgba[at])).sum();
            let mean = sum as f64 / (8.0 * 128.0);
            assert!(mean < 255.0 && mean > 200.0, "band {band}: mean red {mean}");
        }
    }

}
