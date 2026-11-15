//! The PowerShell value semantics the Office COM hosts' results depend on (`mixdog_office_com::ps`), checked against the
//! text Windows PowerShell 5.1 produced: every entry of `tests/fixtures/pswire/corpus.json` (recorded by
//! `recorder/pswire-corpus.ps1`; `MANIFEST.json` records the PowerShell version, the culture, the time zone and the
//! corpus' sha256) is run through the Rust function and must give byte-identical text or the identical value.
//!
//! The entries are specs in a small typed JSON grammar (see the recorder), so the same value is built here and in
//! PowerShell. No COM object and no Office is involved. `pswire_live` re-runs the recorder on the machine it runs on
//! (Windows PowerShell only, under that machine's own culture) and compares the new recording with the Rust functions;
//! it is `#[ignore]`d because it starts PowerShell.

use mixdog_office_com::ps;
use mixdog_office_com::ps::DateKind;
use mixdog_office_com::ps::DateTimeValue;
use mixdog_office_com::ps::Decimal;
use mixdog_office_com::ps::ObjectKind;
use mixdog_office_com::ps::Value;
use mixdog_office_com::ps::collate;
use mixdog_office_com::ps::collate::SortOptions;
use mixdog_office_com::ps::convert;
use mixdog_office_com::ps::datetime;
use mixdog_office_com::ps::fingerprint;
use mixdog_office_com::ps::json;
use mixdog_office_com::ps::payload;
use mixdog_office_com::ps::text;
use serde_json::Value as Json;
use sha2::Digest;
use sha2::Sha256;

fn corpus() -> &'static str {
    mixdog_testkit::fixture!("tests/fixtures/pswire/corpus.json")
}

fn manifest_text() -> &'static str {
    mixdog_testkit::fixture!("tests/fixtures/pswire/MANIFEST.json")
}

// ---- the spec grammar -----------------------------------------------------------------------------------------------

/// `[double]::Parse` of .NET Framework: `-0` reads as `0` (the Framework's parser does not keep the sign of a zero).
fn parse_double(text: &str) -> f64 {
    match text {
        "NaN" => f64::NAN,
        "Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        other => {
            let number = other.parse::<f64>().unwrap_or_else(|e| panic!("double {other:?}: {e}"));
            if number == 0.0 { 0.0 } else { number }
        }
    }
}

fn parse_single(text: &str) -> f32 {
    match text {
        "NaN" => f32::NAN,
        "Infinity" => f32::INFINITY,
        "-Infinity" => f32::NEG_INFINITY,
        other => {
            let number = other.parse::<f32>().unwrap_or_else(|e| panic!("single {other:?}: {e}"));
            if number == 0.0 { 0.0 } else { number }
        }
    }
}

fn pairs(spec: &Json) -> Vec<(String, Value)> {
    spec["v"]
        .as_array()
        .expect("pairs")
        .iter()
        .map(|pair| (pair[0].as_str().expect("key").to_string(), build(&pair[1])))
        .collect()
}

fn object(kind: ObjectKind, items: Vec<(String, Value)>) -> Value {
    let mut object = mixdog_office_com::ps::Object::new(kind);
    for (key, value) in items {
        object.set(&key, value);
    }
    Value::Object(object)
}

fn build(spec: &Json) -> Value {
    if spec.is_null() {
        return Value::Null;
    }
    match spec["t"].as_str().expect("spec type") {
        "null" => Value::Null,
        "dbnull" => Value::DbNull,
        "b" => Value::Bool(spec["v"].as_bool().expect("bool")),
        "i" | "e" => Value::Int(i32::try_from(spec["v"].as_i64().expect("int")).expect("int range")),
        "l" => Value::Long(spec["v"].as_str().expect("long").parse().expect("long text")),
        "d" => Value::Double(parse_double(spec["v"].as_str().expect("double"))),
        "f" => Value::Single(parse_single(spec["v"].as_str().expect("single"))),
        "m" => Value::Decimal(Decimal::parse(spec["v"].as_str().expect("decimal")).expect("decimal text")),
        "s" => Value::String(spec["v"].as_str().expect("string").to_string()),
        "dt" => {
            let text = spec["v"].as_str().expect("date");
            let kind = match spec["k"].as_str().expect("kind") {
                "u" => DateKind::Utc,
                "l" => DateKind::Local,
                _ => DateKind::Unspecified,
            };
            Value::DateTime(DateTimeValue { ticks: ticks_of(text), kind })
        }
        "a" => Value::Array(spec["v"].as_array().expect("array").iter().map(build).collect()),
        "o" => object(ObjectKind::Ordered, pairs(spec)),
        "p" => object(ObjectKind::Custom, pairs(spec)),
        "nest" => {
            let mut value = build(&spec["leaf"]);
            for _ in 0..spec["n"].as_u64().expect("depth") {
                value = match spec["k"].as_str().expect("nest kind") {
                    "o" => object(ObjectKind::Ordered, vec![("k".to_string(), value)]),
                    "p" => object(ObjectKind::Custom, vec![("k".to_string(), value)]),
                    _ => Value::Array(vec![value]),
                };
            }
            value
        }
        other => panic!("unknown spec type {other}"),
    }
}

