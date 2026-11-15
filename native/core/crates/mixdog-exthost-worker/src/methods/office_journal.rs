//! `office.sweepJournals` (`'office.sweepJournals'` of `src/ext-host/methods.mjs`): the listing of the Office transaction journals
//! of a data directory, run for its effect. The listing creates the `office-transactions` folder and removes the records (with
//! the checkpoint and baseline PDF they name) and the unreadable files that are more than 30 days old; the answer is `null`.

use std::path::Path;

use mixdog_fsio::Unlaned;
use mixdog_js::uv_error::error_code;
use mixdog_office_base::journal::list_office_journals;
use serde_json::Value;

use crate::ctx::CallCtx;
use crate::error::CodedError;
use crate::registry::HandlerResult;
use crate::registry::Outcome;
use crate::registry::Registry;

pub(super) fn register(registry: &mut Registry) {
    registry.register_blocking("office.sweepJournals", sweep);
}

/// `listOfficeJournals(ctx.params.dataDir)`: an absent `dataDir` and an empty one are the default data directory; any other
/// value that is not a string is what `path.resolve` refuses.
fn data_dir(params: &Value) -> Result<&str, CodedError> {
    match params.get("dataDir") {
        None => Ok(""),
        Some(Value::String(text)) => Ok(text),
        Some(_) => Err(CodedError::new(
            "ERR_INVALID_ARG_TYPE",
            "The \"paths[0]\" argument must be of type string",
        )),
    }
}

fn sweep(ctx: CallCtx) -> HandlerResult {
    let dir = data_dir(&ctx.params)?;
    if ctx.cancel.is_cancelled() {
        return Err(CodedError::cancelled());
    }
    // The worker runs no lane job of the daemon: its file calls go through the unlaned proof, as the other document methods do.
    list_office_journals(&Unlaned, Path::new(dir), true).map_err(|error| {
        CodedError::new(error_code(&error).unwrap_or("failed"), error.to_string())
    })?;
    Ok(Outcome::value(Value::Null))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_data_dir_is_a_string_or_absent() {
        assert_eq!(data_dir(&json!({})).unwrap(), "");
        assert_eq!(data_dir(&json!({"dataDir": "/x"})).unwrap(), "/x");
        for bad in [json!({"dataDir": null}), json!({"dataDir": 3})] {
            assert_eq!(data_dir(&bad).unwrap_err().code, "ERR_INVALID_ARG_TYPE");
        }
    }
}
