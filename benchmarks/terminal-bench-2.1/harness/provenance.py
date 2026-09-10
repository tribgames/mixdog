"""Record benchmark-owned code identity independently of the runtime bundle."""

import argparse
import hashlib
import json
from pathlib import Path


def harness_manifest(bench_root: Path) -> dict:
    paths = [bench_root / "run.ps1", bench_root / "presets.json"]
    for directory in ("harness", "analysis"):
        paths.extend(p for p in (bench_root / directory).rglob("*")
                     if p.is_file() and p.suffix in (".py", ".ps1", ".mjs", ".json", ".md")
                     and "__pycache__" not in p.parts)
    files = []
    for path in sorted(paths):
        data = path.read_bytes()
        files.append({
            "path": path.relative_to(bench_root).as_posix(),
            "sha256": hashlib.sha256(data).hexdigest(),
            "size": len(data),
        })
    encoded = json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
    return {"schemaVersion": 1, "sha256": hashlib.sha256(encoded).hexdigest(), "files": files}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest = harness_manifest(Path(__file__).resolve().parents[1])
    args.output.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(manifest["sha256"])
