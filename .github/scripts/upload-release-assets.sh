#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${RELEASE_ID:?RELEASE_ID is required}"
test "$#" -gt 0

api="repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}"
upload_url="$(gh api "$api" --jq '.upload_url | split("{")[0]')"

remote_asset() {
  local name="$1"
  gh api --paginate "${api}/assets?per_page=100" \
    --jq ".[] | select(.name == \"${name}\") | [.id, .state, .size, .digest] | @tsv" \
    | head -n 1
}

delete_remote_asset() {
  local row="$1"
  local id="${row%%$'\t'*}"
  if [[ -n "$id" ]]; then gh api --method DELETE "repos/${GITHUB_REPOSITORY}/releases/assets/${id}"; fi
}

remote_asset_is_complete() {
  local row="$1" id state size digest
  IFS=$'\t' read -r id state size digest <<< "$row"
  [[ -n "$id" && "$state" == uploaded && "$size" =~ ^[1-9][0-9]*$ \
    && "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
}

upload_asset() {
  local asset="$1" name existing uploaded response attempt
  test -f "$asset"
  name="$(basename "$asset")"
  existing="$(remote_asset "$name")"
  if [[ -n "$existing" ]]; then delete_remote_asset "$existing"; fi

  uploaded=false
  for attempt in 1 2; do
    response="$(mktemp)"
    echo "Uploading ${name} over bounded HTTP/1.1 (attempt ${attempt}/2)"
    if curl --fail-with-body --silent --show-error --http1.1 \
      --connect-timeout 20 --max-time 150 \
      --speed-limit 1024 --speed-time 20 \
      --request POST \
      --header "Accept: application/vnd.github+json" \
      --header "Authorization: Bearer ${GH_TOKEN}" \
      --header "X-GitHub-Api-Version: 2022-11-28" \
      --header "Content-Type: application/octet-stream" \
      --header "Expect:" \
      --data-binary "@${asset}" \
      --output "$response" \
      "${upload_url}?name=${name}"; then
      node --input-type=module - "$response" <<'NODE'
      import { readFileSync } from 'node:fs';
      const asset = JSON.parse(readFileSync(process.argv[2], 'utf8'));
      if (asset.state !== 'uploaded' || !(asset.size > 0)
          || !/^sha256:[0-9a-f]{64}$/.test(String(asset.digest || ''))) {
        throw new Error(`Incomplete uploaded asset response: ${asset.name || '(unknown)'}`);
      }
NODE
      rm -f "$response"
      uploaded=true
      break
    fi
    rm -f "$response"

    existing="$(remote_asset "$name")"
    if remote_asset_is_complete "$existing"; then
      uploaded=true
      break
    fi
    if [[ -n "$existing" ]]; then delete_remote_asset "$existing"; fi
  done

  if [[ "$uploaded" != true ]]; then
    echo "Failed to upload ${name} after two bounded attempts" >&2
    return 1
  fi
}

pids=()
for asset in "$@"; do
  upload_asset "$asset" &
  pids+=("$!")
done

failed=false
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then failed=true; fi
done
if [[ "$failed" == true ]]; then exit 1; fi
