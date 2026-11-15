#!/usr/bin/env bash
# Sourced by the release installer. Its caller owns the deployment lock and
# has removed stale NEXT_DIR/BACKUP_DIR before arming the transaction, and has
# set INSTALL_DIR, NEXT_DIR, BACKUP_DIR, RELAY_BINARY (the path the unit must run)
# and EXEC_DROPIN (the drop-in file that points the unit at it).
SWAP_STARTED=0
# 1 once the drop-in was written by this transaction; 0 means it is untouched.
DROPIN_CHANGED=0
# What the drop-in was before this transaction: absent, or the text it held.
DROPIN_EXISTED=0
DROPIN_PREVIOUS=""

# A unit that still runs the previous (Node) release is pointed at the binary by a
# drop-in: ExecStart is reset, then set, and the Node heap option the old unit sets
# is unset. A unit that already names the binary is left alone.
ensure_exec_dropin() {
	local shown
	shown="$(systemctl show -p ExecStart mixdog-relay)"
	if [[ "$shown" == *"path=$RELAY_BINARY "* ]]; then
		return 0
	fi
	DROPIN_EXISTED=0
	if [[ -f "$EXEC_DROPIN" ]]; then
		DROPIN_EXISTED=1
		DROPIN_PREVIOUS="$(
			cat "$EXEC_DROPIN"
			printf x
		)"
		DROPIN_PREVIOUS="${DROPIN_PREVIOUS%x}"
	fi
	DROPIN_CHANGED=1
	mkdir -p "$(dirname "$EXEC_DROPIN")"
	printf '[Service]\nExecStart=\nExecStart=%s\nUnsetEnvironment=NODE_OPTIONS\n' "$RELAY_BINARY" >"$EXEC_DROPIN"
	systemctl daemon-reload
}

# Puts the drop-in back to what it was before ensure_exec_dropin and reloads the
# manager, so the restored release runs under the unit it ran under.
restore_exec_dropin() {
	[[ "$DROPIN_CHANGED" = 1 ]] || return 0
	if [[ "$DROPIN_EXISTED" = 1 ]]; then
		printf '%s' "$DROPIN_PREVIOUS" >"$EXEC_DROPIN" || return 1
	else
		rm -f -- "$EXEC_DROPIN" || return 1
	fi
	DROPIN_CHANGED=0
	systemctl daemon-reload
}

activate_release() {
	# Arm BEFORE either rename: failure (or a signal) between the two moves must
	# restore the previous installation, even though the new one never ran.
	SWAP_STARTED=1
	mv "$INSTALL_DIR" "$BACKUP_DIR"
	mv "$NEXT_DIR" "$INSTALL_DIR"
	ensure_exec_dropin
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
		if ! restore_exec_dropin; then
			echo "[deploy] ROLLBACK FAILED: the service unit override could not be restored; previous release is at $INSTALL_DIR" >&2
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
	DROPIN_CHANGED=0
	trap - ERR INT TERM
}
