//! The pictures of a deck: how pptxgenjs names, types and stores them. A picture arrives as a data URI
//! (`image/png;base64,...`) or as a file the caller has read (pptxgenjs reads the path itself; this crate holds no
//! file access, so the caller passes the bytes with the path). Each one becomes a media relationship of its slide
//! (`ISlideRelMedia`): the target `../media/image-<slide>-<n>.<ext>`, the type `image/<ext>`, and, for a path used
//! twice on one slide, the first one's target again. The bytes of every relationship are written under `ppt/media/`.

use base64::Engine;
use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};

/// A picture read from a file: its path (the name pptxgenjs shows and dedups by) and the file's bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageFile {
    pub path: String,
    pub bytes: Vec<u8>,
}

/// What a media relationship holds to write.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum MediaData {
    /// The `data` option: a data URI or a bare base64 text.
    Encoded(String),
    /// A file's bytes.
    Bytes(Vec<u8>),
}

/// `ISlideRelMedia`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct MediaRel {
    pub path: String,
    /// `type`: `image/<ext>`, or `image` for a background picture.
    pub mime: String,
    pub extn: String,
    pub data: MediaData,
    pub rid: usize,
    pub target: String,
    pub is_duplicate: bool,
}

const DEFAULT_PICTURE_NAME: &str = "preencoded";

/// The extension of a picture (`addImageDefinition` step 1): the path's, else `png`, unless the data URI names
/// a type. Lower case when it comes from the path.
pub(crate) fn image_extension(data: &str, path: &str) -> String {
    if !data.is_empty() {
        if let Some(named) = mime_subtype(data) {
            return named;
        }
        if data.to_lowercase().contains("image/svg+xml") {
            return "svg".to_owned();
        }
    }
    let after_slash = path.rfind('/').map_or(path, |at| &path[at + 1..]);
    let before_query = after_slash.split('?').next().unwrap_or("");
    let last_dot = before_query.rsplit('.').next().unwrap_or("");
    let before_hash = last_dot.split('#').next().unwrap_or("");
    let extension = if before_hash.is_empty() { "png" } else { before_hash };
    extension.to_lowercase()
}

/// `/image\/(\w+);/.exec(data)[1]`: the first `image/<word>;` in the text.
fn mime_subtype(data: &str) -> Option<String> {
    let mut rest = data;
    while let Some(at) = rest.find("image/") {
        let after = &rest[at + "image/".len()..];
        let word: String = after.chars().take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_').collect();
        if !word.is_empty() && after[word.len()..].starts_with(';') {
            return Some(word);
        }
        rest = after;
    }
    None
}

/// The relationship of a picture added with `addImage` (not an SVG): the existing one's target for a path already
/// used on the slide with the same type, else a new `image-<slide>-<n>` name.
pub(crate) fn picture_rel(existing: &[MediaRel], slide_number: usize, rid: usize, data: &str, file: Option<&ImageFile>) -> MediaRel {
    let path = file.map_or("", |file| file.path.as_str());
    let extn = image_extension(data, path);
    let mime = format!("image/{extn}");
    let same = existing.iter().find(|rel| !rel.path.is_empty() && rel.path == path && rel.mime == mime && !rel.is_duplicate);
    let target = match same {
        Some(rel) if !rel.target.is_empty() => rel.target.clone(),
        _ => format!("../media/image-{slide_number}-{}.{extn}", existing.len() + 1),
    };
    let stored = match file {
        Some(file) if data.is_empty() => MediaData::Bytes(file.bytes.clone()),
        _ => MediaData::Encoded(data.to_owned()),
    };
    MediaRel {
        path: if path.is_empty() { format!("{DEFAULT_PICTURE_NAME}.{extn}") } else { path.to_owned() },
        mime,
        extn,
        data: stored,
        rid,
        target,
        is_duplicate: same.is_some_and(|rel| !rel.target.is_empty()),
    }
}

/// The relationship of a background picture (`addBackgroundDefinition`): the type is plain `image`, the id counts
/// the slide's media only, the target is `../media/<slide name>-image-<n>.<ext>` and the extension is the path's
/// (`jpg` written as `jpeg`), whatever the data is.
pub(crate) fn background_rel(existing: &[MediaRel], slide_name: &str, data: Option<&str>, file: Option<&ImageFile>) -> MediaRel {
    let path = file.map_or(format!("{DEFAULT_PICTURE_NAME}.png"), |file| file.path.clone());
    let last = path.rsplit('.').next().unwrap_or("");
    let extension = if last.is_empty() { "png" } else { last };
    let extension = extension.split('?').next().unwrap_or("");
    let extn = if extension == "jpg" { "jpeg".to_owned() } else { extension.to_owned() };
    let name = dashed_whitespace(slide_name);
    let stored = match (data, file) {
        (Some(data), _) if !data.is_empty() => MediaData::Encoded(data.to_owned()),
        (_, Some(file)) => MediaData::Bytes(file.bytes.clone()),
        _ => MediaData::Encoded(String::new()),
    };
    MediaRel {
        path,
        mime: "image".to_owned(),
        target: format!("../media/{name}-image-{}.{extn}", existing.len() + 1),
        extn,
        data: stored,
        rid: existing.len() + 1,
        is_duplicate: false,
    }
}

