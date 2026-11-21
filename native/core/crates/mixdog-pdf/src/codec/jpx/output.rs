//! From a parsed JPEG 2000 stream to samples: every tile is decoded (tier-1 per code-block, dequantisation, inverse
//! wavelet transform, inverse component transform, DC level shift and clamping, `opj_tcd_decode_tile`), the tiles
//! are placed in the component planes, the JP2 palette and channel definitions are applied (`opj_jp2_decode`), an
//! sYCC image becomes RGB (`color_sycc_to_rgb` of OpenJPEG's `color.c`), and the planes are delivered as 8-bit
//! interleaved samples the way pdf.js's `JpxImage` hands them to the image pipeline.
//!
//! Read from OpenJPEG 2.5 (`tcd.c`, `t1.c`, `jp2.c`, `color.c`); inferred, not read, because the wasm wrapper of
//! pdf.js has no source in the tree: that the wrapper reduces a sample of precision `p` to 8 bits by a right shift
//! when `p > 8` and by scaling to the full range when `p < 8` (a signed sample is clamped at 0 without an offset: the recording), that
//! it replicates subsampled components to the first component's grid. (The recording shows that the wrapper does not
//! treat a bare three-component codestream with subsampled chroma as sYCC, and that it delivers each component's
//! plane unexpanded in pixel order, reading past the end of the smaller planes; this decoder delivers the expanded
//! image instead.)

use super::boxes::{ChannelDef, ComponentMap, Jp2Info, Palette};
use super::dwt::{ResBox, inverse_irreversible, inverse_reversible};
use super::markers::{CompSiz, Siz};
use super::mct::{inverse_ict, inverse_rct};
use super::t1::Tier1;
use super::tiles::{TileComponent, TileStructure};
use super::{Image, JpxError};

/// Most samples (over all components) an image may hold; a header that asks for more is refused instead of allocated.
const MAX_SAMPLES: u64 = 1 << 28;

/// What the decoder is asked to leave out.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Options {
    /// Do not apply the palette, component mapping and channel definition boxes (pdf.js passes this for an image
    /// whose PDF colour space is `Indexed`: the samples are then the palette indices).
    pub ignore_palette: bool,
}

/// One component of the decoded image on its own sampling grid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plane {
    pub precision: u8,
    pub signed: bool,
    pub dx: u32,
    pub dy: u32,
    /// The plane's origin on its grid (`ceil(X0 / dx)`).
    pub x0: u32,
    pub y0: u32,
    pub width: u32,
    pub height: u32,
    /// `width * height` samples, row after row; signed components keep their sign.
    pub data: Vec<i32>,
}

/// The colour space the JP2 file declares (`EnumCS`), as OpenJPEG maps it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColourSpace {
    Unspecified,
    Srgb,
    Gray,
    Sycc,
    Eycc,
    Cmyk,
}

/// A decoded image.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedImage {
    pub planes: Vec<Plane>,
    pub colour: ColourSpace,
}

/// 8-bit samples, component-interleaved, the delivery format of `JpxImage.decode`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pixels {
    pub width: u32,
    pub height: u32,
    pub components: u32,
    pub data: Vec<u8>,
}

fn ceil_div(a: u32, b: u32) -> u32 {
    a.div_ceil(b)
}

/// Decodes every tile of `image`. Tiles the codestream has no tile-part of stay 0.
pub fn decode(image: &Image, options: Options) -> Result<DecodedImage, JpxError> {
    let cs = &image.codestream;
    let siz = &cs.siz;
    let mut planes = allocate_planes(siz)?;
    let mut t1 = Tier1::new();
    for index in 0..cs.tile_count() {
        if let Some(tile) = cs.decoded_tile(index)? {
            decode_tile(&tile, &siz.comps, &mut planes, &mut t1)?;
        }
    }
    let mut decoded = DecodedImage { planes, colour: ColourSpace::Unspecified };
    if let Some(info) = &image.container {
        decoded.colour = enumerated_colour(info);
        if !options.ignore_palette {
            if let Some(palette) = &info.palette {
                if !info.component_map.is_empty() {
                    decoded.apply_palette(palette, &info.component_map)?;
                }
            }
            if !info.channel_defs.is_empty() {
                decoded.apply_channel_defs(&info.channel_defs);
            }
        }
    }
    decoded.sycc_to_rgb();
    Ok(decoded)
}

