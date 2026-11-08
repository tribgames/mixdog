//! The temp files a 1.4.5 writer leaves behind when the process dies between creating its temp file and publishing it
//! (SM §11.2). Each format below is tied to the one writer in the v1.4.5 source that mints it, and is recognized exactly:
//! the marker, the exact number of lowercase hex digits (or the digits-only run) that writer generates, nothing longer or
//! shorter. A file that merely contains a marker (`guide.mixdog-tmp-not-a-temp.md`) is a user's file.
//!
//! | format | writer (v1.4.5) |
//! |---|---|
//! | `<name>.mixdog-tmp-<16 hex>` | `publishTempPath`, `src/runtime/shared/atomic-file.mjs:388` (every `write*Atomic*` / `updateJsonAtomic*`); `store-agent-worker-header-cache.mjs:76` |
//! | `<archive or pending sidecar>.mixdog-tmp-<8 hex>` | `publishArchive`, `compaction-archive-capture.mjs:270`; `persistPending`, `:407` |
//! | `<id>.json.<12 hex>.tmp` | session saves, `session/store.mjs:336,:634`; `store/lifecycle-barriers.mjs:116` |
//! | `<name>.lock.<pid>.<16 hex>.tmp` | `publishLock`, `src/runtime/shared/file-lock.mjs:345` |
//! | `daemon-owner.json.<pid>.<ms>.tmp`, `memory-runtime-owner.json.<pid>.<ms>.tmp` | `refreshSingletonOwnerAsync`, `src/runtime/shared/singleton-owner.mjs:182`, over the two owner files |
//! | `state-<uuid>.tmp` | `writeRecoveryState`, `apps/desktop/src/main/project-recovery-store.ts:338` |
//!
//! Where each applies is decided by the caller from the store the 1.4.5 writer writes to; the writers outside the migrated
//! locations (downloads, installers, project files, the desktop's scratch state) are listed in the request notes.

/// `.mixdog-tmp-` joins a file name and its random suffix.
const MARKER: &str = ".mixdog-tmp-";

fn lower_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

/// The name a marker-and-hex temp file was minted for, when `name` is `<base>.mixdog-tmp-<hex_len lowercase hex>`.
fn marked_base(name: &str, hex_len: usize) -> Option<&str> {
    let (base, hex) = name.rsplit_once(MARKER)?;
    (!base.is_empty() && lower_hex(hex, hex_len)).then_some(base)
}

/// The file `publishTempPath` minted `name` for: `<base>.mixdog-tmp-<16 hex>` (`randomBytes(8)`).
pub fn atomic_publish_base(name: &str) -> Option<&str> {
    marked_base(name, 16)
}

/// The sidecar `name` was minted for, when it is a compaction capture temp: `<base>.mixdog-tmp-<8 hex>` (`randomBytes(4)`).
pub fn compaction_publish_base(name: &str) -> Option<&str> {
    marked_base(name, 8)
}

/// The session record `name` was minted for: `<base>.<12 hex>.tmp` (`randomBytes(6)`), `base` being `<id>.json`.
pub fn session_save_base(name: &str) -> Option<&str> {
    let (base, hex) = name.strip_suffix(".tmp")?.rsplit_once('.')?;
    (!base.is_empty() && lower_hex(hex, 12)).then_some(base)
}

/// `<name>.lock.<pid>.<16 hex>.tmp`: the private file a lock is hard-linked from.
pub fn is_lock_stage(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".tmp") else {
        return false;
    };
    let Some((rest, hex)) = stem.rsplit_once('.') else {
        return false;
    };
    let Some((lock, pid)) = rest.rsplit_once('.') else {
        return false;
    };
    lower_hex(hex, 16) && digits(pid) && lock.strip_suffix(".lock").is_some_and(|base| !base.is_empty())
}

/// The owner files the singleton-owner writer is pointed at.
const OWNER_FILES: [&str; 2] = ["daemon-owner.json", "memory-runtime-owner.json"];

/// `<owner file>.<pid>.<Date.now()>.tmp`.
pub fn is_owner_refresh(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".tmp") else {
        return false;
    };
    OWNER_FILES.iter().any(|file| {
        stem.strip_prefix(file)
            .and_then(|rest| rest.strip_prefix('.'))
            .and_then(|rest| rest.split_once('.'))
            .is_some_and(|(pid, ms)| digits(pid) && digits(ms))
    })
}

/// `state-<randomUUID()>.tmp`.
pub fn is_recovery_state(name: &str) -> bool {
    let Some(uuid) = name.strip_prefix("state-").and_then(|rest| rest.strip_suffix(".tmp")) else {
        return false;
    };
    uuid.len() == 36
        && uuid.bytes().enumerate().all(|(at, b)| match at {
            8 | 13 | 18 | 23 => b == b'-',
            _ => matches!(b, b'0'..=b'9' | b'a'..=b'f'),
        })
}