/// `name.replace(/\s+/gi, '-')`: each run of white space as one dash.
fn dashed_whitespace(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut in_run = false;
    for ch in name.chars() {
        if ch.is_whitespace() {
            if !in_run {
                out.push('-');
            }
            in_run = true;
        } else {
            out.push(ch);
            in_run = false;
        }
    }
    out
}

const LENIENT: GeneralPurpose = GeneralPurpose::new(
    &alphabet::STANDARD,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent).with_decode_allow_trailing_bits(true),
);

/// JSZip's `base64` decode of a file's text: characters outside the alphabet are dropped and the rest must come in
/// groups of four.
pub(crate) fn decode_base64(text: &str) -> Result<Vec<u8>, String> {
    let clean: String = text.chars().filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '/' | '=')).collect();
    if !clean.len().is_multiple_of(4) {
        return Err("Invalid base64 input, bad content length.".to_owned());
    }
    LENIENT.decode(clean.as_bytes()).map_err(|error| format!("Invalid base64 input: {error}"))
}

impl MediaRel {
    /// The bytes written for the relationship (`createChartMediaRels`): a data text is given a `image/png;base64,`
    /// header when it lacks one, and what follows its last comma is the base64.
    pub(crate) fn bytes(&self) -> Result<Vec<u8>, String> {
        match &self.data {
            MediaData::Bytes(bytes) => Ok(bytes.clone()),
            MediaData::Encoded(text) => decode_base64(text.rsplit(',').next().unwrap_or("")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_from_data_path_and_default() {
        assert_eq!(image_extension("image/jpeg;base64,AAAA", ""), "jpeg");
        assert_eq!(image_extension("data:image/webp;base64,AAAA", "x.png"), "webp");
        assert_eq!(image_extension("", "dir/Photo.JPG?w=1#top"), "jpg");
        assert_eq!(image_extension("", "noextension"), "noextension");
        assert_eq!(image_extension("", ""), "png");
        assert_eq!(image_extension("image/svg+xml;base64,AAAA", ""), "svg");
        assert_eq!(image_extension("text/plain;base64,AAAA", "a.gif"), "gif");
    }

    #[test]
    fn a_picture_used_twice_by_path_shares_its_target() {
        let file = ImageFile { path: "logo.png".to_owned(), bytes: vec![1, 2, 3] };
        let first = picture_rel(&[], 2, 1, "", Some(&file));
        assert_eq!(first.target, "../media/image-2-1.png");
        assert!(!first.is_duplicate);
        let second = picture_rel(&[first.clone()], 2, 2, "", Some(&file));
        assert_eq!(second.target, "../media/image-2-1.png");
        assert!(second.is_duplicate);
        let other = picture_rel(&[first], 2, 2, "image/png;base64,AAAA", None);
        assert_eq!(other.target, "../media/image-2-2.png");
        assert_eq!(other.path, "preencoded.png");
    }

    #[test]
    fn data_is_decoded_after_its_last_comma() {
        let rel = picture_rel(&[], 1, 1, "image/png;base64,QUJD", None);
        assert_eq!(rel.bytes().expect("bytes"), b"ABC");
        assert!(decode_base64("QUJDR").is_err());
        assert_eq!(decode_base64("QU JD\n").expect("whitespace is dropped"), b"ABC");
    }

    #[test]
    fn a_background_picture_is_named_by_its_slide() {
        let rel = background_rel(&[], "Slide 3", Some("image/jpeg;base64,QUJD"), None);
        assert_eq!(rel.target, "../media/Slide-3-image-1.png");
        assert_eq!(rel.mime, "image");
        assert_eq!(rel.rid, 1);
        let file = ImageFile { path: "bg.jpg?x=1".to_owned(), bytes: vec![9] };
        let rel = background_rel(&[rel], "Slide 3", None, Some(&file));
        assert_eq!(rel.target, "../media/Slide-3-image-2.jpeg");
        assert_eq!(rel.rid, 2);
    }
}