/// The zeroed plane of every component, refusing an image of no samples or of more than [`MAX_SAMPLES`].
fn allocate_planes(siz: &Siz) -> Result<Vec<Plane>, JpxError> {
    let mut planes = Vec::with_capacity(siz.comps.len());
    let mut total = 0u64;
    for c in &siz.comps {
        let (x0, y0) = (ceil_div(siz.x0, c.dx), ceil_div(siz.y0, c.dy));
        let (width, height) = (ceil_div(siz.x1, c.dx) - x0, ceil_div(siz.y1, c.dy) - y0);
        if width == 0 || height == 0 {
            return Err(JpxError::new("a component has no samples"));
        }
        total += width as u64 * height as u64;
        if total > MAX_SAMPLES {
            return Err(JpxError::new("the image has too many samples"));
        }
        planes.push(Plane {
            precision: c.precision,
            signed: c.signed,
            dx: c.dx,
            dy: c.dy,
            x0,
            y0,
            width,
            height,
            data: vec![0; width as usize * height as usize],
        });
    }
    Ok(planes)
}

fn enumerated_colour(info: &Jp2Info) -> ColourSpace {
    match info.colour().and_then(|c| c.enumerated) {
        Some(16) => ColourSpace::Srgb,
        Some(17) => ColourSpace::Gray,
        Some(18) => ColourSpace::Sycc,
        Some(24) => ColourSpace::Eycc,
        Some(12) => ColourSpace::Cmyk,
        _ => ColourSpace::Unspecified,
    }
}

/// The samples of one tile-component while it is decoded: integers for the reversible transform, floats for the
/// irreversible one.
enum Samples {
    Int(Vec<i32>),
    Float(Vec<f32>),
}

impl Samples {
    /// Stores the decoded coefficients `src` at `at`: halved for the reversible transform, scaled by `step` for the
    /// irreversible one.
    fn store_row(&mut self, at: usize, src: &[i32], step: f32) {
        match self {
            Samples::Int(d) => {
                for (d, &s) in d[at..at + src.len()].iter_mut().zip(src) {
                    *d = s / 2;
                }
            }
            Samples::Float(d) => {
                for (d, &s) in d[at..at + src.len()].iter_mut().zip(src) {
                    *d = s as f32 * step;
                }
            }
        }
    }
}

struct TileSamples {
    width: usize,
    height: usize,
    samples: Samples,
}

fn decode_tile(tile: &TileStructure, comps: &[CompSiz], planes: &mut [Plane], t1: &mut Tier1) -> Result<(), JpxError> {
    let mut decoded = Vec::with_capacity(tile.components.len());
    for (c, tc) in tile.components.iter().enumerate() {
        decoded.push(decode_component(tile, c, tc, t1)?);
    }
    inverse_component_transform(tile, &mut decoded);
    for (c, ts) in decoded.iter().enumerate() {
        let tc = &tile.components[c];
        let plane = &mut planes[c];
        let (min, max, shift) = level_range(comps[c].precision, comps[c].signed);
        let (ox, oy) = ((tc.x0 - plane.x0) as usize, (tc.y0 - plane.y0) as usize);
        for j in 0..ts.height {
            let row = (oy + j) * plane.width as usize + ox;
            for i in 0..ts.width {
                let v = match &ts.samples {
                    Samples::Int(d) => d[j * ts.width + i] as i64,
                    Samples::Float(d) => d[j * ts.width + i].round_ties_even() as i32 as i64,
                };
                plane.data[row + i] = (v + shift).clamp(min, max) as i32;
            }
        }
    }
    Ok(())
}

/// `opj_tcd_dc_level_shift_decode`: the clamping range of a component and the level shift of unsigned samples.
fn level_range(precision: u8, signed: bool) -> (i64, i64, i64) {
    let half = 1i64 << (precision - 1);
    if signed { (-half, half - 1, 0) } else { (0, (1i64 << precision) - 1, half) }
}

