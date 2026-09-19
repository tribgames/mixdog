// Long-lived server mode: one process answers apply requests over stdin/stdout.

use super::*;

pub(crate) fn run_server() -> Result<(), String> {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut stdout = io::stdout().lock();
    // Idle self-exit watchdog. An orphaned server (parent force-killed without
    // closing our stdin — e.g. a surviving supervisor still holding the pipe's
    // write handle) would never see EOF and would live forever, so they pile up
    // across restarts. A side thread exits the whole process once no request has
    // arrived within the idle window; the JS layer transparently respawns on the
    // next request (getNativePatchServer detects `.exited`). Tunable via
    // MIXDOG_PATCH_SERVER_IDLE_MS (default 300000ms); set 0 to disable.
    let idle_ms: u64 = env::var("MIXDOG_PATCH_SERVER_IDLE_MS")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(300_000);
    let last_activity = Arc::new(AtomicU64::new(now_ms()));
    if idle_ms > 0 {
        let watch = Arc::clone(&last_activity);
        let step = Duration::from_millis(idle_ms.clamp(250, 5_000));
        thread::spawn(move || loop {
            thread::sleep(step);
            if now_ms().saturating_sub(watch.load(Ordering::Relaxed)) >= idle_ms {
                std::process::exit(0);
            }
        });
    }
    loop {
        let mut header = String::new();
        let n = reader
            .read_line(&mut header)
            .map_err(|e| format!("server read header: {e}"))?;
        if n == 0 {
            break;
        }
        last_activity.store(now_ms(), Ordering::Relaxed);
        let header = header.trim_end_matches(['\r', '\n']);
        if header == "QUIT" {
            break;
        }
        if header == "PING" {
            writeln!(stdout, "OK\tPONG").map_err(|e| format!("server write ping response: {e}"))?;
            stdout
                .flush()
                .map_err(|e| format!("server flush ping response: {e}"))?;
            continue;
        }
        // Contract handshake. The RUNNING session states the engine contract it
        // implements, so the proof belongs to the process that will execute the
        // work: a wrapper that only prints the marker cannot answer here, and a
        // swapped artifact cannot change what this process already is.
        if header == "CONTRACT" {
            writeln!(stdout, "OK\t{ENGINE_CONTRACT_MARKER}")
                .map_err(|e| format!("server write contract response: {e}"))?;
            stdout
                .flush()
                .map_err(|e| format!("server flush contract response: {e}"))?;
            continue;
        }
        // EDIT protocol: invariant-safe char-indexed edit over the persistent
        // server. EDIT <path_len> <old_len> <new_len> <replace_all> <dry_run>
        // then path+old+new bytes on stdin. Reuses apply_invariant_safe_edit.
        {
            let parts: Vec<&str> = header.split_whitespace().collect();
            if parts.first() == Some(&"EDIT") {
                if parts.len() != 6 {
                    write_server_err(&mut stdout, "bad edit header")?;
                    continue;
                }
                let path_len = match parts[1].parse::<usize>() {
                    Ok(v) => v,
                    Err(_) => {
                        write_server_err(&mut stdout, "bad path length")?;
                        continue;
                    }
                };
                let old_len = match parts[2].parse::<usize>() {
                    Ok(v) => v,
                    Err(_) => {
                        write_server_err(&mut stdout, "bad old length")?;
                        continue;
                    }
                };
                let new_len = match parts[3].parse::<usize>() {
                    Ok(v) => v,
                    Err(_) => {
                        write_server_err(&mut stdout, "bad new length")?;
                        continue;
                    }
                };
                let replace_all = match parts[4] {
                    "0" => false,
                    "1" => true,
                    _ => {
                        write_server_err(&mut stdout, "bad replace_all value")?;
                        continue;
                    }
                };
                let dry_run = parts[5] == "1";
                let mut path_buf = vec![0u8; path_len];
                let mut old_buf = vec![0u8; old_len];
                let mut new_buf = vec![0u8; new_len];
                if let Err(err) = reader.read_exact(&mut path_buf) {
                    write_server_err(&mut stdout, &format!("read edit path: {err}"))?;
                    break;
                }
                if let Err(err) = reader.read_exact(&mut old_buf) {
                    write_server_err(&mut stdout, &format!("read edit old: {err}"))?;
                    break;
                }
                if let Err(err) = reader.read_exact(&mut new_buf) {
                    write_server_err(&mut stdout, &format!("read edit new: {err}"))?;
                    break;
                }
                let path = match String::from_utf8(path_buf) {
                    Ok(v) => v,
                    Err(_) => {
                        write_server_err(&mut stdout, "edit path is not UTF-8")?;
                        continue;
                    }
                };
                match apply_invariant_safe_edit_to_path(
                    Path::new(&path),
                    &old_buf,
                    &new_buf,
                    replace_all,
                    dry_run,
                ) {
                    Ok((stats, tier)) => {
                        writeln!(
                            stdout,
                            "OK\t{}\t{:.3}\t{:.3}\t{:.3}\t{:.3}\t{}\t{}",
                            stats.replacements,
                            stats.read_ms,
                            stats.apply_ms,
                            stats.write_ms,
                            stats.total_ms,
                            tier.label(),
                            stats.content_hash
                        )
                        .map_err(|e| format!("server write edit response: {e}"))?;
                    }
                    Err(e) => {
                        write_server_err(&mut stdout, &e)?;
                    }
                }
                stdout
                    .flush()
                    .map_err(|e| format!("server flush edit response: {e}"))?;
                continue;
            }
        }
        let parts: Vec<&str> = header.split_whitespace().collect();
        // Protocol: APPLY base_len patch_len timing dry_run fuzz reject_partial
        if parts.len() != 7 || parts[0] != "APPLY" {
            write_server_err(&mut stdout, "bad header")?;
            continue;
        }
        let base_len = match parts[1].parse::<usize>() {
            Ok(v) => v,
            Err(_) => {
                write_server_err(&mut stdout, "bad base length")?;
                continue;
            }
        };
        let patch_len = match parts[2].parse::<usize>() {
            Ok(v) => v,
            Err(_) => {
                write_server_err(&mut stdout, "bad patch length")?;
                continue;
            }
        };
        let _timing = parts[3] == "1";
        let dry_run = parts[4] == "1";
        let fuzz_factor = match parts[5].parse::<usize>() {
            Ok(v) => v,
            Err(_) => {
                write_server_err(&mut stdout, "bad fuzz value")?;
                continue;
            }
        };
        let reject_partial = match parts[6] {
            "0" => false,
            "1" => true,
            _ => {
                write_server_err(&mut stdout, "bad reject_partial value")?;
                continue;
            }
        };
        let opts = ApplyOptions {
            fuzz_factor,
            reject_partial,
        };
        let mut base_buf = vec![0u8; base_len];
        let mut patch_buf = vec![0u8; patch_len];
        if let Err(err) = reader.read_exact(&mut base_buf) {
            write_server_err(&mut stdout, &format!("read base payload: {err}"))?;
            break;
        }
        if let Err(err) = reader.read_exact(&mut patch_buf) {
            write_server_err(&mut stdout, &format!("read patch payload: {err}"))?;
            break;
        }
        let base = match String::from_utf8(base_buf) {
            Ok(v) => v,
            Err(_) => {
                write_server_err(&mut stdout, "base path is not UTF-8")?;
                continue;
            }
        };
        let patch = match String::from_utf8(patch_buf) {
            Ok(v) => v,
            Err(_) => {
                write_server_err(&mut stdout, "patch is not UTF-8")?;
                continue;
            }
        };
        match apply_patch_to_base(Path::new(&base), &patch, dry_run, &opts) {
            Ok(stats) => {
                let content_hashes = stats.content_hashes.join(",");
                if stats.failed.is_empty() {
                    writeln!(
                        stdout,
                        "OK\t{}\t{:.3}\t{:.3}\t{:.3}\t{:.3}\t{:.3}\t{}",
                        stats.files,
                        stats.read_ms,
                        stats.apply_ms,
                        stats.write_ms,
                        stats.total_ms,
                        stats.hash_ms,
                        content_hashes
                    )
                    .map_err(|e| format!("server write response: {e}"))?;
                } else {
                    let mut payload = String::new();
                    for fail in &stats.failed {
                        if !payload.is_empty() {
                            payload.push('\n');
                        }
                        payload.push_str(&fail.descriptor.replace(['\t', '\n', '\r'], " "));
                        payload.push('\t');
                        payload.push_str(&fail.reason.replace(['\t', '\n', '\r'], " "));
                    }
                    let failures_hex = hex_bytes(payload.as_bytes());
                    writeln!(
                        stdout,
                        "OK_PARTIAL\t{}\t{}\t{:.3}\t{:.3}\t{:.3}\t{:.3}\t{:.3}\t{}\t{}",
                        stats.files,
                        stats.failed.len(),
                        stats.read_ms,
                        stats.apply_ms,
                        stats.write_ms,
                        stats.total_ms,
                        stats.hash_ms,
                        content_hashes,
                        failures_hex
                    )
                    .map_err(|e| format!("server write response: {e}"))?;
                }
                stdout
                    .flush()
                    .map_err(|e| format!("server flush response: {e}"))?;
            }
            Err(err) => write_server_err(&mut stdout, &err)?,
        }
    }
    Ok(())
}

pub(crate) fn write_server_err(out: &mut dyn Write, msg: &str) -> Result<(), String> {
    let clean = msg.replace(['\r', '\n', '\t'], " ");
    writeln!(out, "ERR\t{clean}").map_err(|e| format!("server write error response: {e}"))?;
    out.flush()
        .map_err(|e| format!("server flush error response: {e}"))
}
