//! Offline decoder for `mixdog-cli/alloc-profile`. Pass REPORT MAP OUTPUT.jsonl.
//! Keep the map produced beside the exact profiled executable; maps from other builds are not interchangeable.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, BufWriter, Write};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

struct Symbols {
    preferred: u64,
    end: u64,
    names: BTreeMap<u64, String>,
}

impl Symbols {
    fn read(reader: impl BufRead) -> Result<Self> {
        let mut result = Self { preferred: 0, end: 0, names: BTreeMap::new() };
        let mut code_length = 0;
        let mut code_base = 0;
        for line in reader.lines() {
            let line = line?;
            let columns: Vec<_> = line.split_whitespace().collect();
            if let Some(address) = line.trim().strip_prefix("Preferred load address is ") {
                result.preferred = u64::from_str_radix(address, 16)?;
            }
            if columns.first().is_none_or(|address| !address.starts_with("0001:")) {
                continue;
            }
            let offset = u64::from_str_radix(&columns[0][5..], 16)?;
            if columns.len() == 4 && columns[3] == "CODE" {
                let length = u64::from_str_radix(columns[1].trim_end_matches('H'), 16)?;
                code_length = code_length.max(offset + length);
            } else if columns.len() >= 4 {
                let address = u64::from_str_radix(columns[2], 16)?;
                code_base = address - offset;
                result.names.insert(address, format!("{:#}", rustc_demangle::demangle(columns[1])));
            }
        }
        if result.preferred == 0 || result.names.is_empty() || code_length == 0 {
            return Err("map lacks preferred base, code length, or symbols".into());
        }
        result.end = code_base + code_length;
        Ok(result)
    }

    fn resolve(&self, address: u64, image_base: u64) -> String {
        let Some(relative) = address.checked_sub(image_base) else { return format!("foreign:0x{address:x}") };
        let address = relative + self.preferred;
        if address >= self.end {
            return format!("foreign:0x{address:x}");
        }
        self.names.range(..address).next_back().map_or_else(
            || format!("unknown:0x{address:x}"),
            |(_, name)| name.clone(),
        )
    }
}

fn owner(frames: &[String]) -> &str {
    frames.iter().find(|name| {
        name.trim_start_matches('<').starts_with("mixdog_") && !name.contains("alloc_profile")
    }).map(String::as_str).unwrap_or("(no application frame)")
}

#[derive(Default)]
struct Snapshot {
    header: String,
    stacks: Vec<(i64, i64, Vec<String>)>,
}

fn emit(snapshot: &Snapshot, out: &mut impl Write) -> Result<()> {
    if snapshot.header.is_empty() {
        return Ok(());
    }
    let mut groups = BTreeMap::<String, i64>::new();
    let stacks: Vec<_> = snapshot.stacks.iter().map(|(bytes, blocks, frames)| {
        let site = owner(frames);
        *groups.entry(site.to_owned()).or_default() += bytes;
        serde_json::json!({"estimatedBytes": bytes, "estimatedBlocks": blocks, "owner": site, "frames": frames})
    }).collect();
    let mut groups: Vec<_> = groups.into_iter().collect();
    groups.sort_by_key(|(_, bytes)| std::cmp::Reverse(*bytes));
    serde_json::to_writer(&mut *out, &serde_json::json!({
        "measurement": snapshot.header, "estimatedBytesByApplicationFrame": groups, "stacks": stacks,
    }))?;
    writeln!(out)?;
    Ok(())
}

fn decode(reader: impl BufRead, symbols: &Symbols, out: &mut impl Write) -> Result<()> {
    let mut image_base = 0;
    let mut snapshot = Snapshot::default();
    for line in reader.lines() {
        let line = line?;
        if let Some(base) = line.strip_prefix("image_base=0x") {
            image_base = u64::from_str_radix(base, 16)?;
        } else if line.starts_with("== ") {
            emit(&snapshot, out)?;
            snapshot = Snapshot { header: line, stacks: Vec::new() };
        } else if line.starts_with("stack ") {
            let fields: BTreeMap<_, _> = line.split_whitespace().skip(1).filter_map(|part| part.split_once('=')).collect();
            snapshot.stacks.push((fields["bytes"].parse()?, fields["blocks"].parse()?, Vec::new()));
        } else if let Some(address) = line.trim().strip_prefix("0x") {
            if image_base == 0 {
                return Err("report lacks executable image base".into());
            }
            let stack = snapshot.stacks.last_mut().ok_or("address without a stack")?;
            stack.2.push(symbols.resolve(u64::from_str_radix(address, 16)?, image_base));
        }
    }
    emit(&snapshot, out)
}

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 3 {
        return Err("usage: alloc-report REPORT MAP OUTPUT.jsonl".into());
    }
    let symbols = Symbols::read(BufReader::new(std::fs::File::open(&args[1])?))?;
    let mut out = BufWriter::new(std::fs::File::create_new(&args[2])?);
    decode(BufReader::new(std::fs::File::open(&args[0])?), &symbols, &mut out)?;
    out.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoder_rebases_return_addresses_and_preserves_measured_vs_estimated_values() {
        let map = b" Preferred load address is 0000000140000000\n 0001:00000000 00001000H .text CODE\n 0001:00000000 _ZN9mixdog_ai7catalog4loadE 0000000140001000 f obj\n";
        let symbols = Symbols::read(&map[..]).unwrap();
        let report = b"image_base=0x70000000\n== t+5s live 1.0 MiB\nstack bytes=65536 delta=+65536 blocks=2\n            0x70001010\n            0x90000000\n";
        let mut out = Vec::new();
        decode(&report[..], &symbols, &mut out).unwrap();
        let row: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(row["measurement"], "== t+5s live 1.0 MiB");
        assert_eq!(row["stacks"][0]["estimatedBytes"], 65536);
        assert_eq!(row["stacks"][0]["frames"][0], "mixdog_ai::catalog::load");
        assert!(row["stacks"][0]["frames"][1].as_str().unwrap().starts_with("foreign:"));
        assert_eq!(row["estimatedBytesByApplicationFrame"][0][1], 65536);
    }
}
