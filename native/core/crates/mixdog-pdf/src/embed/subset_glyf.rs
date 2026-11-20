//! The TrueType (glyf) subset: fontkit's `TTFSubset`. The subset font keeps the glyphs of the list in order (glyph 0, the
//! missing glyph, first), the glyphs that composite glyphs name are appended to the list as they are met and the
//! component ids of the copied composite are rewritten to the subset's ids. Its tables are `head`, `hhea`, `loca`,
//! `maxp`, `cvt `, `prep`, `glyf`, `hmtx` and `fpgm`; the glyph data is copied byte for byte.

use std::collections::HashMap;

use super::{EmbedError, Sfnt, be_i16, be_u16, be_u32};

/// The subset of `glyphs` (original glyph ids, `.notdef` first) as an sfnt file. The ids of the glyphs in the file are
/// their positions in the list; `glyphs` is extended with the components of composite glyphs.
pub(super) fn subset(font: &Sfnt<'_>, glyphs: &mut Vec<u16>) -> Result<Vec<u8>, EmbedError> {
    let head = font.table(b"head").ok_or_else(|| EmbedError::new("The font has no head table"))?;
    let hhea = font.table(b"hhea").ok_or_else(|| EmbedError::new("The font has no hhea table"))?;
    let maxp = font.table(b"maxp").ok_or_else(|| EmbedError::new("The font has no maxp table"))?;
    let loca = font.table(b"loca").ok_or_else(|| EmbedError::new("The font has no loca table"))?;
    let glyf = font.table(b"glyf").ok_or_else(|| EmbedError::new("The font has no glyf table"))?;
    let hmtx = font.table(b"hmtx").unwrap_or(&[]);
    if head.len() < 54 || hhea.len() < 36 || maxp.len() < 6 {
        return Err(EmbedError::new("The font has a damaged head, hhea or maxp table"));
    }
    let glyph_count = usize::from(be_u16(maxp, 4).unwrap_or(0));
    let long_loca = be_i16(head, 50).unwrap_or(0) == 1;
    let metric_count = usize::from(be_u16(hhea, 34).unwrap_or(0));

    let offset_of = |gid: usize| -> Option<usize> {
        if long_loca { be_u32(loca, gid * 4).map(|value| value as usize) } else { be_u16(loca, gid * 2).map(|value| usize::from(value) * 2) }
    };
    let slice_of = |gid: u16| -> &[u8] {
        let gid = usize::from(gid);
        if gid >= glyph_count {
            return &[];
        }
        match (offset_of(gid), offset_of(gid + 1)) {
            (Some(start), Some(end)) if start <= end && end <= glyf.len() => &glyf[start..end],
            _ => &[],
        }
    };
    let metrics_of = |gid: u16| -> (u16, i16) {
        let gid = usize::from(gid);
        if metric_count == 0 {
            return (0, 0);
        }
        if gid < metric_count {
            (be_u16(hmtx, gid * 4).unwrap_or(0), be_i16(hmtx, gid * 4 + 2).unwrap_or(0))
        } else {
            (be_u16(hmtx, (metric_count - 1) * 4).unwrap_or(0), be_i16(hmtx, metric_count * 4 + (gid - metric_count) * 2).unwrap_or(0))
        }
    };

    let mut index: HashMap<u16, u16> = glyphs.iter().enumerate().map(|(position, gid)| (*gid, position as u16)).collect();
    let mut glyf_out: Vec<u8> = Vec::new();
    let mut offsets: Vec<usize> = Vec::new();
    let mut hmtx_out: Vec<u8> = Vec::new();
    let mut at = 0;
    while at < glyphs.len() {
        let gid = glyphs[at];
        at += 1;
        let mut buffer = slice_of(gid).to_vec();
        if buffer.len() >= 10 && be_i16(&buffer, 0).unwrap_or(0) < 0 {
            let mut position = 10;
            loop {
                let (Some(flags), Some(component)) = (be_u16(&buffer, position), be_u16(&buffer, position + 2)) else {
                    break;
                };
                let id = *index.entry(component).or_insert_with(|| {
                    glyphs.push(component);
                    (glyphs.len() - 1) as u16
                });
                buffer[position + 2..position + 4].copy_from_slice(&id.to_be_bytes());
                position += 4 + if flags & 0x0001 != 0 { 4 } else { 2 };
                if flags & 0x0008 != 0 {
                    position += 2;
                } else if flags & 0x0040 != 0 {
                    position += 4;
                } else if flags & 0x0080 != 0 {
                    position += 8;
                }
                if flags & 0x0020 == 0 {
                    break;
                }
            }
        }
        // The short `loca` stores half offsets: a glyph of odd length is padded so that every offset is even.
        if buffer.len() % 2 == 1 {
            buffer.push(0);
        }
        offsets.push(glyf_out.len());
        glyf_out.extend_from_slice(&buffer);
        let (advance, bearing) = metrics_of(gid);
        hmtx_out.extend_from_slice(&advance.to_be_bytes());
        hmtx_out.extend_from_slice(&bearing.to_be_bytes());
    }
    offsets.push(glyf_out.len());

    let long_out = glyf_out.len() > 0xFFFF;
    let mut loca_out = Vec::new();
    for offset in &offsets {
        if long_out {
            loca_out.extend_from_slice(&(*offset as u32).to_be_bytes());
        } else {
            loca_out.extend_from_slice(&((*offset / 2) as u16).to_be_bytes());
        }
    }
    let count = glyphs.len() as u16;
    let mut head_out = head.to_vec();
    head_out[8..12].copy_from_slice(&[0; 4]);
    head_out[50..52].copy_from_slice(&i16::from(long_out).to_be_bytes());
    let mut hhea_out = hhea.to_vec();
    hhea_out[34..36].copy_from_slice(&count.to_be_bytes());
    let mut maxp_out = maxp.to_vec();
    maxp_out[4..6].copy_from_slice(&count.to_be_bytes());

    let mut tables: Vec<([u8; 4], Vec<u8>)> = vec![(*b"head", head_out), (*b"hhea", hhea_out), (*b"loca", loca_out), (*b"maxp", maxp_out)];
    for tag in [b"cvt ", b"prep"] {
        if let Some(table) = font.table(tag).filter(|table| !table.is_empty()) {
            tables.push((*tag, table.to_vec()));
        }
    }
    tables.push((*b"glyf", glyf_out));
    tables.push((*b"hmtx", hmtx_out));
    if let Some(table) = font.table(b"fpgm").filter(|table| !table.is_empty()) {
        tables.push((*b"fpgm", table.to_vec()));
    }
    Ok(write_sfnt(tables))
}

