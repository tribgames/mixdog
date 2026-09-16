#!/usr/bin/env bash
# Parity fixture: declaration and import shapes the graph reports for bash.
set -euo pipefail

source ./lib/common.sh
. ./lib/extra.sh

log_info() {
  printf '[info] %s\n' "$1"
}

function run_build() {
  local target="${1:-all}"
  log_info "building ${target}"
  helper_inner() {
    printf 'inner\n'
  }
  helper_inner
}

main() {
  run_build "$@"
}

main "$@"
