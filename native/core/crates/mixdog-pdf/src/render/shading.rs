//! Shadings: what `Pattern.parseShading` of pdf.js's `src/core/pattern.js` makes of a shading object (the IR the display
//! layer paints) and what `src/display/pattern_helper.js` paints from it.
//!
//! Types 2 and 3 (axial and radial) are sampled into colour stops and become canvas gradients; types 1, 4, 5, 6 and 7
//! (function based, free-form, lattice, Coons and tensor patch meshes) become a list of triangles with a colour per
//! vertex that is rasterised, as pdf.js does without WebGPU, by `drawTriangle` into an image the page is painted from.
//! A shading that cannot be read is pdf.js's `DummyShading`: it paints `hotpink`.

use std::sync::Arc;

use mixdog_raster::canvas::{Bitmap, Canvas, Gradient, ImageData, PatternStyle, Repetition};

use crate::color::{self, ColorSpace};
use crate::document::Document;
use crate::error::{PdfError, Result};
use crate::function::{self, PdfFunction};
use crate::object::{Dict, Obj};
use crate::oplist::gstate::{self, Matrix, normalize_rect};
use crate::oplist::truthy;
use crate::xref::Xref;

use super::painter::{TransferMaps, axial_bounding_box, js_round, raster, singular_scales};

/// `BaseShading.SMALL_NUMBER`.
const SMALL_NUMBER: f64 = 1e-6;
/// `NUMBER_OF_SAMPLES` of `RadialAxialShading`.
const NUMBER_OF_SAMPLES: usize = 840;
/// `FunctionBasedShading.MAX_STEP_COUNT`.
const MAX_STEP_COUNT: f64 = 512.0;
/// `MeshShading.TRIANGLE_DENSITY` and the bounds of the number of chunks a patch is split into.
const TRIANGLE_DENSITY: f64 = 20.0;
const MIN_SPLIT_PATCH_CHUNKS_AMOUNT: f64 = 3.0;
const MAX_SPLIT_PATCH_CHUNKS_AMOUNT: f64 = 20.0;
/// `EXPECTED_SCALE`, `MAX_PATTERN_SIZE` and `BORDER_SIZE` of `MeshShadingPattern._createMeshCanvas`.
const EXPECTED_SCALE: f64 = 1.1;
const MAX_MESH_PATTERN_SIZE: f64 = 3000.0;
const BORDER_SIZE: u32 = 2;

/// What a shading is painted from (`getIR`).
pub(super) enum ShadingIr {
    RadialAxial(RadialAxial),
    Mesh(Mesh),
    /// `["Dummy"]`: the shading could not be read.
    Dummy,
}

/// `["RadialAxial", type, bbox, colorStops, p0, p1, r0, r1]`.
pub(super) struct RadialAxial {
    pub(super) radial: bool,
    pub(super) bbox: Option<[f64; 4]>,
    pub(super) color_stops: Vec<(f64, String)>,
    pub(super) p0: [f64; 2],
    pub(super) p1: [f64; 2],
    pub(super) r0: f64,
    pub(super) r1: f64,
}

/// `["Mesh", type, posData, colData, vertexCount, bounds, bbox, background]`: triangles of three vertices each, the
/// positions as `x, y` pairs and the colours as `r, g, b, 0` quadruples.
pub(super) struct Mesh {
    pub(super) pos_data: Vec<f32>,
    pub(super) col_data: Vec<u8>,
    pub(super) vertex_count: usize,
    pub(super) bounds: [f64; 4],
    pub(super) bbox: Option<[f64; 4]>,
    pub(super) background: Option<[u8; 3]>,
}

impl RadialAxial {
    /// `isOriginBased`.
    pub(super) fn is_origin_based(&self) -> bool {
        self.p0[0] == 0.0 && self.p0[1] == 0.0 && (!self.radial || (self.p1[0] == 0.0 && self.p1[1] == 0.0))
    }

    /// `areConic`: a radial shading whose circles neither contain each other nor lie apart.
    pub(super) fn are_conic(&self) -> bool {
        if !self.radial {
            return false;
        }
        let dist = (self.p0[0] - self.p1[0]).hypot(self.p0[1] - self.p1[1]);
        dist + self.r1 > self.r0 && dist + self.r0 > self.r1
    }

    fn apply(point: [f64; 2], transform: Option<&Matrix>) -> [f64; 2] {
        match transform {
            Some(m) => {
                let (x, y) = gstate::apply_point(point[0], point[1], m);
                [x, y]
            }
            None => point,
        }
    }

    /// `_createGradient`: the gradient in the space `transform` maps the shading's own to (none: the shading's own).
    pub(super) fn create_gradient(&self, transform: Option<&Matrix>) -> Gradient {
        let first = Self::apply(self.p0, transform);
        let second = Self::apply(self.p1, transform);
        let mut gradient = if self.radial {
            let (mut r0, mut r1) = (self.r0, self.r1);
            if let Some(m) = transform {
                let scale = f64::from(singular_scales(m).0);
                r0 *= scale;
                r1 *= scale;
            }
            Gradient::radial(
                first[0] as f32,
                first[1] as f32,
                r0 as f32,
                second[0] as f32,
                second[1] as f32,
                r1 as f32,
            )
        } else {
            Gradient::linear(first[0] as f32, first[1] as f32, second[0] as f32, second[1] as f32)
        };
        for (offset, color) in &self.color_stops {
            // A stop the canvas refuses (an offset moved out of 0 to 1) throws in Node and ends the shading there.
            if gradient.add_color_stop(*offset as f32, color).is_err() {
                break;
            }
        }
        gradient
    }

    /// `_createReversedGradient`: the radial gradient run from the second circle to the first.
    pub(super) fn create_reversed_gradient(&self, transform: Option<&Matrix>) -> Gradient {
        let first = Self::apply(self.p1, transform);
        let second = Self::apply(self.p0, transform);
        let (mut r0, mut r1) = (self.r1, self.r0);
        if let Some(m) = transform {
            let scale = f64::from(singular_scales(m).0);
            r0 *= scale;
            r1 *= scale;
        }
        let mut gradient = Gradient::radial(
            first[0] as f32,
            first[1] as f32,
            r0 as f32,
            second[0] as f32,
            second[1] as f32,
            r1 as f32,
        );
        for (offset, color) in self.color_stops.iter().rev() {
            if gradient.add_color_stop((1.0 - offset) as f32, color).is_err() {
                break;
            }
        }
        gradient
    }
}

// ---- parsing ---------------------------------------------------------------------------------------------------------

/// `Pattern.parseShading`: the shading `source` (a dictionary, or a stream for a mesh) as the display layer paints it.
/// A shading that cannot be read is the dummy one, said at warn level; a cancellation or a limit is not swallowed.
pub(super) fn read_shading(document: &Document, resources: &Dict, source: &Obj) -> Result<ShadingIr> {
    match parse(document, resources, source) {
        Ok(ir) => Ok(ir),
        Err(error) if error.is_fatal() => Err(error),
        Err(error) => {
            tracing::warn!("{}", error.message());
            Ok(ShadingIr::Dummy)
        }
    }
}