fn decode_component(tile: &TileStructure, c: usize, tc: &TileComponent, t1: &mut Tier1) -> Result<TileSamples, JpxError> {
    let params = &tile.params.comps[c];
    let reversible = params.coding.reversible;
    let (w, h) = ((tc.x1 - tc.x0) as usize, (tc.y1 - tc.y0) as usize);
    let mut samples = if reversible { Samples::Int(vec![0i32; w * h]) } else { Samples::Float(vec![0f32; w * h]) };
    for (r, res) in tc.resolutions.iter().enumerate() {
        let (prev_w, prev_h) = if r > 0 {
            let p = &tc.resolutions[r - 1];
            ((p.x1 - p.x0) as usize, (p.y1 - p.y0) as usize)
        } else {
            (0, 0)
        };
        for band in &res.bands {
            let (offset_x, offset_y) = (if band.orient & 1 != 0 { prev_w } else { 0 }, if band.orient & 2 != 0 { prev_h } else { 0 });
            let step = 0.5f32 * band.stepsize;
            for precinct in &band.precincts {
                for block in &precinct.blocks {
                    if block.segments.is_empty() || block.x1 <= block.x0 || block.y1 <= block.y0 {
                        continue;
                    }
                    let data = t1.decode(block, band.orient, params.coding.style, params.roi_shift)?;
                    let bw = (block.x1 - block.x0) as usize;
                    let bh = (block.y1 - block.y0) as usize;
                    let bx = (block.x0 - band.x0) as usize + offset_x;
                    let by = (block.y0 - band.y0) as usize + offset_y;
                    for j in 0..bh {
                        let at = (by + j) * w + bx;
                        samples.store_row(at, &data[j * bw..(j + 1) * bw], step);
                    }
                }
            }
        }
    }
    let boxes: Vec<ResBox> = tc.resolutions.iter().map(|r| ResBox { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 }).collect();
    match &mut samples {
        Samples::Int(ints) => inverse_reversible(ints, w, &boxes),
        Samples::Float(floats) => inverse_irreversible(floats, w, &boxes),
    }
    Ok(TileSamples { width: w, height: h, samples })
}

/// `opj_tcd_mct_decode`: the inverse RCT or ICT over the first three components when the tile asks for it and they
/// have the same size and kind; otherwise the step is skipped, as OpenJPEG skips it.
fn inverse_component_transform(tile: &TileStructure, decoded: &mut [TileSamples]) {
    if tile.params.mct != 1 || decoded.len() < 3 {
        return;
    }
    if decoded[1..3].iter().any(|t| t.width != decoded[0].width || t.height != decoded[0].height) {
        return;
    }
    let (first, rest) = decoded.split_at_mut(1);
    let (second, third) = rest.split_at_mut(1);
    match (&mut first[0].samples, &mut second[0].samples, &mut third[0].samples) {
        (Samples::Int(a), Samples::Int(b), Samples::Int(c)) => inverse_rct(a, b, c),
        (Samples::Float(a), Samples::Float(b), Samples::Float(c)) => inverse_ict(a, b, c),
        _ => {}
    }
}

impl DecodedImage {
    /// Width of the image as OpenJPEG and pdf.js report it: the first component's.
    pub fn width(&self) -> u32 {
        self.planes.first().map_or(0, |p| p.width)
    }

    pub fn height(&self) -> u32 {
        self.planes.first().map_or(0, |p| p.height)
    }

    pub fn component_count(&self) -> usize {
        self.planes.len()
    }

