#!/usr/bin/env bash
# Shared helpers for the graph outline fixture.

set -euo pipefail

source ./lib/common.sh
source "lib/quoted.sh"
. ./lib/posix.sh
. 'lib/single.sh'

# Commented-out include should not be extracted as a live import.
# source ./dead.sh

usage() {
  echo "usage: $0 [--help]"
}

function greet() {
  local name="${1:-world}"
  echo "hello ${name}"
}

log_info() {
  printf '[info] %s\n' "$*"
}

run_pipeline() {
  greet "$USER"
  log_info "pipeline done"
}

main() {
  if [[ "${1:-}" == "--help" ]]; then
    usage
    return 0
  fi
  run_pipeline
}

nested_wrapper() {
  inner() {
    log_info "inner"
  }
  inner
}

main "$@"
