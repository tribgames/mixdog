#!/usr/bin/env bash
# Connection-tracking table of the relay host (deploy README, "Connection
# tracking"): TURN client flows, relayed peer flows and relay HTTPS/WebSocket
# connections each hold an entry, and once nf_conntrack_max entries exist the
# kernel drops new flows without telling anyone.
#   bash conntrack.sh apply    raise the sysctls, persist them, then report (root)
#   bash conntrack.sh report   values in force now, values configured for the next boot, usage
# Neither mode fails a release: what the host refuses or hides is reported.
set -uo pipefail

# Workload estimate, not a TURN limit: 1000 users x 5 allocations x 8 flows =
# 40000, plus ~5000 relay connections, with ~2.9x headroom; one bucket per
# entry, the kernel's own default ratio.
CONNTRACK_MAX=131072
CONNTRACK_BUCKETS=131072
NETFILTER=/proc/sys/net/netfilter
STAT_FILE=/proc/net/stat/nf_conntrack
MODULES_LOAD_FILE=/etc/modules-load.d/mixdog-conntrack.conf
SYSCTL_FILE=/etc/sysctl.d/99-mixdog-conntrack.conf
HEADER='# mixdog relay deploy (deploy/conntrack.sh); deploy README, "Connection tracking".'

note() { echo "[conntrack] $*"; }
warn() { echo "[conntrack] warning: $*" >&2; }

# The non-negative integer in a kernel file, or nothing.
value() {
	local v
	v="$(cat -- "$1" 2>/dev/null)" && [[ "$v" =~ ^[0-9]+$ ]] && printf '%s' "$v"
}

# The value the sysctl file sets for key $1 at boot, or nothing.
boot_value() {
	sed -n "s/^[[:space:]]*net[./]netfilter[./]$1[[:space:]]*=[[:space:]]*\([0-9][0-9]*\)[[:space:]]*$/\1/p" \
		"$SYSCTL_FILE" 2>/dev/null | tail -n 1
}

# Raises the live sysctl $1 to $2 and succeeds when $2 is then read back. A
# value of 0 (unlimited on some kernels), an unreadable one, or one at least $2
# is never written.
raise() {
	local path="$NETFILTER/$1" live err
	live="$(value "$path")"
	if [[ -z "$live" ]]; then
		warn "$1 is unreadable: left alone"
		return 1
	fi
	if ((live == 0)); then
		note "$1 is 0 (unlimited): left alone"
		return 1
	fi
	if ((live > $2)); then
		note "$1 is $live, above $2: left alone"
		return 1
	fi
	((live == $2)) && return 0
	if ! err="$({ printf '%s\n' "$2" >"$path"; } 2>&1)"; then
		local boot
		boot="$(boot_value "$1")"
		warn "the kernel refused $1 = $2 (${err:-no reason given}); in force now: $live; next boot: ${boot:-not set in $SYSCTL_FILE}"
		return 1
	fi
	live="$(value "$path")"
	if [[ "$live" != "$2" ]]; then
		warn "$1 = $2 was written but reads back ${live:-unreadable}"
		return 1
	fi
	note "$1 set to $2"
}

# Installs $2 as file $1 when it differs, through a temporary file renamed over
# it; succeeds only when $1 then reads back as $2. The existing file is never
# touched by a failure.
install_file() {
	[[ -f "$1" && "$(cat -- "$1" 2>/dev/null)" == "$2" ]] && return 0
	if [[ -e "$1" && ! -r "$1" ]]; then
		warn "$1 exists and cannot be read; left as it is"
		return 1
	fi
	if ! { printf '%s\n' "$2" >"$1.tmp" 2>/dev/null && mv -f -- "$1.tmp" "$1" 2>/dev/null; }; then
		rm -f -- "$1.tmp"
		warn "could not install $1; the boot configuration is what it held before"
		return 1
	fi
	if [[ "$(cat -- "$1" 2>/dev/null)" != "$2" ]]; then
		warn "$1 was replaced but does not read back as written; check it by hand"
		return 1
	fi
	note "installed $1"
}

