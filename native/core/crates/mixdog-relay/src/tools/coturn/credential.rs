//! `turn-credential <user-id> [offset-ms]`: prints `<username> <credential>` for a short-lived TURN credential minted from the
//! secret in `TURN_AUTH_SECRET`. The clock is read as now plus `offset-ms` (default 0), so a negative offset yields an expired
//! credential. The secret is read from the environment only, never from an argument, so it does not appear in a process listing.

use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::ice::turn::{TURN_CREDENTIAL_TTL_SECONDS, issue_turn_credential};

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as i64)
}

/// The output line for `user_id` at `now_ms`.
pub fn credential_line(secret: &str, user_id: &str, now_ms: i64) -> String {
    let issued = issue_turn_credential(secret, user_id, now_ms, TURN_CREDENTIAL_TTL_SECONDS);
    format!("{} {}", issued.username, issued.credential)
}

pub fn main(args: &[String]) -> ExitCode {
    let Some(user_id) = args.first().filter(|id| !id.is_empty()) else {
        eprintln!("usage: mixdog-relay turn-credential <user-id> [offset-ms]  (the secret is TURN_AUTH_SECRET)");
        return ExitCode::from(2);
    };
    let offset = match args.get(1).filter(|offset| !offset.is_empty()).map(|offset| offset.parse::<i64>()) {
        None => 0,
        Some(Ok(offset)) => offset,
        Some(Err(_)) => {
            eprintln!("not an offset in milliseconds: {}", args[1]);
            return ExitCode::from(2);
        }
    };
    let Some(secret) = std::env::var("TURN_AUTH_SECRET").ok().filter(|secret| !secret.is_empty()) else {
        eprintln!("TURN_AUTH_SECRET is not set");
        return ExitCode::from(1);
    };
    println!("{}", credential_line(&secret, user_id, now_ms().saturating_add(offset)));
    ExitCode::SUCCESS
}
