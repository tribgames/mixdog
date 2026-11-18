#!/usr/bin/env bash
set -euo pipefail

exec node scripts/ci/release-assets.mjs upload "$@"
