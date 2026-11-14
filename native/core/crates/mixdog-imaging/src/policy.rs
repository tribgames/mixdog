//! The size policy of `runtime/shared/read-image-resize.mjs`, constant for constant: what a provider takes of an
//! image (bytes, edge, patch budget), the box an image is fitted into, the token estimate and the text that tells the
//! model what was done to the picture.

/// Anthropic inline-image input is capped near 5 MB of base64 (the API rejects on the base64 length, not on raw
/// bytes).
pub const API_IMAGE_MAX_BASE64_SIZE: u64 = 5 * 1024 * 1024;
/// The raw-byte target that stays under that cap after the 4/3 base64 inflation: 3.75 MB.
pub const IMAGE_TARGET_RAW_SIZE: u64 = API_IMAGE_MAX_BASE64_SIZE * 3 / 4;
/// A standard model caps an image at 1568 px on its longest edge before processing.
pub const IMAGE_MAX_WIDTH: u32 = 1568;
pub const IMAGE_MAX_HEIGHT: u32 = 1568;
/// Floor for the shortest edge: patch tiling rejects a degenerate sub-patch image, so such an image is scaled up.
pub const IMAGE_MIN_DIMENSION: u32 = 200;
/// The token budget of one image: est tokens = base64 length * 0.125; the default aligns to the 5 MB base64 ceiling.
pub const DEFAULT_IMAGE_MAX_TOKENS: u64 = API_IMAGE_MAX_BASE64_SIZE.div_ceil(8);
pub const OPENAI_IMAGE_MAX_DIMENSION: u32 = 2048;
pub const OPENAI_IMAGE_PATCH_SIZE: u32 = 32;
pub const OPENAI_IMAGE_MAX_PATCHES: u32 = 1536;
/// Anthropic bills 28x28 patches and a standard-tier image may spend 1568 of them.
pub const ANTHROPIC_IMAGE_PATCH_SIZE: u32 = 28;
pub const ANTHROPIC_IMAGE_MAX_PATCHES: u32 = 1568;

/// The size limits of an image profile (`IMAGE_PROFILE_LIMITS`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ProfileLimits {
    pub max_width: u32,
    pub max_height: u32,
    pub patch_size: u32,
    pub max_patches: u32,
}

/// Whose image rules an image is prepared for.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Default)]
pub enum Profile {
    #[default]
    Anthropic,
    OpenAi,
}

impl Profile {
    pub fn limits(self) -> ProfileLimits {
        match self {
            Self::OpenAi => ProfileLimits {
                max_width: OPENAI_IMAGE_MAX_DIMENSION,
                max_height: OPENAI_IMAGE_MAX_DIMENSION,
                patch_size: OPENAI_IMAGE_PATCH_SIZE,
                max_patches: OPENAI_IMAGE_MAX_PATCHES,
            },
            Self::Anthropic => ProfileLimits {
                max_width: IMAGE_MAX_WIDTH,
                max_height: IMAGE_MAX_HEIGHT,
                patch_size: ANTHROPIC_IMAGE_PATCH_SIZE,
                max_patches: ANTHROPIC_IMAGE_MAX_PATCHES,
            },
        }
    }

    /// The name the cache key and the worker protocol use.
    pub fn name(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::Anthropic => "anthropic",
        }
    }

    /// `profile === 'openai' ? 'openai' : 'anthropic'`.
    pub fn from_name(name: &str) -> Self {
        if name == "openai" { Self::OpenAi } else { Self::Anthropic }
    }
}

/// `imageProfileForProvider`: the providers that bill like OpenAI take its profile, every other provider
/// Anthropic's.
pub fn image_profile_for_provider(provider: Option<&str>) -> Profile {
    let value = provider.unwrap_or_default().trim().to_lowercase();
    let openai_like = ["openai", "xai", "grok", "deepseek", "opencode-go", "mixdog-local"]
        .iter()
        .any(|name| value == *name || value.strip_prefix(name).is_some_and(|rest| rest.starts_with('-')));
    if openai_like { Profile::OpenAi } else { Profile::Anthropic }
}