/// `yyyy-MM-ddTHH:mm:ss.fffffff` as ticks.
fn ticks_of(text: &str) -> i64 {
    let number = |from: usize, to: usize| -> u32 { text[from..to].parse().expect("date digits") };
    datetime::ticks_from_civil(&datetime::Civil {
        year: text[0..4].parse().expect("year"),
        month: number(5, 7),
        day: number(8, 10),
        hour: number(11, 13),
        minute: number(14, 16),
        second: number(17, 19),
        subsecond_ticks: number(20, 27),
    })
}

/// What the entries expect: a value, or a PowerShell error (`{"error": "message"}`).
fn expected(entry: &Json) -> Result<Value, String> {
    let spec = &entry["expected"];
    match spec.get("error") {
        Some(message) => Err(message.as_str().expect("error text").to_string()),
        None => Ok(build(spec)),
    }
}

/// Equal values have equal canonical text (doubles by their exact bits, so rounding shows). A NaN is one value and a zero
/// has no sign: the recording is the text PowerShell wrote, and the .NET Framework writes `-0` as `0` and every NaN alike.
fn canon(value: &Value) -> String {
    match value {
        Value::Double(n) if n.is_nan() => "Double(NaN)".to_string(),
        Value::Single(n) if n.is_nan() => "Single(NaN)".to_string(),
        Value::Double(n) => format!("Double({:#x})", (*n + 0.0).to_bits()),
        Value::Single(n) => format!("Single({:#x})", (*n + 0.0).to_bits()),
        Value::Array(items) => format!("[{}]", items.iter().map(canon).collect::<Vec<String>>().join(",")),
        Value::Object(object) => format!(
            "{:?}{{{}}}",
            object.kind,
            object.entries.iter().map(|(key, item)| format!("{key:?}:{}", canon(item))).collect::<Vec<String>>().join(",")
        ),
        other => format!("{other:?}"),
    }
}

/// An error text of the recording. The recording machine's culture writes an infinity as U+221E in a conversion message
/// (its `NumberFormatInfo` symbol); the Rust text is the invariant `Infinity`, so the two are compared alike.
fn show(result: &Result<Value, String>) -> String {
    match result {
        Ok(value) => canon(value),
        Err(message) => format!("error: {}", message.replace('\u{221e}', "Infinity")),
    }
}

// ---- the entries ----------------------------------------------------------------------------------------------------

/// The arguments of a cast entry. An enum (`DayOfWeek`) is its number everywhere but where it is turned into text: there
/// it is the member name, which the entries only use for `DayOfWeek`.
fn args(entry: &Json) -> Vec<Value> {
    let by_name = matches!(entry["fn"].as_str(), Some("string" | "interp" | "tryparse"));
    entry["args"]
        .as_array()
        .expect("args")
        .iter()
        .map(|spec| {
            if by_name && spec["t"].as_str() == Some("e") {
                const DAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
                Value::string(DAYS[usize::try_from(spec["v"].as_i64().expect("day")).expect("day index")])
            } else {
                build(spec)
            }
        })
        .collect()
}

fn texts(entry: &Json) -> Vec<String> {
    entry["args"].as_array().expect("args").iter().map(|a| a.as_str().expect("text arg").to_string()).collect()
}

fn to_value<T>(result: Result<T, String>, wrap: impl FnOnce(T) -> Value) -> Result<Value, String> {
    result.map(wrap)
}

