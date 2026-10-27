#!/usr/bin/env python3
"""Vendor data-ui (/home/bam/data-ui) into site/public/data-ui/, pinned by commit and by its manifest's sha256s:

Copied from pidtuna-website/scripts/vendor_data_ui.py (the same kit, the same way: the Explorer in Landing.vue is a <data-views>).

    python3 /home/bam/impedance-controller-website/scripts/vendor_data_ui.py            # data-ui's main
    python3 /home/bam/impedance-controller-website/scripts/vendor_data_ui.py --ref 178ba08

- **What it copies:** data-ui's `npm run build` output (dist/), built from a `git archive` of the commit in a
  temporary folder (data-ui's own node_modules linked in), so the copy is that commit's and never a checkout's
  uncommitted edits. Every file of dist/manifest.json except the source maps (`*.map`, which only a debugger asks
  for) and data-ui's docs site (dist/site/, not in the manifest): the core (data-ui.js, data-ui.css), every view
  bundle (views/*.js and the files they load beside them), LICENSES.md, manifest.json, python/data_ui_base.py.
- **What it records:** site/public/data-ui/VENDOR.json: the repo, the commit, its date and subject, the sha256 of the
  manifest itself, and what was left out. tests/data-ui.spec.mjs holds every vendored file to the manifest's
  sha256, so an edit in place fails the deploy's tests.
- **Where it goes:** VitePress serves site/public/data-ui/ at /data-ui/ (python/ is skipped: nothing here imports it).

WHY vendored and re-copied, never edited (data-ui docs/peps/0001 §8): a host that patches its copy drifts from the kit
(Clank's copies froze that way). To update: run this again, rebuild, run the tests.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
TARGET = ROOT / "site" / "public" / "data-ui"
DEFAULT_REPO = pathlib.Path("/home/bam/data-ui")
SKIPPED = {"*.map": "source maps: only a debugger asks for them",
           "site/": "data-ui's own docs site and gallery (not in the manifest)",
           "python/": "the stdlib .base reader: nothing on this site imports it"}


def git(repo: pathlib.Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(repo: pathlib.Path, commit: str, work: pathlib.Path) -> pathlib.Path:
    """data-ui's dist/ for `commit`, built in `work` from a git archive of it."""
    archive = subprocess.run(["git", "-C", str(repo), "archive", "--format=tar", commit], check=True, capture_output=True).stdout
    subprocess.run(["tar", "-x", "-C", str(work)], input=archive, check=True)
    (work / "node_modules").symlink_to(repo / "node_modules", target_is_directory=True)
    subprocess.run(["node", "build.mjs"], cwd=work, check=True)
    return work / "dist"


def vendor(dist: pathlib.Path, target: pathlib.Path) -> list[str]:
    manifest = json.loads((dist / "manifest.json").read_text(encoding="utf-8"))
    kept = [name for name in sorted(manifest["files"]) if not name.endswith(".map") and not name.startswith("python/")]
    for name in kept:
        source = dist / name
        if sha256(source) != manifest["files"][name]["sha256"]:
            raise SystemExit(f"vendor data-ui: {name} does not match its manifest sha256")
    if target.exists():
        shutil.rmtree(target)
    for name in kept + ["manifest.json"]:
        (target / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(dist / name, target / name)
    return kept


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", type=pathlib.Path, default=DEFAULT_REPO)
    parser.add_argument("--ref", default="main", help="the data-ui commit or branch to vendor (default main)")
    args = parser.parse_args(argv)
    repo = args.repo.resolve()
    commit = git(repo, "rev-parse", "--verify", f"{args.ref}^{{commit}}")
    with tempfile.TemporaryDirectory(prefix="data-ui-") as work:
        dist = build(repo, commit, pathlib.Path(work))
        kept = vendor(dist, TARGET)
    record = {
        "repo": str(repo), "commit": commit, "commit_date": git(repo, "show", "-s", "--format=%cI", commit),
        "subject": git(repo, "show", "-s", "--format=%s", commit),
        "built_with": "node build.mjs (data-ui's npm run build) on a git archive of the commit",
        "manifest_sha256": sha256(TARGET / "manifest.json"), "files": len(kept), "skipped": SKIPPED,
    }
    (TARGET / "VENDOR.json").write_text(json.dumps(record, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    total = sum((TARGET / name).stat().st_size for name in kept)
    print(f"vendored data-ui {commit[:7]} ({record['subject'][:60]}): {len(kept)} files, {total / 1e6:.2f} MB -> {TARGET.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
