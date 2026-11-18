//! The sentences of the connect, cleanup and forget code that reach a person: each a stable code and an English template (the
//! fallback for logs and for a client that does not know the code). They are listed in `mixdog_app_protocol::message::client`, which
//! the protocol generator exports; the interface words them in its own language by code, with the parameters.

pub use mixdog_app_protocol::message::client::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_is_unique_and_every_slot_is_a_plain_name() {
        let mut codes: Vec<&str> = ALL.iter().map(|text| text.code).collect();
        codes.sort_unstable();
        let before = codes.len();
        codes.dedup();
        assert_eq!(before, codes.len(), "a code is listed twice");
        for text in ALL {
            for slot in mixdog_app_protocol::v2::connections::SshMessage::slots(text.english) {
                assert!(!slot.is_empty() && slot.chars().all(|c| c.is_ascii_lowercase() || c == '_'), "{}: {slot}", text.code);
            }
        }
    }

    #[test]
    fn the_server_side_shell_names_the_codes_it_raises_and_each_is_in_the_list() {
        let program = crate::install_wire::REMOTE_PROGRAM;
        for code in ["install-no-gzip", "install-no-tar", "install-no-checksum-tool", "upload-not-stored", "upload-checksum-mismatch", "upload-folder-failed", "upload-not-unpacked", "upload-no-program"] {
            assert!(program.contains(code) && ALL.iter().any(|text| text.code == code), "{code}");
        }
    }
}