fn run_cast(function: &str, args: &[Value]) -> Result<Value, String> {
    let first = &args[0];
    match function {
        "int" => to_value(convert::to_int(first), Value::Int),
        "int64" => to_value(convert::to_int64(first), Value::Long),
        "double" => to_value(convert::to_double(first), Value::Double),
        "single" => to_value(convert::to_single(first), Value::Single),
        "bool" => Ok(Value::Bool(convert::to_bool(first))),
        "string" | "interp" => Ok(Value::String(convert::to_ps_string(first))),
        "asint" => Ok(convert::as_int(first).map_or(Value::Null, Value::Int)),
        "tryparse" => Ok(convert::try_parse_int(&convert::to_ps_string(first)).map_or(Value::Null, Value::Int)),
        "round0" => Ok(Value::Double(convert::round(convert::to_double(first)?))),
        "round2" => to_value(convert::round_digits(convert::to_double(first)?, 2), Value::Double),
        "roundint" => {
            let rounded = convert::round(convert::to_double(first)?);
            to_value(convert::to_int(&Value::Double(rounded)), Value::Int)
        }
        "floor" => convert::floor(first),
        "max" => convert::max(first, &args[1]),
        "min" => convert::min(first, &args[1]),
        "hex2" => to_value(convert::format_x2(first), Value::String),
        "cvalue" => to_value(convert::color_value(&convert::to_ps_string(first)), Value::Int),
        "chex" => convert::color_hex_of(first).map(Value::String),
        "add" => convert::arithmetic('+', first, &args[1]),
        "sub" => convert::arithmetic('-', first, &args[1]),
        "mul" => convert::arithmetic('*', first, &args[1]),
        "div" => convert::divide(first, &args[1]),
        "gt" => Ok(Value::Bool(convert::greater_than(first, &args[1]))),
        "eq" => Ok(Value::Bool(convert::equals(first, &args[1]))),
        "ceq" => Ok(Value::Bool(convert::equals_case_sensitive(first, &args[1]))),
        other => panic!("unknown cast {other}"),
    }
}

fn run_text(op: &str, args: &[String]) -> Result<Value, String> {
    let first = args[0].as_str();
    match op {
        "match" => text::is_match(first, &args[1], false).map(Value::Bool),
        "notmatch" => text::is_not_match(first, &args[1], false).map(Value::Bool),
        "cmatch" => text::is_match(first, &args[1], true).map(Value::Bool),
        "replace" => text::replace(first, &args[1], &args[2], false).map(Value::String),
        "creplace" => text::replace(first, &args[1], &args[2], true).map(Value::String),
        "split" => text::split(first, &args[1], false).map(|pieces| ps::unroll(pieces.into_iter().map(Value::String).collect())),
        "like" => Ok(Value::Bool(text::like(first, &args[1]))),
        "escape" => Ok(Value::String(text::regex_escape(first))),
        "trimend" => Ok(Value::String(text::trim_end_cr_bel(first))),
        "join" => Ok(Value::String(text::join(&[Value::string(first), Value::string(&args[1])], ", "))),
        "lower" => Ok(Value::String(text::to_lower_invariant(first))),
        "trim" => Ok(Value::String(text::trim_start(first, &['#']))),
        other => panic!("unknown text op {other}"),
    }
}

/// The corpus' own time zone against this machine's: the UTC text of a date depends on it.
fn corpus_time_zone() -> String {
    let manifest: Json = serde_json::from_str(manifest_text()).expect("manifest");
    manifest["timeZone"].as_str().expect("time zone").to_string()
}

