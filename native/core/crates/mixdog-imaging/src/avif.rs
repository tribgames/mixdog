//! AVIF, the way sharp (libvips with libheif) reads and writes it.
//!
//! Decoding: `avif-parse` finds the AV1 items of the HEIF container (the primary image and, when there is one, the
//! alpha plane), `rav1d` (the pure-Rust port of dav1d) decodes them, and the planes become 8-bit straight-alpha
//! RGB(A) the way libheif hands them to libvips: YCbCr is converted with the matrix and range the `colr` nclx box
//! names, else the AV1 sequence header (BT.601 when it names none), monochrome is grey, 4:2:0 and 4:2:2 chroma are
//! upsampled by replication, and a depth above 8 bits is scaled down to 8. An ICC profile of the container takes the
//! pixels to sRGB, and the `clap`, `irot` and `imir` properties are applied in the order the container lists them
//! (see [`crate::heif`]). An HEIC (HEVC) file is recognised but not decodable: libvips's prebuilt libheif has no
//! HEVC plugin, so sharp's answer is an invalid-image sentence, and that is the answer here.
//!
//! Encoding: `ravif` (rav1e) writes the AVIF a resized AVIF input leaves as: 8-bit 4:4:4, no metadata, at the
//! quantizer libheif's default quality 50 gives, with the alpha plane (same quality) when the picture has alpha.
//!
//! `rav1d` offers the dav1d C-style API; every call into it is wrapped here, once, and the rest of the crate
//! sees only [`decode_avif`], [`encode_avif`] and [`is_heif`].

use std::ffi::c_int;
use std::ffi::c_uint;
use std::io::Cursor;
use std::mem::MaybeUninit;
use std::ptr::NonNull;

use ravif::AlphaColorMode;
use ravif::BitDepth;
use ravif::Encoder;
use ravif::Img;
use ravif::RGB8;
use ravif::RGBA8;

use rav1d::include::dav1d::data::Dav1dData;
use rav1d::include::dav1d::dav1d::Dav1dContext;
use rav1d::include::dav1d::dav1d::Dav1dSettings;
use rav1d::include::dav1d::headers::Dav1dSequenceHeader;
use rav1d::include::dav1d::picture::Dav1dPicture;
use rav1d::src::lib::dav1d_close;
use rav1d::src::lib::dav1d_data_create;
use rav1d::src::lib::dav1d_data_unref;
use rav1d::src::lib::dav1d_default_settings;
use rav1d::src::lib::dav1d_get_picture;
use rav1d::src::lib::dav1d_open;
use rav1d::src::lib::dav1d_picture_unref;
use rav1d::src::lib::dav1d_send_data;

use crate::color;
use crate::decode::Raster;
use crate::error::ImagingError;
use crate::error::PIXEL_LIMIT;
use crate::error::corrupt_header;
use crate::heif;
use crate::heif::Colour;
use crate::heif::Transform;

/// `EAGAIN` as dav1d reports it (negated): "give me more data" or "no picture yet".
const EAGAIN: c_int = 11;

/// What a decode of an AVIF gives the crate.
#[derive(Debug)]
pub struct AvifImage {
    pub width: u32,
    pub height: u32,
    pub raster: Raster,
}

/// libheif's sentence for AV1 data its decoder rejects (inside the pixel data: no corrupt-header prefix).
fn broken(detail: &str) -> ImagingError {
    ImagingError::invalid(format!("heif: Invalid input: Unspecified: {detail} (2.0)"))
}

/// libheif's sentence for an HEVC picture: the prebuilt libheif of sharp carries no HEVC decoder.
const HEVC_UNSUPPORTED: &str = "heif: Error while loading plugin: Support for this compression format has not been built in: HEVC (a suitable decoder plugin is libde265) (11.6003)";

/// libheif's sentences for a container it cannot read, by how far it got.
fn unreadable(bytes: &[u8]) -> ImagingError {
    match heif::shape(bytes) {
        heif::Shape::TooSmall => ImagingError::invalid(corrupt_header("heif: Invalid input: Unspecified: File size too small. (2.0)")),
        heif::Shape::MetaIncomplete => ImagingError::invalid(corrupt_header("heif: Invalid input: No 'meta' box: Cannot read full meta box (2.104)")),
        heif::Shape::Whole => ImagingError::invalid("heif: Invalid input: Unexpected end of file (2.100)"),
    }
}

