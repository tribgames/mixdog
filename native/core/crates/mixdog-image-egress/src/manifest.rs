//! The stored verdict of one original: what import learned about it, in a small checksummed text so the vault, migration and
//! restart all read the same record. A [`Manifest`] is the only source of [`ImageFacts`] outside tests: facts are never built
//! from a supplied label, a codec flag or a previous successful send.

use sha2::Digest;
use sha2::Sha256;

use crate::decide::ImageFacts;
use crate::decide::RenditionFacts;
use crate::policy::ImageKind;

/// A rendition kept beside the original (a blob, by its digest): PNG, or JPEG for a HEIC converted by the OS codec.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Rendition {
    pub kind: ImageKind,
    pub digest: String,
    pub width: u32,
    pub height: u32,
    pub encoded_len: u64,
}

/// Permanent outcome of validating one original at one validator version.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Outcome {
    Accepted { kind: ImageKind, width: u32, height: u32, frames: u32, rendition: Option<Rendition> },
    /// A deterministic refusal, with its short text; never a transient failure.
    Refused { text: String },
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Manifest {
    pub validator_version: u32,
    /// Digest of the original bytes (64 hex), the key.
    pub original: String,
    pub name: String,
    pub encoded_len: u64,
    pub outcome: Outcome,
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '%' => out.push_str("%25"),
            '\n' => out.push_str("%0A"),
            '\r' => out.push_str("%0D"),
            other => out.push(other),
        }
    }
    out
}

fn unescape(text: &str) -> String {
    text.replace("%0A", "\n").replace("%0D", "\r").replace("%25", "%")
}

fn sum(body: &str) -> String {
    Sha256::digest(body.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn kind_name(kind: ImageKind) -> &'static str {
    kind.label()
}

fn kind_of(name: &str) -> Option<ImageKind> {
    [ImageKind::Png, ImageKind::Jpeg, ImageKind::Webp, ImageKind::Gif, ImageKind::Avif, ImageKind::Tiff, ImageKind::Svg, ImageKind::Heic, ImageKind::Bmp, ImageKind::Ico]
        .into_iter()
        .find(|k| kind_name(*k) == name)
}

impl Manifest {
    pub fn encode(&self) -> String {
        let mut body = format!(
            "image-manifest 1\nvalidator={}\noriginal={}\nname={}\nlen={}\n",
            self.validator_version,
            self.original,
            escape(&self.name),
            self.encoded_len
        );
        match &self.outcome {
            Outcome::Accepted { kind, width, height, frames, rendition } => {
                body.push_str(&format!("kind={}\nwidth={width}\nheight={height}\nframes={frames}\n", kind_name(*kind)));
                if let Some(r) = rendition {
                    body.push_str(&format!("rendition={}:{}:{}:{}:{}\n", kind_name(r.kind), r.digest, r.width, r.height, r.encoded_len));
                }
            }
            Outcome::Refused { text } => body.push_str(&format!("refused={}\n", escape(text))),
        }
        let checksum = sum(&body);
        body.push_str(&format!("sum={checksum}\n"));
        body
    }

    /// `None` for anything that is not an intact manifest of this format: a damaged or hand-made file is never trusted.
    pub fn decode(text: &str) -> Option<Self> {
        let at = text.rfind("sum=")?;
        let (body, tail) = text.split_at(at);
        if tail.trim_end() != format!("sum={}", sum(body)) {
            return None;
        }
        let mut lines = body.lines();
        if lines.next()? != "image-manifest 1" {
            return None;
        }
        let field = |lines: &mut std::str::Lines<'_>, key: &str| -> Option<String> { lines.next()?.strip_prefix(&format!("{key}="))?.to_owned().into() };
        let validator_version = field(&mut lines, "validator")?.parse().ok()?;
        let original = field(&mut lines, "original")?;
        if original.len() != 64 || !original.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let name = unescape(&field(&mut lines, "name")?);
        let encoded_len = field(&mut lines, "len")?.parse().ok()?;
        let first = lines.next()?;
        let outcome = if let Some(text) = first.strip_prefix("refused=") {
            Outcome::Refused { text: unescape(text) }
        } else {
            let kind = kind_of(first.strip_prefix("kind=")?)?;
            let width = field(&mut lines, "width")?.parse().ok()?;
            let height = field(&mut lines, "height")?.parse().ok()?;
            let frames = field(&mut lines, "frames")?.parse().ok()?;
            let rendition = match lines.next() {
                None => None,
                Some(line) => {
                    let mut parts = line.strip_prefix("rendition=")?.split(':');
                    Some(Rendition {
                        kind: kind_of(parts.next()?)?,
                        digest: parts.next()?.to_owned(),
                        width: parts.next()?.parse().ok()?,
                        height: parts.next()?.parse().ok()?,
                        encoded_len: parts.next()?.parse().ok()?,
                    })
                }
            };
            Outcome::Accepted { kind, width, height, frames, rendition }
        };
        Some(Self { validator_version, original, name, encoded_len, outcome })
    }

    /// The facts the destination matrix decides on; `None` for a refused original.
    pub fn facts(&self) -> Option<ImageFacts> {
        match &self.outcome {
            Outcome::Accepted { kind, width, height, frames, rendition } => Some(ImageFacts::from_manifest(
                *kind,
                *width,
                *height,
                *frames,
                self.encoded_len,
                rendition.as_ref().map(|r| RenditionFacts::from_rendition(r.kind, r.width, r.height, r.encoded_len)),
            )),
            Outcome::Refused { .. } => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accepted() -> Manifest {
        Manifest {
            validator_version: 1,
            original: "a".repeat(64),
            name: "scan 1\nfinal%.png".into(),
            encoded_len: 99,
            outcome: Outcome::Accepted {
                kind: ImageKind::Tiff,
                width: 10,
                height: 20,
                frames: 1,
                rendition: Some(Rendition { kind: ImageKind::Png, digest: "b".repeat(64), width: 10, height: 20, encoded_len: 55 }),
            },
        }
    }

    #[test]
    fn manifests_round_trip_including_awkward_names_and_refusals() {
        let m = accepted();
        assert_eq!(Manifest::decode(&m.encode()), Some(m.clone()));
        let refused = Manifest { outcome: Outcome::Refused { text: "corrupt\nimage".into() }, ..m };
        assert_eq!(Manifest::decode(&refused.encode()), Some(refused.clone()));
        assert!(refused.facts().is_none());
    }

    #[test]
    fn a_damaged_or_edited_manifest_is_not_trusted() {
        let text = accepted().encode();
        assert!(Manifest::decode(&text.replace("width=10", "width=11")).is_none());
        assert!(Manifest::decode(&text[..text.len() - 8]).is_none());
        assert!(Manifest::decode("").is_none());
    }

    #[test]
    fn facts_come_from_the_manifest() {
        let facts = accepted().facts().unwrap();
        assert_eq!(facts.kind(), ImageKind::Tiff);
        assert_eq!(facts.frames(), 1);
        assert_eq!(facts.rendition().map(|p| p.encoded_len()), Some(55));
    }
}
