#!/usr/bin/env python3
"""Verify a deployed HitGO image and emit a MissionGo release receipt.

This script only reads the public site, the deployed host, and local git history.
It never updates MissionGo or the server.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shlex
import subprocess
import sys
from urllib.parse import urljoin, urlparse


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run(*args: str) -> bytes:
    return subprocess.check_output(args, stderr=subprocess.PIPE, timeout=30)


def remote(target: str, app_dir: str, ssh_opts: str, command: str) -> bytes:
    return run("ssh", *shlex.split(ssh_opts), target, f"cd {shlex.quote(app_dir)} && {command}")


def public(origin: str, path: str) -> bytes:
    url = urljoin(origin + "/", path.lstrip("/"))
    return run(
        "curl", "--fail", "--silent", "--show-error", "--max-time", "20",
        "--proto", "=https", "-H", "Cache-Control: no-cache",
        "-A", "HitGO-release-verifier/1.0", url,
    )


def resolve_commit(short_or_full: str) -> str | None:
    if not re.fullmatch(r"[0-9a-f]{7,40}", short_or_full):
        return None
    try:
        return run("git", "rev-parse", "--verify", f"{short_or_full}^{{commit}}").decode().strip()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None


def verify(args: argparse.Namespace) -> dict:
    origin = args.origin.rstrip("/")
    parsed = urlparse(origin)
    if parsed.scheme != "https" or not parsed.netloc or parsed.path:
        raise ValueError("--origin must be a public HTTPS origin without a path")
    if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        raise ValueError("--commit must be a full git SHA")

    deployed = remote(args.ssh_target, args.app_dir, args.ssh_opts, "cat VERSION").decode().strip()
    if deployed != args.commit:
        raise ValueError(f"remote VERSION is {deployed}, expected {args.commit}")

    health = json.loads(public(origin, "/api/health"))
    if health != {"status": "ok", "commit": args.commit, "version": args.version}:
        raise ValueError(f"public /api/health does not identify {args.version} at {args.commit}")

    index = public(origin, "/")
    remote_index = remote(
        args.ssh_target, args.app_dir, args.ssh_opts,
        "sudo -n docker compose exec -T api cat /app/frontend/dist/index.html",
    )
    if sha256(index) != sha256(remote_index):
        raise ValueError("public index.html differs from the deployed container")

    scripts = re.findall(rb'<script[^>]+src="(/assets/[A-Za-z0-9._-]+\.js)"', index)
    if len(scripts) != 1:
        raise ValueError("expected one hashed JavaScript entry in public index.html")
    asset_path = scripts[0].decode()
    asset = public(origin, asset_path)
    remote_asset = remote(
        args.ssh_target, args.app_dir, args.ssh_opts,
        "sudo -n docker compose exec -T api cat " + shlex.quote("/app/frontend/dist" + asset_path),
    )
    if sha256(asset) != sha256(remote_asset):
        raise ValueError(f"public {asset_path} differs from the deployed container")

    before = resolve_commit(args.before)
    eligible = bool(before and before != args.commit and run("git", "merge-base", before, args.commit).decode().strip() == before)
    return {
        "schemaVersion": 1,
        "product": "HitGO",
        "artifact": "webServer",
        "origin": origin,
        "version": args.version,
        "previousSourceCommit": before,
        "sourceCommit": args.commit,
        "verified": True,
        "eligibleForMatching": eligible,
        "evidence": {
            "publicHealth": "/api/health",
            "indexSha256": sha256(index),
            "assetPath": asset_path,
            "assetSha256": sha256(asset),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--ssh-target", required=True)
    parser.add_argument("--app-dir", required=True)
    parser.add_argument("--ssh-opts", default="-o BatchMode=yes -o ConnectTimeout=15")
    parser.add_argument("--before", default="")
    parser.add_argument("--commit", required=True)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args), ensure_ascii=False, separators=(",", ":")))
        return 0
    except (ValueError, OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        print(f"release verification failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