fn patch_count(width: u32, height: u32, patch_size: u32) -> u64 {
    u64::from(width.max(1).div_ceil(patch_size)) * u64::from(height.max(1).div_ceil(patch_size))
}

/// `openAIImagePatchCount`.
pub fn openai_image_patch_count(width: u32, height: u32) -> u64 {
    patch_count(width, height, OPENAI_IMAGE_PATCH_SIZE)
}

/// JavaScript's `Math.round` for a non-negative number: halves go up.
pub(crate) fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// The box an image is fitted into, and whether the box may be larger than the image.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct TargetDimensions {
    pub width: u32,
    pub height: u32,
    pub allow_enlargement: bool,
}

/// `targetDimensions`: constrain the dimensions while preserving the aspect ratio. Both limits bind, and either one
/// can be the tighter: the per-edge ceiling governs an elongated image, the patch budget a wide one. A sub-patch
/// image is lifted to the floor, but never past the profile's own ceiling; rounding a partial patch up can leave one
/// row or column over budget, so the longer edge is trimmed until it fits.
pub fn target_dimensions(original_width: u32, original_height: u32, profile: Profile) -> TargetDimensions {
    let ProfileLimits { max_width, max_height, patch_size, max_patches } = profile.limits();
    let (original_w, original_h) = (f64::from(original_width), f64::from(original_height));
    let patch = f64::from(patch_size);
    let scale = 1f64
        .min(f64::from(max_width) / original_w)
        .min(f64::from(max_height) / original_h)
        .min(((f64::from(max_patches) * patch * patch) / (original_w * original_h)).sqrt());
    let mut width = (original_w * scale).floor().max(1.0);
    let mut height = (original_h * scale).floor().max(1.0);
    let mut allow_enlargement = false;
    let shortest = width.min(height);
    if shortest < f64::from(IMAGE_MIN_DIMENSION) {
        let ceiling = f64::from(max_width.min(max_height));
        let upscale = (f64::from(IMAGE_MIN_DIMENSION) / shortest).min(ceiling / width.max(height));
        if upscale > 1.0 {
            width = js_round(width * upscale).max(1.0);
            height = js_round(height * upscale).max(1.0);
            allow_enlargement = true;
        }
    }
    // Both are whole numbers below 2^32 here: the scale is at most 1 and an upscale stays under the ceiling.
    let mut width = width as u32;
    let mut height = height as u32;
    while patch_count(width, height, patch_size) > u64::from(max_patches) && (width > 1 || height > 1) {
        if width >= height {
            width -= 1;
        } else {
            height -= 1;
        }
    }
    TargetDimensions { width, height, allow_enlargement }
}

/// The length of the base64 text of `bytes` bytes (with padding).
pub fn base64_len(bytes: usize) -> usize {
    bytes.div_ceil(3) * 4
}

/// `estTokens`: the base64 length times 0.125, rounded up.
pub fn est_tokens(base64_len: usize) -> u64 {
    (base64_len as u64).div_ceil(8)
}

/// `estTokens` of the base64 text of `bytes` bytes.
pub fn est_tokens_of_bytes(bytes: usize) -> u64 {
    est_tokens(base64_len(bytes))
}

/// `normalizeFmt`: a missing format is png, `jpg` is jpeg, the rest lower-cased.
pub fn normalize_fmt(fmt: Option<&str>) -> String {
    match fmt {
        None | Some("") => "png".to_owned(),
        Some(value) => {
            let lower = value.to_lowercase();
            if lower == "jpg" { "jpeg".to_owned() } else { lower }
        }
    }
}

/// What an image was before and after the fit, in pixels.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Dimensions {
    pub original_width: u32,
    pub original_height: u32,
    pub display_width: u32,
    pub display_height: u32,
}

/// JavaScript's `Number.prototype.toFixed(2)`: ties on the exact binary value round up (Rust rounds them to even).
fn to_fixed_2(value: f64) -> String {
    let eighths = value * 8.0;
    let exact_tie = eighths.fract() == 0.0 && (eighths as u64) % 2 == 1;
    if exact_tie { format!("{:.2}", value + 0.001) } else { format!("{value:.2}") }
}

