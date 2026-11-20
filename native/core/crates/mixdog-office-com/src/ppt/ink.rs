//! The colour arithmetic of the deck code (`office-com-host.ps1`): the channels of an OLE colour, relative luminance, the
//! contrast ratio of two colours and the luminance of an `RRGGBB` ink. The issue pass uses them, and the editor's quiet ink
//! and ink-on-fill choice use `ink_luminance`.

/// `Ole-ColorChannel`: one channel (`shift` 0, 8 or 16 for red, green, blue) of a BGR colour as a fraction of 255.
pub fn ole_color_channel(color: i64, shift: u32) -> f64 {
    (((color >> shift) & 255) as f64) / 255.0
}

/// The channel with the gamma of sRGB taken out.
fn linear(channel: f64) -> f64 {
    if channel <= 0.03928 { channel / 12.92 } else { ((channel + 0.055) / 1.055).powf(2.4) }
}

/// `Color-Luminance`: the relative luminance of a BGR colour.
pub fn color_luminance(color: i64) -> f64 {
    let red = linear(ole_color_channel(color, 0));
    let green = linear(ole_color_channel(color, 8));
    let blue = linear(ole_color_channel(color, 16));
    (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
}

/// `Color-ContrastRatio`: the ratio of the lighter colour's luminance to the darker's, each with 0.05 added.
pub fn color_contrast_ratio(left: i64, right: i64) -> f64 {
    let left_luminance = color_luminance(left);
    let right_luminance = color_luminance(right);
    let lighter = left_luminance.max(right_luminance);
    let darker = left_luminance.min(right_luminance);
    (lighter + 0.05) / (darker + 0.05)
}

/// `Convert.ToInt32($hex.Substring($at, 2), 16)`, with the refusal text PowerShell shows.
fn hex_channel(units: &[u16], at: usize) -> Result<i32, String> {
    let Some(pair) = units.get(at..at + 2) else {
        return Err("Exception calling \"Substring\" with \"2\" argument(s): \"Index and length must refer to a location within the string.\r\nParameter name: length\"".to_owned());
    };
    let digit = |unit: u16| char::from_u32(u32::from(unit)).and_then(|c| c.to_digit(16));
    let convert_error = |reason: &str| format!("Exception calling \"ToInt32\" with \"2\" argument(s): \"{reason}\"");
    match (digit(pair[0]), digit(pair[1])) {
        (Some(high), Some(low)) => Ok((high * 16 + low) as i32),
        (Some(_), None) => Err(convert_error("Additional non-parsable characters are at the end of the string.")),
        _ => Err(convert_error("Could not find any recognizable digits.")),
    }
}

/// `Ink-Luminance`: the relative luminance of an `RRGGBB` ink (white on a dark fill, near-black on a light one is chosen
/// from it). A text that is not six hexadecimal digits is refused as the script's `Substring` and `ToInt32` refuse it.
pub fn ink_luminance(hex: &str) -> Result<f64, String> {
    let units: Vec<u16> = hex.encode_utf16().collect();
    let red = hex_channel(&units, 0)?;
    let green = hex_channel(&units, 2)?;
    let blue = hex_channel(&units, 4)?;
    let channel = |value: i32| linear(f64::from(value) / 255.0);
    Ok(0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn white_and_black_are_the_ends_of_the_scale() {
        assert!((color_luminance(0x00FF_FFFF) - 1.0).abs() < 1e-12);
        assert_eq!(color_luminance(0), 0.0);
        assert!((color_contrast_ratio(0, 0x00FF_FFFF) - 21.0).abs() < 1e-9);
        assert_eq!(color_contrast_ratio(0x0080_8080, 0x0080_8080), 1.0);
    }

    #[test]
    fn a_colour_is_read_blue_green_red_from_its_long() {
        assert_eq!(ole_color_channel(0x00FF_0000, 16), 1.0);
        assert_eq!(ole_color_channel(0x00FF_0000, 0), 0.0);
        assert_eq!(ole_color_channel(0x0000_FF00, 8), 1.0);
        assert_eq!(ole_color_channel(0x0000_00FF, 0), 1.0);
    }

    #[test]
    fn the_luminance_of_an_ink_text_matches_that_of_the_same_colour_as_a_long() {
        let from_text = ink_luminance("FF8000").expect("an ink");
        let from_long = color_luminance(0x0000_80FF);
        assert!((from_text - from_long).abs() < 1e-12);
    }

    #[test]
    fn an_ink_that_is_not_six_hex_digits_is_refused_with_the_scripts_texts() {
        assert!(ink_luminance("FFF").unwrap_err().starts_with("Exception calling \"Substring\""));
        assert_eq!(ink_luminance("GG0000").unwrap_err(), "Exception calling \"ToInt32\" with \"2\" argument(s): \"Could not find any recognizable digits.\"");
        assert_eq!(
            ink_luminance("0G0000").unwrap_err(),
            "Exception calling \"ToInt32\" with \"2\" argument(s): \"Additional non-parsable characters are at the end of the string.\""
        );
    }
}
