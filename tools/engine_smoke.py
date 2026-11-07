"""Smoke test: rebuild DuET inputs from a baseline run dir and render with the Score Studio engine."""
import sys, time, json, types, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "backend"))
import numpy as np, pandas as pd
from duet.midi import read_performance_midi
from app.engrave.inputs import Inputs
from app.engrave.config import Config
from app.engrave import studio

run = pathlib.Path(sys.argv[1]); perf = pathlib.Path(sys.argv[2]); maxv = int(sys.argv[3]) if len(sys.argv) > 3 else 3
z = np.load(run / "score.npz", allow_pickle=False)
score = types.SimpleNamespace(**{k: z[k] for k in ("notes", "bar_starts", "bar_lengths", "meters", "voices", "keys")})
data = read_performance_midi(perf)
frames = pd.read_csv(run / "frames.csv")
inp = Inputs.from_prediction(data, score, frames)
cfg = Config(max_voices=maxv)
t = time.time(); p1 = studio.phase1(inp, cfg, "Winter Wind"); t1 = time.time() - t
t = time.time(); r = studio.render(inp, p1, cfg, {}); t2 = time.time() - t
print(f"phase1 {t1:.2f}s render {t2:.2f}s notes {len(r.doc['notes'])} bars {r.doc['meta']['bars']}")
out = run / f"studio_v{maxv}.musicxml"; out.write_text(r.xml, encoding="utf-8")
import collections
print("voices:", collections.Counter((n['staff'], n['voice']) for n in r.doc['notes']))
print("review:", len(r.doc['review']), "warnings:", [l for l in r.log.splitlines() if 'WARNING' in l][:5])