fn parse(document: &Document, resources: &Dict, source: &Obj) -> Result<ShadingIr> {
    let xref = document.xref();
    let dict = match source {
        Obj::Stream(stream) => stream.dict.clone(),
        Obj::Dict(dict) => dict.clone(),
        _ => return Err(PdfError::format("Unsupported ShadingType: undefined")),
    };
    let number = xref.get(&dict, "ShadingType")?.as_num();
    let shading_type = number.filter(|t| t.fract() == 0.0).map(|t| t as i64);
    match shading_type {
        Some(1) => function_based(document, resources, &dict),
        Some(2) => radial_axial(document, resources, &dict, false),
        Some(3) => radial_axial(document, resources, &dict, true),
        Some(t @ 4..=7) => {
            let Obj::Stream(stream) = source else {
                return Err(PdfError::format("Mesh data is not a stream"));
            };
            mesh(document, resources, stream, t)
        }
        _ => Err(PdfError::format(format!(
            "Unsupported ShadingType: {}",
            number.map_or_else(|| "undefined".to_owned(), mixdog_js::number_to_string)
        ))),
    }
}

/// `isNumberArray(array, len)`: the numbers of an array of exactly `len` numbers.
fn numbers(obj: &Obj, len: usize) -> Option<Vec<f64>> {
    let Obj::Array(items) = obj else {
        return None;
    };
    if items.len() != len {
        return None;
    }
    items.iter().map(Obj::as_num).collect()
}

/// `lookupNormalRect(array, null)`.
fn normal_rect(obj: &Obj) -> Option<[f64; 4]> {
    numbers(obj, 4).map(|r| normalize_rect([r[0], r[1], r[2], r[3]]))
}

/// The numbers of an array, NaN for what is not one (the typed arrays pdf.js reads colours from).
fn number_list(obj: &Obj) -> Vec<f64> {
    match obj {
        Obj::Array(items) => items.iter().map(|v| v.as_num().unwrap_or(f64::NAN)).collect(),
        _ => Vec::new(),
    }
}

/// `ColorSpaceUtils.parse` of `dict.getRaw("CS") || dict.getRaw("ColorSpace")`.
fn colour_space(xref: &Xref, resources: &Dict, dict: &Dict) -> Result<Arc<ColorSpace>> {
    let null = Obj::Null;
    let raw = match dict.get_raw("CS") {
        Some(value) if truthy(value) => value,
        _ => dict.get_raw("ColorSpace").unwrap_or(&null),
    };
    color::parse(raw, xref, Some(resources))
}

/// `parseShadingFunction`.
fn shading_function(xref: &Xref, dict: &Dict, inputs: usize, outputs: usize) -> Result<PdfFunction> {
    let null = Obj::Null;
    let function = function::create(xref, dict.get_raw("Function").unwrap_or(&null), true)?;
    if function.num_inputs() != inputs || function.num_outputs() != outputs {
        return Err(PdfError::format(format!(
            "Invalid shading function: expected {inputs}-in {outputs}-out, got {}-in {}-out.",
            function.num_inputs(),
            function.num_outputs()
        )));
    }
    Ok(function)
}

/// The colour of a `/Background` array.
fn read_background(xref: &Xref, dict: &Dict, space: &ColorSpace) -> Result<Option<[u8; 3]>> {
    if !dict.has("Background") {
        return Ok(None);
    }
    let values = number_list(&xref.get_array(dict, "Background")?);
    Ok(Some(space.get_rgb(&values, 0)?))
}

fn radial_axial(document: &Document, resources: &Dict, dict: &Arc<Dict>, radial: bool) -> Result<ShadingIr> {
    let xref = document.xref();
    let coords_len = if radial { 6 } else { 4 };
    let coords = numbers(&xref.get_array(dict, "Coords")?, coords_len)
        .ok_or_else(|| PdfError::format("RadialAxialShading: Invalid /Coords array."))?;
    let space = colour_space(xref, resources, dict)?;
    let bbox = normal_rect(&xref.get_array(dict, "BBox")?);
    let (t0, t1) = numbers(&xref.get_array(dict, "Domain")?, 2).map_or((0.0, 1.0), |d| (d[0], d[1]));
    let (extend_start, extend_end) = match xref.get_array(dict, "Extend")? {
        Obj::Array(items) if items.len() == 2 && items.iter().all(|v| matches!(v, Obj::Bool(_))) => (
            matches!(items[0], Obj::Bool(true)),
            matches!(items[1], Obj::Bool(true)),
        ),
        _ => (false, false),
    };
    let function = shading_function(xref, dict, 1, space.num_comps())?;
    let (p0, p1, r0, r1) = if radial {
        ([coords[0], coords[1]], [coords[3], coords[4]], coords[2], coords[5])
    } else {
        ([coords[0], coords[1]], [coords[2], coords[3]], 0.0, 0.0)
    };
    let mut shading = RadialAxial {
        radial,
        bbox,
        color_stops: Vec::new(),
        p0,
        p1,
        r0,
        r1,
    };
    let step = (t1 - t0) / NUMBER_OF_SAMPLES as f64;
    if t0 >= t1 || step <= 0.0 {
        tracing::info!("Bad shading domain.");
        return Ok(ShadingIr::RadialAxial(shading));
    }
    let num_comps = space.num_comps();
    let mut comps = vec![0.0f64; NUMBER_OF_SAMPLES * num_comps];
    let mut output = vec![0.0f64; function.num_outputs().max(num_comps)];
    for i in 0..NUMBER_OF_SAMPLES {
        // `ratio` and `comps` are `Float32Array`s.
        let ratio = f64::from((t0 + i as f64 * step) as f32);
        function.call(&[ratio], &mut output)?;
        for k in 0..num_comps {
            comps[i * num_comps + k] = f64::from(output[k] as f32);
        }
    }
    let mut rgb = vec![0u8; NUMBER_OF_SAMPLES * 3];
    space.get_rgb_items(&comps, NUMBER_OF_SAMPLES, &mut rgb, 0, 0)?;
    shading.color_stops = color_stops(&rgb);
    let background_color = if dict.has("Background") {
        let values = number_list(&xref.get_array(dict, "Background")?);
        space.get_rgb_hex(&values, 0)?
    } else {
        "transparent".to_owned()
    };
    let stops = &mut shading.color_stops;
    if !extend_start {
        stops.insert(0, (0.0, background_color.clone()));
        stops[1].0 += SMALL_NUMBER;
    }
    if !extend_end {
        let last = stops.len() - 1;
        stops[last].0 -= SMALL_NUMBER;
        stops.push((1.0, background_color));
    }
    Ok(ShadingIr::RadialAxial(shading))
}

