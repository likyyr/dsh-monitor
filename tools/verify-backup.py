#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""核对 GitHub 备份是否与本地插件目录逐字节一致（恢复演练）。

用法：
    python tools/verify-backup.py            # 只比名单 + 哈希（不落盘）
    python tools/verify-backup.py --clone    # 真克隆到临时目录再比哈希，比完删掉

凭据：从本仓库的 origin remote 里取（形如 https://<cred>@github.com/<owner>/<repo>.git）；
没有内嵌凭据时退回环境变量 GITHUB_TOKEN。
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def git(*args, cwd=ROOT):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout


def read_token():
    url = git("remote", "get-url", "origin").strip()
    if "@github.com" in url:
        cred = url.split("//", 1)[1].split("@github.com", 1)[0]
        return cred.split(":", 1)[1] if ":" in cred else cred
    tok = os.environ.get("GITHUB_TOKEN", "")
    if not tok:
        sys.exit("没有内嵌凭据，也没设 GITHUB_TOKEN")
    return tok


def api(path, tok):
    req = urllib.request.Request(
        "https://api.github.com" + path,
        headers={"Authorization": "token " + tok, "Accept": "application/vnd.github+json"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def slug():
    url = git("remote", "get-url", "origin").strip()
    return url.rsplit("github.com", 1)[1].strip("/").removesuffix(".git")


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clone", action="store_true", help="克隆到临时目录真比一遍字节")
    args = ap.parse_args()

    tok = read_token()
    repo = slug()
    head = api(f"/repos/{repo}/commits?per_page=1", tok)[0]["sha"]
    print(f"repo: {repo}  HEAD: {head[:7]}")

    remote = sorted(t["path"] for t in api(f"/repos/{repo}/git/trees/{head}?recursive=1", tok)["tree"] if t["type"] == "blob")
    local = sorted(git("-c", "core.quotepath=false", "ls-tree", "-r", "--name-only", "HEAD").splitlines())
    ok = remote == local
    print(f"文件名单：远端 {len(remote)} 个 / 本地 {len(local)} 个 → {'一致' if ok else '不一致'}")
    for r, l in zip(remote, local):
        if r != l:
            print("  差异:", repr(r), "vs", repr(l))
    bad_names = [p for p in remote if any(ord(ch) > 127 for ch in p)]
    if bad_names:
        print("  ⚠ 远端有非 ASCII 文件名（跨平台易乱码）:", bad_names)

    if args.clone:
        tmp = tempfile.mkdtemp(prefix="dshmon-")
        url = "https://" + tok + "@github.com/" + repo + ".git"
        try:
            subprocess.run(["git", "clone", "-q", "--depth", "1", url, tmp], capture_output=True, check=True)
            same = diff = 0
            for rel in local:
                a, b = os.path.join(ROOT, rel), os.path.join(tmp, rel)
                if os.path.exists(b) and sha(a) == sha(b):
                    same += 1
                else:
                    diff += 1
                    print("  克隆后不一致:", rel)
            print(f"恢复演练：逐字节一致 {same} 个，不一致 {diff} 个")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
