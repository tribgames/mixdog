//! What the modified fancy-regex costs against crates.io's 0.19.2 (release profile; see MIXDOG.md for the result): over
//! the shell analysis's patterns (`corpus/shell.json`), each with its own texts and one long text (the longest text it
//! matches in, repeated to 256 KiB: a long shell command), the median of 31 rounds of each phase, the two engines
//! alternating within a round so that drift touches both. Phases: building the regex, `is_match`, `find_iter`,
//! `captures_iter`. A pattern that does not compile in fancy-regex is left out of both.
//!
//!   cargo run --release --example cost --manifest-path native/core/vendor/fancy-regex-differential/Cargo.toml

use std::hint::black_box;
use std::path::Path;
use std::time::{Duration, Instant};

const ROUNDS: usize = 31;

type Run = Box<dyn Fn(usize) -> usize>;

macro_rules! build {
    ($krate:ident, $pattern:expr) => {
        $krate::Regex::new($pattern)
    };
}

macro_rules! runner {
    ($krate:ident, $pattern:expr, $texts:expr) => {{
        let regex = $krate::Regex::new($pattern).unwrap();
        let texts: Vec<String> = $texts.clone();
        Box::new(move |phase: usize| -> usize {
            match phase {
                0 => texts.iter().filter(|text| regex.is_match(text).unwrap_or(false)).count(),
                1 => texts.iter().map(|text| regex.find_iter(text).take(20).filter(|m| m.is_ok()).count()).sum(),
                _ => texts.iter().map(|text| regex.captures_iter(text).take(20).filter(|c| c.is_ok()).count()).sum(),
            }
        }) as Run
    }};
}

fn median(mut times: Vec<Duration>) -> Duration {
    times.sort();
    times[times.len() / 2]
}

fn main() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("corpus").join("shell.json");
    let entries: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let names = ["build", "is_match", "find_iter", "captures_iter"];
    let mut totals = [(Duration::ZERO, Duration::ZERO); 4];
    let mut rows = Vec::new();
    for entry in entries.as_array().unwrap() {
        let flags: String = entry["flags"].as_str().unwrap().chars().filter(|f| "ims".contains(*f)).collect();
        let pattern = entry["pattern"].as_str().unwrap();
        let pattern = if flags.is_empty() { pattern.to_owned() } else { format!("(?{flags}){pattern}") };
        if build!(upstream, &pattern).is_err() {
            continue;
        }
        let mut texts: Vec<String> = entry["texts"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_owned()).collect();
        let matching = texts.iter().filter(|t| upstream::Regex::new(&pattern).unwrap().is_match(t).unwrap_or(false)).max_by_key(|t| t.len());
        let seed = matching.cloned().or_else(|| texts.iter().max_by_key(|t| t.len()).cloned()).unwrap_or_default();
        if !seed.is_empty() {
            texts.push(seed.repeat((256 << 10) / seed.len() + 1));
        }
        let (up, md) = (runner!(upstream, &pattern, texts), runner!(modified, &pattern, texts));
        let mut samples = vec![(Vec::new(), Vec::new()); 4];
        for _ in 0..ROUNDS {
            let started = Instant::now();
            black_box(build!(upstream, black_box(&pattern)).unwrap());
            let up_build = started.elapsed();
            let started = Instant::now();
            black_box(build!(modified, black_box(&pattern)).unwrap());
            samples[0].0.push(up_build);
            samples[0].1.push(started.elapsed());
            for phase in 0..3 {
                let started = Instant::now();
                black_box(up(phase));
                let up_time = started.elapsed();
                let started = Instant::now();
                black_box(md(phase));
                samples[phase + 1].0.push(up_time);
                samples[phase + 1].1.push(started.elapsed());
            }
        }
        let mut row = vec![(0.0, Duration::ZERO, Duration::ZERO); 4];
        for (phase, (up, md)) in samples.into_iter().enumerate() {
            let (up, md) = (median(up), median(md));
            totals[phase].0 += up;
            totals[phase].1 += md;
            row[phase] = (md.as_secs_f64() / up.as_secs_f64().max(1e-9), up, md);
        }
        rows.push((pattern.chars().take(48).collect::<String>(), row));
    }
    println!("{} patterns, median of {ROUNDS} rounds, modified / upstream", rows.len());
    for (name, (up, md)) in names.iter().zip(totals) {
        println!("{name:>14}: upstream {up:>10.3?}  modified {md:>10.3?}  ratio {:.3}", md.as_secs_f64() / up.as_secs_f64());
    }
    for (phase, name) in names.iter().enumerate() {
        let mut slow: Vec<&(String, Vec<(f64, Duration, Duration)>)> = rows.iter().collect();
        slow.sort_by(|a, b| b.1[phase].0.total_cmp(&a.1[phase].0));
        println!("slowest {name} (ratio, upstream -> modified):");
        for (pattern, row) in slow.iter().take(5) {
            println!("  {:>8.2}  {:>10.3?} -> {:>10.3?}  {pattern}", row[phase].0, row[phase].1, row[phase].2);
        }
    }
}
