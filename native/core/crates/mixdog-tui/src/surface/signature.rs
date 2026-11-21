//! The grammar of the panel layout signature.
//!
//! The shell layout encodes the bottom area into one `|`-joined string; this module is the only reader of that encoding:
//! which panel owns the area, and whether a transition between two signatures is a close the terminal must repaint
//! instantly instead of gliding.

/// Token positions of the signature: `[tool, picker, context, usage, slash, text, inputBoxHidden, floatingPanelRows,
/// promptBoxRows, promptMetaRows, queuedRows, WELCOME_ROWS]`.
pub mod token {
    pub const PICKER: usize = 1;
    pub const SLASH: usize = 4;
    pub const TEXT: usize = 5;
    /// The 2-row live-spinner band slot.
    pub const PROMPT_META: usize = 9;
    /// The queued steering band rows (full wrapped height).
    pub const QUEUED: usize = 10;
}

const PROJECT_TEXT_ENTRY_KINDS: [&str; 3] = ["project-new", "project-create-confirm", "project-rename"];
/// The text-entry kinds whose value is several lines (core memory add and edit).
pub const CORE_MULTILINE_TEXT_ENTRY_KINDS: [&str; 2] = ["core-add", "core-edit"];

/// What a signature says about the panel that owns the area.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SignatureFlags {
    pub slash: bool,
    pub picker_kind: String,
    pub text_kind: String,
}

/// `panelSignatureFlags(signature)`.
pub fn panel_signature_flags(signature: &str) -> SignatureFlags {
    if signature.is_empty() {
        return SignatureFlags::default();
    }
    let parts: Vec<&str> = signature.split('|').collect();
    let at = |index: usize| parts.get(index).copied().unwrap_or("");
    SignatureFlags {
        slash: at(token::SLASH) == "slash",
        picker_kind: at(token::PICKER).strip_prefix("picker:").map(|rest| rest.split(':').next().unwrap_or("").to_owned()).unwrap_or_default(),
        text_kind: at(token::TEXT).strip_prefix("text:").unwrap_or("").to_owned(),
    }
}

/// The first 8 tokens identify which panel (if any) owns the bottom area; the trailing 4 are prompt-wrap, queue and banner
/// row counts that can churn every keystroke without any panel opening, closing or changing kind.
const PANEL_KIND_TOKEN_COUNT: usize = 8;

/// `panelKindSignature(signature)`: comparing only this prefix tells "the prompt grew or shrank a wrapped row" apart from
/// "a panel actually opened or closed".
pub fn panel_kind_signature(signature: &str) -> String {
    if signature.is_empty() {
        return String::new();
    }
    signature.split('|').take(PANEL_KIND_TOKEN_COUNT).collect::<Vec<_>>().join("|")
}

/// `signatureRows(signature, index)`: a row-count token (zero for a missing, empty or non-numeric one).
pub fn signature_rows(signature: &str, index: usize) -> usize {
    let value = signature.split('|').nth(index).map(|part| part.trim().parse::<f64>().unwrap_or(0.0)).unwrap_or(0.0);
    if value.is_finite() && value > 0.0 { value as usize } else { 0 }
}

/// `isInstantPanelCloseTransition(prev, next, initialProjectEntryClose)`.
pub fn is_instant_panel_close_transition(prev: &str, next: &str, initial_project_entry_close: bool) -> bool {
    let prev = panel_signature_flags(prev);
    let next = panel_signature_flags(next);
    if prev.slash && !next.slash {
        return true;
    }
    if prev.picker_kind == "project" && next.picker_kind != "project" {
        return initial_project_entry_close;
    }
    let project_text = |kind: &str| PROJECT_TEXT_ENTRY_KINDS.contains(&kind);
    if project_text(&prev.text_kind) && !project_text(&next.text_kind) {
        return initial_project_entry_close;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const SLASH_OPEN: &str = "||||slash||input-visible|14|3|0|0|11";
    const IDLE: &str = "||||||input-visible|0|3|0|0|11";

    #[test]
    fn flags_read_the_slash_picker_and_text_tokens() {
        assert_eq!(panel_signature_flags(""), SignatureFlags::default());
        assert!(panel_signature_flags(SLASH_OPEN).slash);
        assert_eq!(panel_signature_flags("|picker:project:fit|||||input-hidden|17|0|0|0|0").picker_kind, "project");
        assert_eq!(panel_signature_flags("|||||text:core-add|input-hidden|9|0|0|0|0").text_kind, "core-add");
    }

    #[test]
    fn the_kind_signature_drops_the_churn_tokens() {
        assert_eq!(panel_kind_signature(IDLE), "||||||input-visible|0");
        assert_eq!(panel_kind_signature(""), "");
    }

    #[test]
    fn row_tokens_read_as_numbers() {
        assert_eq!(signature_rows("||||||input-visible|0|3|2|1|0", token::PROMPT_META), 2);
        assert_eq!(signature_rows("||||||input-visible|0|3|2|1|0", token::QUEUED), 1);
        assert_eq!(signature_rows("short", token::QUEUED), 0);
        assert_eq!(signature_rows("||||||x|0|3|abc|1|0", token::PROMPT_META), 0);
    }

    #[test]
    fn closes_that_repaint_instantly() {
        assert!(is_instant_panel_close_transition(SLASH_OPEN, IDLE, false));
        assert!(!is_instant_panel_close_transition(IDLE, SLASH_OPEN, true));
        let project = "|picker:project:fit|||||input-hidden|17|0|0|0|0";
        assert!(is_instant_panel_close_transition(project, IDLE, true));
        assert!(!is_instant_panel_close_transition(project, IDLE, false));
        let entry = "|||||text:project-new|input-hidden|9|0|0|0|0";
        assert!(is_instant_panel_close_transition(entry, IDLE, true));
        assert!(!is_instant_panel_close_transition(entry, "|||||text:project-rename|input-hidden|9|0|0|0|0", true));
    }
}