/// A leftover of a file directly under `<D>`: the atomic writer's, a lock's, an owner file's.
pub fn is_data_root_leftover(name: &str) -> bool {
    atomic_publish_base(name).is_some() || is_lock_stage(name) || is_owner_refresh(name)
}

/// The directory stores under `<D>` whose 1.4.5 writers publish through the atomic writer, with the writer of each.
pub const ATOMIC_STORE_DIRS: &[(&str, &str)] = &[
    ("goals", "goal-storage.mjs:165"),
    ("human-gate", "human-gate/store.mjs:49"),
    ("hooks", "hook-bus/rule-file.mjs:74"),
    ("agents", "agent-store.mjs:107; agent-editor.mjs:158"),
    ("bots", "bot-split-migration.mjs:426; agent-editor.mjs:158"),
    ("workflows", "workflow-packs.mjs:115"),
    ("skills", "skills-api.mjs:27"),
    ("tui-prompt-history", "prompt-history-store.mjs:64,:77"),
];

/// A leftover inside one of those stores (`rel` is relative to `<D>`).
pub fn is_store_leftover(rel: &str) -> bool {
    let Some((dir, rest)) = rel.split_once('/') else {
        return false;
    };
    ATOMIC_STORE_DIRS.iter().any(|(store, _)| *store == dir) && atomic_publish_base(rest.rsplit('/').next().unwrap_or(rest)).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_format_is_exact() {
        let hex16 = "0123456789abcdef";
        assert_eq!(atomic_publish_base(&format!("x.json.mixdog-tmp-{hex16}")), Some("x.json"));
        assert_eq!(compaction_publish_base("s.compaction-archive.pending.mixdog-tmp-0123abcd"), Some("s.compaction-archive.pending"));
        assert_eq!(session_save_base("s.json.0123456789ab.tmp"), Some("s.json"));
        assert!(is_lock_stage("a.json.lock.123.0123456789abcdef.tmp"));
        assert!(is_owner_refresh("daemon-owner.json.4242.1794120373414.tmp"));
        assert!(is_recovery_state("state-0b6a5cde-2b0c-4f7a-9c1d-5e2f3a4b6c7d.tmp"));
        for name in [
            "guide.mixdog-tmp-not-a-temp.md",
            "x.mixdog-tmp-0123456789ABCDEF",
            ".mixdog-tmp-0123456789abcdef",
            "x.mixdog-tmp-0123456789abcdef0",
            "x.mixdog-tmp-0123456789abcde",
        ] {
            assert_eq!(atomic_publish_base(name), None, "{name}");
        }
        assert_eq!(atomic_publish_base("x.mixdog-tmp-0123abcd"), None);
        assert_eq!(compaction_publish_base(&format!("x.mixdog-tmp-{hex16}")), None);
        assert_eq!(session_save_base("s.json.0123456789a.tmp"), None);
        assert_eq!(session_save_base("s.json.0123456789abc.tmp"), None);
        assert!(!is_lock_stage("a.json.lock.123.0123456789abcde.tmp"));
        assert!(!is_lock_stage("a.json.lock.x.0123456789abcdef.tmp"));
        assert!(!is_lock_stage("a.json.lck.123.0123456789abcdef.tmp"));
        assert!(!is_owner_refresh("other.json.4242.1794120373414.tmp"));
        assert!(!is_owner_refresh("daemon-owner.json.4242.tmp"));
        assert!(!is_recovery_state("state-not-a-uuid.tmp"));
        assert!(!is_recovery_state("state-0B6A5CDE-2B0C-4F7A-9C1D-5E2F3A4B6C7D.tmp"));
    }

    #[test]
    fn a_store_retires_the_atomic_temp_of_its_own_directory_only() {
        let temp = "0123456789abcdef";
        for (dir, _) in ATOMIC_STORE_DIRS {
            assert!(is_store_leftover(&format!("{dir}/x.json.mixdog-tmp-{temp}")), "{dir}");
        }
        assert!(is_store_leftover(&format!("skills/example/SKILL.md.mixdog-tmp-{temp}")));
        for rel in [
            "skills/example/guide.mixdog-tmp-not-a-temp.md".to_owned(),
            "goals/s.json".to_owned(),
            format!("schedules/s.json.mixdog-tmp-{temp}"),
            format!("goals.mixdog-tmp-{temp}"),
            format!("goals/s.json.mixdog-tmp-{}", &temp[..8]),
        ] {
            assert!(!is_store_leftover(&rel), "{rel}");
        }
    }
}
