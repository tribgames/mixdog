//! Twin of the shipped skill scripts and the launcher's argument carrier: the Rust functions run on the inputs of
//! `fixtures/skill-scripts/golden.json` (recorded by `benchmarks/rust-core/recorders/record-skill-scripts.mjs` from
//! Node running the scripts of the product tree) and their argv, stdout, stderr and exit code are compared byte for
//! byte. The temporary root is written `<root>` (separators as slashes) and today's date `<today>` on both sides.

use std::path::Path;
use std::sync::LazyLock;

use base64::Engine;
use mixdog_fsio::Unlaned;
use mixdog_skill_scripts::Outcome;
use mixdog_skill_scripts::argv::decode_skill_argv;
use mixdog_skill_scripts::argv::run_entry;
use mixdog_skill_scripts::inventory::run_inventory;
use mixdog_skill_scripts::inventory::utc_today;
use mixdog_skill_scripts::parse_args::OptionSpec;
use mixdog_skill_scripts::parse_args::OptionValue;
use mixdog_skill_scripts::parse_args::ParseConfig;
use mixdog_skill_scripts::parse_args::parse_args;
use mixdog_skill_scripts::validate_skill::run_validate_skill;
use serde_json::Value;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/skill-scripts/golden.json");

static RECORDING: LazyLock<Value> = LazyLock::new(|| serde_json::from_str(&GOLDEN).expect("golden.json is JSON"));

fn cases(kind: &str) -> &'static Vec<Value> {
    RECORDING["cases"][kind].as_array().unwrap_or_else(|| panic!("golden.json has no {kind} cases"))
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().expect("a list").iter().map(|item| item.as_str().expect("a string").to_owned()).collect()
}

fn write_input(root: &Path, input: &Value) {
    mixdog_testkit::create_dir_all(root);
    for dir in input["dirs"].as_array().into_iter().flatten() {
        mixdog_testkit::create_dir_all(root.join(dir.as_str().expect("a folder")));
    }
    for (rel, spec) in input["files"].as_object().into_iter().flatten() {
        let bytes: Vec<u8> = match spec {
            Value::String(text) => text.clone().into_bytes(),
            _ if spec.get("base64").is_some() => {
                base64::engine::general_purpose::STANDARD.decode(spec["base64"].as_str().expect("base64")).expect("base64 decodes")
            }
            _ => {
                let unit = spec["repeat"].as_str().expect("a unit");
                let count = usize::try_from(spec["count"].as_u64().expect("a count")).expect("fits");
                format!("{}{}", unit.repeat(count), spec["suffix"].as_str().unwrap_or_default()).into_bytes()
            }
        };
        let path = root.join(rel);
        mixdog_testkit::create_dir_all(path.parent().expect("a parent"));
        mixdog_testkit::write(&path, bytes);
    }
    for generated in input["gen"].as_array().into_iter().flatten() {
        if let Some(files) = generated.get("files") {
            let dir = root.join(files["dir"].as_str().expect("a folder"));
            mixdog_testkit::create_dir_all(&dir);
            let (name, body) = (files["name"].as_str().expect("a name"), files["body"].as_str().expect("a body"));
            for n in 0..files["count"].as_u64().expect("a count") {
                mixdog_testkit::write(dir.join(name.replace("{n}", &n.to_string())), body);
            }
        } else {
            let dirs = &generated["dirs"];
            let dir = root.join(dirs["dir"].as_str().expect("a folder"));
            mixdog_testkit::create_dir_all(&dir);
            let name = dirs["name"].as_str().expect("a name");
            for n in 0..dirs["count"].as_u64().expect("a count") {
                mixdog_testkit::create_dir(dir.join(name.replace("{n}", &n.to_string())));
            }
        }
    }
}

/// The text as the recorder writes it: the root and its slash form as `<root>`, separators as slashes, today as `<today>`.
fn normalise(text: &str, root: &Path, today: &str) -> String {
    let native = root.display().to_string();
    let fixed = native.replace('\\', "/");
    text.replace(&native, "<root>").replace(&fixed, "<root>").replace('\\', "/").replace(today, "<today>")
}

