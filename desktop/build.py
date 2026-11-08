"""Assemble the portable Windows desktop app (no installer): release/score-studio-<ver>-windows/.

    python desktop/build.py [--out DIR] [--with-models [--mt3-models yptf-multi-ps ...]] [--no-mt3] [--zip]

Model files are NOT bundled by default: on first start the app lists what is missing (DuET, YourMT3+) and downloads
it with one click from Hugging Face into <folder>/models. --with-models bundles them for an offline build.

Reuses what is already installed for development, so it needs no downloads except pywebview:
  * the standalone CPython the main .venv was created from (python-build-standalone, relocatable),
  * .venv's site-packages (torch CUDA, DuET, Transkun, backend deps) + pywebview,
  * .venv-mt3's site-packages minus torch/CUDA (layered over the main runtime as runtime/mt3-site),
  * with --with-models only: the Hugging Face cache of the pinned DuET revision, third_party/YourMT3 + checkpoints,
  * ffmpeg.exe from PATH, web/dist (run `npm --prefix web run build` first),
and compiles ScoreStudio.exe (desktop/launcher.cs) with the .NET Framework csc.exe that ships with Windows.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))
from app import VERSION  # noqa: E402
from app.multi import CKPT  # noqa: E402

CSC = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Microsoft.NET" / "Framework64" / "v4.0.30319" / "csc.exe"
# shared with the main runtime (same torch build) or not needed; exact package names (torchmetrics must stay)
SKIP_MT3 = {"torch", "torchaudio", "torchgen", "functorch", "triton", "pip", "setuptools", "_distutils_hack",
            "distutils-precedence.pth", "__pycache__"}


def skip_mt3(name: str) -> bool:
    base = name.split("-")[0].lower() if name.endswith(".dist-info") else name.lower()
    return base in SKIP_MT3 or base.startswith("nvidia")
IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", "tests", "test")


def log(msg):
    print(msg, flush=True)


def venv_base(venv: Path) -> Path:
    cfg = (venv / "pyvenv.cfg").read_text(encoding="utf-8")
    home = Path(re.search(r"^home\s*=\s*(.+)$", cfg, re.M).group(1).strip())
    return home.resolve()


def copytree(src: Path, dst: Path, ignore=IGNORE):
    shutil.copytree(src, dst, ignore=ignore, dirs_exist_ok=True)


def duet_revision() -> str:
    m = re.search(r"ARG DUET_REVISION=(\w+)", (REPO / "Dockerfile").read_text(encoding="utf-8"))
    return m.group(1)


def make_icon(out: Path):
    from PIL import Image
    img = Image.open(REPO / "web" / "public" / "icon-512.png").convert("RGBA")
    img.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(REPO / "release" / f"score-studio-{VERSION}-windows"))
    ap.add_argument("--mt3-models", nargs="*", default=["yptf-multi-ps"], choices=sorted(CKPT))
    ap.add_argument("--no-mt3", action="store_true", help="leave out the YourMT3+ runtime (multi-instrument)")
    ap.add_argument("--with-models", action="store_true", help="bundle DuET + YourMT3+ model files (offline build)")
    ap.add_argument("--runtime", choices=["cpu", "cuda"], default="cpu",
                    help="cpu (default, ~1.5 GB): fresh CPU PyTorch; GPU acceleration is an optional in-app download. "
                         "cuda: copy .venv's CUDA PyTorch (~5 GB)")
    ap.add_argument("--zip", action="store_true", help="also write <out>.zip")
    a = ap.parse_args()
    out = Path(a.out)
    if not (REPO / "web" / "dist" / "index.html").is_file():
        sys.exit("web/dist missing: run `npm --prefix web run build` first")
    if out.exists():
        log(f"removing old {out}")
        shutil.rmtree(out)
    out.mkdir(parents=True)

    # ---- runtime: standalone Python + backend packages
    py = out / "runtime" / "python"
    base = venv_base(REPO / ".venv")
    copytree(base, py, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "test", "tests", "idlelib", "turtledemo"))
    (py / "Lib" / "EXTERNALLY-MANAGED").unlink(missing_ok=True)      # uv's marker: this copy is ours to modify
    pip = [str(py / "python.exe"), "-m", "pip", "install", "--no-warn-script-location", "--disable-pip-version-check", "-q"]
    if a.runtime == "cuda":
        log(f"runtime: {base} + .venv site-packages (CUDA PyTorch)")
        copytree(REPO / ".venv" / "Lib" / "site-packages", py / "Lib" / "site-packages",
                 ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    else:
        import importlib.metadata as md
        torch_v = md.version("torch").split("+")[0]
        duet = re.search(r"ARG DUET_COMMIT=(\w+)", (REPO / "Dockerfile").read_text(encoding="utf-8")).group(1)
        log(f"runtime: {base} + CPU PyTorch {torch_v} (same packages as the Docker image)")
        subprocess.run(pip + [f"torch=={torch_v}", f"torchaudio=={torch_v}",
                              "--index-url", "https://download.pytorch.org/whl/cpu"], check=True)
        subprocess.run(pip + [f"duet-score @ https://github.com/wei-zeng98/DuET/archive/{duet}.tar.gz"], check=True)
        subprocess.run(pip + ["--no-deps", "transkun==2.0.1"], check=True)
        subprocess.run(pip + ["-r", str(REPO / "backend" / "requirements.txt")], check=True)
    log("installing pywebview into the runtime")
    subprocess.run(pip + ["pywebview>=5"], check=True)

    # ---- YourMT3+ (optional): packages layered over the main runtime + code + checkpoints
    if not a.no_mt3:
        mt3_site = REPO / ".venv-mt3" / "Lib" / "site-packages"
        home = REPO / "third_party" / "YourMT3"
        if mt3_site.is_dir() and (home / "amt" / "src").is_dir():
            log("YourMT3+: runtime/mt3-site" + (", models/YourMT3 " + " ".join(a.mt3_models) if a.with_models else ""))
            dst = out / "runtime" / "mt3-site"
            dst.mkdir(parents=True)
            for item in mt3_site.iterdir():
                if skip_mt3(item.name):
                    continue
                (copytree(item, dst / item.name, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
                 if item.is_dir() else shutil.copy2(item, dst / item.name))
            mdst = out / "models" / "YourMT3"
            for key in (a.mt3_models if a.with_models else []):
                if not (mdst / "model_helper.py").is_file():
                    copytree(home / "amt" / "src", mdst / "amt" / "src")
                    shutil.copy2(home / "model_helper.py", mdst / "model_helper.py")
                exp, f = CKPT[key].split("@")
                rel = Path("amt") / "logs" / "2024" / exp / "checkpoints" / f
                (mdst / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(home / rel, mdst / rel)
        else:
            log("YourMT3+ not installed here (.venv-mt3 / third_party/YourMT3): skipped")

    # ---- models: DuET weights in Hugging Face cache layout (only with --with-models; else downloaded on first start)
    rev = duet_revision()
    (out / "models" / "hf").mkdir(parents=True, exist_ok=True)
    (out / "models" / "duet-revision.txt").write_text(rev, encoding="utf-8")
    if a.with_models:
        hub = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")) / "hub" / "models--Wayne42--DuET"
        if not (hub / "snapshots" / rev).is_dir():
            sys.exit(f"DuET revision {rev} is not in {hub}: transcribe once in development (or snapshot_download) first")
        log("models: DuET " + rev[:8])
        copytree(hub, out / "models" / "hf" / "hub" / hub.name, ignore=None)

    # ---- ffmpeg (audio decoding)
    ff = shutil.which("ffmpeg")
    if ff:
        (out / "runtime" / "bin").mkdir(parents=True, exist_ok=True)
        shutil.copy2(ff, out / "runtime" / "bin" / "ffmpeg.exe")
    else:
        log("WARNING: ffmpeg not on PATH; audio input will need a system ffmpeg")

    # ---- app: backend, web UI, desktop entry point
    app = out / "app"
    tracked = subprocess.run(["git", "ls-files", "-co", "--exclude-standard", "backend", "desktop"], cwd=REPO,
                             capture_output=True, text=True, check=True).stdout.split()
    for rel in tracked:
        if rel.endswith((".pyc",)) or "/tests/" in rel:
            continue
        dst = app / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO / rel, dst)
    copytree(REPO / "web" / "dist", app / "web" / "dist", ignore=None)
    make_icon(app / "desktop" / "icon.ico")

    # ---- ScoreStudio.exe
    log("compiling ScoreStudio.exe")
    subprocess.run([str(CSC), "/nologo", "/target:winexe", "/optimize+", f"/win32icon:{app / 'desktop' / 'icon.ico'}",
                    "/r:System.Windows.Forms.dll", f"/out:{out / 'ScoreStudio.exe'}", str(REPO / "desktop" / "launcher.cs")],
                   check=True)

    (out / "data").mkdir()
    shutil.copy2(REPO / "desktop" / "README-portable.txt", out / "README.txt")
    shutil.copy2(REPO / "LICENSE", out / "LICENSE.txt")
    shutil.copy2(REPO / "THIRD_PARTY_NOTICES.md", out / "THIRD_PARTY_NOTICES.md")

    log("pre-compiling Python files")
    subprocess.run([str(py / "python.exe"), "-m", "compileall", "-q", "-j", "0", str(app / "backend")], check=False)

    size = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    log(f"done: {out}  ({size / 2**30:.1f} GB)")
    if a.zip:
        log("zipping…")
        shutil.make_archive(str(out), "zip", out.parent, out.name)


if __name__ == "__main__":
    main()
