//! The JP2 file format (ITU-T T.800 annex I): the box structure around the codestream, the image header, bits per
//! component, colour specification, palette, component mapping and channel definition boxes.
//!
//! The first codestream box is the image; a stream that starts with SOC is a bare codestream with no boxes.

use std::ops::Range;

use super::JpxError;

const SIGNATURE: u32 = 0x0D0A_870A;

fn fourcc(b: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*b)
}

/// `ihdr`: the image header box.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageHeader {
    pub height: u32,
    pub width: u32,
    pub components: u16,
    /// Bits per component minus one with the sign in bit 7, or 255 when the `bpcc` box holds them.
    pub bpc: u8,
    pub compression: u8,
    pub unknown_colourspace: u8,
    pub intellectual_property: u8,
}

/// `colr`: one colour specification box.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColourSpec {
    /// 1 enumerated, 2 restricted ICC profile, 3 any ICC profile, 4 vendor colour.
    pub method: u8,
    pub precedence: i8,
    pub approximation: u8,
    /// EnumCS for method 1: 16 sRGB, 17 greyscale, 18 sYCC, 12 CMYK, and the other values of the standard's table I.10.
    pub enumerated: Option<u32>,
    /// The ICC profile (methods 2 and 3) or the vendor data (method 4).
    pub profile: Vec<u8>,
}

/// `pclr`: the palette.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Palette {
    pub entries: u16,
    /// Bit depth minus one of each palette column, the sign in bit 7.
    pub column_depths: Vec<u8>,
    /// `entries * columns` values, entry-major.
    pub values: Vec<u32>,
}

/// `cmap`: one component mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ComponentMap {
    pub component: u16,
    /// 0 direct use, 1 palette mapping.
    pub mapping_type: u8,
    pub palette_column: u8,
}

/// `cdef`: one channel definition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChannelDef {
    pub channel: u16,
    /// 0 colour, 1 opacity, 2 premultiplied opacity, 65535 unspecified.
    pub kind: u16,
    /// 0 the whole image, 1..=65534 the colour with that number, 65535 unassociated.
    pub association: u16,
}

/// What the box structure of a JP2 file says besides the codestream.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Jp2Info {
    pub brand: Option<[u8; 4]>,
    pub header: Option<ImageHeader>,
    pub bits_per_component: Vec<u8>,
    pub colours: Vec<ColourSpec>,
    pub palette: Option<Palette>,
    pub component_map: Vec<ComponentMap>,
    pub channel_defs: Vec<ChannelDef>,
    /// Capture and display resolution (`res `), in grid points per metre: `(vertical, horizontal)`, when present.
    pub capture_resolution: Option<(f64, f64)>,
    pub display_resolution: Option<(f64, f64)>,
    /// Where the codestream lies in the input.
    pub codestream: Range<usize>,
}

impl Jp2Info {
    /// The first colour specification box, the one a reader uses (OpenJPEG ignores the later ones).
    pub fn colour(&self) -> Option<&ColourSpec> {
        self.colours.first()
    }

    /// The channels the file declares as opacity (`SMaskInData` 1) or premultiplied opacity (`SMaskInData` 2):
    /// `(channel, premultiplied)`.
    pub fn alpha_channels(&self) -> Vec<(u16, bool)> {
        self.channel_defs
            .iter()
            .filter(|d| d.kind == 1 || d.kind == 2)
            .map(|d| (d.channel, d.kind == 2))
            .collect()
    }
}

struct BoxHeader {
    kind: u32,
    content: Range<usize>,
    end: usize,
}

fn box_at(data: &[u8], pos: usize, limit: usize) -> Result<Option<BoxHeader>, JpxError> {
    if pos + 8 > limit {
        return Ok(None);
    }
    let lbox = u32::from_be_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as u64;
    let kind = u32::from_be_bytes([data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]]);
    let (header, len) = match lbox {
        1 => {
            if pos + 16 > limit {
                return Err(JpxError::new("a JP2 box ends inside its extended length"));
            }
            let mut x = [0u8; 8];
            x.copy_from_slice(&data[pos + 8..pos + 16]);
            (16u64, u64::from_be_bytes(x))
        }
        0 => (8u64, (limit - pos) as u64),
        n => (8u64, n),
    };
    if len < header {
        return Err(JpxError::new("a JP2 box is shorter than its header"));
    }
    let end = (pos as u64).saturating_add(len).min(limit as u64) as usize;
    Ok(Some(BoxHeader { kind, content: pos + header as usize..end, end }))
}

fn be16(d: &[u8], p: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*d.get(p)?, *d.get(p + 1)?]))
}

fn be32(d: &[u8], p: usize) -> Option<u32> {
    Some(((be16(d, p)? as u32) << 16) | be16(d, p + 2)? as u32)
}

fn short() -> JpxError {
    JpxError::new("a JP2 box is shorter than its fields")
}

