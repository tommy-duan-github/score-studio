"""YourMT3+ runner: audio -> multi-instrument notes (JSON).

Runs in its own environment (.venv-mt3: transformers 4.45 / numpy 1.x), separate from DuET's, so it is
called as a subprocess:

    .venv-mt3/Scripts/python.exe backend/mt3/ymt3_runner.py IN_AUDIO OUT_JSON [--model KEY] [--device cuda|cpu]

Progress lines go to stdout as ``PROGRESS <fraction 0..1> <message>``. The output JSON is
``{"model": KEY, "notes": [[onset, offset, pitch, velocity, program, is_drum], ...]}`` with GM programs
(first program of the decoded instrument class: e.g. Violin = 40, Acoustic Piano = 0, Singing Voice = 100).

YOURMT3_HOME points at the downloaded Hugging Face space (default: third_party/YourMT3), which holds
``amt/src`` (code) and ``amt/logs/2024/<exp>/checkpoints`` (weights).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HOME = Path(os.environ.get("YOURMT3_HOME", ROOT / "third_party" / "YourMT3")).resolve()

_PTF = ['-enc', 'perceiver-tf', '-ac', 'spec', '-hop', '300', '-atc', '1']
_MOE = ['-tk', 'mc13_full_plus_256', '-dec', 'multi-t5', '-nl', '26', '-enc', 'perceiver-tf', '-sqr', '1',
        '-ff', 'moe', '-wf', '4', '-nmoe', '8', '-kmoe', '2', '-act', 'silu', '-epe', 'rope', '-rp', '1',
        '-ac', 'spec', '-hop', '300', '-atc', '1']
# key -> (checkpoint "exp@file", extra args); mirrors the official space's app.py
MODELS = {
    "ymt3+": ("notask_all_cross_v6_xk2_amp0811_gm_ext_plus_nops_b72@model.ckpt", []),
    "yptf-single": ("ptf_all_cross_rebal5_mirst_xk2_edr005_attend_c_full_plus_b100@model.ckpt", _PTF),
    "yptf-multi-ps": ("mc13_256_all_cross_v6_xk5_amp0811_edr005_attend_c_full_plus_2psn_nl26_sb_b26r_800k@model.ckpt",
                      ['-tk', 'mc13_full_plus_256', '-dec', 'multi-t5', '-nl', '26'] + _PTF),
    "moe-nops": ("mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops@last.ckpt", _MOE),
    "moe-ps": ("mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b80_ps2@model.ckpt", _MOE),
}
DEFAULT = "yptf-multi-ps"


def progress(f: float, msg: str):
    print(f"PROGRESS {max(0.0, min(1.0, f)):.3f} {msg}", flush=True)


def load(key: str, device: str):
    import torch
    sys.path[:0] = [str(HOME / "amt" / "src"), str(HOME)]
    os.chdir(HOME)                      # YourMT3 resolves checkpoints as amt/logs/<project>/<exp>
    if "wandb" not in sys.modules:      # imported for training-time logging only

        from unittest import mock
        sys.modules["wandb"] = mock.MagicMock()
    from model_helper import load_model_checkpoint  # noqa: E402  (HOME/model_helper.py)
    ckpt, extra = MODELS[key]
    args = [ckpt, '-p', '2024', '-pr', '32', '-w', '0'] + extra
    model = load_model_checkpoint(args=args, device="cpu")
    model.to(device)
    return model, torch


def transcribe(model, torch, audio_path: Path, device: str, bsz: int = 8):
    import numpy as np
    import torchaudio
    from collections import Counter
    from utils.audio import slice_padded_array
    from utils.note2event import mix_notes
    from utils.event2note import merge_zipped_note_events_and_ties_to_notes
    try:
        audio, sr = torchaudio.load(str(audio_path))
    except Exception:                    # torchaudio backends vary; librosa handles mp3/m4a via audioread/ffmpeg
        import librosa
        y, sr = librosa.load(str(audio_path), sr=None, mono=False)
        audio = torch.from_numpy(np.atleast_2d(y))
    audio = torch.mean(audio, dim=0).unsqueeze(0)
    audio = torchaudio.functional.resample(audio, sr, model.audio_cfg['sample_rate'])
    frames = model.audio_cfg['input_frames']
    seg = slice_padded_array(audio, frames, frames)
    seg = torch.from_numpy(seg.astype('float32')).unsqueeze(1)    # (n_seg, 1, seg_len)
    n = seg.shape[0]
    preds = []
    with torch.inference_mode():
        for i in range(0, n, bsz):
            part, _ = model.inference_file(bsz=bsz, audio_segments=seg[i:i + bsz].to(device))
            preds.extend(part)
            progress(0.1 + 0.85 * min(1.0, (i + bsz) / n), f"Transcribing instruments (YourMT3+) — {min(n, i + bsz)} of {n} segments")
    starts = [frames * i / model.audio_cfg['sample_rate'] for i in range(n)]
    per_ch = []
    for ch in range(model.task_manager.num_decoding_channels):
        arr = [a[:, ch, :] for a in preds]
        zipped, _, _ = model.task_manager.detokenize_list_batches(arr, starts, return_events=True)
        notes_ch, _ = merge_zipped_note_events_and_ties_to_notes(zipped)
        per_ch.append(notes_ch)
    notes = mix_notes(per_ch)
    out = []
    for nt in notes:
        prog = nt.program            # decoded program = first GM program of the model's instrument class
        if nt.offset <= nt.onset:
            continue
        out.append([round(float(nt.onset), 4), round(float(nt.offset), 4), int(nt.pitch),
                    int(nt.velocity) if nt.velocity > 1 else 80, int(prog), bool(nt.is_drum)])
    out.sort(key=lambda r: (r[0], r[2]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("out")
    ap.add_argument("--model", default=DEFAULT, choices=sorted(MODELS))
    ap.add_argument("--device", default=None)
    ap.add_argument("--bsz", type=int, default=8)
    a = ap.parse_args()
    audio, out = Path(a.audio).resolve(), Path(a.out).resolve()
    import torch
    device = a.device or ("cuda" if torch.cuda.is_available() else "cpu")
    t0 = time.time()
    progress(0.02, "Loading the instrument transcription model (YourMT3+)…")
    model, torch = load(a.model, device)
    progress(0.1, "Transcribing instruments (YourMT3+)…")
    notes = transcribe(model, torch, audio, device, a.bsz)
    out.write_text(json.dumps(dict(model=a.model, device=device, seconds=round(time.time() - t0, 1), notes=notes)),
                   encoding="utf-8")
    progress(1.0, f"YourMT3+ done: {len(notes)} notes")


if __name__ == "__main__":
    main()
