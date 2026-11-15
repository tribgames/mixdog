//! PDF functions as pdf.js 6.4 builds them (`function.js`): sampled (type 0) with its multilinear interpolation (a
//! simplex interpolation above eight inputs), exponential interpolation (type 2), stitching (type 3) and the
//! PostScript calculator (type 4, [`crate::function_ps`]). A function is built once from the document's objects with
//! [`create`] and called with [`PdfFunction::call`]; like pdf.js's, a call reads `num_inputs` values from the start of
//! `src` and writes `num_outputs` values to the start of `dest`.

use std::cell::RefCell;

use mixdog_js::math as js;

use crate::error::{PdfError, Result};
use crate::function_ps::PostScriptFunction;
use crate::object::{Dict, Obj};
use crate::stream::PdfStream;
use crate::xref::Xref;

/// `PDFFunction.MAX_MULTILINEAR_INPUTS`.
const MAX_MULTILINEAR_INPUTS: usize = 8;
/// Nesting of stitching functions one function may have (pdf.js recurses until the stack runs out).
const MAX_DEPTH: usize = 64;
/// The most samples one sampled function may hold (pdf.js allocates what the dictionary asks for).
const MAX_SAMPLES: f64 = 67_108_864.0;

fn format_error(message: &str) -> PdfError {
    PdfError::Format(message.to_owned())
}

/// `MathClamp`: `Math.min(Math.max(v, min), max)`.
pub(crate) fn clamp(v: f64, min: f64, max: f64) -> f64 {
    js::min(js::max(v, min), max)
}

/// `interpolate` of function.js.
fn interpolate(x: f64, xmin: f64, xmax: f64, ymin: f64, ymax: f64) -> f64 {
    if xmin == xmax {
        ymin
    } else {
        ymin + (x - xmin) * ((ymax - ymin) / (xmax - xmin))
    }
}

/// `ToUint32` of a number stored into a `Uint32Array`.
fn to_u32(x: f64) -> u32 {
    if !x.is_finite() {
        return 0;
    }
    let mut m = x.trunc() % 4_294_967_296.0;
    if m < 0.0 {
        m += 4_294_967_296.0;
    }
    m as u64 as u32
}

