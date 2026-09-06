#!/usr/bin/env bash
# Sourced by the release installer. Its caller owns the deployment lock and
# has removed stale NEXT_DIR/BACKUP_DIR before arming the transaction.
SWAP_STARTED=0

activate_release() {
  # Arm BEFORE either rename: failure (or a signal) between the two moves must
  # restore the previous installation, even though the new one never ran.
  SWAP_STARTED=1
  mv "$INSTALL_DIR" "$BACKUP_DIR"
  mv "$NEXT_DIR" "$INSTALL_DIR"
  systemctl restart mixdog-relay
}

rollback() {
  local status="${1:-$?}"
  trap - ERR INT TERM
  if [[ "$SWAP_STARTED" = 1 && -d "$BACKUP_DIR" ]]; then
    # Never delete either release if the old process cannot be stopped.
    if ! systemctl stop mixdog-relay; then
      echo "[deploy] ROLLBACK FAILED: service could not stop; both releases preserved" >&2
      exit 90
    fi
    if ! rm -rf -- "$INSTALL_DIR" || ! mv "$BACKUP_DIR" "$INSTALL_DIR"; then
      echo "[deploy] ROLLBACK FAILED: previous release remains at $BACKUP_DIR" >&2
      exit 90
    fi
    if ! systemctl restart mixdog-relay || ! systemctl is-active --quiet mixdog-relay; then
      echo "[deploy] ROLLBACK FAILED: $INSTALL_DIR restored but mixdog-relay is not running" >&2
      exit 90
    fi
    echo "[deploy] rolled back to the previous release (deploy exited $status)" >&2
  fi
  # Cleanup cannot outrank restoration. A failure here leaves only a staging
  # directory, never an absent production installation.
  if ! rm -rf -- "$NEXT_DIR"; then
    echo "[deploy] could not remove staging directory $NEXT_DIR" >&2
  fi
  exit "$status"
}

arm_release_transaction() {
  trap 'rollback "$?"' ERR
  trap 'rollback 130' INT
  trap 'rollback 143' TERM
}

commit_release_transaction() {
  SWAP_STARTED=0
  trap - ERR INT TERM
}
