#!/usr/bin/env python3
"""Write branches + last 10 image tags JSON for Wealth CI UI."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(os.environ.get("BRANCH_CACHE_DIR", ROOT / "cache/branches"))
KEEP = int(os.environ.get("HISTORY_KEEP", "10"))
HOME = Path(os.environ.get("JENKINS_HOME", "/var/jenkins_home"))
OUT_DIRS = []
for raw in [
    os.environ.get("WEALTH_UI_DATA", ""),
    str(HOME / "userContent/wealth-data"),
]:
    if raw:
        p = Path(raw)
        if p not in OUT_DIRS:
            OUT_DIRS.append(p)

REPOS = ["wealth-freedom", "wealth-freedom-web", "wealth-ecommerce-web", "wealth-all"]
IMAGES = [
    "wealth-gateway",
    "wealth-auth",
    "wealth-system-server",
    "wealth-admin-server",
    "wealth-ecommerce-server",
    "wealth-freedom-web",
    "wealth-ecommerce-web",
]


def load_branches() -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for name in REPOS:
        f = CACHE / f"{name}.txt"
        lines = []
        if f.exists():
            lines = [ln.strip() for ln in f.read_text().splitlines() if ln.strip() and not ln.startswith("#")]
        if "main" in lines:
            lines = ["main"] + [x for x in lines if x != "main"]
        out[name] = lines or ["main"]
    return out


def docker_tags(image: str) -> list[dict[str, str]]:
    try:
        proc = subprocess.run(
            [
                "docker",
                "images",
                "--format",
                "{{.Tag}}\t{{.CreatedSince}}\t{{.Size}}",
                image,
            ],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return []
    rows = []
    for line in proc.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 1:
            continue
        tag = parts[0].strip()
        if not tag or tag in {"<none>", "latest"}:
            continue
        rows.append(
            {
                "tag": tag,
                "created": parts[1].strip() if len(parts) > 1 else "",
                "size": parts[2].strip() if len(parts) > 2 else "",
            }
        )
        if len(rows) >= KEEP:
            break
    return rows


def main() -> int:
    meta = {
        "keep": KEEP,
        "branches": load_branches(),
        "tags": {img: docker_tags(img) for img in IMAGES},
    }
    text = json.dumps(meta, ensure_ascii=False, indent=2)
    written = 0
    for d in OUT_DIRS:
        try:
            d.mkdir(parents=True, exist_ok=True)
            (d / "meta.json").write_text(text + "\n")
            print(f"ui-meta OK {d / 'meta.json'}")
            written += 1
        except OSError as e:
            print(f"ui-meta skip {d}: {e}")
    if written == 0:
        print("ui-meta WARN: no writable output dir")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