/// An element read as JavaScript's unary plus would read it (`toNumberArray`).
fn plus(obj: &Obj) -> f64 {
    match obj {
        Obj::Num(n) => *n,
        Obj::Null => 0.0,
        Obj::Bool(true) => 1.0,
        Obj::Bool(false) => 0.0,
        Obj::Str(bytes) => {
            let text = String::from_utf8_lossy(bytes);
            let trimmed = text.trim();
            if trimmed.is_empty() {
                0.0
            } else {
                trimmed.parse().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}

/// `toNumberArray(dict.getArray(key))`: `None` when the entry is not an array.
fn number_array(xref: &Xref, dict: &Dict, key: &str) -> Result<Option<Vec<f64>>> {
    Ok(match xref.get_array(dict, key)? {
        Obj::Array(items) => Some(items.iter().map(plus).collect()),
        _ => None,
    })
}

fn at(list: &[f64], index: usize) -> f64 {
    list.get(index).copied().unwrap_or(f64::NAN)
}

/// The scratch of one sampled call, kept per thread so a call allocates nothing.
#[derive(Default)]
struct SampleScratch {
    steps: Vec<f64>,
    weights0: Vec<f64>,
    weights1: Vec<f64>,
    sorted: Vec<usize>,
    vertices: Vec<u32>,
    vertex_weights: Vec<f64>,
}

thread_local! {
    static SAMPLE_SCRATCH: RefCell<Option<SampleScratch>> = const { RefCell::new(None) };
}

struct Sampled {
    domain: Vec<f64>,
    range: Vec<f64>,
    encode: Vec<f64>,
    decode: Vec<f64>,
    size: Vec<f64>,
    samples: Vec<f64>,
    input_size: usize,
    output_size: usize,
}

impl Sampled {
    fn call(&self, src: &[f64], dest: &mut [f64]) {
        let mut s = SAMPLE_SCRATCH
            .with(|slot| slot.borrow_mut().take())
            .unwrap_or_default();
        let input_size = self.input_size;
        let output_size = self.output_size;
        let use_simplex = input_size > MAX_MULTILINEAR_INPUTS;
        let max_vertices = if use_simplex {
            input_size + 1
        } else {
            1usize << input_size
        };
        s.steps.clear();
        s.steps.resize(input_size, 0.0);
        s.weights0.clear();
        s.weights0.resize(input_size, 0.0);
        s.weights1.clear();
        s.weights1.resize(input_size, 0.0);
        s.sorted.clear();
        s.sorted.resize(input_size, 0);
        s.vertices.clear();
        s.vertices.resize(max_vertices, 0);
        s.vertex_weights.clear();
        s.vertex_weights.resize(max_vertices, 0.0);

        let mut base = 0.0f64;
        let mut k = output_size as f64;
        let mut num_active = 0usize;
        for i in 0..input_size {
            let domain_lo = at(&self.domain, 2 * i);
            let domain_hi = at(&self.domain, 2 * i + 1);
            let xi = clamp(at(src, i), domain_lo, domain_hi);
            let mut e = interpolate(
                xi,
                domain_lo,
                domain_hi,
                at(&self.encode, 2 * i),
                at(&self.encode, 2 * i + 1),
            );
            let size_i = at(&self.size, i);
            e = clamp(e, 0.0, size_i - 1.0);
            let e0 = e.floor();
            base += e0 * k;
            if e != e0 {
                s.steps[num_active] = k;
                s.weights0[num_active] = e0 + 1.0 - e;
                s.weights1[num_active] = e - e0;
                num_active += 1;
            }
            k *= size_i;
        }
        s.vertices[0] = to_u32(base);
        s.vertex_weights[0] = 1.0;
        let mut num_vertices = 1usize;
        if !use_simplex {
            for i in 0..num_active {
                let step = s.steps[i];
                let w0 = s.weights0[i];
                let w1 = s.weights1[i];
                for j in 0..num_vertices {
                    s.vertices[num_vertices + j] = to_u32(f64::from(s.vertices[j]) + step);
                    s.vertex_weights[num_vertices + j] = s.vertex_weights[j] * w1;
                    s.vertex_weights[j] *= w0;
                }
                num_vertices <<= 1;
            }
        } else if num_active > 0 {
            for i in 0..num_active {
                let w1 = s.weights1[i];
                let mut j = i;
                while j > 0 && s.weights1[s.sorted[j - 1]] < w1 {
                    s.sorted[j] = s.sorted[j - 1];
                    j -= 1;
                }
                s.sorted[j] = i;
            }
            s.vertex_weights[0] = s.weights0[s.sorted[0]];
            for i in 0..num_active {
                let a = s.sorted[i];
                s.vertices[i + 1] = to_u32(f64::from(s.vertices[i]) + s.steps[a]);
                s.vertex_weights[i + 1] = if i + 1 < num_active {
                    s.weights1[a] - s.weights1[s.sorted[i + 1]]
                } else {
                    s.weights1[a]
                };
            }
            num_vertices = num_active + 1;
        }
        for j in 0..output_size {
            let mut rj = 0.0f64;
            for i in 0..num_vertices {
                let sample = self
                    .samples
                    .get(s.vertices[i] as usize + j)
                    .copied()
                    .unwrap_or(f64::NAN);
                rj += sample * s.vertex_weights[i];
            }
            rj = interpolate(
                rj,
                0.0,
                1.0,
                at(&self.decode, 2 * j),
                at(&self.decode, 2 * j + 1),
            );
            if let Some(slot) = dest.get_mut(j) {
                *slot = clamp(rj, at(&self.range, 2 * j), at(&self.range, 2 * j + 1));
            }
        }
        SAMPLE_SCRATCH.with(|slot| *slot.borrow_mut() = Some(s));
    }
}

struct Interpolated {
    c0: Vec<f64>,
    diff: Vec<f64>,
    n: Option<f64>,
}

impl Interpolated {
    fn call(&self, src: &[f64], dest: &mut [f64]) {
        let input = at(src, 0);
        let x = match self.n {
            Some(1.0) => input,
            Some(n) => js::pow(input, n),
            None => f64::NAN,
        };
        for (j, slot) in dest.iter_mut().enumerate().take(self.diff.len()) {
            *slot = self.c0[j] + x * self.diff[j];
        }
    }
}

struct Stitched {
    domain: Vec<f64>,
    functions: Vec<PdfFunction>,
    bounds: Option<Vec<f64>>,
    encode: Option<Vec<f64>>,
}

impl Stitched {
    fn call(&self, src: &[f64], dest: &mut [f64]) -> Result<()> {
        let (Some(bounds), Some(encode)) = (&self.bounds, &self.encode) else {
            return Err(format_error("Stitching function without Bounds or Encode"));
        };
        let v = clamp(at(src, 0), self.domain[0], self.domain[1]);
        let length = bounds.len();
        let mut i = 0;
        while i < length {
            if v < bounds[i] {
                break;
            }
            i += 1;
        }
        let dmin = if i > 0 { bounds[i - 1] } else { self.domain[0] };
        let dmax = if i < length {
            bounds[i]
        } else {
            self.domain[1]
        };
        let tmp =
            [interpolate(v, dmin, dmax, at(encode, 2 * i), at(encode, 2 * i + 1)) as f32 as f64];
        match self.functions.get(i) {
            Some(function) => function.call(&tmp, dest),
            None => Err(format_error(
                "Stitching function has no function for the interval",
            )),
        }
    }
}

enum Kind {
    Sampled(Sampled),
    Interpolated(Interpolated),
    Stitched(Stitched),
    PostScript(PostScriptFunction),
    /// `PDFFunction.parseArray` with several functions: each yields one output.
    Array(Vec<PdfFunction>),
}

/// A PDF function (or an array of them) built from the document.
pub struct PdfFunction {
    kind: Kind,
    num_inputs: usize,
    num_outputs: usize,
}

impl PdfFunction {
    /// `fn.numInputs`.
    pub fn num_inputs(&self) -> usize {
        self.num_inputs
    }

    /// `fn.numOutputs`.
    pub fn num_outputs(&self) -> usize {
        self.num_outputs
    }

    /// Calls the function: reads `num_inputs` values from the start of `src` and writes `num_outputs` values to the
    /// start of `dest`. An error is what a trap of a compiled PostScript function or a malformed stitching function
    /// throws in pdf.js.
    pub fn call(&self, src: &[f64], dest: &mut [f64]) -> Result<()> {
        match &self.kind {
            Kind::Sampled(f) => f.call(src, dest),
            Kind::Interpolated(f) => f.call(src, dest),
            Kind::Stitched(f) => return f.call(src, dest),
            Kind::PostScript(f) => return f.call(src, dest),
            Kind::Array(functions) => {
                for (i, function) in functions.iter().enumerate() {
                    if i >= dest.len() {
                        break;
                    }
                    function.call(src, &mut dest[i..])?;
                }
            }
        }
        Ok(())
    }
}

/// `PDFFunctionFactory.create`: the function `obj` (a reference, a dictionary or a stream; with `parse_array` also an
/// array of them) names.
pub fn create(xref: &Xref, obj: &Obj, parse_array: bool) -> Result<PdfFunction> {
    create_at(xref, obj, parse_array, 0)
}

fn create_at(xref: &Xref, obj: &Obj, parse_array: bool, depth: usize) -> Result<PdfFunction> {
    let fetched = xref.fetch_if_ref(obj, false)?;
    match &fetched {
        Obj::Array(items) => {
            if !parse_array {
                return Err(format_error(
                    "PDFFunctionFactory.create - expected \"parseArray\" argument.",
                ));
            }
            parse_array_of(xref, items, depth)
        }
        other => parse(xref, other, depth),
    }
}

/// `PDFFunction.parseArray`.
fn parse_array_of(xref: &Xref, items: &[Obj], depth: usize) -> Result<PdfFunction> {
    let mut functions = Vec::with_capacity(items.len());
    for item in items {
        let fetched = xref.fetch_if_ref(item, false)?;
        functions.push(parse(xref, &fetched, depth)?);
    }
    if functions.len() == 1 {
        return Ok(functions.remove(0));
    }
    let num_inputs = functions.first().map_or(0, |f| f.num_inputs);
    if functions
        .iter()
        .any(|f| f.num_inputs != num_inputs || f.num_outputs != 1)
    {
        return Err(format_error("Invalid array of functions."));
    }
    let num_outputs = functions.len();
    Ok(PdfFunction {
        kind: Kind::Array(functions),
        num_inputs,
        num_outputs,
    })
}

/// `PDFFunction.parse`.
fn parse(xref: &Xref, function: &Obj, depth: usize) -> Result<PdfFunction> {
    if depth > MAX_DEPTH {
        return Err(format_error("Functions nested too deeply."));
    }
    let dict = function
        .dict_or_stream_dict()
        .ok_or_else(|| format_error("Function is neither a dictionary nor a stream."))?;
    let kind = xref.get(dict, "FunctionType")?;
    match kind.as_num() {
        Some(0.0) => construct_sampled(xref, function, dict),
        Some(2.0) => construct_interpolated(xref, dict),
        Some(3.0) => construct_stitched(xref, dict, depth),
        Some(4.0) => construct_postscript(xref, function, dict),
        _ => Err(format_error(&format!(
            "Unknown function type: {}",
            describe(&kind)
        ))),
    }
}

fn describe(obj: &Obj) -> String {
    match obj {
        Obj::Num(n) => n.to_string(),
        Obj::Name(n) => n.to_string(),
        Obj::Null => "undefined".to_owned(),
        _ => "object".to_owned(),
    }
}

fn function_stream<'a>(function: &'a Obj, what: &str) -> Result<&'a PdfStream> {
    function
        .as_stream()
        .map(|s| &**s)
        .ok_or_else(|| format_error(&format!("{what} function is not a stream")))
}

fn stream_bytes(xref: &Xref, stream: &PdfStream) -> Result<Vec<u8>> {
    stream.decode(&**xref.filters(), xref.guard())
}

/// `PDFFunction.getSampleArray`.
fn get_sample_array(size: &[f64], output_size: usize, bps: i32, bytes: &[u8]) -> Result<Vec<f64>> {
    let mut length = output_size as f64;
    for s in size {
        length *= s;
    }
    if !(length >= 0.0 && length.fract() == 0.0 && length <= 4_294_967_295.0) {
        return Err(format_error("Invalid array length"));
    }
    if length > MAX_SAMPLES {
        return Err(PdfError::ResourceLimit(
            "sampled function holds too many samples".to_owned(),
        ));
    }
    let length = length as usize;
    let sample_mul = 1.0 / (2.0f64.powi(bps) - 1.0);
    let wanted = (length as f64 * f64::from(bps) + 7.0) / 8.0;
    let wanted = wanted.floor() as usize;
    let available = &bytes[..bytes.len().min(wanted)];
    let mut code_size: i32 = 0;
    let mut code_buf: i32 = 0;
    let mut index = 0usize;
    let mut array = Vec::with_capacity(length);
    for _ in 0..length {
        while code_size < bps {
            code_buf = code_buf.wrapping_shl(8);
            code_buf |= i32::from(available.get(index).copied().unwrap_or(0));
            index += 1;
            code_size += 8;
        }
        code_size -= bps;
        array.push(f64::from(code_buf >> code_size) * sample_mul);
        code_buf &= 1i32.wrapping_shl(code_size as u32).wrapping_sub(1);
    }
    Ok(array)
}

/// `constructSampled`.
fn construct_sampled(xref: &Xref, function: &Obj, dict: &Dict) -> Result<PdfFunction> {
    let domain = number_array(xref, dict, "Domain")?;
    let range = number_array(xref, dict, "Range")?;
    let (Some(domain), Some(range)) = (domain, range) else {
        return Err(format_error("No domain or range"));
    };
    let input_size = domain.len() / 2;
    let output_size = range.len() / 2;
    let size = number_array(xref, dict, "Size")?.ok_or_else(|| format_error("No size"))?;
    let bps = xref
        .get(dict, "BitsPerSample")?
        .as_num()
        .ok_or_else(|| format_error("No BitsPerSample"))?;
    if !(1.0..=32.0).contains(&bps) || bps.fract() != 0.0 {
        return Err(format_error("Unsupported BitsPerSample"));
    }
    let order = xref.get(dict, "Order")?;
    if let Some(order) = order.as_num()
        && order != 1.0
        && order != 0.0
    {
        tracing::debug!("No support for cubic spline interpolation: {order}");
    }
    let encode = match number_array(xref, dict, "Encode")? {
        Some(encode) => encode,
        None => (0..input_size)
            .flat_map(|i| [0.0, at(&size, i) - 1.0])
            .collect(),
    };
    let decode = number_array(xref, dict, "Decode")?.unwrap_or_else(|| range.clone());
    let bytes = stream_bytes(xref, function_stream(function, "Sampled")?)?;
    let samples = get_sample_array(&size, output_size, bps as i32, &bytes)?;
    Ok(PdfFunction {
        kind: Kind::Sampled(Sampled {
            domain,
            range,
            encode,
            decode,
            size,
            samples,
            input_size,
            output_size,
        }),
        num_inputs: input_size,
        num_outputs: output_size,
    })
}

/// `constructInterpolated`.
fn construct_interpolated(xref: &Xref, dict: &Dict) -> Result<PdfFunction> {
    let domain = number_array(xref, dict, "Domain")?;
    let c0 = number_array(xref, dict, "C0")?.unwrap_or_else(|| vec![0.0]);
    let c1 = number_array(xref, dict, "C1")?.unwrap_or_else(|| vec![1.0]);
    let n = xref.get(dict, "N")?.as_num();
    let diff: Vec<f64> = (0..c0.len()).map(|i| at(&c1, i) - c0[i]).collect();
    let num_outputs = diff.len();
    Ok(PdfFunction {
        kind: Kind::Interpolated(Interpolated { c0, diff, n }),
        num_inputs: domain.map_or(1, |d| d.len() / 2),
        num_outputs,
    })
}

/// `constructStitched`.
fn construct_stitched(xref: &Xref, dict: &Dict, depth: usize) -> Result<PdfFunction> {
    let domain = number_array(xref, dict, "Domain")?.ok_or_else(|| format_error("No domain"))?;
    let input_size = domain.len() / 2;
    if input_size != 1 {
        return Err(format_error("Bad domain for stitched function"));
    }
    let Obj::Array(items) = xref.get(dict, "Functions")? else {
        return Err(format_error(
            "Functions of a stitched function is not an array",
        ));
    };
    let mut functions = Vec::with_capacity(items.len());
    for item in items.iter() {
        let fetched = xref.fetch_if_ref(item, false)?;
        functions.push(parse(xref, &fetched, depth + 1)?);
    }
    let num_outputs = functions.first().map_or(0, |f| f.num_outputs);
    if functions.is_empty()
        || functions
            .iter()
            .any(|f| f.num_inputs != 1 || f.num_outputs != num_outputs)
    {
        return Err(format_error(
            "Incompatible sub-functions for stitched function",
        ));
    }
    let bounds = number_array(xref, dict, "Bounds")?;
    let encode = number_array(xref, dict, "Encode")?;
    Ok(PdfFunction {
        kind: Kind::Stitched(Stitched {
            domain,
            functions,
            bounds,
            encode,
        }),
        num_inputs: input_size,
        num_outputs,
    })
}

/// `constructPostScript`.
fn construct_postscript(xref: &Xref, function: &Obj, dict: &Dict) -> Result<PdfFunction> {
    let domain = number_array(xref, dict, "Domain")?.ok_or_else(|| format_error("No domain."))?;
    let range = number_array(xref, dict, "Range")?.ok_or_else(|| format_error("No range."))?;
    let code = stream_bytes(xref, function_stream(function, "PostScript")?)?;
    let program = PostScriptFunction::new(&code, &domain, &range, xref.guard())?;
    Ok(PdfFunction {
        kind: Kind::PostScript(program),
        num_inputs: domain.len() / 2,
        num_outputs: range.len() / 2,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_array_reads_bit_widths_like_pdfjs() {
        // 4 bits: two samples per byte, high nibble first
        let samples = get_sample_array(&[4.0], 1, 4, &[0x12, 0x34]).expect("samples");
        let m = 1.0 / 15.0;
        assert_eq!(samples, vec![m, 2.0 * m, 3.0 * m, 4.0 * m]);
        // 12 bits across byte borders
        let samples = get_sample_array(&[2.0], 1, 12, &[0xab, 0xcd, 0xef]).expect("samples");
        assert_eq!(
            samples,
            vec![
                f64::from(0xabcu32) * (1.0 / 4095.0),
                f64::from(0xdefu32) * (1.0 / 4095.0)
            ]
        );
        // 16 bits
        let samples = get_sample_array(&[1.0], 1, 16, &[0x80, 0x00]).expect("samples");
        assert_eq!(samples, vec![32768.0 * (1.0 / 65535.0)]);
    }

    #[test]
    fn missing_sample_bytes_read_as_zero() {
        let samples = get_sample_array(&[3.0], 1, 8, &[255]).expect("samples");
        assert_eq!(samples, vec![1.0, 0.0, 0.0]);
    }

    #[test]
    fn thirty_two_bit_samples_are_signed_like_javascripts_shifts() {
        let samples = get_sample_array(&[2.0], 1, 32, &[0x80, 0, 0, 0, 0x7f, 0xff, 0xff, 0xff])
            .expect("samples");
        assert_eq!(samples[0], -2_147_483_648.0 * (1.0 / 4_294_967_295.0));
        assert_eq!(samples[1], 2_147_483_647.0 * (1.0 / 4_294_967_295.0));
    }

    #[test]
    fn an_invalid_sample_count_is_an_error() {
        assert!(get_sample_array(&[-1.0], 1, 8, &[]).is_err());
        assert!(get_sample_array(&[1.5], 1, 8, &[]).is_err());
        assert!(get_sample_array(&[f64::NAN], 1, 8, &[]).is_err());
    }

    fn sampled_1d(samples: Vec<f64>, encode: Vec<f64>, size: f64) -> Sampled {
        Sampled {
            domain: vec![0.0, 1.0],
            range: vec![0.0, 1.0],
            encode,
            decode: vec![0.0, 1.0],
            size: vec![size],
            samples,
            input_size: 1,
            output_size: 1,
        }
    }

    #[test]
    fn sampled_function_interpolates_between_samples() {
        let f = sampled_1d(vec![0.0, 1.0, 0.0], vec![0.0, 2.0], 3.0);
        let mut out = [0.0];
        f.call(&[0.25], &mut out);
        assert_eq!(out[0], 0.5);
        f.call(&[0.5], &mut out);
        assert_eq!(out[0], 1.0);
        f.call(&[0.75], &mut out);
        assert_eq!(out[0], 0.5);
        // the input is clamped to the domain
        f.call(&[7.0], &mut out);
        assert_eq!(out[0], 0.0);
    }

    #[test]
    fn two_input_sampled_function_is_bilinear() {
        let f = Sampled {
            domain: vec![0.0, 1.0, 0.0, 1.0],
            range: vec![0.0, 1.0],
            encode: vec![0.0, 1.0, 0.0, 1.0],
            decode: vec![0.0, 1.0],
            size: vec![2.0, 2.0],
            samples: vec![0.0, 1.0, 0.5, 0.0],
            input_size: 2,
            output_size: 1,
        };
        let mut out = [0.0];
        f.call(&[0.5, 0.5], &mut out);
        assert_eq!(out[0], 0.375);
        f.call(&[1.0, 0.0], &mut out);
        assert_eq!(out[0], 1.0);
    }

    #[test]
    fn exponential_interpolation() {
        let f = Interpolated {
            c0: vec![0.0, 1.0],
            diff: vec![1.0, -1.0],
            n: Some(2.0),
        };
        let mut out = [0.0, 0.0];
        f.call(&[0.5], &mut out);
        assert_eq!(out, [0.25, 0.75]);
        let missing = Interpolated {
            c0: vec![0.0],
            diff: vec![1.0],
            n: None,
        };
        let mut one = [0.0];
        missing.call(&[0.5], &mut one);
        assert!(one[0].is_nan());
    }

    #[test]
    fn to_u32_wraps() {
        assert_eq!(to_u32(-1.0), u32::MAX);
        assert_eq!(to_u32(4_294_967_296.0 + 5.0), 5);
        assert_eq!(to_u32(f64::NAN), 0);
    }
}