/// One decoded picture, owned by dav1d until it is dropped.
struct Picture(Dav1dPicture);

impl Drop for Picture {
    fn drop(&mut self) {
        // SAFETY: the picture is either default (dav1d ignores an empty one) or was filled by a successful
        // `dav1d_get_picture`; it is unreferenced exactly once, here.
        unsafe { dav1d_picture_unref(Some(NonNull::from(&mut self.0))) };
    }
}

/// Data handed to dav1d; what it has not consumed is released when this is dropped, on every path.
struct Data(Dav1dData);

impl Drop for Data {
    fn drop(&mut self) {
        // SAFETY: the data is either default (dav1d ignores an empty one) or came from `dav1d_data_create` and
        // was partly or wholly consumed by `dav1d_send_data`; what is left is unreferenced exactly once, here.
        unsafe { dav1d_data_unref(Some(NonNull::from(&mut self.0))) };
    }
}

/// An open decoder.
struct Decoder(Option<Dav1dContext>);

impl Decoder {
    fn open() -> Result<Self, ImagingError> {
        let mut settings = MaybeUninit::<Dav1dSettings>::uninit();
        // SAFETY: `dav1d_default_settings` writes a whole `Dav1dSettings` into the pointed-to storage, which is
        // not null.
        unsafe { dav1d_default_settings(NonNull::new_unchecked(settings.as_mut_ptr())) };
        // SAFETY: the call above initialised every field.
        let mut settings = unsafe { settings.assume_init() };
        settings.n_threads = 1;
        settings.max_frame_delay = 1;
        settings.all_layers = 0;
        let mut context: Option<Dav1dContext> = None;
        // SAFETY: both pointers are valid for the call: `context` is written, `settings` is read.
        let result = unsafe { dav1d_open(Some(NonNull::from(&mut context)), Some(NonNull::from(&mut settings))) };
        match (result.0, context) {
            (0, Some(_)) => Ok(Self(context)),
            _ => Err(ImagingError::environment("cannot open the AV1 decoder")),
        }
    }

    /// Decodes the one picture of an AV1 still-image item.
    fn decode(&self, item: &[u8]) -> Result<Picture, ImagingError> {
        if item.is_empty() {
            return Err(broken("the AV1 item is empty"));
        }
        let mut data = Data(Dav1dData::default());
        // SAFETY: `data` is valid to write; the call allocates `item.len()` bytes that dav1d owns.
        let buffer = unsafe { dav1d_data_create(Some(NonNull::from(&mut data.0)), item.len()) };
        let Some(buffer) = NonNull::new(buffer) else { return Err(ImagingError::environment("cannot allocate AV1 data")) };
        // SAFETY: `buffer` was allocated for exactly `item.len()` bytes and does not overlap `item`.
        unsafe { std::ptr::copy_nonoverlapping(item.as_ptr(), buffer.as_ptr(), item.len()) };
        let mut picture = Picture(Dav1dPicture::default());
        for _ in 0..64 {
            if data.0.sz > 0 {
                // SAFETY: the context is open and `data` is valid to read and write.
                let sent = unsafe { dav1d_send_data(self.0, Some(NonNull::from(&mut data.0))) }.0;
                if sent != 0 && sent != -EAGAIN {
                    return Err(broken("Corrupt frame detected"));
                }
            }
            // SAFETY: the context is open and the picture storage is valid to write.
            let got = unsafe { dav1d_get_picture(self.0, Some(NonNull::from(&mut picture.0))) }.0;
            if got == 0 {
                return Ok(picture);
            }
            if got != -EAGAIN {
                return Err(broken("Corrupt frame detected"));
            }
        }
        Err(broken("Corrupt frame detected"))
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        // SAFETY: the context came from `dav1d_open` and is closed exactly once, here.
        unsafe { dav1d_close(Some(NonNull::from(&mut self.0))) };
    }
}

