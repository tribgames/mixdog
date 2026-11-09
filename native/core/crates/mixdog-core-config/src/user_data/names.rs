//! Backup folder names and their order: `<iso-ms>-<10-digit seq>-<reason>`, the newest by time and
//! then by sequence, and the ring that keeps the newest forty (`user-data-guard.mjs`
//! `nextBackupName`, `newestBackupOrder`, `backupsToPrune`, `safeReason`).

use std::cmp::Ordering;

use chrono::NaiveDate;

/// The folder of one data dir's backups starts with this.
pub(super) const SCOPE_PREFIX: &str = "scope-";
/// The newest backups a scope keeps.
pub(super) const KEEP: usize = 40;

/// The sequence an older build's name (it has none) counts as: after every sequenced name of its millisecond.
const UNBOUNDED: i64 = i64::MAX;

/// What `nextBackupName` carries between calls (module-level `lastBackupMs` and `backupSeq` in Node).
#[derive(Debug, Default)]
pub(super) struct Counter {
    last_ms: i64,
    seq: i64,
}

/// `[0-9]` at `at..at + len`.
fn digits(bytes: &[u8], at: usize, len: usize) -> Option<i64> {
    let part = bytes.get(at..at + len)?;
    part.iter().all(u8::is_ascii_digit).then(|| part.iter().fold(0_i64, |n, d| n * 10 + i64::from(d - b'0')))
}

/// `Date.parse(...)` of the name's time, as V8 reads an ISO string: any day 1-31 of a month (it
/// rolls over), hour 24 only as the very end of the day.
fn parse_time(bytes: &[u8]) -> Option<i64> {
    let (year, month, day) = (digits(bytes, 0, 4)?, digits(bytes, 5, 2)?, digits(bytes, 8, 2)?);
    let (hour, minute, second, milli) = (digits(bytes, 11, 2)?, digits(bytes, 14, 2)?, digits(bytes, 17, 2)?, digits(bytes, 20, 3)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || minute > 59 || second > 59 {
        return None;
    }
    if hour > 24 || (hour == 24 && (minute, second, milli) != (0, 0, 0)) {
        return None;
    }
    let first = NaiveDate::from_ymd_opt(i32::try_from(year).ok()?, u32::try_from(month).ok()?, 1)?;
    let midnight = first.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis();
    Some(midnight + (day - 1) * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1000 + milli)
}

/// `BACKUP_NAME_RE` and `Date.parse`: the time of a backup's name and its sequence ([`UNBOUNDED`] when it has none).
fn parse_name(name: &str) -> Option<(i64, i64)> {
    let bytes = name.as_bytes();
    let shape = [(4, b'-'), (7, b'-'), (10, b'T'), (13, b'-'), (16, b'-'), (19, b'-'), (23, b'Z'), (24, b'-')];
    if !shape.iter().all(|(at, sep)| bytes.get(*at) == Some(sep)) {
        return None;
    }
    let time = parse_time(bytes)?;
    let seq = match (digits(bytes, 25, 10), bytes.get(35)) {
        (Some(seq), Some(b'-')) => seq,
        _ => UNBOUNDED,
    };
    Some((time, seq))
}

/// `newestBackupOrder(names)`: the newest time and, within it, the highest sequence. Names that are no
/// backup's are ignored.
fn newest_order(names: &[String]) -> (i64, i64) {
    let (mut ms, mut seq) = (0, -1);
    for name in names {
        let Some((time, order)) = parse_name(name) else { continue };
        if time > ms || (time == ms && order > seq) {
            (ms, seq) = (time, order);
        }
    }
    (ms, seq)
}

/// `safeReason(reason)`: runs of anything but `[a-z0-9_.-]` become one `-`; at most 48 characters.
pub(super) fn safe_reason(reason: &str) -> String {
    let reason = if reason.is_empty() { "snapshot" } else { reason };
    let mut out = String::new();
    let mut dashing = false;
    for c in reason.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
            out.push(c);
            dashing = false;
        } else if !dashing {
            out.push('-');
            dashing = true;
        }
    }
    out.truncate(48);
    if out.is_empty() { "snapshot".to_owned() } else { out }
}

/// `new Date(ms).toISOString()`.
pub(super) fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)).unwrap_or_default()
}

impl Counter {
    /// `nextBackupName(names, reason)`: a name that sorts after every backup in `names`, whichever process wrote them and
    /// whatever its clock said, so the backup a restore picks as the newest is the one written last and pruning never takes it.
    pub(super) fn next_name(&mut self, names: &[String], reason: &str, now_ms: i64) -> String {
        let (newest_ms, newest_seq) = newest_order(names);
        self.last_ms = now_ms.max(self.last_ms).max(newest_ms);
        if self.last_ms == newest_ms {
            if newest_seq == UNBOUNDED {
                self.last_ms += 1;
            } else {
                self.seq = self.seq.max(newest_seq + 1);
            }
        }
        let time = iso(self.last_ms).replace([':', '.'], "-");
        let seq = self.seq;
        self.seq += 1;
        format!("{time}-{seq:010}-{}", safe_reason(reason))
    }
}

/// JavaScript's default `Array.prototype.sort` order of strings: by UTF-16 code unit.
pub(super) fn js_order(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `backupsToPrune(names, own)`: the names past the newest [`KEEP`], never the just-written backup.
pub(super) fn to_prune(names: &[String], own: &str) -> Vec<String> {
    let mut sorted: Vec<&String> = names.iter().collect();
    sorted.sort_by(|a, b| js_order(b, a));
    sorted.into_iter().skip(KEEP).filter(|name| name.as_str() != own).cloned().collect()
}