/// The colour stops of the 840 sampled colours: a stop is kept where a straight line between the stops can no longer
/// stay within one level of every sample.
fn color_stops(rgb: &[u8]) -> Vec<(f64, String)> {
    let sample = |i: usize| {
        (
            f64::from(rgb[i * 3]),
            f64::from(rgb[i * 3 + 1]),
            f64::from(rgb[i * 3 + 2]),
        )
    };
    let hex = |(r, g, b): (f64, f64, f64)| color::make_hex_color(r as u8, g as u8, b as u8);
    let mut stops = Vec::new();
    let mut i_base = 0usize;
    let mut base = sample(0);
    stops.push((0.0, hex(base)));
    let mut i_prev = 1usize;
    let mut prev = sample(1);
    let mut max_slope = (prev.0 - base.0 + 1.0, prev.1 - base.1 + 1.0, prev.2 - base.2 + 1.0);
    let mut min_slope = (prev.0 - base.0 - 1.0, prev.1 - base.1 - 1.0, prev.2 - base.2 - 1.0);
    for i in 2..NUMBER_OF_SAMPLES {
        let (r, g, b) = sample(i);
        let run = (i - i_base) as f64;
        max_slope.0 = max_slope.0.min((r - base.0 + 1.0) / run);
        max_slope.1 = max_slope.1.min((g - base.1 + 1.0) / run);
        max_slope.2 = max_slope.2.min((b - base.2 + 1.0) / run);
        min_slope.0 = min_slope.0.max((r - base.0 - 1.0) / run);
        min_slope.1 = min_slope.1.max((g - base.1 - 1.0) / run);
        min_slope.2 = min_slope.2.max((b - base.2 - 1.0) / run);
        let slopes_exist =
            min_slope.0 <= max_slope.0 && min_slope.1 <= max_slope.1 && min_slope.2 <= max_slope.2;
        if !slopes_exist {
            stops.push((i_prev as f64 / NUMBER_OF_SAMPLES as f64, hex(prev)));
            max_slope = (r - prev.0 + 1.0, g - prev.1 + 1.0, b - prev.2 + 1.0);
            min_slope = (r - prev.0 - 1.0, g - prev.1 - 1.0, b - prev.2 - 1.0);
            i_base = i_prev;
            base = prev;
        }
        i_prev = i;
        prev = (r, g, b);
    }
    stops.push((1.0, hex(prev)));
    stops
}

/// `FunctionBasedShading`: the domain sampled on a grid of at most 512 steps a side, drawn as a lattice mesh.
fn function_based(document: &Document, resources: &Dict, dict: &Arc<Dict>) -> Result<ShadingIr> {
    let xref = document.xref();
    let bbox = normal_rect(&xref.get_array(dict, "BBox")?);
    let space = colour_space(xref, resources, dict)?;
    let background = read_background(xref, dict, &space)?;
    if !dict.get_raw("Function").is_some_and(truthy) {
        return Err(PdfError::format("FunctionBasedShading: missing /Function"));
    }
    let function = shading_function(xref, dict, 2, space.num_comps())?;
    let domain = numbers(&xref.get_array(dict, "Domain")?, 4).unwrap_or_else(|| vec![0.0, 1.0, 0.0, 1.0]);
    let (x0, x1, y0, y1) = (domain[0], domain[1], domain[2], domain[3]);
    let matrix: Matrix = numbers(&xref.get_array(dict, "Matrix")?, 6)
        .map_or(gstate::IDENTITY, |m| [m[0], m[1], m[2], m[3], m[4], m[5]]);
    let mut bounds = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    axial_bounding_box(&[x0, y0, x1, y1], &matrix, &mut bounds);
    let steps = |extent: f64| extent.ceil().clamp(1.0, MAX_STEP_COUNT) as usize;
    let steps_x = steps(bounds[2] - bounds[0]);
    let steps_y = steps(bounds[3] - bounds[1]);
    let vertices_per_row = steps_x + 1;
    let total = (steps_y + 1) * vertices_per_row;
    let num_comps = space.num_comps();
    let mut coords = vec![0.0f32; total * 2];
    let mut comps = vec![0.0f64; total * num_comps];
    let mut output = vec![0.0f64; function.num_outputs().max(num_comps)];
    let range_x = (x1 - x0) / steps_x as f64;
    let range_y = (y1 - y0) / steps_y as f64;
    let (half_x, half_y) = (range_x / 2.0, range_y / 2.0);
    let mut vertex = 0usize;
    for row in 0..=steps_y {
        let y_domain = y0 + range_y * row as f64;
        let input_y = if row == steps_y { y_domain - half_y } else { y_domain };
        for col in 0..=steps_x {
            let x_domain = x0 + range_x * col as f64;
            let input_x = if col == steps_x { x_domain - half_x } else { x_domain };
            function.call(&[f64::from(input_x as f32), f64::from(input_y as f32)], &mut output)?;
            for k in 0..num_comps {
                comps[vertex * num_comps + k] = f64::from(output[k] as f32);
            }
            // The position is stored single precision and then transformed in place.
            let (px, py) = (f64::from(x_domain as f32), f64::from(y_domain as f32));
            let (tx, ty) = gstate::apply_point(px, py, &matrix);
            coords[vertex * 2] = tx as f32;
            coords[vertex * 2 + 1] = ty as f32;
            vertex += 1;
        }
    }
    let mut colors = vec![0u8; total * 4];
    space.get_rgb_items(&comps, total, &mut colors, 0, 1)?;
    let figures = [Figure::Lattice {
        coords: (0..total as i32).collect(),
        colors: (0..total as i32).collect(),
        vertices_per_row,
    }];
    let (pos_data, col_data, vertex_count) = build_vertex_data(&coords, &colors, &figures);
    Ok(ShadingIr::Mesh(Mesh {
        pos_data,
        col_data,
        vertex_count,
        bounds,
        bbox,
        background,
    }))
}

// ---- mesh shadings -------------------------------------------------------------------------------------------------

/// `MeshFigureType`: the figures a mesh is read into.
enum Figure {
    Triangles { coords: Vec<i32>, colors: Vec<i32> },
    Lattice { coords: Vec<i32>, colors: Vec<i32>, vertices_per_row: usize },
    Patch { coords: [i32; 16], colors: [i32; 4] },
}

/// `buildMeshVertexData`: the triangles of the figures as vertex lists.
fn build_vertex_data(coords: &[f32], colors: &[u8], figures: &[Figure]) -> (Vec<f32>, Vec<u8>, usize) {
    let mut vertex_count = 0usize;
    for figure in figures {
        match figure {
            Figure::Triangles { coords, .. } => vertex_count += coords.len(),
            Figure::Lattice { coords, vertices_per_row, .. } => {
                let rows = (coords.len() / vertices_per_row).saturating_sub(1);
                vertex_count += rows * (vertices_per_row - 1) * 6;
            }
            Figure::Patch { .. } => {}
        }
    }
    let mut pos_data = Vec::with_capacity(vertex_count * 2);
    let mut col_data = Vec::with_capacity(vertex_count * 4);
    let mut add = |position: i32, color: i32| {
        let (p, c) = (position as usize, color as usize);
        pos_data.push(coords.get(p * 2).copied().unwrap_or(0.0));
        pos_data.push(coords.get(p * 2 + 1).copied().unwrap_or(0.0));
        for k in 0..3 {
            col_data.push(colors.get(c * 4 + k).copied().unwrap_or(0));
        }
        col_data.push(0);
    };
    for figure in figures {
        match figure {
            Figure::Triangles { coords: ps, colors: cs } => {
                for (p, c) in ps.iter().zip(cs) {
                    add(*p, *c);
                }
            }
            Figure::Lattice { coords: ps, colors: cs, vertices_per_row } => {
                let vpr = *vertices_per_row;
                let rows = (ps.len() / vpr).saturating_sub(1);
                let cols = vpr - 1;
                for i in 0..rows {
                    let mut q = i * vpr;
                    for _ in 0..cols {
                        for at in [q, q + 1, q + vpr, q + vpr + 1, q + 1, q + vpr] {
                            add(ps[at], cs[at]);
                        }
                        q += 1;
                    }
                }
            }
            Figure::Patch { .. } => {}
        }
    }
    (pos_data, col_data, vertex_count)
}

