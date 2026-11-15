#!/usr/bin/env bash
# Release transaction tests: real renames in a temporary folder, with systemctl
# replaced by a recorder. Never sources the production entry.
#
#   bash release-transaction.test.sh                      runs every scenario
#   bash release-transaction.test.sh <folder> <scenario>  the fault-injection harness for one
#
# The folder of the harness is caller-created and named mixdog-release-transaction-*.
set -Eeuo pipefail

SELF="${BASH_SOURCE[0]}"

harness() {
	local root scenario
	root="$(cd "$1" && pwd)"
	scenario="$2"
	[[ "$(basename "$root")" = mixdog-release-transaction-* ]]
	INSTALL_DIR="$root/mixdog-relay"
	NEXT_DIR="$root/mixdog-relay.next-v0.0.1"
	# shellcheck disable=SC2034  # consumed by the sourced release-transaction.sh
	BACKUP_DIR="$root/mixdog-relay.backup-v0.0.1"
	# shellcheck disable=SC2034  # consumed by the sourced release-transaction.sh
	RELAY_BINARY=/opt/mixdog-relay/mixdog-relay
	# shellcheck disable=SC2034  # consumed by the sourced release-transaction.sh
	EXEC_DROPIN="$root/unit.d/exec.conf"
	# shellcheck source-path=SCRIPTDIR
	# shellcheck source=release-transaction.sh
	source "$(dirname "$SELF")/release-transaction.sh"
	local restart_count=0 reload_count=0
	systemctl() {
		printf '%s\n' "$*" >>"$root/service-operations"
		case "$1" in
		stop) [[ "$scenario" != stop-fails ]] ;;
		restart)
			restart_count=$((restart_count + 1))
			if [[ "$scenario" = restart-fails && "$restart_count" = 1 ]]; then return 1; fi
			[[ "$scenario" != rollback-start-fails || "$restart_count" = 1 ]]
			;;
		is-active) return 0 ;;
		daemon-reload)
			reload_count=$((reload_count + 1))
			[[ "$scenario" != dropin-rollback-reload-fails || "$reload_count" = 1 ]]
			;;
		show)
			# The unit of the previous release runs node; the scenarios that do not
			# name the drop-in run a unit that already names the binary.
			if [[ "$scenario" = dropin-* && "$scenario" != dropin-present ]]; then
				echo 'ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /opt/mixdog-relay/server.mjs ; }'
			else
				echo "ExecStart={ path=$RELAY_BINARY ; argv[]=$RELAY_BINARY ; }"
			fi
			;;
		*) return 99 ;;
		esac
	}
	mv() {
		if [[ "$scenario" = first-move-fails && "$1" = "$INSTALL_DIR" ]]; then return 1; fi
		if [[ "$scenario" = second-move-fails && "$1" = "$NEXT_DIR" ]]; then return 1; fi
		command mv "$@"
	}
	if [[ "$scenario" = dropin-existing-rollback ]]; then
		mkdir -p "$root/unit.d"
		printf '[Service]\nExecStart=\nExecStart=/somewhere/else\n' >"$EXEC_DROPIN"
	fi
	arm_release_transaction
	if [[ "$scenario" = preparation-fails ]]; then false; fi
	activate_release
	case "$scenario" in
	verify-fails | stop-fails | rollback-start-fails | dropin-rollback | dropin-existing-rollback | dropin-rollback-reload-fails) false ;;
	esac
	if [[ "$scenario" = interrupted ]]; then
		kill -TERM "$$"
	fi
	commit_release_transaction
}

failures=0
check() { # <description> <condition result: 0 holds>
	if [[ "$2" != 0 ]]; then
		echo "FAIL: $scenario: $1" >&2
		failures=$((failures + 1))
	fi
}
same() { # <file> <expected text>
	[[ -f "$1" && "$(<"$1")" = "$2" ]]
}
operations() { cat "$root/service-operations" 2>/dev/null || true; }

