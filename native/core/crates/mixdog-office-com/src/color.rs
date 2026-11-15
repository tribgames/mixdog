//! `Color-Value` and `Color-Hex` of `office-com-host.ps1`.
//!
//! The casts and the arithmetic of the colour code are PowerShell's, so they live with the rest of them in
//! [`crate::ps::convert`] (checked against the recorded corpus there); this is the name the Office ports call them by.
//! `color_value("#FF8000")` is `33023`, `color_value("12")` is the refusal `Invalid color '12'; expected RRGGBB`, and
//! `color_hex(33023)` is `FF8000`.

pub use crate::ps::convert::color_hex;
pub use crate::ps::convert::color_hex_of;
pub use crate::ps::convert::color_value;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_colour_round_trips_through_the_bgr_integer() {
        assert_eq!(color_value("#FF8000"), Ok(33023));
        assert_eq!(color_value("0000FF"), Ok(0x00FF_0000));
        assert_eq!(color_hex(33023), "FF8000");
        assert_eq!(color_hex(i64::from(color_value("12AB9F").unwrap())), "12AB9F");
    }

    #[test]
    fn a_colour_that_is_not_six_digits_is_refused_with_the_scripts_text() {
        assert_eq!(color_value("12"), Err("Invalid color '12'; expected RRGGBB".to_owned()));
        assert_eq!(color_value("#1234567"), Err("Invalid color '#1234567'; expected RRGGBB".to_owned()));
    }
}