/// `MeshStreamReader`: the bit reader of the mesh data.
struct MeshReader<'a> {
    data: &'a [u8],
    pos: usize,
    /// The stream is an unfiltered one (pdf.js's `Stream`, which knows where it ends).
    plain: bool,
    buffer: i32,
    buffer_length: i32,
    bits_per_flag: u32,
    bits_per_coordinate: u32,
    bits_per_component: u32,
    decode: Vec<f64>,
    color_function: Option<PdfFunction>,
    space: Arc<ColorSpace>,
    num_comps: usize,
}

impl MeshReader<'_> {
    fn get_byte(&mut self) -> i32 {
        match self.data.get(self.pos) {
            Some(byte) => {
                self.pos += 1;
                i32::from(*byte)
            }
            None => -1,
        }
    }

    fn has_data(&mut self) -> bool {
        if self.plain {
            return self.pos < self.data.len();
        }
        if self.buffer_length > 0 {
            return true;
        }
        let next = self.get_byte();
        if next < 0 {
            return false;
        }
        self.buffer = next;
        self.buffer_length = 8;
        true
    }

    /// `readBits`, with the 32-bit integer arithmetic of JavaScript.
    fn read_bits(&mut self, n: u32) -> f64 {
        if n == 32 {
            if self.buffer_length == 0 {
                let value = (self.get_byte().wrapping_shl(24))
                    | (self.get_byte().wrapping_shl(16))
                    | (self.get_byte().wrapping_shl(8))
                    | self.get_byte();
                return f64::from(value as u32);
            }
            let buffer = (self.buffer.wrapping_shl(24))
                | (self.get_byte().wrapping_shl(16))
                | (self.get_byte().wrapping_shl(8))
                | self.get_byte();
            let next = self.get_byte();
            let held = self.buffer_length as u32;
            self.buffer = next & 1i32.wrapping_shl(held).wrapping_sub(1);
            let value = buffer.wrapping_shl(8 - held) | ((next & 0xff) >> held);
            return f64::from(value as u32);
        }
        if n == 8 && self.buffer_length == 0 {
            return f64::from(self.get_byte());
        }
        let mut buffer = self.buffer;
        let mut length = self.buffer_length;
        while length < n as i32 {
            buffer = buffer.wrapping_shl(8) | self.get_byte();
            length += 8;
        }
        length -= n as i32;
        self.buffer_length = length;
        self.buffer = buffer & 1i32.wrapping_shl(length as u32).wrapping_sub(1);
        f64::from(buffer.wrapping_shr(length as u32))
    }

    fn align(&mut self) {
        self.buffer = 0;
        self.buffer_length = 0;
    }

    fn read_flag(&mut self) -> i64 {
        self.read_bits(self.bits_per_flag) as i64
    }

    fn scale_of(bits: u32) -> f64 {
        if bits < 32 {
            1.0 / ((1u64 << bits) - 1) as f64
        } else {
            2.3283064365386963e-10
        }
    }

    fn read_coordinate(&mut self) -> [f64; 2] {
        let xi = self.read_bits(self.bits_per_coordinate);
        let yi = self.read_bits(self.bits_per_coordinate);
        let scale = Self::scale_of(self.bits_per_coordinate);
        let d = &self.decode;
        [xi * scale * (d[1] - d[0]) + d[0], yi * scale * (d[3] - d[2]) + d[2]]
    }

    fn read_components(&mut self) -> Result<[u8; 3]> {
        let scale = Self::scale_of(self.bits_per_component);
        let mut components = vec![0.0f64; self.num_comps];
        for (i, slot) in components.iter_mut().enumerate() {
            let j = 4 + i * 2;
            let ci = self.read_bits(self.bits_per_component);
            // A `Float32Array`.
            *slot = f64::from((ci * scale * (self.decode[j + 1] - self.decode[j]) + self.decode[j]) as f32);
        }
        match &self.color_function {
            Some(function) => {
                let mut color = vec![0.0f64; function.num_outputs().max(self.space.num_comps())];
                function.call(&components, &mut color)?;
                let narrowed: Vec<f64> = color.iter().map(|v| f64::from(*v as f32)).collect();
                self.space.get_rgb(&narrowed, 0)
            }
            None => self.space.get_rgb(&components, 0),
        }
    }
}

/// The geometry a mesh is read into before its triangles are listed.
struct MeshData {
    coords: Vec<[f64; 2]>,
    colors: Vec<[u8; 3]>,
    figures: Vec<Figure>,
}

fn mesh(document: &Document, resources: &Dict, stream: &Arc<crate::stream::PdfStream>, shading_type: i64) -> Result<ShadingIr> {
    let xref = document.xref();
    let dict = &stream.dict;
    let bbox = normal_rect(&xref.get_array(dict, "BBox")?);
    let space = colour_space(xref, resources, dict)?;
    let background = read_background(xref, dict, &space)?;
    let color_function = if dict.get_raw("Function").is_some_and(truthy) {
        Some(shading_function(xref, dict, 1, space.num_comps())?)
    } else {
        None
    };
    let bits = |key: &str| -> Result<u32> {
        let value = xref.get(dict, key)?.as_num().unwrap_or(f64::NAN);
        if value.is_finite() && (1.0..=32.0).contains(&value) {
            Ok(value as u32)
        } else {
            Err(PdfError::format(format!("Invalid {key}")))
        }
    };
    let bits_per_coordinate = bits("BitsPerCoordinate")?;
    let bits_per_component = bits("BitsPerComponent")?;
    let bits_per_flag = if shading_type == 5 { 0 } else { bits("BitsPerFlag")? };
    let num_comps = if color_function.is_some() { 1 } else { space.num_comps() };
    let decode = number_list(&xref.get_array(dict, "Decode")?);
    if decode.len() < 4 + num_comps * 2 {
        return Err(PdfError::format("Invalid Decode"));
    }
    let data = stream.decode(&**xref.filters(), document.guard())?;
    let mut reader = MeshReader {
        data: &data,
        pos: 0,
        plain: stream.chain().is_empty(),
        buffer: 0,
        buffer_length: 0,
        bits_per_flag,
        bits_per_coordinate,
        bits_per_component,
        decode,
        color_function,
        space,
        num_comps,
    };
    let mut mesh = MeshData {
        coords: Vec::new(),
        colors: Vec::new(),
        figures: Vec::new(),
    };
    let mut patch_mesh = false;
    match shading_type {
        4 => decode_type4(&mut reader, &mut mesh)?,
        5 => {
            let vertices_per_row = xref.get(dict, "VerticesPerRow")?.as_num().map_or(0, |v| v as i64);
            if vertices_per_row < 2 {
                return Err(PdfError::format("Invalid VerticesPerRow"));
            }
            decode_type5(&mut reader, &mut mesh, vertices_per_row as usize)?;
        }
        6 => {
            decode_patches(&mut reader, &mut mesh, false)?;
            patch_mesh = true;
        }
        _ => {
            decode_patches(&mut reader, &mut mesh, true)?;
            patch_mesh = true;
        }
    }
    let mut bounds = mesh_bounds(&mesh.coords)?;
    if patch_mesh {
        for index in 0..mesh.figures.len() {
            build_figure_from_patch(&mut mesh, index, &bounds);
        }
        bounds = mesh_bounds(&mesh.coords)?;
    }
    let coords: Vec<f32> = mesh.coords.iter().flat_map(|c| [c[0] as f32, c[1] as f32]).collect();
    let mut colors = Vec::with_capacity(mesh.colors.len() * 4);
    for color in &mesh.colors {
        colors.extend_from_slice(&[color[0], color[1], color[2], 0]);
    }
    let (pos_data, col_data, vertex_count) = build_vertex_data(&coords, &colors, &mesh.figures);
    Ok(ShadingIr::Mesh(Mesh {
        pos_data,
        col_data,
        vertex_count,
        bounds,
        bbox,
        background,
    }))
}

