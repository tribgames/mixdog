#!/usr/bin/env bash
# Fault-injection harness: real renames in a caller-created temporary folder,
# with systemctl replaced by a recorder. Never sources the production entry.
set -Eeuo pipefail
root="$(cd "$1" && pwd)"
scenario="$2"
[[ "$(basename "$root")" = mixdog-release-transaction-* ]]
INSTALL_DIR="$root/mixdog-relay"
NEXT_DIR="$root/mixdog-relay.next-v0.0.1"
BACKUP_DIR="$root/mixdog-relay.backup-v0.0.1"
source "$(dirname "${BASH_SOURCE[0]}")/release-transaction.sh"
restart_count=0
systemctl() {
  printf '%s\n' "$*" >> "$root/service-operations"
  case "$1" in
    stop) [[ "$scenario" != stop-fails ]] ;;
    restart)
      restart_count=$((restart_count + 1))
      if [[ "$scenario" = restart-fails && "$restart_count" = 1 ]]; then return 1; fi
      [[ "$scenario" != rollback-start-fails || "$restart_count" = 1 ]]
      ;;
    is-active) return 0 ;;
    *) return 99 ;;
  esac
}
mv() {
  if [[ "$scenario" = first-move-fails && "$1" = "$INSTALL_DIR" ]]; then return 1; fi
  if [[ "$scenario" = second-move-fails && "$1" = "$NEXT_DIR" ]]; then return 1; fi
  command mv "$@"
}
arm_release_transaction
if [[ "$scenario" = preparation-fails ]]; then false; fi
activate_release
if [[ "$scenario" = verify-fails || "$scenario" = stop-fails || "$scenario" = rollback-start-fails ]]; then
  false
fi
if [[ "$scenario" = interrupted ]]; then
  kill -TERM "$$"
fi
commit_release_transaction