fn clip(text: &str) -> String {
    text.chars().take(300).collect()
}

/// Runs `run` for every case of `kind` the filter admits and returns the differences from the recording.
fn compare(kind: &str, admit: impl Fn(&Value) -> bool, run: impl Fn(&[String], &str) -> Outcome) -> (usize, Vec<String>) {
    let today = utc_today();
    let mut ran = 0;
    let mut differences = Vec::new();
    for case in cases(kind).iter().filter(|case| admit(&case["input"])) {
        let name = case["case"].as_str().expect("a case name");
        let root = tempfile::tempdir().expect("temp dir");
        write_input(root.path(), &case["input"]);
        let fixed = root.path().display().to_string().replace('\\', "/");
        let args: Vec<String> = strings(&case["argv"]).iter().map(|arg| arg.replace("<root>", &fixed)).collect();
        let outcome = run(&args, &today);
        let observed = &case["observed"];
        let got = [
            ("stdout", normalise(&outcome.stdout, root.path(), &today)),
            ("stderr", normalise(&outcome.stderr, root.path(), &today)),
            ("status", outcome.code.to_string()),
        ];
        let want = [
            observed["stdout"].as_str().expect("stdout").to_owned(),
            observed["stderr"].as_str().expect("stderr").to_owned(),
            observed["status"].to_string(),
        ];
        for ((field, got), want) in got.iter().zip(want.iter()) {
            if got != want {
                differences.push(format!("{kind}: {name}: {field} differs\n  node: {:?}\n  rust: {:?}", clip(want), clip(got)));
            }
        }
        ran += 1;
    }
    (ran, differences)
}

