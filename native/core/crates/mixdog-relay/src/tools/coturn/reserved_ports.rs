//! `reserved-ports`: adds the coturn relay port range to `net.ipv4.ip_local_reserved_ports` without disturbing what else is
//! reserved there, and takes back only what it added. The sysctl is a comma-separated list of ports and ranges: ports listed
//! in it are never picked as ephemeral ports, while an explicit bind (how coturn takes its relay ports) is unaffected.
//!
//! ```text
//! reserved-ports apply <min> <max> <record>   reserve the part of min-max that is not reserved yet; write that part to <record>
//! reserved-ports release <record>             un-reserve exactly the part <record> names
//! reserved-ports covers <min> <max>           exit 0 when min-max is wholly reserved
//! ```
//!
//! `RESERVED_PORTS_PROC` names the sysctl file (tests point it elsewhere).

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use mixdog_fsio::Unlaned;

/// A port is 16 bits (RFC 9293 section 3.1).
const MAX_PORT: u64 = 65_535;

const USAGE: &str = "usage: reserved-ports apply <min> <max> <record> | release <record> | covers <min> <max>";

/// Sorted, merged (overlapping and adjacent ranges joined) `(lo, hi)` pairs.
pub type Ranges = Vec<(u32, u32)>;

/// The file writer: tests replace it to fail at a chosen step.
pub type Writer<'a> = dyn FnMut(&Path, &str) -> io::Result<()> + 'a;

fn normalize(mut ranges: Ranges) -> Ranges {
    ranges.sort_by_key(|range| range.0);
    let mut merged: Ranges = Vec::new();
    for (lo, hi) in ranges {
        match merged.last_mut() {
            Some(last) if lo <= last.1.saturating_add(1) => last.1 = last.1.max(hi),
            _ => merged.push((lo, hi)),
        }
    }
    merged
}

fn digits(text: &str) -> Option<u64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

pub fn parse_ranges(text: &str) -> Result<Ranges, String> {
    let mut ranges = Vec::new();
    for token in text.split(',').map(str::trim).filter(|part| !part.is_empty()) {
        let bad = || format!("not a port range: {token}");
        let (low, high) = match token.split_once('-') {
            Some((low, high)) => (low, Some(high)),
            None => (token, None),
        };
        let lo = digits(low).ok_or_else(bad)?;
        let hi = match high {
            Some(high) => digits(high).ok_or_else(bad)?,
            None => lo,
        };
        if lo > hi || hi > MAX_PORT {
            return Err(bad());
        }
        ranges.push((lo as u32, hi as u32));
    }
    Ok(normalize(ranges))
}

pub fn format_ranges(ranges: &[(u32, u32)]) -> String {
    ranges.iter().map(|&(lo, hi)| if lo == hi { lo.to_string() } else { format!("{lo}-{hi}") }).collect::<Vec<_>>().join(",")
}

/// `from` without any port in `removed`.
pub fn subtract_ranges(from: &[(u32, u32)], removed: &[(u32, u32)]) -> Ranges {
    let mut rest = from.to_vec();
    for &(remove_lo, remove_hi) in removed {
        rest = rest
            .into_iter()
            .flat_map(|(lo, hi)| {
                if hi < remove_lo || lo > remove_hi {
                    return vec![(lo, hi)];
                }
                let mut kept = Vec::new();
                if lo < remove_lo {
                    kept.push((lo, remove_lo - 1));
                }
                if hi > remove_hi {
                    kept.push((remove_hi + 1, hi));
                }
                kept
            })
            .collect();
    }
    rest
}

/// The part of lo-hi that `current` does not reserve.
pub fn missing_ranges(current: &[(u32, u32)], lo: u32, hi: u32) -> Ranges {
    subtract_ranges(&[(lo, hi)], current)
}

pub fn covers_range(current: &[(u32, u32)], lo: u32, hi: u32) -> bool {
    missing_ranges(current, lo, hi).is_empty()
}

pub fn add_ranges(current: &[(u32, u32)], added: &[(u32, u32)]) -> Ranges {
    normalize(current.iter().chain(added).copied().collect())
}

fn read_ranges(path: &Path) -> Result<Ranges, String> {
    let text = mixdog_fsio::read_to_string(&Unlaned, path).map_err(|error| format!("{}: {error}", path.display()))?;
    parse_ranges(&text)
}