/// A resolution box (T.800 I.5.3.7): VRcN, VRcD, HRcN, HRcD (two bytes each), VRcE and HRcE (one byte each), the
/// resolution being `numerator / denominator * 10^exponent` grid points per metre: `(vertical, horizontal)`.
fn resolution(d: &[u8]) -> Option<(f64, f64)> {
    let value = |at: usize, exponent: usize| -> Option<f64> {
        let num = be16(d, at)? as f64;
        let den = be16(d, at + 2)? as f64;
        let exp = *d.get(exponent)? as i8;
        if den == 0.0 {
            return None;
        }
        Some(num / den * 10f64.powi(exp as i32))
    };
    Some((value(0, 8)?, value(4, 9)?))
}

fn parse_header_box(kind: u32, c: &[u8], info: &mut Jp2Info) -> Result<(), JpxError> {
    match kind {
        k if k == fourcc(b"ihdr") => {
            info.header = Some(ImageHeader {
                height: be32(c, 0).ok_or_else(short)?,
                width: be32(c, 4).ok_or_else(short)?,
                components: be16(c, 8).ok_or_else(short)?,
                bpc: *c.get(10).ok_or_else(short)?,
                compression: *c.get(11).ok_or_else(short)?,
                unknown_colourspace: *c.get(12).ok_or_else(short)?,
                intellectual_property: *c.get(13).ok_or_else(short)?,
            });
        }
        k if k == fourcc(b"bpcc") => info.bits_per_component = c.to_vec(),
        k if k == fourcc(b"colr") => {
            let method = *c.first().ok_or_else(short)?;
            let precedence = *c.get(1).ok_or_else(short)? as i8;
            let approximation = *c.get(2).ok_or_else(short)?;
            let (enumerated, profile) = if method == 1 {
                (Some(be32(c, 3).ok_or_else(short)?), Vec::new())
            } else {
                (None, c[3..].to_vec())
            };
            info.colours.push(ColourSpec { method, precedence, approximation, enumerated, profile });
        }
        k if k == fourcc(b"pclr") => {
            let entries = be16(c, 0).ok_or_else(short)?;
            let columns = *c.get(2).ok_or_else(short)? as usize;
            let depths = c.get(3..3 + columns).ok_or_else(short)?.to_vec();
            let mut at = 3 + columns;
            let mut values = Vec::with_capacity(entries as usize * columns);
            for _ in 0..entries {
                for d in &depths {
                    let bytes = ((d & 0x7f) as usize + 1).div_ceil(8);
                    let mut v: u32 = 0;
                    for _ in 0..bytes {
                        v = (v << 8) | *c.get(at).ok_or_else(short)? as u32;
                        at += 1;
                    }
                    values.push(v);
                }
            }
            info.palette = Some(Palette { entries, column_depths: depths, values });
        }
        k if k == fourcc(b"cmap") => {
            info.component_map = c
                .chunks_exact(4)
                .map(|m| ComponentMap {
                    component: u16::from_be_bytes([m[0], m[1]]),
                    mapping_type: m[2],
                    palette_column: m[3],
                })
                .collect();
        }
        k if k == fourcc(b"cdef") => {
            let n = be16(c, 0).ok_or_else(short)? as usize;
            for i in 0..n {
                let p = 2 + i * 6;
                info.channel_defs.push(ChannelDef {
                    channel: be16(c, p).ok_or_else(short)?,
                    kind: be16(c, p + 2).ok_or_else(short)?,
                    association: be16(c, p + 4).ok_or_else(short)?,
                });
            }
        }
        k if k == fourcc(b"res ") => {
            let mut at = 0;
            while let Some(b) = box_at(c, at, c.len())? {
                let body = &c[b.content.clone()];
                if b.kind == fourcc(b"resc") {
                    info.capture_resolution = resolution(body);
                } else if b.kind == fourcc(b"resd") {
                    info.display_resolution = resolution(body);
                }
                at = b.end;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Reads the box structure of a JP2 file, or reports a bare codestream (input starting with SOC) as an info whose
/// codestream is the whole input.
pub fn parse_container(data: &[u8]) -> Result<Jp2Info, JpxError> {
    if data.len() >= 2 && data[0] == 0xFF && data[1] == 0x4F {
        return Ok(Jp2Info { codestream: 0..data.len(), ..Jp2Info::default() });
    }
    let mut info = Jp2Info::default();
    let mut pos = 0usize;
    let mut first = true;
    let mut found = false;
    while let Some(b) = box_at(data, pos, data.len())? {
        if first {
            if b.kind != fourcc(b"jP  ") || be32(data, b.content.start) != Some(SIGNATURE) {
                return Err(JpxError::new("not a JPEG 2000 file: no JP2 signature box"));
            }
            first = false;
        }
        let content = &data[b.content.clone()];
        if b.kind == fourcc(b"ftyp") {
            if let Some(brand) = content.get(0..4) {
                info.brand = Some([brand[0], brand[1], brand[2], brand[3]]);
            }
        } else if b.kind == fourcc(b"jp2h") {
            let mut at = 0;
            while let Some(sub) = box_at(content, at, content.len())? {
                parse_header_box(sub.kind, &content[sub.content.clone()], &mut info)?;
                at = sub.end;
            }
        } else if b.kind == fourcc(b"jp2c") {
            info.codestream = b.content.clone();
            found = true;
            break;
        }
        pos = b.end;
    }
    if !found {
        return Err(JpxError::new("no JPEG 2000 codestream box found"));
    }
    Ok(info)
}
