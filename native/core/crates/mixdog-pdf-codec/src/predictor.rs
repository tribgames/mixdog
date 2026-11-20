//! The predictors of Flate and LZW streams, as pdf.js `PredictorStream`: 2 is TIFF predictor 2 (per component
//! differences along a row), 10 to 15 are the PNG filters (each row starts with its own filter byte, whatever the
//! number says). `Colors`, `BitsPerComponent` and `Columns` give the row layout.
//!
//! A last row cut short by the end of the data is completed with zeros where the data is missing, as pdf.js does.

use crate::CodecError;

/// The `DecodeParms` values of the predictor; 0 stands for "not given" (pdf.js reads each with `|| default`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PredictorParams {
    pub predictor: i64,
    pub colors: i64,
    pub bits_per_component: i64,
    pub columns: i64,
}

fn put(row: &mut [u8], index: usize, value: u8) {
    if let Some(slot) = row.get_mut(index) {
        *slot = value;
    }
}

fn at(row: &[u8], index: usize) -> u8 {
    row.get(index).copied().unwrap_or(0)
}

/// Removes the predictor from `data`. Without a predictor (`predictor <= 1`) the data is returned as it is. The output
/// exceeding `limit` returns `ResourceLimit`.
pub fn decode(data: &[u8], params: &PredictorParams, limit: usize) -> Result<Vec<u8>, CodecError> {
    crate::check_output(decode_prefix(data, params, limit.saturating_add(1))?, limit)
}

fn decode_prefix(data: &[u8], params: &PredictorParams, limit: usize) -> Result<Vec<u8>, CodecError> {
    let predictor = params.predictor;
    if predictor <= 1 {
        return Ok(data[..data.len().min(limit)].to_vec());
    }
    if predictor != 2 && !(10..=15).contains(&predictor) {
        return Err(CodecError::Format(format!("Unsupported predictor: {predictor}")));
    }
    let pick = |value: i64, default: i64| if value > 0 { value } else { default };
    let colors = pick(params.colors, 1);
    let bits = pick(params.bits_per_component, 8);
    let columns = pick(params.columns, 1);
    let pix_bytes = usize::try_from((colors.saturating_mul(bits).saturating_add(7)) >> 3).unwrap_or(usize::MAX);
    let row_bytes = usize::try_from(columns.saturating_mul(colors).saturating_mul(bits).saturating_add(7) >> 3).unwrap_or(usize::MAX);
    let mut out = Vec::new();
    let mut pos = 0usize;
    let mut prev_row: Vec<u8> = Vec::new();
    while out.len() < limit {
        let png_filter = if predictor == 2 {
            None
        } else {
            let Some(&b) = data.get(pos) else { break };
            pos += 1;
            Some(b)
        };
        let raw = &data[pos.min(data.len())..pos.saturating_add(row_bytes).min(data.len())];
        pos += raw.len();
        if raw.is_empty() {
            break;
        }
        // Only the bytes that can reach the output are computed: a row wider than the limit is the last one.
        let want = row_bytes.min(limit - out.len());
        let row = match png_filter {
            None => tiff_row(raw, want, colors, bits, columns, row_bytes),
            Some(filter) => png_row(raw, want, filter, pix_bytes, &prev_row)?,
        };
        out.extend_from_slice(&row);
        prev_row = row;
    }
    out.truncate(limit);
    Ok(out)
}