/// A plane of samples widened to u16, `width` samples a row.
struct Plane {
    width: usize,
    height: usize,
    samples: Vec<u16>,
}

impl Plane {
    fn at(&self, x: usize, y: usize) -> u16 {
        self.samples[y * self.width + x]
    }
}

/// Reads plane `index` of `picture`, `width` by `height` samples.
fn read_plane(picture: &Picture, index: usize, width: usize, height: usize) -> Result<Plane, ImagingError> {
    let pointer = picture.0.data[index].ok_or_else(|| broken("a plane is missing"))?;
    let stride = picture.0.stride[usize::from(index > 0)];
    let wide = picture.0.p.bpc > 8;
    let size = if wide { 2 } else { 1 };
    let mut samples = Vec::with_capacity(width * height);
    for row in 0..height {
        let offset = isize::try_from(row).map_err(|_| broken("a plane is too large"))? * stride;
        // SAFETY: dav1d allocates every plane row with `stride` bytes between rows and at least `width` samples
        // of `size` bytes each in it, and keeps them alive until the picture is unreferenced.
        let line = unsafe { std::slice::from_raw_parts(pointer.as_ptr().cast::<u8>().offset(offset), width * size) };
        if wide {
            samples.extend(line.chunks_exact(2).map(|pair| u16::from_ne_bytes([pair[0], pair[1]])));
        } else {
            samples.extend(line.iter().map(|&sample| u16::from(sample)));
        }
    }
    Ok(Plane { width, height, samples })
}

/// The planes of a decoded picture.
struct Frame {
    width: usize,
    height: usize,
    depth: u32,
    luma: Plane,
    chroma: Option<(Plane, Plane)>,
    matrix: u32,
    full_range: bool,
}

fn frame_of(picture: &Picture) -> Result<Frame, ImagingError> {
    let (width, height) = (usize::try_from(picture.0.p.w).unwrap_or(0), usize::try_from(picture.0.p.h).unwrap_or(0));
    if width == 0 || height == 0 {
        return Err(broken("the image has no size"));
    }
    let depth = u32::try_from(picture.0.p.bpc).unwrap_or(0);
    if !(8..=12).contains(&depth) {
        return Err(broken("an unsupported bit depth"));
    }
    let luma = read_plane(picture, 0, width, height)?;
    // dav1d's layouts: 0 monochrome, 1 4:2:0, 2 4:2:2, 3 4:4:4.
    let layout: c_uint = picture.0.p.layout;
    let chroma = match layout {
        0 => None,
        1..=3 => {
            let cw = if layout == 3 { width } else { width.div_ceil(2) };
            let ch = if layout == 1 { height.div_ceil(2) } else { height };
            Some((read_plane(picture, 1, cw, ch)?, read_plane(picture, 2, cw, ch)?))
        }
        _ => return Err(broken("an unknown chroma layout")),
    };
    let (matrix, full_range) = match picture.0.seq_hdr {
        Some(header) => {
            // SAFETY: a picture from dav1d carries a sequence header that lives as long as the picture does.
            let header: &Dav1dSequenceHeader = unsafe { header.as_ref() };
            (header.mtrx, header.color_range != 0)
        }
        None => (2, false),
    };
    Ok(Frame { width, height, depth, luma, chroma, matrix, full_range })
}

/// Scales a sample of `depth` bits (as a float in `0..=maximum`) to 8 bits.
fn to_8_bits(value: f32, depth: u32) -> u8 {
    let maximum = ((1u32 << depth) - 1) as f32;
    (value / maximum * 255.0).round().clamp(0.0, 255.0) as u8
}

/// `(Kr, Kb)` of the matrix coefficients code; BT.601 when the stream names none that is known.
fn weights(matrix: u32) -> (f32, f32) {
    match matrix {
        1 => (0.2126, 0.0722),
        4 => (0.30, 0.11),
        7 => (0.212, 0.087),
        9 | 10 => (0.2627, 0.0593),
        _ => (0.299, 0.114),
    }
}