run_scenario() {
	local root install next backup status expected_status stderr
	local swapped=0
	root="$(mktemp -d "${TMPDIR:-/tmp}/mixdog-release-transaction-XXXXXX")"
	install="$root/mixdog-relay"
	next="$root/mixdog-relay.next-v0.0.1"
	backup="$root/mixdog-relay.backup-v0.0.1"
	mkdir "$install" "$next"
	printf old >"$install/release"
	printf new >"$next/release"
	# The side-by-side renderer registry travels with the install tree, so it is
	# swapped, backed up and rolled back as one unit with it.
	mkdir "$install/renderer-releases" "$next/renderer-releases"
	printf old-registry >"$install/renderer-releases/index.json"
	printf new-registry >"$next/renderer-releases/index.json"
	status=0
	timeout 15 bash --noprofile --norc "$SELF" "$root" "$scenario" 2>"$root/stderr" || status=$?
	stderr="$(<"$root/stderr")"
	case "$scenario" in
	success | dropin-install | dropin-present) expected_status=0 ;;
	interrupted) expected_status=143 ;;
	stop-fails | rollback-start-fails | dropin-rollback-reload-fails) expected_status=90 ;;
	*) expected_status=1 ;;
	esac
	[[ "$status" = "$expected_status" ]]
	check "exit status $status, expected $expected_status: $stderr" $?
	case "$scenario" in success | stop-fails | dropin-install | dropin-present) swapped=1 ;; esac
	if [[ "$swapped" = 1 ]]; then
		same "$install/release" new
		check "the new release is installed" $?
		same "$install/renderer-releases/index.json" new-registry
		check "the new registry is installed" $?
		same "$backup/release" old
		check "the previous release is kept as the backup" $?
		same "$backup/renderer-releases/index.json" old-registry
		check "the previous registry is kept in the backup" $?
	elif [[ "$scenario" != dropin-rollback-reload-fails ]]; then
		same "$install/release" old
		check "the previous release is restored" $?
		same "$install/renderer-releases/index.json" old-registry
		check "the previous registry is restored" $?
	fi
	case "$scenario" in
	preparation-fails | first-move-fails)
		[[ ! -e "$root/service-operations" ]]
		check "no service operation ran" $?
		;;
	second-move-fails)
		[[ "$(operations)" = $'stop mixdog-relay\nrestart mixdog-relay\nis-active --quiet mixdog-relay' ]]
		check "the service was stopped, restarted and checked after the rollback" $?
		;;
	stop-fails | rollback-start-fails | dropin-rollback-reload-fails)
		[[ "$stderr" == *"ROLLBACK FAILED"* ]]
		check "the failed rollback is reported" $?
		;;
	esac
	case "$scenario" in
	dropin-install)
		same "$root/unit.d/exec.conf" $'[Service]\nExecStart=\nExecStart=/opt/mixdog-relay/mixdog-relay\nUnsetEnvironment=NODE_OPTIONS'
		check "the drop-in points the unit at the binary and unsets NODE_OPTIONS" $?
		[[ "$(operations)" = $'show -p ExecStart mixdog-relay\ndaemon-reload\nrestart mixdog-relay' ]]
		check "the manager is reloaded before the restart" $?
		;;
	dropin-present)
		[[ ! -e "$root/unit.d/exec.conf" && "$(operations)" = $'show -p ExecStart mixdog-relay\nrestart mixdog-relay' ]]
		check "a unit that names the binary gets no drop-in and no reload" $?
		;;
	dropin-rollback)
		[[ ! -e "$root/unit.d/exec.conf" ]]
		check "a failed first switch leaves no drop-in" $?
		[[ "$(operations)" = $'show -p ExecStart mixdog-relay\ndaemon-reload\nrestart mixdog-relay\nstop mixdog-relay\ndaemon-reload\nrestart mixdog-relay\nis-active --quiet mixdog-relay' ]]
		check "the manager is reloaded after the drop-in is removed, before the restart" $?
		;;
	dropin-existing-rollback)
		same "$root/unit.d/exec.conf" $'[Service]\nExecStart=\nExecStart=/somewhere/else'
		check "a drop-in that existed is restored as it was" $?
		;;
	dropin-rollback-reload-fails)
		[[ ! -e "$root/unit.d/exec.conf" ]]
		check "the drop-in is gone although the reload failed" $?
		;;
	esac
	rm -rf "$root"
	echo "ok: $scenario"
}

if [[ $# -gt 0 ]]; then
	harness "$@"
	exit
fi
# A failed check is counted and reported, not a reason to stop the run.
set +e
for scenario in \
	success preparation-fails first-move-fails second-move-fails restart-fails verify-fails interrupted \
	stop-fails rollback-start-fails dropin-install dropin-present dropin-rollback dropin-existing-rollback \
	dropin-rollback-reload-fails; do
	run_scenario
done
if [[ "$failures" != 0 ]]; then
	echo "$failures check(s) failed" >&2
	exit 1
fi
