"""Build the release folders for the current version (backend/app VERSION) from tracked sources only.

    python tools/release.py                 # both: Docker release + Windows portable app
    python tools/release.py --docker        # release/score-studio-<ver>/: image tarball, compose, README, CHANGES, HERMES
    python tools/release.py --windows       # release/score-studio-<ver>-windows/ (web build + desktop/build.py)
    python tools/release.py --docker --docs-only   # rewrite the Docker release docs without building the image

Sources: packaging/docker/README.md ({{version}} is filled in), packaging/docker/HERMES.md, the repo's
docker-compose.yml (its image tag must match the version) and this version's section of CHANGELOG.md.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
VERSION = re.search(r'^VERSION = "([^"]+)"', (REPO / "backend" / "app" / "__init__.py").read_text(encoding="utf-8"), re.M).group(1)
IMAGE = f"score-studio:{VERSION}"


def log(message: str):
    print(message, flush=True)


def changes(version: str) -> str:
    text = (REPO / "CHANGELOG.md").read_text(encoding="utf-8")
    match = re.search(rf"^## {re.escape(version)}\s*$(.*?)(?=^## |\Z)", text, re.M | re.S)
    if not match:
        sys.exit(f"CHANGELOG.md has no '## {version}' section")
    return f"# Score Studio {version}\n\n{match.group(1).strip()}\n"


def write(path: Path, text: str):
    path.write_text(text, encoding="utf-8", newline="\n")


def docker_docs(out: Path) -> list[str]:
    out.mkdir(parents=True, exist_ok=True)
    readme = (REPO / "packaging" / "docker" / "README.md").read_text(encoding="utf-8").replace("{{version}}", VERSION)
    write(out / "README.md", readme)
    shutil.copyfile(REPO / "packaging" / "docker" / "HERMES.md", out / "HERMES.md")
    compose = (REPO / "docker-compose.yml").read_text(encoding="utf-8")
    if f"image: {IMAGE}" not in compose:
        sys.exit(f"docker-compose.yml must use image: {IMAGE}")
    write(out / "docker-compose.yml", compose)
    write(out / "CHANGES.md", changes(VERSION))
    return ["docker-compose.yml", "README.md", "CHANGES.md", "HERMES.md"]


def save_image(target: Path):
    """docker save | gzip, streamed (no temporary .tar)."""
    log(f"saving {IMAGE} -> {target.name}")
    partial = target.with_suffix(".partial")
    with subprocess.Popen(["docker", "save", IMAGE], stdout=subprocess.PIPE) as proc, \
            open(partial, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=6, mtime=0) as gz:
        assert proc.stdout
        while chunk := proc.stdout.read(8 << 20):
            gz.write(chunk)
    if proc.returncode:
        partial.unlink(missing_ok=True)
        sys.exit(f"docker save failed ({proc.returncode})")
    partial.replace(target)


def sha256sums(out: Path, names: list[str]):
    lines = []
    for name in names:
        digest = hashlib.sha256()
        with open(out / name, "rb") as handle:
            while chunk := handle.read(8 << 20):
                digest.update(chunk)
        lines.append(f"{digest.hexdigest()} *{name}")
    write(out / "SHA256SUMS", "\n".join(lines) + "\n")


def docker_release(docs_only: bool):
    out = REPO / "release" / f"score-studio-{VERSION}"
    names = docker_docs(out)
    tarball = f"score-studio-{VERSION}-docker-amd64.tar.gz"
    if not docs_only:
        log(f"building {IMAGE} (with YourMT3+)")
        subprocess.run(["docker", "build", "--build-arg", "WITH_MT3=1", "-t", IMAGE, "."], cwd=REPO, check=True)
        save_image(out / tarball)
    if (out / tarball).is_file():
        names.insert(0, tarball)
    sha256sums(out, names)
    log(f"docker release: {out}")


def windows_release():
    npm = shutil.which("npm") or sys.exit("npm not found")
    subprocess.run([npm, "--prefix", "web", "run", "build"], cwd=REPO, check=True)
    venv = REPO / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    subprocess.run([str(venv if venv.is_file() else sys.executable), str(REPO / "desktop" / "build.py")], cwd=REPO, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--docker", action="store_true")
    parser.add_argument("--windows", action="store_true")
    parser.add_argument("--docs-only", action="store_true", help="with --docker: write the docs and checksums only")
    args = parser.parse_args()
    both = not (args.docker or args.windows)
    if args.docker or both:
        docker_release(args.docs_only)
    if args.windows or both:
        windows_release()


if __name__ == "__main__":
    main()
