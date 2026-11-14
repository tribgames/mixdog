//! The set-of-marks burn-in (`observation/som-overlay.ts`): the captured frame with one outlined rectangle and one numbered
//! badge per element, drawn into the pixels the model will point at. The Electron offscreen renderer is gone; the rectangles
//! and badges are rasterised here with a 5x7 digit bitmap font, so the marks land on the same pixels without a window.
//! PNG is read and written here on `flate2` (no PNG crate is in the offline lock); JPEG is read by `jpeg-decoder` and cannot
//! be written until `jpeg-encoder` 0.6 is vendored, so a JPEG frame is left unmarked with the reason reported.

use std::io::Cursor;

/// Where a mark came from (`markColor`): the colour of its outline and badge.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarkSource {
    Uia,
    Ocr,
    Msaa,
}

impl MarkSource {
    /// `ocr` and `msaa` are named; everything else (`uia`, a missing or unknown source) is the default colour.
    pub fn parse(source: Option<&str>) -> Self {
        match source {
            Some("ocr") => Self::Ocr,
            Some("msaa") => Self::Msaa,
            _ => Self::Uia,
        }
    }

    fn color(self) -> [u8; 3] {
        match self {
            Self::Ocr => [0x72, 0xe0, 0x6a],
            Self::Msaa => [0xff, 0xb0, 0x20],
            Self::Uia => [0x29, 0xd3, 0xff],
        }
    }
}

/// One element to mark: its number, its `[x, y, w, h]` bounds in frame pixels and where it was found.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mark {
    pub mark: u32,
    pub bounds: [f64; 4],
    pub source: MarkSource,
}

/// An image as bytes with its MIME type.
#[derive(Clone, Debug, PartialEq)]
pub struct PaintedImage {
    pub bytes: Vec<u8>,
    pub mime: String,
}

#[derive(Debug)]
pub enum PaintError {
    /// The input could not be decoded as the MIME type says, or is not a pixel layout this path draws on.
    Decode(String),
    Encode(String),
}

impl std::fmt::Display for PaintError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Decode(reason) => write!(f, "mark overlay could not read the frame: {reason}"),
            Self::Encode(reason) => write!(f, "mark overlay could not write the frame: {reason}"),
        }
    }
}

impl std::error::Error for PaintError {}

/// The result of a degrading paint (`renderSomOverlay`'s `{image, rendered, error}`).
#[derive(Clone, Debug, PartialEq)]
pub struct Overlay {
    pub image: PaintedImage,
    pub rendered: bool,
    pub error: Option<String>,
}

const BADGE_HEIGHT: f64 = 19.0;
const BADGE_RADIUS: f64 = 4.0;
const BADGE_TEXT_TOP: f64 = 5.0;
const GLYPH_WIDTH: usize = 6;
const GLYPH_HEIGHT: usize = 9;
const GLYPH_ADVANCE: f64 = 8.0;
const INK: [u8; 3] = [0x10, 0x14, 0x19];

