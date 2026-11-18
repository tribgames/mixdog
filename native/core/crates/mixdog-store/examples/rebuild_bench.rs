//! Times the index projection of a data dir's sessions into a new database: `rebuild_bench <data> <db>`.

use std::path::PathBuf;
use std::time::Instant;

fn main() {
    let mut args = std::env::args_os().skip(1);
    let data = PathBuf::from(args.next().expect("the data dir"));
    let db = PathBuf::from(args.next().expect("the database to create"));
    let mut ids: Vec<String> = std::fs::read_dir(data.join("sessions"))
        .expect("sessions")
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().join("log.000000").is_file())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    ids.sort();
    let started = Instant::now();
    mixdog_store::sqlite::project_index(&data, &db, &ids).expect("projected");
    println!("sessions={} ms={}", ids.len(), started.elapsed().as_millis());
}
