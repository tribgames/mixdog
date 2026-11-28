#!/usr/bin/env bash
# Waits until a run artifact exists, so a job that needs it can start its own work (checkout, runtime
# preparation) while the job that produces it is still running, instead of idling behind `needs:`.
#
#   wait-for-artifact.sh <artifact name> <producer job name> [minutes]
#
# Polls this run (GITHUB_RUN_ID) through the Actions API (the calling job needs `actions: read` and GH_TOKEN).
# The producer is matched by its job name, or by its name as a called workflow's job ("<caller> / <name>"). A
# producer that finished without success fails this at once instead of waiting out the deadline.
set -uo pipefail
artifact=${1:?artifact name}
producer=${2:?producer job name}
minutes=${3:-25}
deadline=$((SECONDS + minutes * 60))
api_failures=0
missing_after_success=0
while :; do
	# Thirty jobs a page: GitHub answered 502 to every page of 100 of a deploy run of 166 jobs (46102511409) and served
	# the same listing in pages of 50 and 30.
	if ! build=$(gh api --paginate \
		"repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/jobs?per_page=30" \
		--jq ".jobs[] | select(.name == \"${producer}\" or (.name | endswith(\" / ${producer}\"))) | \"\(.status) \(.conclusion)\""); then
		build=unknown
	fi
	if ! count=$(gh api \
		"repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/artifacts?name=${artifact}&per_page=100" \
		--jq '[.artifacts[] | select(.expired | not)] | length'); then
		count=unknown
	fi
	if [ "$build" = unknown ] || [ "$count" = unknown ]; then
		api_failures=$((api_failures + 1))
		if [ "$api_failures" -ge 5 ]; then
			echo "::error title=${artifact} unavailable::The Actions API failed ${api_failures} times in a row."
			exit 1
		fi
	else
		api_failures=0
		build=$(printf '%s\n' "$build" | tail -n 1)
		case "$build" in
		"completed success" | "") ;;
		completed*)
			echo "::error title=${producer} failed::${producer} finished as '${build#completed }'; there is no ${artifact} to use."
			exit 1
			;;
		esac
		if [ "$count" -gt 0 ]; then
			echo "${artifact} is available (${producer}: ${build:-not listed})."
			exit 0
		fi
		# Three polls of grace for the artifact listing to catch up.
		if [ "$build" = "completed success" ]; then
			missing_after_success=$((missing_after_success + 1))
			if [ "$missing_after_success" -ge 3 ]; then
				echo "::error title=${artifact} missing::${producer} succeeded without a ${artifact} artifact."
				exit 1
			fi
		fi
	fi
	if [ "$SECONDS" -ge "$deadline" ]; then
		echo "::error title=${artifact} timed out::${artifact} did not appear within ${minutes} minutes (${producer}: ${build:-not listed})."
		exit 1
	fi
	sleep 10
done
