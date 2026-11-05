#!/usr/bin/env bash
# Power-cut simulation of the session log on ext4 (SM §11.8 §7) with dm-log-writes.
# Runs inside the privileged container built from powercut/Dockerfile:
#   docker build -f native/core/crates/mixdog-store/powercut/Dockerfile -t mixdog-powercut native/core
#   docker run --rm --privileged mixdog-powercut [batches]
#
# 1. The writer runs on a dm-log-writes device; after each acknowledged barrier the
#    script inserts the mark `ack-<n>` (n items acknowledged).
# 2. Replay to every mark: the replayed fs must hold at least n items, undamaged.
# 3. Replay entry by entry, checking at every FUA/flush (the points a power cut can
#    expose): the log must open clean or torn, never damaged, and keep every item that
#    was acknowledged before that point.
set -euo pipefail

BATCHES="${1:-300}"
SIZE_MB=512
WORK=/work
mkdir -p "$WORK"

truncate -s "${SIZE_MB}M" "$WORK/data.img" "$WORK/log.img" "$WORK/replay.img"
DATA=$(losetup --find --show "$WORK/data.img")
LOG=$(losetup --find --show "$WORK/log.img")
REPLAY=$(losetup --find --show "$WORK/replay.img")
SECTORS=$(blockdev --getsz "$DATA")

cleanup() {
  umount /mnt/data 2>/dev/null || true
  umount /mnt/replay 2>/dev/null || true
  dmsetup remove lw 2>/dev/null || true
  losetup -d "$DATA" "$LOG" "$REPLAY" 2>/dev/null || true
}
trap cleanup EXIT

dmsetup create lw --table "0 $SECTORS log-writes $DATA $LOG"
mkfs.ext4 -q /dev/mapper/lw
dmsetup message lw 0 mark mkfs
mkdir -p /mnt/data /mnt/replay
mount /dev/mapper/lw /mnt/data

: > "$WORK/marks"
powercut write /mnt/data "$BATCHES" | while read -r _ n; do
  dmsetup message lw 0 mark "ack-$n"
  echo "$n" >> "$WORK/marks"
done
umount /mnt/data
dmsetup remove lw

entry_of() {  # entry_of <find args...>: the entry number of `entry@offset`
  replay-log --log "$LOG" --find "$@" | cut -d@ -f1
}

# Replays entries [0, limit) onto a zeroed copy, mounts it (ext4 recovers its journal as
# after a power cut) and verifies the session log against `acked`.
check_prefix() {  # check_prefix <limit> <acked>
  truncate -s 0 "$WORK/replay.img"; truncate -s "${SIZE_MB}M" "$WORK/replay.img"
  replay-log --log "$LOG" --replay "$REPLAY" --limit "$1"
  fsck.ext4 -fn "$REPLAY" >/dev/null 2>&1 || fsck.ext4 -fy "$REPLAY" >/dev/null 2>&1 || true
  mount "$REPLAY" /mnt/replay
  powercut verify /mnt/replay "$2"
  umount /mnt/replay
}

# Entry number of every acknowledgement mark, ascending: "<entry> <acked>".
: > "$WORK/mark_entries"
while read -r n; do
  echo "$(entry_of --end-mark "ack-$n") $n" >> "$WORK/mark_entries"
done < "$WORK/marks"

echo "== replay to every acknowledgement mark"
while read -r entry n; do
  check_prefix "$((entry + 1))" "$n"
done < "$WORK/mark_entries"

echo "== replay to every FUA point after mkfs"
TOTAL=$(replay-log --log "$LOG" --num-entries)
ENTRY=$(entry_of --end-mark mkfs)
POINTS=0
while :; do
  NEXT=$(entry_of --next-fua --start-entry "$((ENTRY + 1))" 2>/dev/null || true)
  [ -n "$NEXT" ] && [ "$NEXT" -lt "$TOTAL" ] || break
  # Acknowledged before this point: the newest mark at a smaller entry.
  ACKED=$(awk -v e="$NEXT" '$1 < e { a = $2 } END { print a + 0 }' "$WORK/mark_entries")
  check_prefix "$((NEXT + 1))" "$ACKED"
  POINTS=$((POINTS + 1))
  ENTRY=$NEXT
done
echo "PASS: $(wc -l < "$WORK/marks") marks and $POINTS FUA points verified"
