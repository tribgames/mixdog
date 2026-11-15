//! The pasted-attachment buffers (`app/use-pasted-buffers.mjs`). A large pasted image or text folds into an `[Image #N]` or
//! `[Pasted text #N +M lines]` token of the prompt; the payloads live here until submit expands the tokens. `install`
//! rehydrates a queued or restored draft's buffers, the snapshot clears drop exactly the entries a submit consumed, and
//! `register` mints the next token of a fresh paste.

use std::collections::{BTreeMap, BTreeSet};

use mixdog_term::paste::{ImageAttachment, PastedImage, format_image_ref, format_pasted_text_ref};

/// One buffer kind: the entries by id and the next id to mint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BufferSlice<T> {
    entries: BTreeMap<u64, T>,
    next_id: u64,
}

impl<T: Clone + PartialEq> Default for BufferSlice<T> {
    fn default() -> Self {
        Self { entries: BTreeMap::new(), next_id: 1 }
    }
}

impl<T: Clone + PartialEq> BufferSlice<T> {
    pub fn entries(&self) -> &BTreeMap<u64, T> {
        &self.entries
    }

    /// The id the next fresh paste gets.
    pub fn next_id(&self) -> u64 {
        self.next_id
    }

    /// `install(buffers, { merge })`: an empty set is a no-op; the next id clears the highest id held.
    pub fn install(&mut self, buffers: &BTreeMap<u64, T>, merge: bool) {
        if buffers.is_empty() {
            return;
        }
        let mut next = if merge { self.entries.clone() } else { BTreeMap::new() };
        next.extend(buffers.iter().map(|(id, buffer)| (*id, buffer.clone())));
        let max_id = next.keys().copied().max().unwrap_or(0);
        if max_id >= self.next_id {
            self.next_id = max_id + 1;
        }
        self.entries = next;
    }

    /// `clearSnapshot(snapshot)`: `None` drops everything, a snapshot drops only the entries that are still the very ones it
    /// holds (an entry replaced since stays).
    pub fn clear_snapshot(&mut self, snapshot: Option<&BTreeMap<u64, T>>) {
        let Some(snapshot) = snapshot else {
            self.entries.clear();
            return;
        };
        for (id, buffer) in snapshot {
            if self.entries.get(id) == Some(buffer) {
                self.entries.remove(id);
            }
        }
    }

    /// The snapshot clear of a submit that knows the ids it consumed (`None`: every entry).
    pub fn clear_ids(&mut self, ids: Option<&BTreeSet<u64>>) {
        match ids {
            None => self.entries.clear(),
            Some(ids) => self.entries.retain(|id, _| !ids.contains(id)),
        }
    }

    /// Stores what `make` builds for the next id; a refusal leaves the id sequence untouched.
    fn register_with(&mut self, make: impl FnOnce(u64) -> Option<T>) -> Option<u64> {
        let id = self.next_id;
        let entry = make(id)?;
        self.next_id = id + 1;
        self.entries.insert(id, entry);
        Some(id)
    }
}

/// The image and text buffers of the prompt.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PastedBuffers {
    pub images: BufferSlice<PastedImage>,
    pub texts: BufferSlice<String>,
}

impl PastedBuffers {
    pub fn new() -> Self {
        Self::default()
    }

    /// `registerPastedImage(image)`: the `[Image #N]` token; `""` for an image without content.
    pub fn register_image(&mut self, image: &ImageAttachment) -> String {
        let id = self.images.register_with(|id| {
            (!image.content.is_empty()).then(|| PastedImage {
                id,
                content: image.content.clone(),
                media_type: Some(image.media_type.clone()),
                metadata_text: image.metadata_text.clone(),
            })
        });
        id.map(format_image_ref).unwrap_or_default()
    }

    /// `registerPastedText(text)`: the `[Pasted text #N +M lines]` token; `""` for an empty paste.
    pub fn register_text(&mut self, text: &str) -> String {
        let id = self.texts.register_with(|_| (!text.is_empty()).then(|| text.to_owned()));
        id.map(|id| format_pasted_text_ref(id, text)).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attachment(content: &str) -> ImageAttachment {
        ImageAttachment {
            content: content.to_owned(),
            media_type: "image/png".to_owned(),
            filename: "a.png".to_owned(),
            source_path: String::new(),
            metadata_text: None,
        }
    }

    fn image(id: u64, content: &str) -> PastedImage {
        PastedImage { id, content: content.to_owned(), media_type: Some("image/png".to_owned()), metadata_text: None }
    }

    fn ids<T: Clone + PartialEq>(slice: &BufferSlice<T>) -> Vec<u64> {
        slice.entries().keys().copied().collect()
    }

    #[test]
    fn pasted_images_mint_refs_install_merges_and_advances_the_id_clears_drop_what_a_submit_consumed() {
        let mut buffers = PastedBuffers::new();
        assert_eq!(buffers.register_image(&attachment("")), "", "an image without content registers nothing");
        assert_eq!(buffers.images.next_id(), 1);
        assert_eq!(buffers.register_image(&attachment("AA")), "[Image #1]");
        assert_eq!(buffers.images.entries().get(&1), Some(&image(1, "AA")));

        buffers.images.install(&BTreeMap::new(), true);
        assert_eq!(ids(&buffers.images), [1], "an empty install is a no-op");

        let restored = image(5, "BB");
        buffers.images.install(&BTreeMap::from([(5, restored.clone())]), true);
        assert_eq!(buffers.images.next_id(), 6, "the next id clears the highest installed one");
        assert_eq!(buffers.register_image(&attachment("CC")), "[Image #6]");

        buffers.images.clear_snapshot(Some(&BTreeMap::from([(5, restored), (1, image(1, "other"))])));
        assert_eq!(ids(&buffers.images), [1, 6], "only identical entries are dropped");

        buffers.images.install(&BTreeMap::from([(9, image(9, "DD"))]), false);
        assert_eq!(ids(&buffers.images), [9]);
        buffers.images.clear_snapshot(None);
        assert!(buffers.images.entries().is_empty());
    }

    #[test]
    fn pasted_texts_mint_refs_install_merges_and_advances_the_id_clears_drop_what_a_submit_consumed() {
        let mut buffers = PastedBuffers::new();
        assert_eq!(buffers.register_text(""), "", "an empty paste registers nothing");
        assert_eq!(buffers.register_text("hello\nworld"), "[Pasted text #1 +2 lines]");
        buffers.texts.install(&BTreeMap::new(), true);
        assert_eq!(ids(&buffers.texts), [1]);

        buffers.texts.install(&BTreeMap::from([(4, "restored".to_owned())]), true);
        assert_eq!(buffers.texts.next_id(), 5);
        assert_eq!(buffers.register_text("next"), "[Pasted text #5 +1 lines]");

        buffers.texts.clear_snapshot(Some(&BTreeMap::from([(4, "restored".to_owned()), (1, "hello\nworld".to_owned())])));
        assert_eq!(ids(&buffers.texts), [5]);

        buffers.texts.install(&BTreeMap::from([(8, "only".to_owned())]), false);
        assert_eq!(ids(&buffers.texts), [8]);
        buffers.texts.clear_ids(Some(&BTreeSet::from([8])));
        assert!(buffers.texts.entries().is_empty());
        buffers.texts.install(&BTreeMap::from([(2, "x".to_owned())]), true);
        buffers.texts.clear_ids(None);
        assert!(buffers.texts.entries().is_empty());
    }
}
