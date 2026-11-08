"""Download YourMT3+ (code from the official Hugging Face space, weights from the model repo) at pinned revisions.

    python backend/mt3/download.py [--dest third_party/YourMT3] [--models yptf-multi-ps moe-nops | --all]

Needs only ``huggingface_hub`` (any environment). Code: Apache-2.0 (mimbres/YourMT3 space); weights: the
``mimbres/YourMT3`` model repo, tagged Apache-2.0. Each checkpoint is 0.36–0.76 GB.
"""
from __future__ import annotations

import argparse
from pathlib import Path

SPACE, SPACE_REV = "mimbres/YourMT3", "5e66c1ea173a8186e0d20432b841d3180cc015b5"
MODEL_REV = "e45ebd70398682d54b7bb1901a5216e18f3b1824"
CKPT = {   # runner key -> path inside the model repo
    "yptf-multi-ps": "logs/2024/mc13_256_all_cross_v6_xk5_amp0811_edr005_attend_c_full_plus_2psn_nl26_sb_b26r_800k/checkpoints/model.ckpt",
    "moe-nops": "logs/2024/mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops/checkpoints/last.ckpt",
    "moe-ps": "logs/2024/mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b80_ps2/checkpoints/model.ckpt",
    "yptf-single": "logs/2024/ptf_all_cross_rebal5_mirst_xk2_edr005_attend_c_full_plus_b100/checkpoints/model.ckpt",
    "ymt3+": "logs/2024/notask_all_cross_v6_xk2_amp0811_gm_ext_plus_nops_b72/checkpoints/model.ckpt",
}
ROOT = Path(__file__).resolve().parents[2]


def main():
    from huggingface_hub import hf_hub_download, snapshot_download
    ap = argparse.ArgumentParser()
    ap.add_argument("--dest", default=str(ROOT / "third_party" / "YourMT3"))
    ap.add_argument("--models", nargs="*", default=["yptf-multi-ps"], choices=sorted(CKPT))
    ap.add_argument("--all", action="store_true")
    a = ap.parse_args()
    dest = Path(a.dest)
    snapshot_download(SPACE, repo_type="space", revision=SPACE_REV, local_dir=str(dest),
                      allow_patterns=["amt/src/**/*.py", "*.py", "README.md"],
                      ignore_patterns=["amt/src/extras/*", "amt/src/tests/*", "app.py"])
    for key in (sorted(CKPT) if a.all else a.models):
        rel = CKPT[key]
        target = dest / "amt" / rel
        if target.is_file():
            print("have", key)
            continue
        print("downloading", key)
        hf_hub_download(SPACE, rel, revision=MODEL_REV, repo_type="model", local_dir=str(dest / "amt"))
    print("YourMT3+ ready in", dest)


if __name__ == "__main__":
    main()
