//! Compact elapsed-time labels (`src/tui/time-format.mjs`, which re-exports `runtime/shared/time-format.mjs`):
//! `42s`, `9m 23s`, `1h 2m 3s`, `1d 3h 20m`. Every surface derives its tool-card detail rows ("Running - 12s") from this
//! one formatter.

use mixdog_js::number_to_string;

/// The options of `formatDuration`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DurationOptions {
    /// Only the largest unit: `2h` for 2 h 5 m.
    pub most_significant_only: bool,
    /// Drop the units that are zero at the end: `1h` for 1 h 0 m 0 s.
    pub hide_trailing_zeros: bool,
}

/// `formatDuration(ms, options)`: empty for a value that is not a number and for less than a second.
pub fn format_duration(ms: f64, options: DurationOptions) -> String {
    if !ms.is_finite() {
        return String::new();
    }
    let value = ms.max(0.0);
    if value < 60_000.0 {
        if value < 1_000.0 {
            return String::new();
        }
        return format!("{}s", number_to_string((value / 1000.0).floor()));
    }

    let days = (value / 86_400_000.0).floor();
    let hours = ((value % 86_400_000.0) / 3_600_000.0).floor();
    let minutes = ((value % 3_600_000.0) / 60_000.0).floor();
    let seconds = ((value % 60_000.0) / 1000.0).floor();
    let n = number_to_string;

    if options.most_significant_only {
        if days > 0.0 {
            return format!("{}d", n(days));
        }
        if hours > 0.0 {
            return format!("{}h", n(hours));
        }
        if minutes > 0.0 {
            return format!("{}m", n(minutes));
        }
        return format!("{}s", n(seconds));
    }

    let hide = options.hide_trailing_zeros;
    if days > 0.0 {
        if hide && hours == 0.0 && minutes == 0.0 {
            return format!("{}d", n(days));
        }
        if hide && minutes == 0.0 {
            return format!("{}d {}h", n(days), n(hours));
        }
        return format!("{}d {}h {}m", n(days), n(hours), n(minutes));
    }
    if hours > 0.0 {
        if hide && minutes == 0.0 && seconds == 0.0 {
            return format!("{}h", n(hours));
        }
        if hide && seconds == 0.0 {
            return format!("{}h {}m", n(hours), n(minutes));
        }
        return format!("{}h {}m {}s", n(hours), n(minutes), n(seconds));
    }
    if minutes > 0.0 {
        if hide && seconds == 0.0 {
            return format!("{}m", n(minutes));
        }
        return format!("{}m {}s", n(minutes), n(seconds));
    }
    format!("{}s", n(seconds))
}

/// `formatElapsed(ms)`: the default label, empty when there is nothing to show (zero, negative, under a second, not a
/// number or infinite).
pub fn format_elapsed(ms: f64) -> String {
    let n = if ms.is_nan() { 0.0 } else { ms.max(0.0) };
    if !n.is_finite() || n < 1000.0 {
        return String::new();
    }
    format_duration(n, DurationOptions::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_follow_the_documented_examples() {
        let plain = DurationOptions::default();
        assert_eq!(format_duration(42_000.0, plain), "42s");
        assert_eq!(format_duration(563_000.0, plain), "9m 23s");
        assert_eq!(format_duration(3_723_000.0, plain), "1h 2m 3s");
        assert_eq!(format_duration(98_400_000.0, plain), "1d 3h 20m");
    }

    #[test]
    fn options_shorten_the_label() {
        let trimmed = DurationOptions { hide_trailing_zeros: true, ..DurationOptions::default() };
        let leading = DurationOptions { most_significant_only: true, ..DurationOptions::default() };
        assert_eq!(format_duration(3_600_000.0, trimmed), "1h");
        assert_eq!(format_duration(3_660_000.0, trimmed), "1h 1m");
        assert_eq!(format_duration(86_400_000.0, trimmed), "1d");
        assert_eq!(format_duration(7_500_000.0, leading), "2h");
    }

    #[test]
    fn nothing_to_show_is_empty() {
        assert_eq!(format_duration(999.0, DurationOptions::default()), "");
        assert_eq!(format_duration(f64::NAN, DurationOptions::default()), "");
        assert_eq!(format_elapsed(-5.0), "");
        assert_eq!(format_elapsed(f64::INFINITY), "");
        assert_eq!(format_elapsed(61_000.0), "1m 1s");
    }
}
