//! AVIF decoding: `avif-parse` finds the AV1 items of the HEIF container (the primary image and, when there is
//! one, the alpha plane), `rav1d` (the pure-Rust port of dav1d) decodes them, and the planes become 8-bit
//! straight-alpha RGB(A) the way libheif hands them to libvips: YCbCr is converted with the matrix and range the
//! AV1 sequence header names (BT.601 when it names none), monochrome is grey, 4:2:0 and 4:2:2 chroma are
//! upsampled by replication, and a depth above 8 bits is scaled down to 8.
//!
//! `rav1d` offers the dav1d C-style API; every call into it is wrapped here, once, and the rest of the crate
//! sees only [`decode_avif`] and [`is_avif`].

use std::ffi::c_int;
use std::ffi::c_uint;
use std::io::Cursor;
use std::mem::MaybeUninit;
use std::ptr::NonNull;

use rav1d::include::dav1d::data::Dav1dData;
use rav1d::include::dav1d::dav1d::Dav1dContext;
use rav1d::include::dav1d::dav1d::Dav1dSettings;
use rav1d::include::dav1d::headers::Dav1dSequenceHeader;
use rav1d::include::dav1d::picture::Dav1dPicture;
use rav1d::src::lib::dav1d_close;
use rav1d::src::lib::dav1d_data_create;
use rav1d::src::lib::dav1d_default_settings;
use rav1d::src::lib::dav1d_get_picture;
use rav1d::src::lib::dav1d_open;
use rav1d::src::lib::dav1d_picture_unref;
use rav1d::src::lib::dav1d_send_data;

use crate::decode::Raster;
use crate::error::ImagingError;
use crate::error::PIXEL_LIMIT;
use crate::error::corrupt_header;

/// `EAGAIN` as dav1d reports it (negated): "give me more data" or "no picture yet".
const EAGAIN: c_int = 11;

/// What a decode of an AVIF gives the crate.
pub struct AvifImage {
    pub width: u32,
    pub height: u32,
    pub raster: Raster,
}

fn broken(detail: &str) -> ImagingError {
    ImagingError::invalid(corrupt_header(&format!("heifload_buffer: {detail}")))
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
        let mut data = Dav1dData::default();
        // SAFETY: `data` is valid to write; the call allocates `item.len()` bytes that dav1d owns.
        let buffer = unsafe { dav1d_data_create(Some(NonNull::from(&mut data)), item.len()) };
        let Some(buffer) = NonNull::new(buffer) else { return Err(ImagingError::environment("cannot allocate AV1 data")) };
        // SAFETY: `buffer` was allocated for exactly `item.len()` bytes and does not overlap `item`.
        unsafe { std::ptr::copy_nonoverlapping(item.as_ptr(), buffer.as_ptr(), item.len()) };
        let mut picture = Picture(Dav1dPicture::default());
        for _ in 0..64 {
            if data.sz > 0 {
                // SAFETY: the context is open and `data` is valid to read and write.
                let sent = unsafe { dav1d_send_data(self.0, Some(NonNull::from(&mut data))) }.0;
                if sent != 0 && sent != -EAGAIN {
                    return Err(broken("the AV1 data is not decodable"));
                }
            }
            // SAFETY: the context is open and the picture storage is valid to write.
            let got = unsafe { dav1d_get_picture(self.0, Some(NonNull::from(&mut picture.0))) }.0;
            if got == 0 {
                return Ok(picture);
            }
            if got != -EAGAIN {
                return Err(broken("the AV1 data is not decodable"));
            }
        }
        Err(broken("the AV1 data holds no picture"))
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

/// Whether `bytes` is a HEIF container that names an AV1 still (`avif`) or sequence (`avis`) brand.
pub fn is_avif(bytes: &[u8]) -> bool {
    if bytes.len() < 16 || &bytes[4..8] != b"ftyp" {
        return false;
    }
    let size = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    let end = size.clamp(16, bytes.len());
    let brands = std::iter::once(&bytes[8..12]).chain(bytes[16..end].chunks_exact(4));
    brands.into_iter().any(|brand| brand == b"avif" || brand == b"avis")
}

/// Decodes the primary item (and the alpha item, when there is one) of an AVIF.
pub fn decode_avif(bytes: &[u8], pixel_limit: u64) -> Result<AvifImage, ImagingError> {
    let parsed = avif_parse::read_avif(&mut Cursor::new(bytes)).map_err(|_| broken("unable to parse the AVIF container"))?;
    let meta = parsed.primary_item_metadata().map_err(|_| broken("unable to parse the AV1 header"))?;
    if u64::from(meta.max_frame_width.get()) * u64::from(meta.max_frame_height.get()) > pixel_limit {
        return Err(ImagingError::invalid(PIXEL_LIMIT));
    }
    let decoder = Decoder::open()?;
    let picture = decoder.decode(&parsed.primary_item)?;
    let frame = frame_of(&picture)?;
    let mut data = rgb_of(&frame);
    let (width, height) = (frame.width, frame.height);
    let mut has_alpha = false;
    if let Some(alpha_item) = &parsed.alpha_item {
        let alpha_picture = decoder.decode(alpha_item)?;
        let alpha = frame_of(&alpha_picture)?;
        if (alpha.width, alpha.height) != (width, height) {
            return Err(broken("the alpha plane differs in size from the image"));
        }
        let mut rgba = Vec::with_capacity(width * height * 4);
        for (index, pixel) in data.chunks_exact(3).enumerate() {
            let a = to_8_bits(f32::from(alpha.luma.samples[index]), alpha.depth);
            let straight = |channel: u8| {
                if parsed.premultiplied_alpha && a != 0 && a != 255 {
                    (u32::from(channel) * 255 / u32::from(a)).min(255) as u8
                } else {
                    channel
                }
            };
            rgba.extend_from_slice(&[straight(pixel[0]), straight(pixel[1]), straight(pixel[2]), a]);
        }
        data = rgba;
        has_alpha = true;
    }
    let (width, height) = (u32::try_from(width).map_err(|_| broken("too wide"))?, u32::try_from(height).map_err(|_| broken("too tall"))?);
    Ok(AvifImage { width, height, raster: Raster { width, height, has_alpha, data } })
}
