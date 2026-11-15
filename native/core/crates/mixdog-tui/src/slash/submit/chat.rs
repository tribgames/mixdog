//! The normal prompt-box submit: slash commands, and chat text with pasted image and text token expansion
//! (`prompt-submit/chat-submit.mjs`).

use std::collections::{BTreeMap, BTreeSet};

use mixdog_js::{is_js_space, js_trim};
use mixdog_term::paste::{
    PastedImage, build_prompt_content_with_images, image_reference_ids, pasted_text_reference_ids,
};

use super::submit_prompt;
use crate::slash::dispatch::run_slash_command;
use crate::slash::host::{CommittedClear, ImageRestoreMeta, SlashHost, SubmitOptions, Tone};

/// The entries of `held` whose id is among `ids` (`referencedSnapshot`).
fn referenced<T: Clone>(held: &BTreeMap<u64, T>, ids: &BTreeSet<u64>) -> BTreeMap<u64, T> {
    held.iter().filter(|(id, _)| ids.contains(id)).map(|(id, value)| (*id, value.clone())).collect()
}

/// Pasted images travel as content; the restore metadata keeps everything but the bytes, so a requeue can rebuild the token
/// without re-reading the paste.
fn image_restore_meta(snapshot: &BTreeMap<u64, PastedImage>) -> BTreeMap<u64, ImageRestoreMeta> {
    snapshot
        .iter()
        .map(|(id, image)| {
            let meta = ImageRestoreMeta {
                id: image.id,
                media_type: image.media_type.clone(),
                metadata_text: image.metadata_text.clone(),
                size_bytes: (image.content.len() as u64 * 3) / 4,
            };
            (*id, meta)
        })
        .collect()
}

/// `str.split(/\s+/)` of a trimmed text: the first piece may be empty (`/ x`), no other.
fn split_whitespace_runs(text: &str) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut start = 0;
    let mut in_space = false;
    let mut space_from = 0;
    for (at, c) in text.char_indices() {
        if is_js_space(c) {
            if !in_space {
                in_space = true;
                space_from = at;
            }
        } else if in_space {
            pieces.push(&text[start..space_from]);
            start = at;
            in_space = false;
        }
    }
    pieces.push(&text[start..if in_space { space_from } else { text.len() }]);
    pieces
}

/// `submitSlashCommand(ctx, commandText)`: runs `/cmd args`; refused while a session command runs.
pub fn submit_slash_command(host: &mut dyn SlashHost, command_text: &str) -> bool {
    if host.state().command_busy {
        host.push_notice("wait for the current command to finish", Tone::Warn);
        return false;
    }
    let pieces = split_whitespace_runs(&command_text[1..]);
    let (cmd, rest) = (pieces[0], &pieces[1..]);
    let accepted = run_slash_command(host, cmd, js_trim(&rest.join(" ")));
    if accepted {
        host.clear_pasted_images(None);
    }
    accepted
}

/// `submitChat(ctx, text)`: the text goes out with the pasted images and folded pasted texts it references.
pub fn submit_chat(host: &mut dyn SlashHost, text: &str) -> bool {
    let image_refs = image_reference_ids(text);
    let image_snapshot = referenced(&host.pasted_images(), &image_refs);
    let has_images = !image_snapshot.is_empty();
    // Folded `[Pasted text #N +M lines]` tokens expand back to their original text where the image content is built. Broken
    // or partially deleted tokens do not match and are left as they are.
    let text_refs = pasted_text_reference_ids(text);
    let text_snapshot = referenced(&host.pasted_texts(), &text_refs);
    let has_texts = !text_snapshot.is_empty();
    let content = build_prompt_content_with_images(text, &image_snapshot);
    let options = SubmitOptions {
        display_text: (has_images || has_texts).then(|| text.to_owned()),
        pasted_images: image_restore_meta(&image_snapshot),
        pasted_texts: text_snapshot.clone(),
        on_committed: (has_images || has_texts).then(|| CommittedClear {
            images: image_snapshot.keys().copied().collect(),
            texts: text_snapshot.keys().copied().collect(),
        }),
    };
    let accepted = submit_prompt(host, &content, Some(&options));
    if accepted {
        host.arm_transcript_follow();
        let busy = host.state().busy;
        if image_refs.is_empty() || (!has_images && !busy) {
            host.clear_pasted_images(None);
        } else if busy && has_images {
            host.clear_pasted_images(Some(&image_snapshot.keys().copied().collect()));
        }
        if text_refs.is_empty() || (!has_texts && !busy) {
            host.clear_pasted_texts(None);
        } else if busy && has_texts {
            host.clear_pasted_texts(Some(&text_snapshot.keys().copied().collect()));
        }
    }
    accepted
}

#[cfg(test)]
mod tests {
    use super::split_whitespace_runs;

    #[test]
    fn a_command_line_splits_on_whitespace_runs_like_the_node_regex() {
        assert_eq!(split_whitespace_runs("model  gpt x"), ["model", "gpt", "x"]);
        assert_eq!(split_whitespace_runs(" x"), ["", "x"]);
        assert_eq!(split_whitespace_runs("clear"), ["clear"]);
        assert_eq!(split_whitespace_runs(""), [""]);
    }
}
