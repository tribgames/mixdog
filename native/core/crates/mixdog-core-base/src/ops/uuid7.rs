//! Op ids are client-generated UUIDv7 strings (P §9.1); their 48-bit millisecond timestamp
//! orders them against a scope's retention watermark (P §9.5).

use std::sync::Arc;

use mixdog_core_api::error::CoreError;
use mixdog_core_api::ids::OpId;

/// The Unix-millisecond timestamp of a canonical lowercase UUIDv7
/// (`xxxxxxxx-xxxx-7xxx-[89ab]xxx-xxxxxxxxxxxx`). Anything else is refused as invalid params
/// at `path`.
pub(super) fn op_time_ms(id: &OpId, path: &str) -> Result<u64, CoreError> {
    let text = id.as_str().as_bytes();
    let hex = |b: u8| matches!(b, b'0'..=b'9' | b'a'..=b'f');
    let well_formed = text.len() == 36
        && text.iter().enumerate().all(|(i, &b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            14 => b == b'7',
            19 => matches!(b, b'8' | b'9' | b'a' | b'b'),
            _ => hex(b),
        });
    if !well_formed {
        return Err(CoreError::InvalidParams {
            path: path.into(),
            expected: "a lowercase UUIDv7".into(),
        });
    }
    let digits = text[..8].iter().chain(&text[9..13]);
    Ok(digits.fold(0u64, |ms, &b| {
        let nibble = match b {
            b'0'..=b'9' => b - b'0',
            _ => b - b'a' + 10,
        };
        (ms << 4) | u64::from(nibble)
    }))
}

/// The watermark as the wire shows it: the smallest UUIDv7 of millisecond `ms`.
pub(super) fn watermark_text(ms: u64) -> Arc<str> {
    format!(
        "{:08x}-{:04x}-7000-8000-000000000000",
        ms >> 16,
        ms & 0xffff
    )
    .into()
}