fn assert_twin(kind: &str, ran: usize, differences: &[String]) {
    assert!(ran > 0, "no {kind} case ran");
    assert!(differences.is_empty(), "{} difference(s) of {ran} {kind} case(s):\n{}", differences.len(), differences.iter().take(8).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn validate_skill_prints_what_node_prints() {
    let (ran, differences) = compare("validate", |_| true, |args, _| run_validate_skill(&Unlaned, args));
    assert_twin("validate", ran, &differences);
}

#[test]
fn inventory_prints_what_node_prints() {
    let (ran, differences) = compare("inventory", |input| input.get("gen").is_none(), |args, today| run_inventory(&Unlaned, args, today));
    assert_twin("inventory", ran, &differences);
}

/// The two bounds that need tens of thousands of files and folders: more than 20000 test files, more than 50000 folders.
#[test]
fn inventory_refuses_what_node_refuses_at_its_bounds() {
    let (ran, differences) = compare("inventory", |input| input.get("gen").is_some(), |args, today| run_inventory(&Unlaned, args, today));
    assert_eq!(ran, 2);
    assert_twin("inventory bounds", ran, &differences);
}

fn config_of(name: &str) -> (Vec<OptionSpec>, bool) {
    let vision = OptionSpec::boolean("no-vision");
    match name {
        "qc" => (
            vec![
                OptionSpec::string("provider"),
                OptionSpec::string("model"),
                OptionSpec::string("effort"),
                OptionSpec::string("output"),
                OptionSpec::string("pages"),
                vision,
            ],
            true,
        ),
        _ => (
            vec![
                OptionSpec::string("provider").short('p'),
                OptionSpec::boolean("verbose").short('v'),
                OptionSpec::boolean("quiet").short('q'),
                vision,
                OptionSpec::string("o"),
            ],
            name == "mixed",
        ),
    }
}

#[test]
fn parse_args_reads_and_refuses_what_node_does() {
    let mut differences = Vec::new();
    for case in cases("parseArgs") {
        let (options, allow_positionals) = config_of(case["config"].as_str().expect("a config"));
        // A list holding a `null` is a list Node's own call refuses with a TypeError before it reads anything; Rust's
        // argument list is a list of strings and cannot hold one, so the refusal is what the recording must hold.
        if case["args"].as_array().is_some_and(|items| items.iter().any(|item| !item.is_string())) {
            let message = case["observed"]["message"].as_str().unwrap_or_default();
            if !message.starts_with("Cannot read properties of") || case["observed"].get("code").is_some() {
                differences.push(format!("{} {}: a list with a non-string is not a TypeError in the recording", case["config"], case["args"]));
            }
            continue;
        }
        let args = strings(&case["args"]);
        let got = match parse_args(&args, &ParseConfig { options: &options, allow_positionals }) {
            Ok(parsed) => serde_json::json!({
                "values": parsed.values.iter().map(|(key, value)| match value {
                    OptionValue::Text(text) => serde_json::json!([key, text]),
                    OptionValue::Flag => serde_json::json!([key, true]),
                }).collect::<Vec<_>>(),
                "positionals": parsed.positionals,
            }),
            Err(error) => serde_json::json!({ "code": error.code, "message": error.message }),
        };
        if got != case["observed"] {
            differences.push(format!("{} {args:?}\n  node: {}\n  rust: {}", case["config"], clip(&case["observed"].to_string()), clip(&got.to_string())));
        }
    }
    assert!(!cases("parseArgs").is_empty());
    assert!(differences.is_empty(), "{} difference(s):\n{}", differences.len(), differences.iter().take(8).cloned().collect::<Vec<_>>().join("\n"));
}

#[test]
fn the_carrier_decodes_as_node_decodes_it() {
    let mut differences = Vec::new();
    for case in cases("carrier") {
        let value = case["value"].as_str();
        let got = decode_skill_argv(value).map_or(Value::Null, |items| serde_json::json!(items));
        if got != case["observed"] {
            differences.push(format!("{:?}\n  node: {}\n  rust: {}", case["value"], clip(&case["observed"].to_string()), clip(&got.to_string())));
        }
    }
    assert!(differences.is_empty(), "{} difference(s):\n{}", differences.len(), differences.iter().take(8).cloned().collect::<Vec<_>>().join("\n"));
}

/// The entry reads the target and its arguments as `skill-script-entry.mjs` does. A stand-in for the script prints the
/// arguments it was given, as the recorded probe does; a script that does not exist fails.
#[test]
fn the_entry_runs_what_node_runs() {
    let mut differences = Vec::new();
    for case in cases("entry") {
        let name = case["case"].as_str().expect("a case name");
        let outcome = run_entry(&strings(&case["argv"]), case["env"].as_str(), |target, args| {
            if target == "probe.mjs" {
                Ok(Outcome { stdout: serde_json::json!({ "args": args }).to_string(), stderr: String::new(), code: 0 })
            } else {
                Err(format!("Cannot find module {target}"))
            }
        });
        let observed = &case["observed"];
        let status = observed["status"].as_i64().expect("a status");
        let stdout = observed["stdout"].as_str().expect("stdout");
        let expected_args = if stdout.is_empty() { None } else { Some(serde_json::from_str::<Value>(stdout).expect("probe output")["args"].clone()) };
        let got_args = if outcome.stdout.is_empty() { None } else { Some(serde_json::from_str::<Value>(&outcome.stdout).expect("probe output")["args"].clone()) };
        let stderr_ok = match observed["stderr"].as_str().expect("stderr") {
            "<failure text>" => !outcome.stderr.is_empty(),
            text => text == outcome.stderr,
        };
        if i64::from(outcome.code) != status || expected_args != got_args || !stderr_ok {
            differences.push(format!("{name}: node status {status} args {expected_args:?}; rust status {} args {got_args:?} stderr {:?}", outcome.code, clip(&outcome.stderr)));
        }
    }
    assert!(differences.is_empty(), "{} difference(s):\n{}", differences.len(), differences.join("\n"));
}