    /// `opj_jp2_apply_pclr`: replaces the components by the channels of the component mapping, reading palette
    /// columns for the mapped ones. Every channel takes the precision and sign of its palette column, a directly used
    /// one too. A single-component image whose mapping leaves a palette column unused is mapped column by column
    /// instead, as `opj_jp2_check_color` corrects it ("Component mapping seems wrong").
    fn apply_palette(&mut self, palette: &Palette, map: &[ComponentMap]) -> Result<(), JpxError> {
        let columns = palette.column_depths.len();
        let corrected: Vec<ComponentMap>;
        let map = if self.planes.len() == 1 && (0..columns).any(|c| !map.iter().take(columns).any(|m| m.palette_column as usize == c)) {
            corrected =
                (0..columns).map(|c| ComponentMap { component: map.get(c).map_or(0, |m| m.component), mapping_type: 1, palette_column: c as u8 }).collect();
            &corrected[..]
        } else {
            map
        };
        let mut out: Vec<Option<Plane>> = vec![None; columns];
        for (i, m) in map.iter().enumerate().take(columns) {
            let source = self.planes.get(m.component as usize).ok_or_else(|| JpxError::new("a component mapping names a component that does not exist"))?;
            if m.mapping_type == 0 {
                let depth = palette.column_depths[i];
                out[i] = Some(Plane { precision: (depth & 0x7f) + 1, signed: depth & 0x80 != 0, ..source.clone() });
                continue;
            }
            let column = m.palette_column as usize;
            if column >= columns {
                return Err(JpxError::new("a component mapping names a palette column that does not exist"));
            }
            let depth = palette.column_depths[column];
            let top = palette.entries.saturating_sub(1) as i64;
            let data = source
                .data
                .iter()
                .map(|&k| {
                    let k = (k as i64).clamp(0, top) as usize;
                    palette.values.get(k * columns + column).copied().unwrap_or(0) as i32
                })
                .collect();
            out[column] = Some(Plane { precision: (depth & 0x7f) + 1, signed: depth & 0x80 != 0, data, ..source.clone() });
        }
        let planes: Option<Vec<Plane>> = out.into_iter().collect();
        self.planes = planes.ok_or_else(|| JpxError::new("the component mapping leaves a palette channel unset"))?;
        Ok(())
    }

    /// `opj_jp2_apply_cdef`: moves each colour channel to the position its association names.
    fn apply_channel_defs(&mut self, defs: &[ChannelDef]) {
        let mut defs = defs.to_vec();
        let n = self.planes.len();
        for i in 0..defs.len() {
            let cn = defs[i].channel as usize;
            if cn >= n {
                continue;
            }
            let asoc = defs[i].association;
            if asoc == 0 || asoc == 65535 {
                continue;
            }
            let acn = asoc as usize - 1;
            if acn >= n {
                continue;
            }
            if cn != acn && defs[i].kind == 0 {
                self.planes.swap(cn, acn);
                for later in defs.iter_mut().skip(i + 1) {
                    if later.channel as usize == cn {
                        later.channel = acn as u16;
                    } else if later.channel as usize == acn {
                        later.channel = cn as u16;
                    }
                }
            }
        }
    }

    /// `color_sycc_to_rgb` of OpenJPEG, applied when the file says sYCC. (The recording of pdf.js leaves a bare
    /// codestream with subsampled chroma unconverted: `opj_decompress`'s guess is not made.)
    fn sycc_to_rgb(&mut self) {
        let p = &self.planes;
        if p.len() < 3 {
            return;
        }
        if self.colour != ColourSpace::Sycc {
            return;
        }
        let (a, b, c) = (&p[0], &p[1], &p[2]);
        let shape = |q: &Plane| (q.dx, q.dy);
        let supported = (shape(a) == (1, 1) && shape(b) == (2, 2) && shape(c) == (2, 2))
            || (shape(a) == (1, 1) && shape(b) == (2, 1) && shape(c) == (2, 1))
            || (shape(a) == (1, 1) && shape(b) == (1, 1) && shape(c) == (1, 1));
        if !supported {
            return;
        }
        let (w, h) = (a.width as usize, a.height as usize);
        let offset = 1i32 << (a.precision - 1);
        let upb = ((1i64 << a.precision) - 1) as i32;
        let mut r = vec![0i32; w * h];
        let mut g = vec![0i32; w * h];
        let mut bl = vec![0i32; w * h];
        for j in 0..h {
            for i in 0..w {
                let y = a.data[j * w + i];
                let cb = sample_at(b, a, i, j) - offset;
                let cr = sample_at(c, a, i, j) - offset;
                let at = j * w + i;
                r[at] = (y + (1.402f64 * cr as f32 as f64) as i32).clamp(0, upb);
                g[at] = (y - (0.344f64 * cb as f32 as f64 + 0.714f64 * cr as f32 as f64) as i32).clamp(0, upb);
                bl[at] = (y + (1.772f64 * cb as f32 as f64) as i32).clamp(0, upb);
            }
        }
        let kinds: Vec<(u8, bool)> = p.iter().take(3).map(|q| (q.precision, q.signed)).collect();
        let (x0, y0, width, height) = (a.x0, a.y0, a.width, a.height);
        for (k, data) in [r, g, bl].into_iter().enumerate() {
            let (precision, signed) = kinds[k];
            self.planes[k] = Plane { precision, signed, dx: 1, dy: 1, x0, y0, width, height, data };
        }
        self.colour = ColourSpace::Srgb;
    }