/// `imageMetadataText`: the metadata line prepended to a resized image, with the coordinate scale when the image was
/// downsampled. Without usable dimensions, only the source path (when there is one).
pub fn image_metadata_text(dims: Option<&Dimensions>, source_path: Option<&str>) -> Option<String> {
    let source = source_path.filter(|path| !path.is_empty());
    let only_source = || source.map(|path| format!("[Image source: {path}]"));
    let Some(dims) = dims else { return only_source() };
    let Dimensions { original_width, original_height, display_width, display_height } = *dims;
    if original_width == 0 || original_height == 0 || display_width == 0 || display_height == 0 {
        return only_source();
    }
    let was_resized = original_width != display_width || original_height != display_height;
    let mut parts = Vec::new();
    if let Some(path) = source {
        parts.push(format!("source: {path}"));
    }
    parts.push(format!("{original_width}x{original_height}"));
    if was_resized {
        let scale = f64::from(original_width) / f64::from(display_width);
        parts.push(format!(
            "displayed at {display_width}x{display_height}. Multiply coordinates by {} to map to the original image.",
            to_fixed_2(scale)
        ));
    } else {
        parts.push(format!("displayed at {display_width}x{display_height}"));
    }
    Some(format!("[Image: {}]", parts.join(", ")))
}

