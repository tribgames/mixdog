# Sourced by the Linux steps of action.yml.
OFFICE_APT_PACKAGES="fonts-liberation fonts-crosextra-carlito fonts-nanum libreoffice-writer libreoffice-impress libreoffice-calc"

# A stuck mirror once held a step for 30+ minutes. A composite step has no
# timeout-minutes, so each apt call is bounded by timeout and retried, which
# fails over to another mirror address.
apt_retry() {
	local limit="$1" attempt
	shift
	for attempt in 1 2 3; do
		if sudo timeout -k 10 "$limit" apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 "$@"; then
			return 0
		fi
		echo "apt-get $1 failed (attempt ${attempt}/3)" >&2
		sleep $((attempt * 5))
	done
	return 1
}