fn tiff_row(raw: &[u8], n: usize, colors: i64, bits: i64, columns: i64, row_bytes: usize) -> Vec<u8> {
    let mut row = vec![0u8; n];
    let colors_n = usize::try_from(colors).unwrap_or(usize::MAX);
    let raw_at = |i: usize| raw.get(i).copied();
    if bits == 1 && colors == 1 {
        let mut inbuf: u8 = 0;
        for (i, slot) in row.iter_mut().enumerate() {
            let mut c = raw_at(i).unwrap_or(0) ^ inbuf;
            c ^= c >> 1;
            c ^= c >> 2;
            c ^= c >> 4;
            inbuf = (c & 1) << 7;
            *slot = c;
        }
    } else if bits == 8 {
        let head = colors_n.min(row_bytes);
        for (i, slot) in row.iter_mut().enumerate().take(head) {
            *slot = raw_at(i).unwrap_or(0);
        }
        for i in head..n {
            // A byte the data does not have makes the sum NaN in pdf.js, which stores as 0.
            row[i] = raw_at(i).map_or(0, |r| row[i - colors_n].wrapping_add(r));
        }
    } else if bits == 16 {
        let bytes_per_pixel = colors_n.saturating_mul(2);
        let head = bytes_per_pixel.min(row_bytes);
        for (i, slot) in row.iter_mut().enumerate().take(head) {
            *slot = raw_at(i).unwrap_or(0);
        }
        let mut i = head;
        while i < row_bytes && i < n {
            let sum = (u32::from(raw_at(i).unwrap_or(0)) << 8)
                + u32::from(raw_at(i + 1).unwrap_or(0))
                + (u32::from(at(&row, i - bytes_per_pixel)) << 8)
                + u32::from(at(&row, i + 1 - bytes_per_pixel));
            put(&mut row, i, (sum >> 8) as u8);
            put(&mut row, i + 1, sum as u8);
            i += 2;
        }
    } else {
        let sh = |x: i32, n: i64| x.wrapping_shr(n as u32);
        let shl = |x: i32, n: i64| x.wrapping_shl(n as u32);
        let mut comp = vec![0u8; colors_n.saturating_add(1).min(1 << 16)];
        let bit_mask = shl(1, bits).wrapping_sub(1);
        let (mut inbuf, mut outbuf) = (0i32, 0i32);
        let (mut inbits, mut outbits) = (0i64, 0i64);
        let mut j = 0usize;
        let mut k = 0usize;
        'columns: for _ in 0..columns {
            for slot in comp.iter_mut().take(colors_n) {
                if inbits < bits {
                    inbuf = shl(inbuf, 8) | i32::from(raw_at(j).unwrap_or(0));
                    j += 1;
                    inbits += 8;
                }
                *slot = (i32::from(*slot).wrapping_add(sh(inbuf, inbits - bits)) & bit_mask) as u8;
                inbits -= bits;
                outbuf = shl(outbuf, bits) | i32::from(*slot);
                outbits += bits;
                if outbits >= 8 {
                    put(&mut row, k, (sh(outbuf, outbits - 8) & 0xff) as u8);
                    k += 1;
                    outbits -= 8;
                }
            }
            if k >= n {
                break 'columns;
            }
        }
        if outbits > 0 {
            let value = shl(outbuf, 8 - outbits).wrapping_add(inbuf & shl(1, 8 - outbits).wrapping_sub(1));
            put(&mut row, k, value as u8);
        }
    }
    row
}

fn png_row(raw: &[u8], n: usize, filter: u8, pix: usize, prev: &[u8]) -> Result<Vec<u8>, CodecError> {
    let mut row = vec![0u8; n];
    // A byte the data does not have makes the sum NaN in pdf.js, which stores as 0: `r` is `None` then.
    let raw_at = |i: usize| raw.get(i).copied();
    let up_at = |i: usize| prev.get(i).copied().unwrap_or(0);
    let head = pix.min(n);
    match filter {
        0 => {
            for (i, slot) in row.iter_mut().enumerate() {
                *slot = raw_at(i).unwrap_or(0);
            }
        }
        1 => {
            for (i, slot) in row.iter_mut().enumerate().take(head) {
                *slot = raw_at(i).unwrap_or(0);
            }
            for i in head..n {
                row[i] = raw_at(i).map_or(0, |r| row[i - pix].wrapping_add(r));
            }
        }
        2 => {
            for (i, slot) in row.iter_mut().enumerate() {
                *slot = raw_at(i).map_or(0, |r| up_at(i).wrapping_add(r));
            }
        }
        3 => {
            for (i, slot) in row.iter_mut().enumerate().take(head) {
                *slot = raw_at(i).map_or(0, |r| (up_at(i) >> 1).wrapping_add(r));
            }
            for i in head..n {
                row[i] = raw_at(i).map_or(0, |r| {
                    let avg = ((u16::from(up_at(i)) + u16::from(row[i - pix])) >> 1) as u8;
                    avg.wrapping_add(r)
                });
            }
        }
        4 => {
            for (i, slot) in row.iter_mut().enumerate().take(head) {
                *slot = raw_at(i).map_or(0, |r| up_at(i).wrapping_add(r));
            }
            for i in head..n {
                let up = i32::from(up_at(i));
                let up_left = i32::from(up_at(i - pix));
                let left = i32::from(row[i - pix]);
                let p = left + up - up_left;
                let pa = (p - left).abs();
                let pb = (p - up).abs();
                let pc = (p - up_left).abs();
                let base = if pa <= pb && pa <= pc {
                    left
                } else if pb <= pc {
                    up
                } else {
                    up_left
                };
                row[i] = raw_at(i).map_or(0, |r| (base as u8).wrapping_add(r));
            }
        }
        other => {
            return Err(CodecError::Format(format!("Unsupported predictor: {other}")));
        }
    }
    Ok(row)
}
