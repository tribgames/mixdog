# Local model maintenance

Read to verify, repair or delete an installed model, or to report a model's
load time or speed.

- Integrity check: `maintain_local_model` with `modelId` and
  `operation: verify` returns a cancellable background checksum job.
- Redownload: with approval, `operation: repair`. An active model must first
  be explicitly unloaded. A failed redownload retains the previous file.
- Deletion:
  1. Read `local_model_details` and show its exact file paths, size and the
     permanent-deletion warning. This is not Recycle Bin deletion; recovery
     means redownloading.
  2. Obtain explicit approval, then call `delete_local_model` with its recent
     `confirmationToken`. Tokens expire and changed files need a new
     confirmation.
  3. Never force deletion of an in-use model.
- The detail dialog shows load time, first-response latency, generation speed
  and sampled free GPU memory. Missing observations remain unknown, not zero.