/// `supersedingImageMetadataText`: the line for an image whose display size changed after an earlier annotation was
/// already written next to it.
pub fn superseding_image_metadata_text(dims: &Dimensions) -> String {
    let line = image_metadata_text(Some(dims), None).unwrap_or_else(|| "null".to_owned());
    format!("{line} These display dimensions supersede any earlier display-size annotation for the following image.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(width: u32, height: u32, profile: Profile) -> (u32, u32, bool) {
        let t = target_dimensions(width, height, profile);
        (t.width, t.height, t.allow_enlargement)
    }

    #[test]
    fn the_constants_are_the_nodes() {
        assert_eq!(API_IMAGE_MAX_BASE64_SIZE, 5_242_880);
        assert_eq!(IMAGE_TARGET_RAW_SIZE, 3_932_160);
        assert_eq!(DEFAULT_IMAGE_MAX_TOKENS, 655_360);
        assert_eq!(Profile::OpenAi.limits(), ProfileLimits { max_width: 2048, max_height: 2048, patch_size: 32, max_patches: 1536 });
        assert_eq!(Profile::Anthropic.limits(), ProfileLimits { max_width: 1568, max_height: 1568, patch_size: 28, max_patches: 1568 });
    }

    #[test]
    fn a_provider_bills_like_openai_only_by_its_listed_prefixes() {
        for provider in ["openai", "OpenAI", " xai ", "grok-4", "deepseek-chat", "opencode-go", "mixdog-local-qwen", "openai-codex"] {
            assert_eq!(image_profile_for_provider(Some(provider)), Profile::OpenAi, "{provider}");
        }
        for provider in ["anthropic", "openaix", "xaix", "", "gemini"] {
            assert_eq!(image_profile_for_provider(Some(provider)), Profile::Anthropic, "{provider}");
        }
        assert_eq!(image_profile_for_provider(None), Profile::Anthropic);
    }

    #[test]
    fn an_image_inside_both_limits_keeps_its_size() {
        assert_eq!(target(800, 600, Profile::Anthropic), (800, 600, false));
        assert_eq!(target(1456, 819, Profile::Anthropic), (1456, 819, false));
    }

    #[test]
    fn the_patch_budget_binds_before_the_edge_does() {
        // 1568x882 clears 1568 px on both edges yet needs 1792 patches, so a 1080p frame lands near 1456x819 (the box is 1456x831, and fitting the picture inside it leaves 819 rows).
        let (width, height, enlarge) = target(1920, 1080, Profile::Anthropic);
        assert!(!enlarge);
        assert!(width <= 1568 && height <= 1568);
        assert!(patch_count(width, height, 28) <= 1568);
        assert_eq!((width, height), (1456, 831));
    }

    #[test]
    fn an_edge_over_the_ceiling_is_cut_to_it() {
        assert_eq!(target(4000, 100, Profile::Anthropic), (1568, 39, false));
        let (width, height, _) = target(3000, 3000, Profile::OpenAi);
        assert!(patch_count(width, height, 32) <= 1536);
    }

    #[test]
    fn a_sub_patch_image_is_lifted_to_the_floor_but_not_past_the_ceiling() {
        assert_eq!(target(1, 1, Profile::Anthropic), (200, 200, true));
        assert_eq!(target(100, 100, Profile::Anthropic), (200, 200, true));
        // An extreme aspect ratio keeps its shape rather than being blown up for its short edge.
        let (width, height, enlarge) = target(1, 1000, Profile::Anthropic);
        assert!(width <= 200 && height <= 1568, "{width}x{height}");
        assert!(enlarge);
    }

    #[test]
    fn an_over_budget_rounding_is_trimmed_off_the_longer_edge() {
        for (w, h) in [(1568, 1568), (1500, 1100), (2047, 1024)] {
            let (width, height, _) = target(w, h, Profile::OpenAi);
            assert!(patch_count(width, height, 32) <= 1536, "{w}x{h} -> {width}x{height}");
        }
    }

    #[test]
    fn tokens_are_the_base64_length_over_eight() {
        assert_eq!(base64_len(0), 0);
        assert_eq!(base64_len(1), 4);
        assert_eq!(base64_len(3), 4);
        assert_eq!(base64_len(4), 8);
        assert_eq!(est_tokens(8), 1);
        assert_eq!(est_tokens(9), 2);
        assert_eq!(est_tokens_of_bytes(IMAGE_TARGET_RAW_SIZE as usize), DEFAULT_IMAGE_MAX_TOKENS);
        assert_eq!(est_tokens_of_bytes(IMAGE_TARGET_RAW_SIZE as usize + 1), DEFAULT_IMAGE_MAX_TOKENS + 1);
    }

    #[test]
    fn formats_normalise_like_nodes_normalize_fmt() {
        assert_eq!(normalize_fmt(None), "png");
        assert_eq!(normalize_fmt(Some("")), "png");
        assert_eq!(normalize_fmt(Some("JPG")), "jpeg");
        assert_eq!(normalize_fmt(Some("WebP")), "webp");
    }

    #[test]
    fn the_metadata_line_names_the_scale_when_the_image_was_downsampled() {
        let resized = Dimensions { original_width: 1920, original_height: 1080, display_width: 1456, display_height: 819 };
        assert_eq!(
            image_metadata_text(Some(&resized), None).as_deref(),
            Some("[Image: 1920x1080, displayed at 1456x819. Multiply coordinates by 1.32 to map to the original image.]")
        );
        assert_eq!(
            image_metadata_text(Some(&resized), Some("a.png")).as_deref(),
            Some("[Image: source: a.png, 1920x1080, displayed at 1456x819. Multiply coordinates by 1.32 to map to the original image.]")
        );
        let same = Dimensions { original_width: 10, original_height: 20, display_width: 10, display_height: 20 };
        assert_eq!(image_metadata_text(Some(&same), None).as_deref(), Some("[Image: 10x20, displayed at 10x20]"));
        let empty = Dimensions { original_width: 0, original_height: 20, display_width: 10, display_height: 20 };
        assert_eq!(image_metadata_text(Some(&empty), Some("p")).as_deref(), Some("[Image source: p]"));
        assert_eq!(image_metadata_text(None, None), None);
        assert_eq!(image_metadata_text(None, Some("")), None);
    }

    #[test]
    fn to_fixed_rounds_a_binary_tie_up_like_javascript() {
        assert_eq!(to_fixed_2(0.125), "0.13");
        assert_eq!(to_fixed_2(2.375), "2.38");
        assert_eq!(to_fixed_2(1.5), "1.50");
        assert_eq!(to_fixed_2(1.0 / 3.0), "0.33");
    }

    #[test]
    fn a_superseding_line_carries_the_notice() {
        let dims = Dimensions { original_width: 400, original_height: 400, display_width: 200, display_height: 200 };
        assert_eq!(
            superseding_image_metadata_text(&dims),
            "[Image: 400x400, displayed at 200x200. Multiply coordinates by 2.00 to map to the original image.] These display dimensions supersede any earlier display-size annotation for the following image."
        );
    }
}