    /// The samples as 8-bit, component-interleaved pixels of the first component's grid. At most `max_components`
    /// components are delivered (the first ones); other components are replicated onto the first one's grid.
    pub fn to_pixels(&self, max_components: usize) -> Pixels {
        let count = self.planes.len().min(max_components.max(1));
        let (w, h) = (self.width() as usize, self.height() as usize);
        let mut data = vec![0u8; w * h * count];
        if let Some(first) = self.planes.first() {
            for (c, plane) in self.planes.iter().take(count).enumerate() {
                for j in 0..h {
                    for i in 0..w {
                        data[(j * w + i) * count + c] = to_u8(sample_at(plane, first, i, j), plane);
                    }
                }
            }
        }
        Pixels { width: w as u32, height: h as u32, components: count as u32, data }
    }
}

/// The sample of `plane` that covers pixel `(i, j)` of the reference plane's grid.
fn sample_at(plane: &Plane, reference: &Plane, i: usize, j: usize) -> i32 {
    if plane.dx == reference.dx && plane.dy == reference.dy && plane.width == reference.width {
        return plane.data[j * plane.width as usize + i];
    }
    let x = (reference.x0 as u64 + i as u64) * reference.dx as u64 / plane.dx as u64;
    let y = (reference.y0 as u64 + j as u64) * reference.dy as u64 / plane.dy as u64;
    let x = (x.saturating_sub(plane.x0 as u64) as usize).min(plane.width as usize - 1);
    let y = (y.saturating_sub(plane.y0 as u64) as usize).min(plane.height as usize - 1);
    plane.data[y * plane.width as usize + x]
}