fn check_entry(entry: &Json, same_zone: bool, problems: &mut Vec<String>) {
    let id = entry["id"].as_str().expect("id");
    let mut fail = |what: String| problems.push(format!("{id}: {what}"));
    match entry["kind"].as_str().expect("kind") {
        "json" => {
            let depth = entry["depth"].as_u64().expect("depth") as usize;
            let got = json::to_json(&build(&entry["spec"]), depth);
            let want = entry["expected"].as_str().expect("text");
            if got != want {
                fail(format!("json depth {depth}: got {got:?} want {want:?}"));
            }
        }
        "pipe" => {
            let got = json::pipeline_text(&build(&entry["spec"]), 20).unwrap_or_default();
            let want = entry["expected"].as_str().expect("text");
            if got != want {
                fail(format!("pipeline: got {got:?} want {want:?}"));
            }
        }
        "fp" => {
            let value = build(&entry["spec"]);
            let text = json::pipeline_text(&value, 30).unwrap_or_default();
            if text != entry["text"].as_str().expect("text") {
                fail(format!("fingerprint text: got {text:?}"));
            }
            let got = fingerprint::snapshot_fingerprint(&value);
            if got != entry["expected"].as_str().expect("hash") {
                fail(format!("fingerprint: got {got}"));
            }
        }
        "sha" => {
            let got = fingerprint::text_sha256(entry["text"].as_str().expect("text"));
            if got != entry["expected"].as_str().expect("hash") {
                fail(format!("sha256: got {got}"));
            }
        }
        "payload" => {
            let got = payload::parse_payload(entry["text"].as_str().expect("text"));
            let want = expected(entry);
            if show(&got) != show(&want) {
                fail(format!("payload: got {} want {}", show(&got), show(&want)));
            }
        }
        "get" => {
            let payload_value = payload::parse_payload(entry["text"].as_str().expect("text")).expect("payload");
            let got = Ok(payload::property(&payload_value, entry["name"].as_str().expect("name")));
            let want = expected(entry);
            if show(&got) != show(&want) {
                fail(format!("property: got {} want {}", show(&got), show(&want)));
            }
        }
        "opprop" => {
            let op = payload::parse_payload(entry["text"].as_str().expect("text")).expect("payload");
            let got = Ok(payload::operation_property(&op, entry["name"].as_str().expect("name"), build(&entry["fallback"])));
            let want = expected(entry);
            if show(&got) != show(&want) {
                fail(format!("operation property: got {} want {}", show(&got), show(&want)));
            }
        }
        "cast" => {
            let got = run_cast(entry["fn"].as_str().expect("fn"), &args(entry));
            let want = expected(entry);
            if show(&got) != show(&want) {
                fail(format!("{} {:?}: got {} want {}", entry["fn"], entry["args"], show(&got), show(&want)));
            }
        }
        "sort" => {
            let values: Vec<Value> = entry["values"].as_array().expect("values").iter().map(build).collect();
            let options = SortOptions { descending: entry["desc"].as_bool().expect("desc"), unique: entry["unique"].as_bool().expect("unique") };
            let got = Value::Array(collate::sort_values(&values, options));
            let want = build(&entry["expected"]);
            if canon(&got) != canon(&want) {
                fail(format!("sort: got {} want {}", canon(&got), canon(&want)));
            }
        }
        "sortkey" => {
            let values: Vec<Value> = entry["values"].as_array().expect("values").iter().map(build).collect();
            let key = |item: &Value| -> Value {
                let Value::Object(object) = item else { return Value::Null };
                Value::Int(convert::to_int(object.get("start").unwrap_or(&Value::Null)).expect("start"))
            };
            let got = Value::Array(collate::sort_by_key(&values, SortOptions::default(), key));
            let want = build(&entry["expected"]);
            if canon(&got) != canon(&want) {
                fail(format!("sort by key: got {} want {}", canon(&got), canon(&want)));
            }
        }
        "group" => {
            let values: Vec<Value> = entry["values"].as_array().expect("values").iter().map(build).collect();
            let got: Vec<(String, u64)> =
                collate::groups_by_count_descending(&values).into_iter().map(|g| (g.name, g.count as u64)).collect();
            let want: Vec<(String, u64)> = entry["expected"]
                .as_array()
                .expect("rows")
                .iter()
                .map(|row| (row[0].as_str().expect("name").to_string(), row[1].as_u64().expect("count")))
                .collect();
            if got != want {
                fail(format!("group: got {got:?} want {want:?}"));
            }
        }
        "text" => {
            let got = run_text(entry["op"].as_str().expect("op"), &texts(entry));
            let want = expected(entry);
            if show(&got) != show(&want) {
                fail(format!("{} {:?}: got {} want {}", entry["op"], entry["args"], show(&got), show(&want)));
            }
        }
        "date" => {
            let oa = parse_double(entry["oa"].as_str().expect("oa"));
            if let Some(message) = entry.get("error") {
                let got = datetime::oa_date_to_local_text(oa);
                if got != Err(message.as_str().expect("error").to_string()) {
                    fail(format!("date error: got {got:?} want {message}"));
                }
                return;
            }
            let local = datetime::oa_date_to_local_text(oa);
            if local.as_ref().ok().map(String::as_str) != entry["local"].as_str() {
                fail(format!("date local: got {local:?} want {}", entry["local"]));
            }
            if same_zone {
                let utc = datetime::oa_date_to_utc_text(oa);
                if utc.as_ref().ok().map(String::as_str) != entry["utc"].as_str() {
                    fail(format!("date utc: got {utc:?} want {}", entry["utc"]));
                }
            }
        }
        other => panic!("unknown entry kind {other}"),
    }
}

fn check_corpus(corpus: &str, same_zone: bool) -> Vec<String> {
    let entries: Json = serde_json::from_str(corpus).expect("corpus");
    let mut problems = Vec::new();
    let list = entries.as_array().expect("entries");
    assert!(!list.is_empty());
    for entry in list {
        check_entry(entry, same_zone, &mut problems);
    }
    problems
}