fn rgb_of(frame: &Frame) -> Vec<u8> {
    let mut out = Vec::with_capacity(frame.width * frame.height * 3);
    let scale = (1u32 << (frame.depth - 8)) as f32;
    let maximum = ((1u32 << frame.depth) - 1) as f32;
    let (kr, kb) = weights(frame.matrix);
    let kg = 1.0 - kr - kb;
    let level = |sample: f32| {
        let sample = if frame.full_range { sample } else { (sample - 16.0 * scale) * maximum / (219.0 * scale) };
        to_8_bits(sample, frame.depth)
    };
    for y in 0..frame.height {
        for x in 0..frame.width {
            let luma = f32::from(frame.luma.at(x, y));
            let Some((cb, cr)) = &frame.chroma else {
                let grey = level(luma);
                out.extend_from_slice(&[grey, grey, grey]);
                continue;
            };
            let (cx, cy) = (x * cb.width / frame.width, y * cb.height / frame.height);
            let (u, v) = (f32::from(cb.at(cx, cy)), f32::from(cr.at(cx, cy)));
            if frame.matrix == 0 {
                // Identity: the planes are G, B and R.
                out.extend_from_slice(&[level(v), level(luma), level(u)]);
                continue;
            }
            let (y_n, u_n, v_n) = if frame.full_range {
                (luma / maximum, (u - 128.0 * scale) / maximum, (v - 128.0 * scale) / maximum)
            } else {
                ((luma - 16.0 * scale) / (219.0 * scale), (u - 128.0 * scale) / (224.0 * scale), (v - 128.0 * scale) / (224.0 * scale))
            };
            let r = y_n + 2.0 * (1.0 - kr) * v_n;
            let b = y_n + 2.0 * (1.0 - kb) * u_n;
            let g = (y_n - kr * r - kb * b) / kg;
            for channel in [r, g, b] {
                out.push(to_8_bits(channel * maximum, frame.depth));
            }
        }
    }
    out
}

/// The brands libheif accepts as its own (`heif_check_filetype`): AV1 stills and sequences, the HEVC family, and the
/// generic image-collection brands.
const HEIF_BRANDS: [&[u8; 4]; 12] = [b"avif", b"avis", b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"hevm", b"hevs", b"mif1", b"msf1"];

/// The brands that mean HEVC pictures.
const HEVC_BRANDS: [&[u8; 4]; 8] = [b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"hevm", b"hevs"];

/// The major brand and the compatible brands of the `ftyp` box that opens `bytes`.
fn brands(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    let ftyp = bytes.len() >= 12 && &bytes[4..8] == b"ftyp";
    let size = if ftyp { u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize } else { 0 };
    let compatible = if ftyp && bytes.len() >= 16 { &bytes[16..size.clamp(16, bytes.len())] } else { &[][..] };
    ftyp.then(|| &bytes[8..12]).into_iter().chain(compatible.chunks_exact(4))
}

fn is_brand(brand: &[u8], known: &[&[u8; 4]]) -> bool {
    known.iter().any(|known| brand == known.as_slice())
}

/// Whether `bytes` opens with the `ftyp` of a HEIF file (AV1 or HEVC pictures): libvips hands those to libheif.
pub fn is_heif(bytes: &[u8]) -> bool {
    brands(bytes).any(|brand| is_brand(brand, &HEIF_BRANDS))
}

