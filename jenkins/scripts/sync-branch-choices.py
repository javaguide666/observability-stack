#!/usr/bin/env python3
"""Read cache/branches/*.txt and rewrite BRANCH ChoiceParameter in job XMLs."""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(os.environ.get("BRANCH_CACHE_DIR", ROOT / "cache/branches"))
SEED = ROOT / "job-seed/modules"

REPO = {
    "wealth-gateway": "wealth-freedom",
    "wealth-auth": "wealth-freedom",
    "wealth-system-server": "wealth-freedom",
    "wealth-admin-server": "wealth-freedom",
    "wealth-ecommerce-server": "wealth-freedom",
    "wealth-freedom-web": "wealth-freedom-web",
    "wealth-ecommerce-web": "wealth-ecommerce-web",
    "wealth-all": "wealth-all",
}

CHOICE_RE = re.compile(
    r"\s*<com\.syhuang\.hudson\.plugins\.listgitbranchesparameter\.ListGitBranchesParameterDefinition"
    r"[\s\S]*?</com\.syhuang\.hudson\.plugins\.listgitbranchesparameter\.ListGitBranchesParameterDefinition>\s*"
    r"|\s*<org\.biouno\.unochoice\.ChoiceParameter[\s\S]*?</org\.biouno\.unochoice\.ChoiceParameter>\s*"
    r"|\s*<hudson\.model\.ChoiceParameterDefinition>\s*<name>BRANCH</name>"
    r"[\s\S]*?</hudson\.model\.ChoiceParameterDefinition>\s*",
    re.M,
)


def load_branches(name: str) -> list[str]:
    f = CACHE / f"{name}.txt"
    if not f.exists():
        return ["main"]
    lines = [ln.strip() for ln in f.read_text().splitlines() if ln.strip() and not ln.startswith("#")]
    lines = sorted(set(lines), key=lambda x: (x != "main", x))
    if "main" in lines:
        lines = ["main"] + [x for x in lines if x != "main"]
    return lines or ["main"]


def choice_xml(branches: list[str]) -> str:
    items = "\n".join(f"              <string>{b}</string>" for b in branches)
    return f"""        <hudson.model.ChoiceParameterDefinition>
          <name>BRANCH</name>
          <description>本模块分支（本地缓存下拉；刷新：Job wealth-refresh-branches）</description>
          <choices class="java.util.Arrays$ArrayList">
            <a class="string-array">
{items}
            </a>
          </choices>
        </hudson.model.ChoiceParameterDefinition>
"""


def patch_text(text: str, job: str) -> str:
    repo = REPO[job]
    block = choice_xml(load_branches(repo))
    if CHOICE_RE.search(text):
        return CHOICE_RE.sub("\n" + block, text, count=1)
    m = re.search(r"(\s*<hudson\.model\.StringParameterDefinition>\s*<name>GIT_SHA</name>)", text)
    if not m:
        raise SystemExit(f"cannot find BRANCH/GIT_SHA anchor in {job}")
    return text[: m.start()] + "\n" + block + text[m.start() :]


def main() -> int:
    homes: list[Path] = []
    for raw in [
        os.environ.get("JENKINS_HOME_JOBS", ""),
        "/var/jenkins_home/jobs",
        "/Users/eric_brewer/.docker/jenkins/home/jobs",
    ]:
        if not raw:
            continue
        p = Path(raw)
        if p.is_dir() and p not in homes:
            homes.append(p)

    for job in REPO:
        seed = SEED / f"{job}.xml"
        if seed.exists():
            try:
                seed.write_text(patch_text(seed.read_text(), job))
                print(f"seed OK {job} ({len(load_branches(REPO[job]))} branches)")
            except OSError as e:
                print(f"seed skip {job}: {e}")
        for home in homes:
            cfg = home / job / "config.xml"
            if cfg.exists():
                try:
                    cfg.write_text(patch_text(cfg.read_text(), job))
                    print(f"home OK {home}/{job}")
                except OSError as e:
                    print(f"home skip {home}/{job}: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