fn report(problems: &[String]) -> String {
    let shown: Vec<&str> = problems.iter().take(25).map(String::as_str).collect();
    format!("{} of the corpus' entries differ; the first:\n{}", problems.len(), shown.join("\n"))
}

// ---- tests ----------------------------------------------------------------------------------------------------------

#[test]
fn manifest_describes_the_corpus() {
    let manifest: Json = serde_json::from_str(manifest_text()).expect("manifest");
    assert!(manifest["powershell"].as_str().expect("version").starts_with("5.1."), "recorded with Windows PowerShell 5.1");
    assert!(!manifest["culture"].as_str().expect("culture").is_empty());
    // The line endings of a checkout may differ; the recorder wrote LF.
    let normalised = corpus().replace("\r\n", "\n");
    let digest = Sha256::digest(normalised.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(manifest["corpusSha256"].as_str().expect("sha256"), hex, "corpus.json is the recorded file");
    let entries: Json = serde_json::from_str(corpus()).expect("corpus");
    assert_eq!(manifest["entries"].as_u64().expect("entries") as usize, entries.as_array().expect("entries").len());
}

#[test]
fn every_recorded_entry_matches_the_rust_functions() {
    // The UTC text of a date is the recording machine's time zone; it is compared only where that zone is the same.
    let same_zone = cfg!(windows) && machine_time_zone().as_deref() == Some(corpus_time_zone().as_str());
    let problems = check_corpus(corpus(), same_zone);
    assert!(problems.is_empty(), "{}", report(&problems));
}

#[test]
fn a_date_written_in_utc_has_the_round_trip_shape() {
    // Zone independent: the shape of ToString('o') for both kinds, from fixed ticks.
    let ticks = ticks_of("2026-09-12T03:04:05.0000000");
    assert_eq!(datetime::round_trip_text(ticks, true), "2026-09-12T03:04:05.0000000Z");
    assert_eq!(datetime::round_trip_text(ticks, false), "2026-09-12T03:04:05.0000000");
    assert_eq!(datetime::oa_date_to_local_text(25569.0).expect("date"), "1970-01-01T00:00:00.0000000");
}

#[cfg(windows)]
fn machine_time_zone() -> Option<String> {
    use windows_sys::Win32::System::Time::DYNAMIC_TIME_ZONE_INFORMATION;
    use windows_sys::Win32::System::Time::GetDynamicTimeZoneInformation;

    // The corpus records `TimeZoneInfo.Local.Id`, the Windows zone key name: the key name of the dynamic time zone.
    // SAFETY: the struct is plain data that Windows fills in; the pointer is to a local.
    let mut zone: DYNAMIC_TIME_ZONE_INFORMATION = unsafe { std::mem::zeroed() };
    let id = unsafe { GetDynamicTimeZoneInformation(&mut zone) };
    if id == 0xFFFF_FFFF {
        return None;
    }
    let length = zone.TimeZoneKeyName.iter().position(|unit| *unit == 0).unwrap_or(zone.TimeZoneKeyName.len());
    let name = String::from_utf16_lossy(&zone.TimeZoneKeyName[..length]);
    if name.is_empty() { None } else { Some(name) }
}

#[cfg(not(windows))]
fn machine_time_zone() -> Option<String> {
    None
}

/// Re-runs `recorder/pswire-corpus.ps1` on this machine (Windows PowerShell 5.1, any locale; Office is not needed) and
/// compares its recording with the Rust functions, so a difference that depends on the culture or the time zone shows on
/// the machine that has it. Run it on a Korean and on an English Windows.
#[tokio::test(flavor = "current_thread")]
#[ignore = "starts Windows PowerShell and takes minutes; run on a Windows machine"]
async fn pswire_live() {
    let out = std::env::temp_dir().join(format!("mixdog-pswire-live-{}", std::process::id()));
    mixdog_testkit::create_dir_all(&out);
    let recorder = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("recorder").join("pswire-corpus.ps1");
    let status = tokio::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&recorder)
        .arg("-Out")
        .arg(&out)
        .status()
        .await
        .expect("start powershell.exe");
    assert!(status.success(), "the recorder failed");
    let corpus = mixdog_testkit::read_string(out.join("corpus.json"));
    let problems = check_corpus(&corpus, true);
    mixdog_testkit::remove_dir_all(&out);
    assert!(problems.is_empty(), "{}", report(&problems));
}