/// Decodes the primary item (and the alpha item, when there is one) of an AVIF.
pub fn decode_avif(bytes: &[u8], pixel_limit: u64) -> Result<AvifImage, ImagingError> {
    let container = heif::read(bytes);
    let hevc_item = matches!(container.item_type, Some(kind) if &kind == b"hvc1" || &kind == b"hev1");
    let hevc_brand = container.item_type != Some(*b"av01") && brands(bytes).next().is_some_and(|brand| is_brand(brand, &HEVC_BRANDS));
    if hevc_item || hevc_brand {
        return Err(ImagingError::invalid(HEVC_UNSUPPORTED));
    }
    let parsed = avif_parse::read_avif(&mut Cursor::new(bytes)).map_err(|_| unreadable(bytes))?;
    let meta = parsed.primary_item_metadata().map_err(|_| broken("Bitstream not supported by this decoder"))?;
    if u64::from(meta.max_frame_width.get()) * u64::from(meta.max_frame_height.get()) > pixel_limit {
        return Err(ImagingError::invalid(PIXEL_LIMIT));
    }
    let decoder = Decoder::open()?;
    let picture = decoder.decode(&parsed.primary_item)?;
    let mut frame = frame_of(&picture)?;
    // The nclx box of the container outranks the sequence header.
    for colour in &container.colours {
        if let Colour::Nclx { matrix, full_range } = colour {
            frame.matrix = u32::from(*matrix);
            frame.full_range = *full_range;
        }
    }
    let data = rgb_of(&frame);
    let (width, height) = (frame.width, frame.height);
    let alpha = match &parsed.alpha_item {
        Some(alpha_item) => {
            let alpha_picture = decoder.decode(alpha_item)?;
            let plane = frame_of(&alpha_picture)?;
            let samples: Vec<u8> = (0..plane.width * plane.height).map(|index| to_8_bits(f32::from(plane.luma.samples[index]), plane.depth)).collect();
            Some((plane.width, plane.height, samples))
        }
        None => None,
    };
    let (width, height) = (u32::try_from(width).map_err(|_| broken("too wide"))?, u32::try_from(height).map_err(|_| broken("too tall"))?);
    let mut raster = Raster { width, height, has_alpha: false, data };
    for transform in &container.transforms {
        raster = transformed(&raster, *transform);
    }
    if let Some((alpha_width, alpha_height, samples)) = alpha {
        // libheif applies the properties of the primary item to the colour only: the alpha plane (an item of its own,
        // with none of them) is laid over the transformed colour, scaled by nearest neighbour when the sizes differ.
        let (out_width, out_height) = (raster.width as usize, raster.height as usize);
        let mut rgba = Vec::with_capacity(out_width * out_height * 4);
        for (index, pixel) in raster.data.chunks_exact(3).enumerate() {
            let (x, y) = (index % out_width, index / out_width);
            let a = samples[(y * alpha_height / out_height) * alpha_width + x * alpha_width / out_width];
            let straight = |channel: u8| {
                if parsed.premultiplied_alpha && a != 0 && a != 255 {
                    (u32::from(channel) * 255 / u32::from(a)).min(255) as u8
                } else {
                    channel
                }
            };
            rgba.extend_from_slice(&[straight(pixel[0]), straight(pixel[1]), straight(pixel[2]), a]);
        }
        raster = Raster { width: raster.width, height: raster.height, has_alpha: true, data: rgba };
    }
    // The profile is applied to the decoded (straight-alpha) picture, as libvips imports it after libheif's decode; a
    // per-pixel conversion commutes with the transforms above.
    for colour in &container.colours {
        if let Colour::Icc(profile) = colour {
            color::rgb_to_srgb(&mut raster.data, raster.has_alpha, profile);
        }
    }
    Ok(AvifImage { width: raster.width, height: raster.height, raster })
}

/// `raster` with one transformative property applied.
fn transformed(raster: &Raster, transform: Transform) -> Raster {
    let (width, height, channels) = (raster.width as usize, raster.height as usize, raster.channels());
    let pixel = |x: usize, y: usize| &raster.data[(y * width + x) * channels..][..channels];
    // `place(x, y)` names the source pixel of output pixel (x, y).
    let build = |out_width: usize, out_height: usize, place: &dyn Fn(usize, usize) -> (usize, usize)| {
        let mut data = Vec::with_capacity(out_width * out_height * channels);
        for y in 0..out_height {
            for x in 0..out_width {
                let (source_x, source_y) = place(x, y);
                data.extend_from_slice(pixel(source_x, source_y));
            }
        }
        Raster { width: out_width as u32, height: out_height as u32, has_alpha: raster.has_alpha, data }
    };
    match transform {
        Transform::Crop(aperture) => {
            let (left, top, kept_width, kept_height) = aperture.window(raster.width, raster.height);
            build(kept_width as usize, kept_height as usize, &|x, y| (x + left as usize, y + top as usize))
        }
        // A counter-clockwise quarter turn takes the right edge to the top.
        Transform::Rotate(1) => build(height, width, &|x, y| (width - 1 - y, x)),
        Transform::Rotate(2) => build(width, height, &|x, y| (width - 1 - x, height - 1 - y)),
        Transform::Rotate(_) => build(height, width, &|x, y| (y, height - 1 - x)),
        Transform::Mirror(0) => build(width, height, &|x, y| (x, height - 1 - y)),
        Transform::Mirror(_) => build(width, height, &|x, y| (width - 1 - x, y)),
    }
}