/// The digits 0-9 as 5 columns by 7 rows, one `u8` per row with the left column in bit 4.
const DIGITS: [[u8; 7]; 10] = [
    [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
    [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
    [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
    [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
    [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
    [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
    [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
    [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
    [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
    [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],
];

/// An 8-bit RGB raster.
struct Raster {
    width: usize,
    height: usize,
    rgb: Vec<u8>,
}

impl Raster {
    fn put(&mut self, x: i64, y: i64, color: [u8; 3]) {
        if x < 0 || y < 0 || x >= self.width as i64 || y >= self.height as i64 {
            return;
        }
        let at = (y as usize * self.width + x as usize) * 3;
        self.rgb[at..at + 3].copy_from_slice(&color);
    }

    /// Paints every pixel whose centre lies inside the rectangle and satisfies `inside`, clipped to the image.
    fn paint(&mut self, [x0, y0, x1, y1]: [f64; 4], color: [u8; 3], inside: impl Fn(f64, f64) -> bool) {
        let from_x = (x0.floor() as i64 - 1).max(0);
        let to_x = (x1.ceil() as i64 + 1).min(self.width as i64);
        let from_y = (y0.floor() as i64 - 1).max(0);
        let to_y = (y1.ceil() as i64 + 1).min(self.height as i64);
        for y in from_y..to_y {
            for x in from_x..to_x {
                let (cx, cy) = (x as f64 + 0.5, y as f64 + 0.5);
                if cx > x0 && cx < x1 && cy > y0 && cy < y1 && inside(cx, cy) {
                    self.put(x, y, color);
                }
            }
        }
    }
}

/// Whether the point is inside the rectangle with its corners rounded by `radius`.
fn in_rounded(cx: f64, cy: f64, [x0, y0, x1, y1]: [f64; 4], radius: f64) -> bool {
    if cx < x0 || cx > x1 || cy < y0 || cy > y1 {
        return false;
    }
    let dx = (x0 + radius - cx).max(cx - (x1 - radius)).max(0.0);
    let dy = (y0 + radius - cy).max(cy - (y1 - radius)).max(0.0);
    dx * dx + dy * dy <= radius * radius
}

/// The badge's width for a mark (`max(20, digits * 8 + 10)`).
fn badge_width(mark: u32) -> f64 {
    (mark.to_string().len() as f64 * GLYPH_ADVANCE + 10.0).max(20.0)
}

/// The badge's top-left corner for a mark whose bounds start at `x, y` in an image `width` wide (`badgeX`, `badgeY`):
/// clamped to the left and top edges and to the right edge, one badge above the rectangle.
fn badge_origin(x: f64, y: f64, width: f64, badge_width: f64) -> (f64, f64) {
    ((width - badge_width).min(x).max(0.0), (y - 20.0).max(0.0))
}

fn draw_digit(raster: &mut Raster, digit: u32, left: f64, top: f64) {
    let rows = &DIGITS[digit as usize % 10];
    for gy in 0..GLYPH_HEIGHT {
        let row = rows[gy * 7 / GLYPH_HEIGHT];
        for gx in 0..GLYPH_WIDTH {
            if row >> (4 - gx * 5 / GLYPH_WIDTH) & 1 == 1 {
                raster.put((left + gx as f64).round() as i64, (top + gy as f64).round() as i64, INK);
            }
        }
    }
}

fn draw_mark(raster: &mut Raster, mark: &Mark, scale: (f64, f64)) {
    let [bx, by, bw, bh] = mark.bounds;
    let (x, y) = (bx * scale.0, by * scale.1);
    let (w, h) = ((bw * scale.0).max(1.0), (bh * scale.1).max(1.0));
    let color = mark.source.color();
    // The 2px outline is centred on the rectangle's edge: an outer rectangle one pixel out minus an inner one pixel in.
    let outer = [x - 1.0, y - 1.0, x + w + 1.0, y + h + 1.0];
    let inner = [x + 1.0, y + 1.0, x + w - 1.0, y + h - 1.0];
    let hollow = inner[0] < inner[2] && inner[1] < inner[3];
    raster.paint(outer, color, |cx, cy| !(hollow && cx > inner[0] && cx < inner[2] && cy > inner[1] && cy < inner[3]));

    let badge_w = badge_width(mark.mark);
    let (badge_x, badge_y) = badge_origin(x, y, raster.width as f64, badge_w);
    let shell = [badge_x, badge_y, badge_x + badge_w, badge_y + BADGE_HEIGHT];
    let core = [shell[0] + 1.0, shell[1] + 1.0, shell[2] - 1.0, shell[3] - 1.0];
    raster.paint(shell, INK, |cx, cy| in_rounded(cx, cy, shell, BADGE_RADIUS));
    raster.paint(core, color, |cx, cy| in_rounded(cx, cy, core, BADGE_RADIUS - 1.0));

    let digits: Vec<u32> = mark.mark.to_string().bytes().map(|digit| u32::from(digit - b'0')).collect();
    let text_width = digits.len() as f64 * GLYPH_ADVANCE - (GLYPH_ADVANCE - GLYPH_WIDTH as f64);
    let left = (badge_x + (badge_w - text_width) / 2.0).round();
    let top = (badge_y + BADGE_TEXT_TOP).round();
    for (index, digit) in digits.into_iter().enumerate() {
        draw_digit(raster, digit, left + index as f64 * GLYPH_ADVANCE, top);
    }
}

fn is_png(mime: &str) -> bool {
    mime.eq_ignore_ascii_case("image/png")
}

fn decode(image: &[u8], mime: &str) -> Result<Raster, PaintError> {
    if is_png(mime) {
        return decode_png(image);
    }
    let mut decoder = jpeg_decoder::Decoder::new(Cursor::new(image));
    let pixels = decoder.decode().map_err(|error| PaintError::Decode(error.to_string()))?;
    let info = decoder.info().ok_or_else(|| PaintError::Decode("jpeg without a header".to_owned()))?;
    let (width, height) = (usize::from(info.width), usize::from(info.height));
    let rgb = match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => pixels,
        jpeg_decoder::PixelFormat::L8 => pixels.iter().flat_map(|&gray| [gray; 3]).collect(),
        other => return Err(PaintError::Decode(format!("jpeg pixel format {other:?} is not drawn on"))),
    };
    if rgb.len() != width * height * 3 {
        return Err(PaintError::Decode("pixel count does not match the header".to_owned()));
    }
    Ok(Raster { width, height, rgb })
}

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

fn crc32(parts: &[&[u8]]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in parts.iter().flat_map(|part| part.iter()) {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

fn paeth(left: u8, up: u8, upper_left: u8) -> u8 {
    let (a, b, c) = (i32::from(left), i32::from(up), i32::from(upper_left));
    let estimate = a + b - c;
    let (pa, pb, pc) = ((estimate - a).abs(), (estimate - b).abs(), (estimate - c).abs());
    if pa <= pb && pa <= pc {
        left
    } else if pb <= pc {
        up
    } else {
        upper_left
    }
}

/// Reads a non-interlaced PNG (every colour type and bit depth, palettes expanded, 16-bit stripped, alpha dropped). The
/// workspace has no PNG crate (`png` is not in Cargo.lock), so the container is read here on `flate2`, which it has.
fn decode_png(image: &[u8]) -> Result<Raster, PaintError> {
    use std::io::Read;
    let fail = |reason: &str| PaintError::Decode(reason.to_owned());
    if image.len() < 8 || image[..8] != PNG_SIGNATURE {
        return Err(fail("not a png"));
    }
    let (mut header, mut palette, mut data) = (None, Vec::new(), Vec::new());
    let mut at = 8usize;
    while at + 12 <= image.len() {
        let length = u32::from_be_bytes([image[at], image[at + 1], image[at + 2], image[at + 3]]) as usize;
        let kind = &image[at + 4..at + 8];
        let body = image.get(at + 8..at + 8 + length).ok_or_else(|| fail("truncated png chunk"))?;
        match kind {
            b"IHDR" if body.len() >= 13 => header = Some(body.to_vec()),
            b"PLTE" => palette = body.to_vec(),
            b"IDAT" => data.extend_from_slice(body),
            b"IEND" => break,
            _ => {}
        }
        at += 12 + length;
    }
    let header = header.ok_or_else(|| fail("png without a header"))?;
    let width = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
    let height = u32::from_be_bytes([header[4], header[5], header[6], header[7]]) as usize;
    let (depth, color, interlace) = (usize::from(header[8]), header[9], header[12]);
    if interlace != 0 {
        return Err(fail("interlaced png is not drawn on"));
    }
    let channels = match (color, depth) {
        (0, 1 | 2 | 4 | 8 | 16) => 1,
        (3, 1 | 2 | 4 | 8) => 1,
        (2, 8 | 16) => 3,
        (4, 8 | 16) => 2,
        (6, 8 | 16) => 4,
        _ => return Err(fail("png colour type and depth are not a valid pair")),
    };
    if width == 0 || height == 0 || width.checked_mul(height).is_none_or(|pixels| pixels > 1 << 28) {
        return Err(fail("png size is not drawn on"));
    }
    let bits = channels * depth;
    let stride = (width * bits).div_ceil(8);
    let step = bits.div_ceil(8);
    let mut raw = Vec::with_capacity((stride + 1) * height);
    flate2::read::ZlibDecoder::new(data.as_slice())
        .take(((stride + 1) * height) as u64)
        .read_to_end(&mut raw)
        .map_err(|error| PaintError::Decode(error.to_string()))?;
    if raw.len() != (stride + 1) * height {
        return Err(fail("png pixel data is short"));
    }
    let mut rows = vec![0u8; stride * height];
    for row in 0..height {
        let filter = raw[row * (stride + 1)];
        let line = &raw[row * (stride + 1) + 1..(row + 1) * (stride + 1)];
        for i in 0..stride {
            let left = if i >= step { rows[row * stride + i - step] } else { 0 };
            let up = if row > 0 { rows[(row - 1) * stride + i] } else { 0 };
            let upper_left = if row > 0 && i >= step { rows[(row - 1) * stride + i - step] } else { 0 };
            rows[row * stride + i] = line[i].wrapping_add(match filter {
                0 => 0,
                1 => left,
                2 => up,
                3 => ((u16::from(left) + u16::from(up)) / 2) as u8,
                4 => paeth(left, up, upper_left),
                _ => return Err(fail("png filter type is unknown")),
            });
        }
    }
    let sample = |row: usize, index: usize| -> u8 {
        let line = &rows[row * stride..(row + 1) * stride];
        match depth {
            16 => line[index * 2],
            8 => line[index],
            _ => {
                let per_byte = 8 / depth;
                let shift = 8 - depth * (index % per_byte + 1);
                (line[index / per_byte] >> shift) & ((1u8 << depth) - 1)
            }
        }
    };
    let mut rgb = Vec::with_capacity(width * height * 3);
    for row in 0..height {
        for x in 0..width {
            let pixel = match color {
                0 | 4 => {
                    let gray = sample(row, x * channels);
                    let gray = if depth < 8 { (u16::from(gray) * 255 / ((1u16 << depth) - 1)) as u8 } else { gray };
                    [gray; 3]
                }
                3 => {
                    let at = usize::from(sample(row, x)) * 3;
                    let entry = palette.get(at..at + 3).ok_or_else(|| fail("png palette entry is missing"))?;
                    [entry[0], entry[1], entry[2]]
                }
                _ => [sample(row, x * channels), sample(row, x * channels + 1), sample(row, x * channels + 2)],
            };
            rgb.extend_from_slice(&pixel);
        }
    }
    Ok(Raster { width, height, rgb })
}

fn png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], body: &[u8]) {
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(body);
    out.extend_from_slice(&crc32(&[kind, body]).to_be_bytes());
}

/// An 8-bit RGB PNG with the Sub filter on every row, deflated by `flate2`.
fn encode_png(raster: &Raster) -> Result<Vec<u8>, PaintError> {
    use std::io::Write;
    let stride = raster.width * 3;
    let mut filtered = Vec::with_capacity((stride + 1) * raster.height);
    for line in raster.rgb.chunks_exact(stride) {
        filtered.push(1);
        filtered.extend((0..stride).map(|i| line[i].wrapping_sub(if i >= 3 { line[i - 3] } else { 0 })));
    }
    let mut zlib = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    zlib.write_all(&filtered).map_err(|error| PaintError::Encode(error.to_string()))?;
    let deflated = zlib.finish().map_err(|error| PaintError::Encode(error.to_string()))?;
    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&(raster.width as u32).to_be_bytes());
    header.extend_from_slice(&(raster.height as u32).to_be_bytes());
    header.extend_from_slice(&[8, 2, 0, 0, 0]);
    let mut out = PNG_SIGNATURE.to_vec();
    png_chunk(&mut out, b"IHDR", &header);
    png_chunk(&mut out, b"IDAT", &deflated);
    png_chunk(&mut out, b"IEND", &[]);
    Ok(out)
}

fn encode(raster: &Raster, mime: &str, _quality: u8) -> Result<PaintedImage, PaintError> {
    if is_png(mime) {
        return Ok(PaintedImage { bytes: encode_png(raster)?, mime: "image/png".to_owned() });
    }
    // Nothing in the offline lock encodes JPEG: `jpeg-encoder` 0.6 must be fetched into the registry cache and added to
    // Cargo.lock before a JPEG frame can carry the burn-in. Until then the frame goes out unmarked and this is reported.
    Err(PaintError::Encode("jpeg output needs the jpeg-encoder 0.6 crate, which is not in the offline Cargo.lock".to_owned()))
}

/// Burns the marks into the image and re-encodes it in the input's format (`image/png` stays PNG, anything else is JPEG at
/// `quality`). `width` and `height` are the frame's size the bounds are in; a decoded image of another size has the bounds
/// scaled onto it. A mark with a non-finite bound is skipped, as `renderSomOverlay` did.
pub fn paint_marks(
    image: &[u8],
    mime: &str,
    width: u32,
    height: u32,
    marks: &[Mark],
    quality: u8,
) -> Result<PaintedImage, PaintError> {
    let mut raster = decode(image, mime)?;
    let scale = (raster.width as f64 / f64::from(width.max(1)), raster.height as f64 / f64::from(height.max(1)));
    for mark in marks.iter().filter(|mark| mark.bounds.iter().all(|value| value.is_finite())) {
        draw_mark(&mut raster, mark, scale);
    }
    encode(&raster, mime, quality)
}

/// `renderSomOverlay`: no marks or a failed paint leaves the original image and says why, so a capture never fails on it.
pub fn paint_marks_or_input(
    image: &[u8],
    mime: &str,
    width: u32,
    height: u32,
    marks: &[Mark],
    quality: u8,
) -> Overlay {
    let original = || PaintedImage { bytes: image.to_vec(), mime: mime.to_owned() };
    if marks.is_empty() {
        return Overlay { image: original(), rendered: false, error: None };
    }
    match paint_marks(image, mime, width, height, marks, quality) {
        Ok(painted) if !painted.bytes.is_empty() => Overlay { image: painted, rendered: true, error: None },
        Ok(_) => Overlay { image: original(), rendered: false, error: None },
        Err(error) => Overlay { image: original(), rendered: false, error: Some(error.to_string()) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank(width: u32, height: u32, mime: &str) -> Vec<u8> {
        let raster = Raster { width: width as usize, height: height as usize, rgb: vec![0x80; (width * height * 3) as usize] };
        encode(&raster, mime, 95).unwrap().bytes
    }

    fn pixel(painted: &PaintedImage, x: usize, y: usize) -> [u8; 3] {
        let raster = decode(&painted.bytes, &painted.mime).unwrap();
        let at = (y * raster.width + x) * 3;
        [raster.rgb[at], raster.rgb[at + 1], raster.rgb[at + 2]]
    }

    fn mark(number: u32, bounds: [f64; 4], source: MarkSource) -> Mark {
        Mark { mark: number, bounds, source }
    }

    fn near(actual: [u8; 3], expected: [u8; 3]) -> bool {
        actual.iter().zip(expected).all(|(a, e)| a.abs_diff(e) <= 12)
    }

    #[test]
    fn badge_position_follows_the_overlay_rules() {
        assert_eq!(badge_width(7), 20.0);
        assert_eq!(badge_width(12), 26.0);
        assert_eq!(badge_width(123), 34.0);
        // Above the rectangle, with the left edge of the rectangle.
        assert_eq!(badge_origin(50.0, 60.0, 200.0, 20.0), (50.0, 40.0));
        // Clamped to the top and the left edge.
        assert_eq!(badge_origin(-5.0, 4.0, 200.0, 20.0), (0.0, 0.0));
        // Clamped so the badge ends inside the right edge.
        assert_eq!(badge_origin(195.0, 60.0, 200.0, 26.0), (174.0, 40.0));
    }

    #[test]
    fn colours_follow_the_source() {
        assert_eq!(MarkSource::parse(Some("ocr")).color(), [0x72, 0xe0, 0x6a]);
        assert_eq!(MarkSource::parse(Some("msaa")).color(), [0xff, 0xb0, 0x20]);
        assert_eq!(MarkSource::parse(Some("uia")).color(), [0x29, 0xd3, 0xff]);
        assert_eq!(MarkSource::parse(None), MarkSource::Uia);
        assert_eq!(MarkSource::parse(Some("other")), MarkSource::Uia);
    }

    #[test]
    fn outline_and_badge_land_on_the_overlay_pixels_in_png() {
        let source = blank(200, 120, "image/png");
        let marks = [mark(5, [40.0, 50.0, 60.0, 30.0], MarkSource::Ocr)];
        let painted = paint_marks(&source, "image/png", 200, 120, &marks, 90).unwrap();
        assert_eq!(painted.mime, "image/png");
        // The outline is 2px wide centred on the edge: columns 39 and 40 on the left.
        assert_eq!(pixel(&painted, 39, 65), [0x72, 0xe0, 0x6a]);
        assert_eq!(pixel(&painted, 40, 65), [0x72, 0xe0, 0x6a]);
        assert_eq!(pixel(&painted, 41, 65), [0x80, 0x80, 0x80]);
        assert_eq!(pixel(&painted, 70, 80), [0x72, 0xe0, 0x6a]);
        assert_eq!(pixel(&painted, 70, 70), [0x80, 0x80, 0x80]);
        // The badge sits at (40, 30), 20x19: its border is dark, its body the source colour, the corner is rounded off.
        assert_eq!(pixel(&painted, 50, 30), INK);
        assert_eq!(pixel(&painted, 41, 33), [0x72, 0xe0, 0x6a]);
        assert_eq!(pixel(&painted, 40, 30), [0x80, 0x80, 0x80]);
        // Something of the digit is drawn in ink inside the badge.
        let inked = (42..58).flat_map(|x| (35..46).map(move |y| (x, y))).filter(|&(x, y)| pixel(&painted, x, y) == INK).count();
        assert!(inked > 10, "digit pixels: {inked}");
    }

    #[test]
    fn a_jpeg_frame_is_left_unmarked_with_the_reason_until_the_encoder_is_vendored() {
        let raster = Raster { width: 4, height: 4, rgb: vec![0x80; 48] };
        let reason = encode(&raster, "image/jpeg", 92).unwrap_err().to_string();
        assert!(reason.contains("jpeg-encoder"), "{reason}");
    }

    #[test]
    fn png_round_trips_and_the_crc_matches() {
        assert_eq!(crc32(&[b"IEND"]), 0xae42_6082);
        let rgb: Vec<u8> = (0..30 * 17 * 3).map(|i| ((i * 7) % 251) as u8).collect();
        let raster = Raster { width: 30, height: 17, rgb: rgb.clone() };
        let bytes = encode_png(&raster).unwrap();
        assert_eq!(&bytes[..8], &PNG_SIGNATURE);
        assert_eq!(decode_png(&bytes).unwrap().rgb, rgb);
    }

    #[test]
    fn a_badge_at_the_edges_stays_inside_the_image() {
        let source = blank(100, 60, "image/png");
        let marks = [mark(123, [96.0, 2.0, 30.0, 20.0], MarkSource::Uia), mark(4, [-10.0, -10.0, 8.0, 8.0], MarkSource::Uia)];
        let painted = paint_marks(&source, "image/png", 100, 60, &marks, 90).unwrap();
        // 123 is 34 wide, so its badge starts at 66 and ends at the right edge (the last column is its dark border).
        assert_eq!(pixel(&painted, 99, 10), INK);
        assert_eq!(pixel(&painted, 98, 10), [0x29, 0xd3, 0xff]);
        assert_eq!(pixel(&painted, 70, 10), [0x29, 0xd3, 0xff]);
        assert_eq!(pixel(&painted, 50, 10), [0x80, 0x80, 0x80]);
    }

    #[test]
    fn a_mark_with_a_non_finite_bound_is_skipped() {
        let source = blank(64, 64, "image/png");
        let marks = [mark(1, [f64::NAN, 4.0, 10.0, 10.0], MarkSource::Uia)];
        let painted = paint_marks(&source, "image/png", 64, 64, &marks, 90).unwrap();
        assert_eq!(decode(&painted.bytes, "image/png").unwrap().rgb, vec![0x80; 64 * 64 * 3]);
    }

    #[test]
    fn corrupt_input_degrades_to_the_input() {
        let junk = vec![1u8, 2, 3, 4];
        let marks = [mark(1, [1.0, 1.0, 5.0, 5.0], MarkSource::Uia)];
        assert!(paint_marks(&junk, "image/jpeg", 10, 10, &marks, 80).is_err());
        let overlay = paint_marks_or_input(&junk, "image/png", 10, 10, &marks, 80);
        assert!(!overlay.rendered);
        assert!(overlay.error.is_some());
        assert_eq!(overlay.image, PaintedImage { bytes: junk, mime: "image/png".to_owned() });
    }

    #[test]
    fn no_marks_leaves_the_image_untouched_without_an_error() {
        let source = vec![0xff, 0xd8, 1, 2, 3];
        let overlay = paint_marks_or_input(&source, "image/jpeg", 32, 32, &[], 80);
        assert!(!overlay.rendered);
        assert_eq!(overlay.error, None);
        assert_eq!(overlay.image.bytes, source);
    }

    #[test]
    fn a_decoded_image_of_another_size_has_the_bounds_scaled() {
        let source = blank(100, 100, "image/png");
        let marks = [mark(1, [40.0, 40.0, 20.0, 20.0], MarkSource::Uia)];
        let painted = paint_marks(&source, "image/png", 200, 200, &marks, 90).unwrap();
        assert_eq!(pixel(&painted, 20, 30), [0x29, 0xd3, 0xff]);
    }
}
