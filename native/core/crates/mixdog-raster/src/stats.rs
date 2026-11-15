//! `stats()`: per-band minimum, maximum, sum, sum of squares, mean and standard deviation of the pixels as stored (no
//! alpha premultiplication), and where the first minimum and maximum are. The standard deviation is the one libvips
//! gives: the sample deviation, `sqrt((sum of squares - sum^2 / n) / (n - 1))`.

use crate::image::Image;

/// One band of `sharp(...).stats().channels`.
#[derive(Clone, PartialEq, Debug)]
pub struct ChannelStats {
    pub min: u8,
    pub max: u8,
    pub sum: f64,
    pub squares_sum: f64,
    pub mean: f64,
    pub stdev: f64,
    pub min_x: u32,
    pub min_y: u32,
    pub max_x: u32,
    pub max_y: u32,
}

/// The statistics of every band of `image`, in band order (grey, then alpha; or red, green, blue, then alpha).
pub fn stats(image: &Image) -> Vec<ChannelStats> {
    let bands: Vec<usize> = match image.channels() {
        1 => vec![0],
        2 => vec![0, 3],
        3 => vec![0, 1, 2],
        _ => vec![0, 1, 2, 3],
    };
    let width = image.width() as usize;
    let count = (width * image.height() as usize) as f64;
    bands
        .into_iter()
        .map(|band| {
            let (mut min, mut max) = (255u8, 0u8);
            let (mut min_at, mut max_at) = (0usize, 0usize);
            let (mut sum, mut squares) = (0f64, 0f64);
            for (i, pixel) in image.rgba().chunks_exact(4).enumerate() {
                let value = pixel[band];
                if value < min {
                    min = value;
                    min_at = i;
                }
                if value > max {
                    max = value;
                    max_at = i;
                }
                sum += f64::from(value);
                squares += f64::from(value) * f64::from(value);
            }
            let mean = sum / count;
            let stdev = if count > 1.0 { ((squares - sum * sum / count).max(0.0) / (count - 1.0)).sqrt() } else { 0.0 };
            ChannelStats {
                min,
                max,
                sum,
                squares_sum: squares,
                mean,
                stdev,
                min_x: (min_at % width) as u32,
                min_y: (min_at / width) as u32,
                max_x: (max_at % width) as u32,
                max_y: (max_at / width) as u32,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_two_value_band() {
        let image = Image::from_raw(2, 2, 4, &[0, 10, 20, 0, 255, 10, 20, 255, 0, 10, 20, 255, 255, 10, 20, 0]).unwrap();
        let bands = stats(&image);
        assert_eq!(bands.len(), 4);
        assert_eq!((bands[0].min, bands[0].max, bands[0].sum, bands[0].mean), (0, 255, 510.0, 127.5));
        assert!((bands[0].stdev - 147.224_318_643).abs() < 1e-6, "{}", bands[0].stdev);
        assert_eq!((bands[1].min, bands[1].max, bands[1].stdev), (10, 10, 0.0));
        assert_eq!((bands[3].min, bands[3].max), (0, 255));
        assert_eq!((bands[0].max_x, bands[0].max_y), (1, 0));
    }

    #[test]
    fn a_grey_image_has_one_band_and_with_alpha_two() {
        assert_eq!(stats(&Image::from_raw(1, 1, 1, &[7]).unwrap()).len(), 1);
        assert_eq!(stats(&Image::from_raw(1, 1, 2, &[7, 9]).unwrap()).len(), 2);
    }
}
