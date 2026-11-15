"""Reduce the pinned ICU 77.1 data archive to the items extract-js-date-display.py reads.

The archive is an ICU common-data package (`CmnD`): a header, a table of contents and the items. The extractor loads only
the zone and locale display-name resources, the numbering systems, the time zone data and the locale-ID tables (the
predicate below is the extractor's own selection). This script copies exactly those items, byte for byte, into a new
package of the same layout (same header, 16-byte aligned items, table of contents sorted by name) and bzip2-compresses it,
so the extractor produces identical output from the smaller file. Nothing is downloaded: the input is the archive that was
pinned by the extractor before the reduction (sha256 below; source
https://raw.githubusercontent.com/nodejs/node/v22.20.0/deps/icu-small/source/data/in/icudt77l.dat.bz2).

    python reduce-icu-data.py <icudt77l.dat.bz2 (full)> <output .dat.bz2>
"""
import bz2
import hashlib
import struct
import sys

FULL_SHA256 = "488a0a666ba33dace736d0788a8973729c8d83f3f4966d0fed1be7ad162d4729"
PREFIX = "icudt77l/"
NAMED = {"pool", "zoneinfo64", "timezoneTypes", "metaZones", "numberingSystems", "metadata", "keyTypeData"}
ZONE_SKIPPED = {"zone/res_index.res", "zone/tzdbNames.res"}


def wanted(name):
    """The extractor's selection: the items its `Package.bundle` and its two loops read."""
    if not name.endswith(".res"):
        return False
    if name.startswith("zone/"):
        return name not in ZONE_SKIPPED
    if "/" in name:
        return False
    stem = name[:-4]
    if stem in NAMED:
        return True
    head = stem.split("_")[0]
    return stem == "root" or (2 <= len(head) <= 3 and stem.replace("_", "").isalnum())


def read_package(data):
    assert data[12:16] == b"CmnD" and data[8] == 0
    header = struct.unpack_from("<H", data, 0)[0]
    count = struct.unpack_from("<I", data, header)[0]
    entries = []
    for i in range(count):
        name_at, offset = struct.unpack_from("<II", data, header + 4 + i * 8)
        name = data[header + name_at:data.index(0, header + name_at)].decode("ascii")
        assert name.startswith(PREFIX)
        entries.append((name[len(PREFIX):], header + offset))
    items = {}
    for i, (name, start) in enumerate(entries):
        items[name] = data[start:entries[i + 1][1] if i + 1 < count else len(data)]
    return header, items


def write_package(head, items):
    names = sorted(items)
    table = 4 + len(names) * 8
    names_blob = bytearray()
    name_offsets = []
    for name in names:
        name_offsets.append(table + len(names_blob))
        names_blob += (PREFIX + name).encode("ascii") + b"\0"
    data_at = (len(head) + table + len(names_blob) + 15) & ~15
    body = bytearray()
    offsets = []
    for name in names:
        offsets.append(data_at - len(head) + len(body))
        body += items[name]
        body += b"\0" * (-len(body) % 16)
    out = bytearray(head)
    out += struct.pack("<I", len(names))
    for name_at, offset in zip(name_offsets, offsets):
        out += struct.pack("<II", name_at, offset)
    out += names_blob
    out += b"\0" * (data_at - len(out))
    out += body
    return bytes(out)


def main(source, destination):
    packed = open(source, "rb").read()
    assert hashlib.sha256(packed).hexdigest() == FULL_SHA256, "not the pinned full archive"
    data = bz2.decompress(packed)
    header, items = read_package(data)
    kept = {name: body for name, body in items.items() if wanted(name)}
    reduced = write_package(data[:header], kept)
    # The reduced package must read back to the same bytes for every kept item.
    _, again = read_package(reduced)
    assert set(again) == set(kept)
    for name, body in kept.items():
        assert again[name].rstrip(b"\0") == body.rstrip(b"\0"), name
    out = bz2.compress(reduced, 9)
    open(destination, "wb").write(out)
    print(f"items {len(items)} -> {len(kept)}; package {len(data)} -> {len(reduced)} bytes; "
          f"bz2 {len(packed)} -> {len(out)} bytes; sha256 {hashlib.sha256(out).hexdigest()}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