stat_counters() {
	local header row i
	local -A sum=()
	[[ -r "$STAT_FILE" ]] || return 0
	{
		read -r -a header || return 0
		while read -r -a row; do
			for i in "${!header[@]}"; do
				case "${header[i]}" in
				drop | early_drop | insert_failed)
					[[ "${row[i]:-}" =~ ^[0-9a-fA-F]+$ ]] && sum[${header[i]}]=$((${sum[${header[i]}]:-0} + 16#${row[i]}))
					;;
				esac
			done
		done
	} <"$STAT_FILE"
	[[ -n "${sum[drop]:-}" ]] && printf '%s %s %s' "${sum[drop]}" "${sum[early_drop]:-?}" "${sum[insert_failed]:-?}"
}

tool_counters() {
	local out field key
	local -A sum=()
	command -v conntrack >/dev/null 2>&1 || return 0
	out="$(conntrack -S 2>/dev/null)" || return 0
	for field in $out; do
		key="${field%%=*}"
		case "$key" in
		drop | early_drop | insert_failed)
			[[ "${field#*=}" =~ ^[0-9]+$ ]] && sum[$key]=$((${sum[$key]:-0} + ${field#*=}))
			;;
		esac
	done
	[[ -n "${sum[drop]:-}" ]] && printf '%s %s %s' "${sum[drop]}" "${sum[early_drop]:-?}" "${sum[insert_failed]:-?}"
}

report() {
	local max count buckets usage counters source objsize mem_kib memory boot_max boot_buckets preload
	local drop early_drop insert_failed
	max="$(value "$NETFILTER/nf_conntrack_max")"
	count="$(value "$NETFILTER/nf_conntrack_count")"
	buckets="$(value "$NETFILTER/nf_conntrack_buckets")"
	usage="in use=${count:-unavailable}"
	if [[ -n "$count" && -n "$max" ]] && ((max > 0)); then
		usage+=" ($((count * 100 / max)).$((count * 1000 / max % 10))%, headroom $((max - count)))"
	fi
	[[ "$max" == 0 ]] && usage+=" (max 0: unlimited)"
	note "in force now: max=${max:-unavailable} buckets=${buckets:-unavailable} $usage"

	boot_max="$(boot_value nf_conntrack_max)"
	boot_buckets="$(boot_value nf_conntrack_buckets)"
	preload=no
	grep -qx 'nf_conntrack' "$MODULES_LOAD_FILE" 2>/dev/null && preload=yes
	note "next boot ($SYSCTL_FILE): max=${boot_max:-not set} buckets=${boot_buckets:-not set}; nf_conntrack preloaded: $preload"

	source="$STAT_FILE"
	counters="$(stat_counters)"
	if [[ -z "$counters" ]]; then
		source="conntrack -S"
		counters="$(tool_counters)"
	fi
	if [[ -n "$counters" ]]; then
		read -r drop early_drop insert_failed <<<"$counters"
		note "since boot ($source): drop=$drop (new flows refused) early_drop=$early_drop (entries evicted under pressure) insert_failed=$insert_failed"
	else
		note "drop counters unavailable (no readable $STAT_FILE, no conntrack -S): unknown, not zero"
	fi

	objsize="$(awk '$1 == "nf_conntrack" { print $4 }' /proc/slabinfo 2>/dev/null)"
	mem_kib="$(awk '$1 == "MemTotal:" { print $2 }' /proc/meminfo 2>/dev/null)"
	memory="entry size unavailable (/proc/slabinfo)"
	if [[ "$objsize" =~ ^[0-9]+$ ]]; then
		memory="${objsize} B per entry"
		[[ -n "$max" ]] && ((max > 0)) && memory+=", $((max * objsize / 1048576)) MiB of entry objects when full (extensions extra)"
	fi
	[[ -n "$buckets" ]] && memory+=", hash $((buckets * 8 / 1024)) KiB"
	[[ "$mem_kib" =~ ^[0-9]+$ ]] && memory+=", RAM $((mem_kib / 1024)) MiB"
	note "memory: $memory"
}

apply() {
	if [[ "$(id -u)" != 0 ]]; then
		warn "apply needs root; nothing changed"
		report
		return 0
	fi
	local err key line content file target
	if [[ ! -e "$NETFILTER/nf_conntrack_max" ]] && ! err="$(modprobe nf_conntrack 2>&1)"; then
		warn "modprobe nf_conntrack failed: ${err:-no reason given}"
	fi

	# A key is configured for boot only once its target is in force and read
	# back; otherwise the file keeps whatever it already set for that key.
	local -a lines=()
	for key in nf_conntrack_max nf_conntrack_buckets; do
		line=""
		target="$CONNTRACK_BUCKETS"
		[[ "$key" == nf_conntrack_max ]] && target="$CONNTRACK_MAX"
		if raise "$key" "$target"; then
			line="net.netfilter.$key = $target"
		elif [[ -n "$(boot_value "$key")" ]]; then
			line="net.netfilter.$key = $(boot_value "$key")"
		fi
		[[ -n "$line" ]] && lines+=("$line")
	done
	local max
	max="$(value "$NETFILTER/nf_conntrack_max")"
	if [[ -n "$max" ]] && ((max > 0 && max < CONNTRACK_MAX)); then
		{
			echo "[conntrack] !!! CAPACITY RISK: nf_conntrack_max in force is $max, below the $CONNTRACK_MAX this relay is sized for."
			echo "[conntrack] !!! Past it the kernel silently drops new TURN and relay flows. The release continues."
		} >&2
	fi

	if ((${#lines[@]})); then
		content="$HEADER"$'\n'"$(printf '%s\n' "${lines[@]}")"
		# The module must be present before systemd-sysctl applies the file.
		install_file "$MODULES_LOAD_FILE" "$HEADER"$'\n'"nf_conntrack"
		install_file "$SYSCTL_FILE" "$content"
	fi
	shopt -s nullglob
	for file in /etc/sysctl.d/*.conf /run/sysctl.d/*.conf /usr/local/lib/sysctl.d/*.conf \
		/usr/lib/sysctl.d/*.conf /lib/sysctl.d/*.conf /etc/sysctl.conf; do
		[[ -f "$file" && "$file" != "$SYSCTL_FILE" ]] || continue
		if grep -Eq '^[[:space:]]*net[./]netfilter[./]nf_conntrack_(max|buckets)[[:space:]]*=' "$file"; then
			warn "$file also sets nf_conntrack_max or _buckets; at boot the file applied last (by name) wins"
		fi
	done
	report
}

case "${1:-}" in
apply) apply ;;
report) report ;;
*)
	echo "usage: conntrack.sh apply|report" >&2
	exit 2
	;;
esac