fn to_u8(sample: i32, plane: &Plane) -> u8 {
    let p = plane.precision as i64;
    // A signed sample is reduced as it is and a negative one becomes 0: the recording of pdf.js shows no offset.
    let v = sample as i64;
    let v = if p > 8 {
        v >> (p - 8)
    } else if p < 8 {
        v * 255 / ((1i64 << p) - 1)
    } else {
        v
    };
    v.clamp(0, 255) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plane(precision: u8, signed: bool, w: u32, h: u32, data: Vec<i32>) -> Plane {
        Plane { precision, signed, dx: 1, dy: 1, x0: 0, y0: 0, width: w, height: h, data }
    }

    #[test]
    fn level_range_follows_signedness() {
        assert_eq!(level_range(8, false), (0, 255, 128));
        assert_eq!(level_range(8, true), (-128, 127, 0));
        assert_eq!(level_range(31, false), (0, 2_147_483_647, 1_073_741_824));
    }

    #[test]
    fn samples_reduce_to_eight_bits() {
        assert_eq!(to_u8(1000, &plane(12, false, 1, 1, vec![])), 62);
        assert_eq!(to_u8(-128, &plane(8, true, 1, 1, vec![])), 0);
        assert_eq!(to_u8(96, &plane(12, true, 1, 1, vec![])), 6);
        assert_eq!(to_u8(-3, &plane(12, true, 1, 1, vec![])), 0);
        assert_eq!(to_u8(15, &plane(4, false, 1, 1, vec![])), 255);
        assert_eq!(to_u8(1, &plane(1, false, 1, 1, vec![])), 255);
        assert_eq!(to_u8(300, &plane(8, false, 1, 1, vec![])), 255);
    }

    #[test]
    fn pixels_interleave_and_stop_at_the_requested_components() {
        let image = DecodedImage {
            planes: vec![plane(8, false, 2, 1, vec![1, 2]), plane(8, false, 2, 1, vec![3, 4]), plane(8, false, 2, 1, vec![5, 6])],
            colour: ColourSpace::Srgb,
        };
        assert_eq!(image.to_pixels(3).data, [1, 3, 5, 2, 4, 6]);
        let two = image.to_pixels(2);
        assert_eq!((two.components, two.data), (2, vec![1, 3, 2, 4]));
        assert_eq!(image.to_pixels(9).components, 3);
    }

    #[test]
    fn a_subsampled_plane_is_replicated_onto_the_first_grid() {
        let first = plane(8, false, 4, 2, vec![0; 8]);
        let half = Plane { dx: 2, dy: 2, width: 2, height: 1, ..plane(8, false, 2, 1, vec![10, 20]) };
        let got: Vec<i32> = (0..2).flat_map(|j| (0..4).map(move |i| (i, j))).map(|(i, j)| sample_at(&half, &first, i, j)).collect();
        assert_eq!(got, [10, 10, 20, 20, 10, 10, 20, 20]);
    }

    #[test]
    fn a_palette_maps_indices_to_columns() {
        let mut image = DecodedImage { planes: vec![plane(8, false, 2, 1, vec![0, 1])], colour: ColourSpace::Unspecified };
        let palette = Palette { entries: 2, column_depths: vec![7, 7, 7], values: vec![1, 2, 3, 4, 5, 6] };
        let map: Vec<ComponentMap> = (0..3).map(|c| ComponentMap { component: 0, mapping_type: 1, palette_column: c }).collect();
        image.apply_palette(&palette, &map).unwrap();
        assert_eq!(image.planes.len(), 3);
        assert_eq!(image.planes[1].data, [2, 5]);
        assert_eq!(image.planes[2].precision, 8);
    }

    #[test]
    fn a_single_component_mapping_without_palette_columns_is_corrected_to_the_palette() {
        let mut image = DecodedImage { planes: vec![plane(8, false, 2, 1, vec![0, 1])], colour: ColourSpace::Unspecified };
        let palette = Palette { entries: 2, column_depths: vec![7, 7, 7], values: vec![1, 2, 3, 4, 5, 6] };
        let map: Vec<ComponentMap> = (0..3).map(|_| ComponentMap { component: 0, mapping_type: 0, palette_column: 0 }).collect();
        image.apply_palette(&palette, &map).unwrap();
        assert_eq!((image.planes[0].data.clone(), image.planes[2].data.clone()), (vec![1, 4], vec![3, 6]));
    }

    #[test]
    fn channel_definitions_swap_colour_channels_into_place() {
        let mut image = DecodedImage { planes: vec![plane(8, false, 1, 1, vec![1]), plane(8, false, 1, 1, vec![2])], colour: ColourSpace::Unspecified };
        let defs = [ChannelDef { channel: 0, kind: 0, association: 2 }, ChannelDef { channel: 1, kind: 0, association: 1 }];
        image.apply_channel_defs(&defs);
        assert_eq!((image.planes[0].data[0], image.planes[1].data[0]), (2, 1));
    }

    #[test]
    fn sycc_444_becomes_rgb() {
        let mut image = DecodedImage {
            planes: vec![plane(8, false, 1, 1, vec![100]), plane(8, false, 1, 1, vec![128]), plane(8, false, 1, 1, vec![128])],
            colour: ColourSpace::Sycc,
        };
        image.sycc_to_rgb();
        assert_eq!(image.colour, ColourSpace::Srgb);
        assert_eq!(image.to_pixels(3).data, [100, 100, 100]);
    }
}