/// `meshUpdateBounds`.
fn mesh_bounds(coords: &[[f64; 2]]) -> Result<[f64; 4]> {
    let Some(first) = coords.first() else {
        return Err(PdfError::format("Cannot read properties of undefined (reading '0')"));
    };
    let mut bounds = [first[0], first[1], first[0], first[1]];
    for c in &coords[1..] {
        bounds[0] = bounds[0].min(c[0]);
        bounds[1] = bounds[1].min(c[1]);
        bounds[2] = bounds[2].max(c[0]);
        bounds[3] = bounds[3].max(c[1]);
    }
    Ok(bounds)
}

/// `_decodeType4Shading`: free-form triangles, each vertex with a flag.
fn decode_type4(reader: &mut MeshReader<'_>, mesh: &mut MeshData) -> Result<()> {
    let mut ps: Vec<i32> = Vec::new();
    let mut vertices_left = 0;
    let at = |ps: &Vec<i32>, back: usize| ps.len().checked_sub(back).map_or(0, |i| ps[i]);
    while reader.has_data() {
        let f = reader.read_flag();
        let coord = reader.read_coordinate();
        let color = reader.read_components()?;
        if vertices_left == 0 {
            match f {
                0 => vertices_left = 3,
                1 => {
                    let (a, b) = (at(&ps, 2), at(&ps, 1));
                    ps.push(a);
                    ps.push(b);
                    vertices_left = 1;
                }
                2 => {
                    let (a, b) = (at(&ps, 3), at(&ps, 1));
                    ps.push(a);
                    ps.push(b);
                    vertices_left = 1;
                }
                _ => return Err(PdfError::format("Unknown type4 flag")),
            }
        }
        ps.push(mesh.coords.len() as i32);
        mesh.coords.push(coord);
        mesh.colors.push(color);
        vertices_left -= 1;
        reader.align();
    }
    mesh.figures.push(Figure::Triangles {
        colors: ps.clone(),
        coords: ps,
    });
    Ok(())
}

/// `_decodeType5Shading`: a lattice of vertices.
fn decode_type5(reader: &mut MeshReader<'_>, mesh: &mut MeshData, vertices_per_row: usize) -> Result<()> {
    let mut ps: Vec<i32> = Vec::new();
    while reader.has_data() {
        let coord = reader.read_coordinate();
        let color = reader.read_components()?;
        ps.push(mesh.coords.len() as i32);
        mesh.coords.push(coord);
        mesh.colors.push(color);
    }
    mesh.figures.push(Figure::Lattice {
        colors: ps.clone(),
        coords: ps,
        vertices_per_row,
    });
    Ok(())
}

/// `_decodeType6Shading` (Coons, `tensor` false) and `_decodeType7Shading` (tensor): the patches, each by its flag
/// either complete or sharing an edge with the one before. The index tables persist from one patch to the next.
fn decode_patches(reader: &mut MeshReader<'_>, mesh: &mut MeshData, tensor: bool) -> Result<()> {
    let mut ps = [0i32; 16];
    let mut cs = [0i32; 4];
    while reader.has_data() {
        let f = reader.read_flag();
        if !(0..=3).contains(&f) {
            return Err(PdfError::format(format!("Unknown type{} flag", if tensor { 7 } else { 6 })));
        }
        let pi = mesh.coords.len() as i32;
        let new_points = match (tensor, f != 0) {
            (false, false) => 12,
            (false, true) => 8,
            (true, false) => 16,
            (true, true) => 12,
        };
        for _ in 0..new_points {
            let coord = reader.read_coordinate();
            mesh.coords.push(coord);
        }
        let ci = mesh.colors.len() as i32;
        for _ in 0..(if f != 0 { 2 } else { 4 }) {
            let color = reader.read_components()?;
            mesh.colors.push(color);
        }
        match f {
            0 => {
                ps[12] = pi + 3;
                ps[13] = pi + 4;
                ps[14] = pi + 5;
                ps[15] = pi + 6;
                ps[8] = pi + 2;
                ps[4] = pi + 1;
                ps[0] = pi;
                ps[1] = pi + 11;
                ps[2] = pi + 10;
                ps[3] = pi + 9;
                if tensor {
                    ps[9] = pi + 13;
                    ps[10] = pi + 14;
                    ps[11] = pi + 7;
                    ps[5] = pi + 12;
                    ps[6] = pi + 15;
                    ps[7] = pi + 8;
                } else {
                    ps[11] = pi + 7;
                    ps[7] = pi + 8;
                }
                cs[2] = ci + 1;
                cs[3] = ci + 2;
                cs[0] = ci;
                cs[1] = ci + 3;
            }
            1 => {
                let (t1, t2, t3, t4) = (ps[12], ps[13], ps[14], ps[15]);
                ps[12] = t4;
                ps[13] = pi;
                ps[14] = pi + 1;
                ps[15] = pi + 2;
                ps[8] = t3;
                ps[11] = pi + 3;
                ps[4] = t2;
                ps[7] = pi + 4;
                ps[0] = t1;
                ps[1] = pi + 7;
                ps[2] = pi + 6;
                ps[3] = pi + 5;
                if tensor {
                    ps[9] = pi + 9;
                    ps[10] = pi + 10;
                    ps[5] = pi + 8;
                    ps[6] = pi + 11;
                }
                let (c1, c2) = (cs[2], cs[3]);
                cs[2] = c2;
                cs[3] = ci;
                cs[0] = c1;
                cs[1] = ci + 1;
            }
            2 => {
                let (t1, t2) = (ps[15], ps[11]);
                ps[12] = ps[3];
                ps[13] = pi;
                ps[14] = pi + 1;
                ps[15] = pi + 2;
                ps[8] = ps[7];
                ps[11] = pi + 3;
                ps[4] = t2;
                ps[7] = pi + 4;
                ps[0] = t1;
                ps[1] = pi + 7;
                ps[2] = pi + 6;
                ps[3] = pi + 5;
                if tensor {
                    ps[9] = pi + 9;
                    ps[10] = pi + 10;
                    ps[5] = pi + 8;
                    ps[6] = pi + 11;
                }
                let t = cs[3];
                cs[2] = cs[1];
                cs[3] = ci;
                cs[0] = t;
                cs[1] = ci + 1;
            }
            _ => {
                ps[12] = ps[0];
                ps[13] = pi;
                ps[14] = pi + 1;
                ps[15] = pi + 2;
                ps[8] = ps[1];
                ps[11] = pi + 3;
                ps[4] = ps[2];
                ps[7] = pi + 4;
                ps[0] = ps[3];
                ps[1] = pi + 7;
                ps[2] = pi + 6;
                ps[3] = pi + 5;
                if tensor {
                    ps[9] = pi + 9;
                    ps[10] = pi + 10;
                    ps[5] = pi + 8;
                    ps[6] = pi + 11;
                }
                cs[2] = cs[0];
                cs[3] = ci;
                cs[0] = cs[1];
                cs[1] = ci + 1;
            }
        }
        if !tensor {
            // The four inner control points of a Coons patch follow from its boundary.
            for (slot, terms) in [
                (5usize, [0usize, 15, 4, 1, 12, 3, 13, 7]),
                (6, [3, 12, 2, 7, 0, 15, 4, 14]),
                (9, [12, 3, 8, 13, 0, 15, 11, 1]),
                (10, [15, 0, 11, 14, 12, 3, 2, 8]),
            ] {
                let point = coons_inner(&mesh.coords, &ps, terms);
                ps[slot] = mesh.coords.len() as i32;
                mesh.coords.push(point);
            }
        }
        mesh.figures.push(Figure::Patch { coords: ps, colors: cs });
    }
    Ok(())
}