fn checksum(data: &[u8]) -> u32 {
    let mut sum = 0u32;
    for chunk in data.chunks(4) {
        let mut word = [0u8; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        sum = sum.wrapping_add(u32::from_be_bytes(word));
    }
    sum
}

/// An sfnt file of `tables` (in this order): `true` as the version tag, every table padded to four bytes, the table
/// checksums and the `checkSumAdjustment` of `head` filled in.
fn write_sfnt(tables: Vec<([u8; 4], Vec<u8>)>) -> Vec<u8> {
    let count = tables.len();
    let exponent = (usize::BITS - 1 - count.leading_zeros()) as usize;
    let search_range = (1usize << exponent) * 16;
    let mut out = Vec::new();
    out.extend_from_slice(b"true");
    out.extend_from_slice(&(count as u16).to_be_bytes());
    out.extend_from_slice(&(search_range as u16).to_be_bytes());
    out.extend_from_slice(&(exponent as u16).to_be_bytes());
    out.extend_from_slice(&((count * 16 - search_range) as u16).to_be_bytes());
    let mut offset = 12 + count * 16;
    let mut head_at = None;
    for (tag, data) in &tables {
        if tag == b"head" {
            head_at = Some(offset);
        }
        out.extend_from_slice(tag);
        out.extend_from_slice(&checksum(data).to_be_bytes());
        out.extend_from_slice(&(offset as u32).to_be_bytes());
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        offset += data.len().div_ceil(4) * 4;
    }
    for (_, data) in &tables {
        out.extend_from_slice(data);
        out.resize(out.len().div_ceil(4) * 4, 0);
    }
    if let Some(at) = head_at {
        let adjustment = 0xB1B0_AFBAu32.wrapping_sub(checksum(&out));
        out[at + 8..at + 12].copy_from_slice(&adjustment.to_be_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_pads_the_last_word_with_zeros() {
        assert_eq!(checksum(&[0, 0, 0, 1, 2]), 1 + 0x0200_0000);
    }

    #[test]
    fn the_directory_counts_tables_the_way_fontkit_writes_it() {
        let out = write_sfnt(vec![(*b"head", vec![0; 54]), (*b"hhea", vec![0; 36]), (*b"maxp", vec![0; 6])]);
        assert_eq!(&out[..4], b"true");
        assert_eq!(be_u16(&out, 4), Some(3));
        assert_eq!(be_u16(&out, 6), Some(32));
        assert_eq!(be_u16(&out, 8), Some(1));
        assert_eq!(be_u16(&out, 10), Some(16));
        assert_eq!(out.len() % 4, 0);
    }
}