/// The ownership record is one line, `pending|applied|released [ranges]`. The ranges are the part of the reservation this tool
/// owns: `pending` means the sysctl write is about to happen (or happened and was not confirmed), so they may or may not be
/// reserved yet; `applied` means they are. Either way they are ours to take back, because they were unreserved when the record
/// was made.
fn read_record(path: &Path) -> Result<Ranges, String> {
    let text = match mixdog_fsio::read_to_string(&Unlaned, path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("{}: {error}", path.display())),
    };
    let text = text.trim();
    let line_end = |c: char| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    for state in ["pending", "applied", "released"] {
        let Some(rest) = text.strip_prefix(state) else { continue };
        if rest.is_empty() {
            return Ok(Vec::new());
        }
        if let Some(ranges) = rest.strip_prefix(' ').filter(|ranges| !ranges.contains(line_end)) {
            return parse_ranges(ranges);
        }
    }
    Err(format!("not an ownership record: {}", path.display()))
}

/// Whole-file replace (temp file + rename), so a record is never half written.
fn save_record(path: &Path, state: &str, ranges: &[(u32, u32)], write: &mut Writer) -> Result<(), String> {
    let mut temp = OsString::from(path);
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    let body = if ranges.is_empty() { format!("{state}\n") } else { format!("{state} {}\n", format_ranges(ranges)) };
    write(&temp, &body).map_err(|error| format!("{}: {error}", temp.display()))?;
    mixdog_fsio::rename(&Unlaned, &temp, path).map_err(|error| format!("{}: {error}", path.display()))
}

fn write_sysctl(proc: &Path, ranges: &[(u32, u32)], write: &mut Writer) -> Result<(), String> {
    write(proc, &format!("{}\n", format_ranges(ranges))).map_err(|error| format!("{}: {error}", proc.display()))
}

fn port(value: Option<&String>) -> Result<u32, String> {
    match value.map(String::as_str).and_then(digits) {
        Some(number) if (1..=MAX_PORT).contains(&number) => Ok(number as u32),
        _ => Err(format!("not a port: {}", value.map_or("undefined", String::as_str))),
    }
}

/// One invocation against the sysctl file `proc`; `Ok` is the line to print, `Err` the message and exit status 1.
pub fn run(argv: &[String], proc: &Path, write: &mut Writer) -> Result<String, String> {
    let usage = || USAGE.to_owned();
    let Some((command, args)) = argv.split_first() else { return Err(usage()) };
    match command.as_str() {
        "apply" => {
            let Some(record) = args.get(2) else { return Err(usage()) };
            let record = Path::new(record);
            let current = read_ranges(proc)?;
            let (min, max) = (port(args.first())?, port(args.get(1))?);
            if min > max {
                return Err(format!("not a port range: {min}-{max}"));
            }
            // A start that follows a crash (no stop ran) still owns what the last one added.
            let mut owned = read_record(record)?;
            owned.extend(missing_ranges(&current, min, max));
            let added = normalize(owned);
            let merged = add_ranges(&current, &added);
            // Ownership first: if the record cannot be saved nothing has changed, and if this process dies after the sysctl
            // write the record already names the part.
            save_record(record, "pending", &added, write)?;
            if format_ranges(&merged) != format_ranges(&current) {
                write_sysctl(proc, &merged, write)?;
            }
            save_record(record, "applied", &added, write)?;
            let shown = if added.is_empty() { "nothing, already reserved".to_owned() } else { format_ranges(&added) };
            Ok(format!("reserved {}-{} (added: {shown})", args[0], args[1]))
        }
        "release" => {
            let Some(record) = args.first() else { return Err(usage()) };
            let record = Path::new(record);
            let added = read_record(record)?;
            if added.is_empty() {
                return Ok("nothing to release".to_owned());
            }
            write_sysctl(proc, &subtract_ranges(&read_ranges(proc)?, &added), write)?;
            save_record(record, "released", &[], write)?;
            Ok(format!("released {}", format_ranges(&added)))
        }
        "covers" => {
            let current = read_ranges(proc)?;
            let (min, max) = (port(args.first())?, port(args.get(1))?);
            if !covers_range(&current, min, max) {
                let reserved = if current.is_empty() { "none".to_owned() } else { format_ranges(&current) };
                return Err(format!("{}-{} is not wholly reserved (reserved: {reserved})", args[0], args[1]));
            }
            Ok(format!("reserved: {}", format_ranges(&current)))
        }
        _ => Err(usage()),
    }
}

/// The sysctl file: `RESERVED_PORTS_PROC` when set and not empty, else the kernel's.
pub fn proc_path() -> PathBuf {
    match std::env::var_os("RESERVED_PORTS_PROC").filter(|value| !value.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from("/proc/sys/net/ipv4/ip_local_reserved_ports"),
    }
}

pub fn main(args: &[String]) -> ExitCode {
    match run(args, &proc_path(), &mut |path, data| mixdog_fsio::write(&Unlaned, path, data)) {
        Ok(line) => {
            println!("{line}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(1)
        }
    }
}