/// One inner control point of a Coons patch: `(-4 * P[t0] - P[t1] + 6 * (P[t2] + P[t3]) - 2 * (P[t4] + P[t5]) + 3 *
/// (P[t6] + P[t7])) / 9` on each axis, `P[i]` being the point `ps[i]` names.
fn coons_inner(coords: &[[f64; 2]], ps: &[i32; 16], t: [usize; 8]) -> [f64; 2] {
    let p = |at: usize, axis: usize| coords[ps[t[at]] as usize][axis];
    let axis = |a: usize| {
        (-4.0 * p(0, a) - p(1, a) + 6.0 * (p(2, a) + p(3, a)) - 2.0 * (p(4, a) + p(5, a))
            + 3.0 * (p(6, a) + p(7, a)))
            / 9.0
    };
    [axis(0), axis(1)]
}

/// `getB`: the Bernstein weights of the cubic at `count + 1` positions.
fn bernstein(count: usize) -> Vec<[f32; 4]> {
    (0..=count)
        .map(|i| {
            let t = i as f64 / count as f64;
            let t_ = 1.0 - t;
            [
                t_.powi(3) as f32,
                (3.0 * t * t_.powi(2)) as f32,
                (3.0 * t.powi(2) * t_) as f32,
                t.powi(3) as f32,
            ]
        })
        .collect()
}

/// `_buildFigureFromPatch`: a patch is cut into a lattice of triangles, its colours blended across it.
fn build_figure_from_patch(mesh: &mut MeshData, index: usize, bounds: &[f64; 4]) {
    let Figure::Patch { coords: pi, colors: ci } = mesh.figures[index] else {
        return;
    };
    let corner = |at: usize, axis: usize| mesh.coords[pi[at] as usize][axis];
    let corners = [0usize, 3, 12, 15];
    let figure_min_x = corners.iter().map(|&c| corner(c, 0)).fold(f64::INFINITY, f64::min);
    let figure_min_y = corners.iter().map(|&c| corner(c, 1)).fold(f64::INFINITY, f64::min);
    let figure_max_x = corners.iter().map(|&c| corner(c, 0)).fold(f64::NEG_INFINITY, f64::max);
    let figure_max_y = corners.iter().map(|&c| corner(c, 1)).fold(f64::NEG_INFINITY, f64::max);
    let chunks = |extent: f64, whole: f64| -> usize {
        let split = (extent * TRIANGLE_DENSITY / whole).ceil();
        if split.is_nan() {
            return MIN_SPLIT_PATCH_CHUNKS_AMOUNT as usize;
        }
        split.clamp(MIN_SPLIT_PATCH_CHUNKS_AMOUNT, MAX_SPLIT_PATCH_CHUNKS_AMOUNT) as usize
    };
    let split_x = chunks(figure_max_x - figure_min_x, bounds[2] - bounds[0]);
    let split_y = chunks(figure_max_y - figure_min_y, bounds[3] - bounds[1]);
    let vertices_per_row = split_x + 1;
    let mut figure_coords = vec![0i32; (split_y + 1) * vertices_per_row];
    let mut figure_colors = vec![0i32; (split_y + 1) * vertices_per_row];
    let (c0, c1, c2, c3) = (
        mesh.colors[ci[0] as usize],
        mesh.colors[ci[1] as usize],
        mesh.colors[ci[2] as usize],
        mesh.colors[ci[3] as usize],
    );
    let b_row = bernstein(split_y);
    let b_col = bernstein(split_x);
    let mut k = 0usize;
    for row in 0..=split_y {
        let blend = |a: u8, b: u8, at: usize, whole: usize| -> u8 {
            ((f64::from(a) * (whole - at) as f64 + f64::from(b) * at as f64) / whole as f64) as i64 as u8
        };
        let cl = [
            blend(c0[0], c2[0], row, split_y),
            blend(c0[1], c2[1], row, split_y),
            blend(c0[2], c2[2], row, split_y),
        ];
        let cr = [
            blend(c1[0], c3[0], row, split_y),
            blend(c1[1], c3[1], row, split_y),
            blend(c1[2], c3[2], row, split_y),
        ];
        for col in 0..=split_x {
            if (row == 0 || row == split_y) && (col == 0 || col == split_x) {
                k += 1;
                continue;
            }
            let (mut x, mut y) = (0.0f64, 0.0f64);
            let mut q = 0;
            for i in 0..4 {
                for j in 0..4 {
                    let m = f64::from(b_row[row][i] * b_col[col][j]);
                    let point = mesh.coords[pi[q] as usize];
                    x += point[0] * m;
                    y += point[1] * m;
                    q += 1;
                }
            }
            figure_coords[k] = mesh.coords.len() as i32;
            mesh.coords.push([x, y]);
            figure_colors[k] = mesh.colors.len() as i32;
            mesh.colors.push([
                blend(cl[0], cr[0], col, split_x),
                blend(cl[1], cr[1], col, split_x),
                blend(cl[2], cr[2], col, split_x),
            ]);
            k += 1;
        }
    }
    figure_coords[0] = pi[0];
    figure_colors[0] = ci[0];
    figure_coords[split_x] = pi[3];
    figure_colors[split_x] = ci[1];
    figure_coords[vertices_per_row * split_y] = pi[12];
    figure_colors[vertices_per_row * split_y] = ci[2];
    figure_coords[vertices_per_row * split_y + split_x] = pi[15];
    figure_colors[vertices_per_row * split_y + split_x] = ci[3];
    mesh.figures[index] = Figure::Lattice {
        coords: figure_coords,
        colors: figure_colors,
        vertices_per_row,
    };
}

// ---- painting a mesh -------------------------------------------------------------------------------------------------

/// `MeshShadingPattern._createMeshCanvas`'s result: the canvas holding the rasterised mesh and where and how it is
/// placed.
pub(super) struct MeshCanvas {
    pub(super) pattern: PatternStyle,
    pub(super) offset_x: f64,
    pub(super) offset_y: f64,
    pub(super) scale_x: f64,
    pub(super) scale_y: f64,
}

