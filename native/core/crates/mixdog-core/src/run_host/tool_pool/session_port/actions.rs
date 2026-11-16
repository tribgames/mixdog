//! Unknown-bot diagnostics retained by the active session port.

use mixdog_core_base::rooms::ids::MIXY_AGENT_ID;
use mixdog_core_base::rooms::ids::agent_home_session_id;
use mixdog_js::slice_utf16;
use mixdog_js::utf16_len;
use mixdog_tools::exec::escape_harness_tags;
use mixdog_tools::orch::util::PortError;

use super::DirectorySessionPort;
use super::failed;

impl DirectorySessionPort {
    /// `unknownBotError`: the ids of the bots a send can reach (Mixy and every contact), for a bot-shaped `target` that is none.
    pub(super) async fn unknown_bot_text(&self, target: &str) -> Result<Option<String>, PortError> {
        if agent_home_session_id(target).is_none() {
            return Ok(None);
        }
        const MAX_NAMED_BOTS: usize = 30;
        let mut ids = vec![MIXY_AGENT_ID.to_owned()];
        ids.extend(self.parts.bots.ids().await.map_err(failed)?);
        let named = ids.iter().take(MAX_NAMED_BOTS).cloned().collect::<Vec<_>>().join(", ");
        let more = if ids.len() > MAX_NAMED_BOTS { format!(", … ({} more)", ids.len() - MAX_NAMED_BOTS) } else { String::new() };
        // `quotedText(target, 64)`: one line, tag-shaped text escaped, bounded.
        let one_line = target.split(|c: char| c.is_whitespace()).filter(|word| !word.is_empty()).collect::<Vec<_>>().join(" ");
        let escaped = escape_harness_tags(&one_line);
        let quoted = if utf16_len(&escaped) > 64 { format!("{}…", slice_utf16(&escaped, 63).trim_end()) } else { escaped };
        Ok(Some(format!("session: \"{quoted}\" is neither a session nor a known bot id; bot ids: {named}{more}; session action=list finds session ids")))
    }
}