/// The quantizer libheif's default AVIF quality (50) gives its encoder, on rav1e's 0 to 255 scale, written as the
/// quality `ravif` maps to it (`quality_to_quantizer(78)` is 124, libaom's quantizer index at quality 50).
const AVIF_QUALITY: f32 = 78.0;

/// sharp's default AVIF effort is 4, which libvips hands libheif as speed 9 - 4 = 5.
const AVIF_SPEED: u8 = 5;

/// An AVIF of `raster`: 8-bit 4:4:4 BT.601 full range, the alpha as a second AV1 item at the same quality, left
/// unassociated (libheif writes the colour as it is).
pub fn encode_avif(raster: &Raster) -> Result<Vec<u8>, ImagingError> {
    let (width, height) = (raster.width as usize, raster.height as usize);
    let encoder = Encoder::new()
        .with_quality(AVIF_QUALITY)
        .with_alpha_quality(AVIF_QUALITY)
        .with_speed(AVIF_SPEED)
        .with_bit_depth(BitDepth::Eight)
        .with_alpha_color_mode(AlphaColorMode::UnassociatedDirty)
        .with_num_threads(Some(1));
    let encoded = if raster.has_alpha {
        let pixels: Vec<RGBA8> = raster.data.chunks_exact(4).map(|pixel| RGBA8::new(pixel[0], pixel[1], pixel[2], pixel[3])).collect();
        encoder.encode_rgba(Img::new(&pixels[..], width, height))
    } else {
        let pixels: Vec<RGB8> = raster.data.chunks_exact(3).map(|pixel| RGB8::new(pixel[0], pixel[1], pixel[2])).collect();
        encoder.encode_rgb(Img::new(&pixels[..], width, height))
    };
    encoded.map(|image| image.avif_file).map_err(|error| ImagingError::environment(format!("the image could not be encoded: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::DECODE_PIXEL_LIMIT;

    fn gradient(width: u32, height: u32, has_alpha: bool) -> Raster {
        let mut data = Vec::new();
        for y in 0..height {
            for x in 0..width {
                data.extend_from_slice(&[(x * 255 / width) as u8, (y * 255 / height) as u8, 100]);
                if has_alpha {
                    data.push(60 + ((x + y) % 150) as u8);
                }
            }
        }
        Raster { width, height, has_alpha, data }
    }

    fn mean_difference(a: &Raster, b: &Raster) -> f64 {
        let total: u64 = a.data.iter().zip(&b.data).map(|(left, right)| u64::from(left.abs_diff(*right))).sum();
        total as f64 / a.data.len() as f64
    }

    #[test]
    fn what_is_written_is_an_avif_that_reads_back_close_with_its_alpha() {
        for has_alpha in [false, true] {
            let raster = gradient(48, 32, has_alpha);
            let bytes = encode_avif(&raster).unwrap();
            assert!(is_heif(&bytes) && &bytes[8..12] == b"avif", "alpha {has_alpha}");
            let back = decode_avif(&bytes, DECODE_PIXEL_LIMIT).unwrap();
            assert_eq!((back.width, back.height, back.raster.has_alpha), (48, 32, has_alpha));
            let difference = mean_difference(&raster, &back.raster);
            assert!(difference <= 6.0, "alpha {has_alpha}: mean difference {difference}");
        }
    }

    #[test]
    fn a_written_avif_carries_no_transformations() {
        let container = heif::read(&encode_avif(&gradient(16, 16, false)).unwrap());
        assert_eq!(container.item_type, Some(*b"av01"));
        assert!(container.transforms.is_empty());
    }

    /// An `ftyp heic` file whose primary item is `hvc1`.
    fn hevc_file() -> Vec<u8> {
        let mut file = b"\0\0\0\x18ftypheic\0\0\0\0mif1heic".to_vec();
        let infe: Vec<u8> = [&[0, 0, 0, 21][..], b"infe", &[2, 0, 0, 0, 0, 1, 0, 0], b"hvc1", &[0]].concat();
        let iinf: Vec<u8> = [&[0, 0, 0, 35][..], b"iinf", &[0, 0, 0, 0, 0, 1], &infe].concat();
        let pitm: Vec<u8> = [&[0, 0, 0, 14][..], b"pitm", &[0, 0, 0, 0, 0, 1]].concat();
        let meta_body: Vec<u8> = [&[0, 0, 0, 0][..], &pitm, &iinf].concat();
        file.extend_from_slice(&u32::try_from(8 + meta_body.len()).unwrap().to_be_bytes());
        file.extend_from_slice(b"meta");
        file.extend_from_slice(&meta_body);
        file
    }

    #[test]
    fn a_hevc_file_is_named_for_what_libheifs_build_lacks() {
        let file = hevc_file();
        assert!(is_heif(&file));
        let error = decode_avif(&file, DECODE_PIXEL_LIMIT).unwrap_err();
        assert_eq!(error.sentence(), HEVC_UNSUPPORTED);
        assert!(!error.is_environment());
    }

    #[test]
    fn a_file_the_container_parse_refuses_gets_libheifs_sentence_by_how_far_it_got() {
        let good = encode_avif(&gradient(16, 16, false)).unwrap();
        let short = decode_avif(&good[..12], DECODE_PIXEL_LIMIT).unwrap_err();
        assert!(short.sentence().ends_with("File size too small. (2.0)"), "{short}");
        let inside_meta = decode_avif(&good[..40], DECODE_PIXEL_LIMIT).unwrap_err();
        assert!(inside_meta.sentence().starts_with("Input buffer has corrupt header: heif: Invalid input"), "{inside_meta}");
        let cut = decode_avif(&good[..good.len() - 30], DECODE_PIXEL_LIMIT).unwrap_err();
        assert!(cut.sentence().contains("heif: Invalid input"), "{cut}");
        assert!(!cut.is_environment());
    }

    #[test]
    fn brands_decide_what_libheif_is_given() {
        assert!(is_heif(b"\0\0\0\x1cftypavif\0\0\0\0mif1avif"));
        assert!(is_heif(b"\0\0\0\x0cftypavif"));
        assert!(is_heif(b"\0\0\0\x18ftypmif1\0\0\0\0mif1heic"));
        assert!(!is_heif(b"\0\0\0\x14ftypisom\0\0\0\0isom"));
        assert!(!is_heif(b"\0\0\0\x08ftyp"));
        assert!(!is_heif(b"not a heif file at all"));
    }

    #[test]
    fn quarter_turns_mirrors_and_crops_move_the_pixels_libheif_moves() {
        // A 3 by 2 picture whose pixels are their own numbers: 0 1 2 / 3 4 5.
        let picture = Raster { width: 3, height: 2, has_alpha: false, data: (0..6u8).flat_map(|n| [n, n, n]).collect() };
        let ids = |raster: &Raster| raster.data.chunks_exact(3).map(|pixel| pixel[0]).collect::<Vec<_>>();
        let turned = transformed(&picture, Transform::Rotate(1));
        assert_eq!((turned.width, turned.height, ids(&turned)), (2, 3, vec![2, 5, 1, 4, 0, 3]));
        assert_eq!(ids(&transformed(&picture, Transform::Rotate(2))), [5, 4, 3, 2, 1, 0]);
        let back = transformed(&picture, Transform::Rotate(3));
        assert_eq!((back.width, back.height, ids(&back)), (2, 3, vec![3, 0, 4, 1, 5, 2]));
        assert_eq!(ids(&transformed(&picture, Transform::Mirror(0))), [3, 4, 5, 0, 1, 2]);
        assert_eq!(ids(&transformed(&picture, Transform::Mirror(1))), [2, 1, 0, 5, 4, 3]);
    }
}