/// `JavaScript`'s `x | 0` on a double followed by the store into a `Uint8ClampedArray`.
fn clamped(value: f64) -> u8 {
    (value as i32).clamp(0, 255) as u8
}

/// Writes `value` at `index` of a typed array: an index outside it is ignored.
fn put(bytes: &mut [u8], index: i64, value: u8) {
    if index >= 0 && (index as usize) < bytes.len() {
        bytes[index as usize] = value;
    }
}

/// The scale and offset a mesh is rasterised at (`context` of `_createMeshCanvas`).
struct TriangleContext<'a> {
    coords: &'a [f32],
    colors: &'a [u8],
    offset_x: f64,
    offset_y: f64,
    scale_x: f64,
    scale_y: f64,
}

/// `drawTriangle`: one Gouraud triangle scan-converted into `bytes` (RGBA rows of `width` pixels).
fn draw_triangle(bytes: &mut [u8], width: usize, context: &TriangleContext<'_>, vertices: [usize; 3]) {
    let row_size = (width * 4) as i64;
    let y_of = |p: usize| f64::from(context.coords[p * 2 + 1]);
    let (mut p1, mut p2, mut p3) = (vertices[0], vertices[1], vertices[2]);
    if y_of(p1) > y_of(p2) {
        std::mem::swap(&mut p1, &mut p2);
    }
    if y_of(p2) > y_of(p3) {
        std::mem::swap(&mut p2, &mut p3);
    }
    if y_of(p1) > y_of(p2) {
        std::mem::swap(&mut p1, &mut p2);
    }
    let point = |p: usize| {
        (
            (f64::from(context.coords[p * 2]) + context.offset_x) * context.scale_x,
            (f64::from(context.coords[p * 2 + 1]) + context.offset_y) * context.scale_y,
        )
    };
    let (x1, y1) = point(p1);
    let (x2, y2) = point(p2);
    let (x3, y3) = point(p3);
    if y1 >= y3 {
        return;
    }
    let color = |p: usize| {
        (
            f64::from(context.colors[p * 4]),
            f64::from(context.colors[p * 4 + 1]),
            f64::from(context.colors[p * 4 + 2]),
        )
    };
    let (c1r, c1g, c1b) = color(p1);
    let (c2r, c2g, c2b) = color(p2);
    let (c3r, c3g, c3b) = color(p3);
    let min_y = js_round(y1) as i64;
    let max_y = js_round(y3) as i64;
    for y in min_y..=max_y {
        let yf = y as f64;
        let (xa, car, cag, cab);
        if yf < y2 {
            let k = if yf < y1 { 0.0 } else { (y1 - yf) / (y1 - y2) };
            xa = x1 - (x1 - x2) * k;
            car = c1r - (c1r - c2r) * k;
            cag = c1g - (c1g - c2g) * k;
            cab = c1b - (c1b - c2b) * k;
        } else {
            let k = if yf > y3 {
                1.0
            } else if y2 == y3 {
                0.0
            } else {
                (y2 - yf) / (y2 - y3)
            };
            xa = x2 - (x2 - x3) * k;
            car = c2r - (c2r - c3r) * k;
            cag = c2g - (c2g - c3g) * k;
            cab = c2b - (c2b - c3b) * k;
        }
        let k = if yf < y1 {
            0.0
        } else if yf > y3 {
            1.0
        } else {
            (y1 - yf) / (y1 - y3)
        };
        let xb = x1 - (x1 - x3) * k;
        let cbr = c1r - (c1r - c3r) * k;
        let cbg = c1g - (c1g - c3g) * k;
        let cbb = c1b - (c1b - c3b) * k;
        let x1_ = js_round(xa.min(xb)) as i64;
        let x2_ = js_round(xa.max(xb)) as i64;
        let mut j = row_size * y + x1_ * 4;
        for x in x1_..=x2_ {
            let mut k = (xa - x as f64) / (xa - xb);
            if k < 0.0 {
                k = 0.0;
            } else if k > 1.0 {
                k = 1.0;
            }
            put(bytes, j, clamped(car - (car - cbr) * k));
            put(bytes, j + 1, clamped(cag - (cag - cbg) * k));
            put(bytes, j + 2, clamped(cab - (cab - cbb) * k));
            put(bytes, j + 3, 255);
            j += 4;
        }
    }
}

impl Mesh {
    /// `_createMeshCanvas`: the triangles drawn into an image of the size the page will show them at (`combined_scale`
    /// is the scale of the matrices between the mesh and the device), the background colour behind them when there is
    /// one, the transfer maps applied, and a border of two transparent pixels around it.
    pub(super) fn create_canvas(
        &self,
        combined_scale: (f32, f32),
        background: Option<[u8; 3]>,
        transfer: Option<&TransferMaps>,
    ) -> Result<MeshCanvas> {
        let offset_x = self.bounds[0].floor();
        let offset_y = self.bounds[1].floor();
        let bounds_width = self.bounds[2].ceil() - offset_x;
        let bounds_height = self.bounds[3].ceil() - offset_y;
        let size = |extent: f64, scale: f32| {
            let size = (extent * f64::from(scale) * EXPECTED_SCALE).abs().ceil().min(MAX_MESH_PATTERN_SIZE);
            if size == 0.0 || size.is_nan() { 1.0 } else { size }
        };
        let width = size(bounds_width, combined_scale.0);
        let height = size(bounds_height, combined_scale.1);
        let scale_x = if bounds_width != 0.0 { bounds_width / width } else { 1.0 };
        let scale_y = if bounds_height != 0.0 { bounds_height / height } else { 1.0 };
        let context = TriangleContext {
            coords: &self.pos_data,
            colors: &self.col_data,
            offset_x: -offset_x,
            offset_y: -offset_y,
            scale_x: 1.0 / scale_x,
            scale_y: 1.0 / scale_y,
        };
        let (width_px, height_px) = (width as u32, height as u32);
        let mut canvas = Canvas::new(width_px + BORDER_SIZE * 2, height_px + BORDER_SIZE * 2).map_err(raster)?;
        let mut data = ImageData::new(width_px, height_px).map_err(raster)?;
        if let Some(color) = background {
            for pixel in data.data_mut().chunks_exact_mut(4) {
                pixel.copy_from_slice(&[color[0], color[1], color[2], 255]);
            }
        }
        for first in (0..self.vertex_count).step_by(3) {
            if first + 2 >= self.vertex_count {
                break;
            }
            draw_triangle(data.data_mut(), width_px as usize, &context, [first, first + 1, first + 2]);
        }
        canvas.put_image_data(&data, BORDER_SIZE as i32, BORDER_SIZE as i32, None);
        if let Some(maps) = transfer {
            apply_transfer(&mut canvas, maps)?;
        }
        Ok(MeshCanvas {
            pattern: PatternStyle::new(&Bitmap::from_canvas(&canvas), Repetition::NoRepeat),
            offset_x: offset_x - f64::from(BORDER_SIZE) * scale_x,
            offset_y: offset_y - f64::from(BORDER_SIZE) * scale_y,
            scale_x,
            scale_y,
        })
    }
}

/// `TransferMapsFallback.applyToCanvas`.
pub(super) fn apply_transfer(canvas: &mut Canvas, maps: &TransferMaps) -> Result<()> {
    let mut data = canvas
        .get_image_data(0, 0, canvas.width(), canvas.height())
        .map_err(raster)?;
    maps.apply_to_rgba(data.data_mut());
    canvas.put_image_data(&data, 0, 0, None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn axial(stops: Vec<(f64, String)>) -> RadialAxial {
        RadialAxial {
            radial: false,
            bbox: None,
            color_stops: stops,
            p0: [0.0, 0.0],
            p1: [10.0, 0.0],
            r0: 0.0,
            r1: 0.0,
        }
    }

    #[test]
    fn a_flat_run_of_samples_is_one_stop_pair() {
        let rgb = vec![10u8; NUMBER_OF_SAMPLES * 3];
        let stops = color_stops(&rgb);
        assert_eq!(stops.len(), 2);
        assert_eq!(stops[0], (0.0, "#0a0a0a".to_owned()));
        assert_eq!(stops[1], (1.0, "#0a0a0a".to_owned()));
    }

    #[test]
    fn a_straight_ramp_needs_no_stop_in_between() {
        let mut rgb = Vec::new();
        for i in 0..NUMBER_OF_SAMPLES {
            let v = (i * 255 / (NUMBER_OF_SAMPLES - 1)) as u8;
            rgb.extend_from_slice(&[v, v, v]);
        }
        let stops = color_stops(&rgb);
        assert_eq!(stops.first().map(|s| s.0), Some(0.0));
        assert_eq!(stops.last().map(|s| s.0), Some(1.0));
        assert!(stops.len() < 12, "{} stops", stops.len());
    }

    #[test]
    fn a_kink_in_the_ramp_makes_a_stop() {
        let mut rgb = Vec::new();
        for i in 0..NUMBER_OF_SAMPLES {
            let v = (if i < 420 { i / 2 } else { 210 - (i - 420) / 2 }) as u8;
            rgb.extend_from_slice(&[v, v, v]);
        }
        let stops = color_stops(&rgb);
        assert!(stops.iter().any(|s| (s.0 - 0.5).abs() < 0.02), "{stops:?}");
    }

    #[test]
    fn origin_based_and_conic_radial_shadings_are_told_apart() {
        let mut radial = axial(Vec::new());
        radial.radial = true;
        radial.p1 = [0.0, 0.0];
        radial.r0 = 2.0;
        radial.r1 = 5.0;
        assert!(radial.is_origin_based());
        assert!(!radial.are_conic(), "nested circles are not conic");
        radial.p1 = [4.0, 0.0];
        assert!(!radial.is_origin_based());
        assert!(radial.are_conic(), "overlapping circles are conic");
        radial.p1 = [40.0, 0.0];
        assert!(!radial.are_conic(), "apart circles are not conic");
        assert!(!axial(Vec::new()).are_conic());
    }

    #[test]
    fn a_reversed_gradient_has_the_stops_mirrored() {
        let mut radial = axial(vec![(0.0, "#ff0000".to_owned()), (1.0, "#0000ff".to_owned())]);
        radial.radial = true;
        radial.r1 = 4.0;
        let mut forward = Gradient::radial(0.0, 0.0, 0.0, 10.0, 0.0, 4.0);
        forward.add_color_stop(0.0, "#ff0000").expect("stop");
        forward.add_color_stop(1.0, "#0000ff").expect("stop");
        assert_eq!(radial.create_gradient(None), forward);
        let mut reversed = Gradient::radial(10.0, 0.0, 4.0, 0.0, 0.0, 0.0);
        reversed.add_color_stop(0.0, "#0000ff").expect("stop");
        reversed.add_color_stop(1.0, "#ff0000").expect("stop");
        assert_eq!(radial.create_reversed_gradient(None), reversed);
    }

    fn reader(data: &[u8], plain: bool, bits: u32) -> MeshReader<'_> {
        MeshReader {
            data,
            pos: 0,
            plain,
            buffer: 0,
            buffer_length: 0,
            bits_per_flag: bits,
            bits_per_coordinate: bits,
            bits_per_component: bits,
            decode: vec![0.0, 1.0, 0.0, 1.0, 0.0, 1.0],
            color_function: None,
            space: ColorSpace::gray(),
            num_comps: 1,
        }
    }

    #[test]
    fn bits_are_read_across_byte_boundaries() {
        let data = [0b1010_1100, 0b0101_0011];
        let mut r = reader(&data, false, 4);
        assert_eq!(r.read_bits(4), 10.0);
        assert_eq!(r.read_bits(6), 49.0);
        assert_eq!(r.read_bits(6), 19.0);
        let mut whole = reader(&[1, 2, 3, 4], false, 8);
        assert_eq!(whole.read_bits(32), 16_909_060.0);
    }

    #[test]
    fn plain_streams_report_data_by_position_and_others_by_the_next_byte() {
        let mut plain = reader(&[1], true, 8);
        assert!(plain.has_data());
        plain.read_bits(8);
        assert!(!plain.has_data());
        let mut filtered = reader(&[7], false, 8);
        assert!(filtered.has_data());
        assert_eq!(filtered.read_bits(4), 0.0);
        assert!(filtered.has_data(), "four bits of the byte are still held");
        filtered.read_bits(4);
        assert!(!filtered.has_data());
    }

    #[test]
    fn a_triangle_is_filled_with_blended_colours() {
        // Three vertices: red at the top left, green at the top right, blue at the bottom.
        let coords = [0.0f32, 0.0, 9.0, 0.0, 0.0, 9.0];
        let colors = [255u8, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255, 0];
        let context = TriangleContext {
            coords: &coords,
            colors: &colors,
            offset_x: 0.0,
            offset_y: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
        };
        let mut bytes = vec![0u8; 10 * 10 * 4];
        draw_triangle(&mut bytes, 10, &context, [0, 1, 2]);
        let at = |x: usize, y: usize| &bytes[(y * 10 + x) * 4..(y * 10 + x) * 4 + 4];
        assert_eq!(at(0, 0)[3], 255, "inside");
        assert!(at(0, 0)[0] > 200 && at(0, 0)[1] < 40, "near the red vertex");
        assert!(at(0, 8)[2] > 150, "near the blue vertex");
        assert_eq!(at(9, 9)[3], 0, "outside");
    }

    #[test]
    fn the_mesh_canvas_has_a_border_and_a_scale() {
        let mesh = Mesh {
            pos_data: vec![0.0, 0.0, 10.0, 0.0, 0.0, 10.0],
            col_data: vec![255, 0, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0],
            vertex_count: 3,
            bounds: [0.0, 0.0, 10.0, 10.0],
            bbox: None,
            background: None,
        };
        let canvas = mesh.create_canvas((2.0, 2.0), None, None).expect("canvas");
        // 10 * 2 * 1.1 rounds up to 23 pixels, so one pixel stands for 10 / 23 of a unit; the border is two pixels.
        let width = (10.0f64 * 2.0 * 1.1).ceil();
        assert_eq!(width, 23.0);
        assert!((canvas.scale_x - 10.0 / width).abs() < 1e-12);
        assert!((canvas.offset_x + 2.0 * canvas.scale_x).abs() < 1e-12);
    }
}
