"""Score Studio engraving driver.

Splits DuET's readable pipeline (``pipeline._run``) into
  * ``Phase1`` – meter, beat grid, quantisation, bars (depends only on the inputs and
    the rhythm settings; cached), and
  * ``render`` – user edits + keys/spelling/runs + hands + N-voice layers + layout +
    MusicXML, returning the XML and the editor's score document.

Edit state (JSON-serialisable, see ``app.edits``)::

    {"notes": {"17": {"staff": 0|1, "vpin": 1..4, "on": "25/2", "dur": "1/2", "pitch": 65,
                      "spell": ["G", -1], "grace": false, "deleted": true}},
     "added": [{"id": 100000, "pitch": 60, "on": "4", "dur": "1", "staff": 0, "vpin": null}],
     "keys":  {"12": -1}}          # per-bar key signature overrides (bar index -> fifths)
"""
from __future__ import annotations

import copy
import io
from collections import Counter, defaultdict
from dataclasses import dataclass, replace
from fractions import Fraction as F

import numpy as np

from . import review as review_mod
from .config import Config
from .context import Ctx, Bars
from .grid import build_grid, fix_rewinds
from .hands import playability, cross_over
from .meter import analyse as analyse_meter
from .layout import Plan, lh_clefs, local_clefs, clef_timeline, events_for, ottava_runs, ottava_bassa_runs, directions
from .musicxml import write
from .pipeline import sanitize, snap_model_bars, map_model_bars, BarMappingError
from .quantize import quantize
from .spelling import Speller, set_key, STEP_PC
from .voices import dedupe, assign

STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
ADDED_BASE = 100000


def frac(v) -> F:
    return F(v).limit_denominator(48) if not isinstance(v, str) else F(v)


# ----------------------------------------------------------------------------- phase 1
@dataclass
class Phase1:
    ctx: Ctx
    notes: list
    G: object
    shift_at: object
    log: str
    keys_model: list


def _phase1(inp, cfg: Config, title: str) -> Phase1:
    logf = io.StringIO()
    log = lambda s: print(s, file=logf)
    ctx = Ctx(cfg=cfg, log=log, title=title)
    z = inp.score
    on = np.array([p[0] for p in inp.perf])
    M, q_model, qd_model, to_old, model_bars = analyse_meter(z, on, log)
    z = dict(z)
    z['notes'] = z['notes'].copy()
    z['notes'][:, 1], z['notes'][:, 2] = q_model, qd_model
    if model_bars is not None and cfg.snap_bar_lines:
        model_bars = snap_model_bars(model_bars, z['notes'][:, 1], log)
    inp = replace(inp, score=z)
    ctx.B, ctx.num, ctx.beat_type = M.bar_q, M.num, M.den
    ctx.pulse, ctx.compound = M.pulse_q, M.compound
    B = ctx.B
    if model_bars is None:
        fb = None
        if ctx.pulse == 1:
            from scipy.signal import find_peaks
            fr = inp.frames
            pk, _ = find_peaks(fr.p_any_beat.values, height=cfg.rewind_frame_conf, distance=cfg.beat_peak_distance)
            fb = (fr.performance_time_sec.values[pk], fr.p_downbeat.values[pk] > 0.5)
        z['notes'][:, 1] = fix_rewinds(on, z['notes'][:, 1], float(B), cfg, log, fb)
    grid_bars = None if model_bars is None else (
        np.array([b[0] for b in model_bars]), np.array([b[3] for b in model_bars]))
    G, shift_at = build_grid(inp.frames, on, z['notes'][:, 1], B, cfg, log, pulse=ctx.pulse, bars=grid_bars)
    first_q = min(float(z['notes'][i, 1]) + shift_at(on[i]) for i in range(len(on)))
    lead = F(int(first_q / float(ctx.pulse))) * ctx.pulse
    ctx.pickup = lead if 0 < lead < B else F(0)
    if model_bars is not None:
        last_q = max(float(z['notes'][i, 1]) + shift_at(on[i]) for i in range(len(on)))
        ctx.bars = map_model_bars(model_bars, z['notes'][:, 1], on, shift_at, F(last_q).limit_denominator(48), ctx, quiet=True)
    notes = quantize(inp, G, shift_at, ctx)
    sanitize(notes, ctx)
    notes = dedupe(notes, ctx)
    last_on = max(n['on'] for n in notes)
    if model_bars is None:
        ctx.nbars = int(last_on // B) + 1
        ctx.bars = Bars.uniform(ctx.nbars, ctx.num, ctx.beat_type)
    else:
        ctx.bars = map_model_bars(model_bars, z['notes'][:, 1], on, shift_at, last_on, ctx)
        ctx.nbars = ctx.bars.n
        first = min(n['on'] for n in notes) - ctx.bars.start(0)
        lead = F(int(first / ctx.pulse)) * ctx.pulse
        ctx.pickup = lead if 0 < lead < ctx.bars.length(0) else F(0)
    keys_model = [int(k) for k in z.get('keys', [0])]
    starts = np.asarray(z.get('bar_starts', np.arange(len(keys_model)) * float(B)), float)
    old_pos = (lambda m: to_old(float(ctx.bars.start(m)) + 1e-6)) if model_bars is None else \
        (lambda m: model_bars[min(m, len(model_bars) - 1)][0] + 1e-6)
    ctx.keys = [keys_model[min(max(int(np.searchsorted(starts, old_pos(m), 'right')) - 1, 0), len(keys_model) - 1)]
                for m in range(ctx.nbars)]
    for n in notes:
        n['id'] = int(n['i'])
    return Phase1(ctx=ctx, notes=notes, G=G, shift_at=shift_at, log=logf.getvalue(), keys_model=list(ctx.keys))


def phase1(inp, cfg: Config, title: str) -> Phase1:
    """Run phase 1, retrying without count corrections like ``pipeline.run``."""
    try:
        return _phase1(copy.deepcopy(inp), cfg, title)
    except BarMappingError:
        return _phase1(copy.deepcopy(inp), replace(cfg, grid_count_fix=False, snap_bar_lines=False), title)


# ----------------------------------------------------------------------------- helpers
def spell_name(step, alt, octave):
    return step + {-2: 'bb', -1: 'b', 0: '', 1: '#', 2: '##'}[alt] + str(octave)


def spellings_for(pitch):
    """all (step, alter) candidates for a MIDI pitch with |alter| <= 2"""
    out = []
    for s in STEPS:
        for a in (-2, -1, 0, 1, 2):
            if (STEP_PC[s] + a) % 12 == pitch % 12:
                out.append((s, a))
    return out


def prefer_spelling(pitch, prefer, key_fifths=0):
    cands = spellings_for(pitch)
    if prefer == 'sharp':
        cands = sorted(cands, key=lambda c: (c[1] < 0, abs(c[1]), c[1]))
    elif prefer == 'flat':
        cands = sorted(cands, key=lambda c: (c[1] > 0, abs(c[1]), -c[1]))
    else:
        return None
    return list(cands[0])


def _new_note(nid, pitch, on, dur, staff, t, vel=64):
    return dict(i=nid, id=nid, pitch=int(pitch), staff=int(staff), x=float(on), xo=float(on + dur), q=float(on),
                qd=float(dur), vel=vel, grace=False, roll=False, bass_grace=False, t=float(t),
                on=on, dur=dur, pd=float(dur), added=True, edited=True)


class TimeMap:
    """score quarter <-> performance seconds from the notes that kept their played time"""

    def __init__(self, notes):
        by = defaultdict(list)
        for n in notes:
            if not n.get('grace') and not n.get('added') and 'on_user' not in n:
                by[float(n['on'])].append(n['t'])
        pts = sorted((q, float(np.median(ts))) for q, ts in by.items())
        mono = []
        for q, s in pts:
            if not mono or s > mono[-1][1]:
                mono.append((q, s))
        if len(mono) < 2:
            mono = [(0.0, 0.0), (4.0, 2.0)]
        self.q = np.array([p[0] for p in mono])
        self.s = np.array([p[1] for p in mono])

    def sec(self, q):
        q = float(q)
        if q <= self.q[0]:
            slope = (self.s[1] - self.s[0]) / (self.q[1] - self.q[0])
            return float(self.s[0] + (q - self.q[0]) * slope)
        if q >= self.q[-1]:
            slope = (self.s[-1] - self.s[-2]) / (self.q[-1] - self.q[-2])
            return float(self.s[-1] + (q - self.q[-1]) * slope)
        return float(np.interp(q, self.q, self.s))

    def pairs(self, step=1.0, end=None):
        end = end if end is not None else self.q[-1]
        out, q = [], 0.0
        while q <= end + 1e-9:
            out.append([round(q, 4), round(self.sec(q), 4)])
            q += step
        return out


# ----------------------------------------------------------------------------- render
@dataclass
class Result:
    xml: str
    doc: dict
    log: str


def render(inp, p1: Phase1, cfg: Config, edits: dict | None = None) -> Result:
    edits = edits or {}
    nov = {int(k): v for k, v in (edits.get('notes') or {}).items()}
    logf = io.StringIO()
    logf.write(p1.log)
    log = lambda s: print(s, file=logf)
    ctx = copy.copy(p1.ctx)
    ctx.cfg, ctx.log = cfg, log
    ctx.keys = list(p1.ctx.keys)
    notes = copy.deepcopy(p1.notes)
    base_by_id = {n['id']: n for n in p1.notes}
    tm0 = TimeMap(p1.notes)

    # ---- a. note-level edits that analysis should see
    deleted_rows = []
    kept = []
    for n in notes:
        o = nov.get(n['id'])
        if o:
            n['edited'] = sorted(k for k in o if k != 'deleted')
            if o.get('deleted'):
                deleted_rows.append(n)
                continue
            if 'pitch' in o:
                n['pitch'] = int(o['pitch'])
            if 'on' in o:
                n['on'] = frac(o['on']); n['on_user'] = True
            if 'dur' in o:
                n['dur'] = frac(o['dur']); n['dur_lock'] = True
            if 'grace' in o:
                n['grace'] = bool(o['grace'])
                if not n['grace'] and n['dur'] <= 0:
                    n['dur'] = F(1, 4)
        kept.append(n)
    notes = kept
    for a in edits.get('added') or []:
        on, dur = frac(a['on']), frac(a['dur'])
        n = _new_note(int(a['id']), a['pitch'], on, dur, int(a.get('staff', 0)), tm0.sec(on))
        if a.get('vpin'):
            n['vpin'] = int(a['vpin'])
        n['edited'] = ['added']
        o = nov.get(n['id'])
        if o and o.get('deleted'):
            deleted_rows.append(n)
            continue
        notes.append(n)
    # extend the bar list if an edit moved notes past the end
    last = max((n['on'] + n['dur'] for n in notes), default=F(0))
    while ctx.bars.end(ctx.bars.n - 1) < last:
        m = ctx.bars.n - 1
        ctx.bars = Bars(ctx.bars.starts + [ctx.bars.end(m)], ctx.bars.sigs + [ctx.bars.sig(m)],
                        ctx.bars.lens + [F(ctx.bars.sig(m)[0] * 4, ctx.bars.sig(m)[1])])
        ctx.keys.append(ctx.keys[-1])
    ctx.nbars = ctx.bars.n

    rv = review_mod.Review(ctx)
    if cfg.auto_keys:
        review_mod.auto_keys(notes, ctx, rv, log)
    for m, f in (edits.get('keys') or {}).items():
        m = int(m)
        if 0 <= m < ctx.nbars:
            ctx.keys[m] = int(f)
    if cfg.auto_runs:
        notes = review_mod.auto_runs(notes, ctx, inp.perf, rv, log)
    # user grace / duration decisions win over the run cleanup
    for n in notes:
        o = nov.get(n['id'])
        if o and 'grace' in o:
            n['grace'] = bool(o['grace'])
        if o and 'dur' in o and not n['grace']:
            n['dur'] = frac(o['dur'])
    if cfg.auto_spelling:
        review_mod.auto_spelling(notes, ctx, rv, log)
    for n in notes:
        o = nov.get(n['id'])
        if o and o.get('spell'):
            n['spell'] = tuple(o['spell'])
    set_key(Counter(ctx.keys).most_common(1)[0][0])

    notes, stats = playability(notes, ctx)
    stats['cross_over'] = cross_over(notes, ctx)
    for n in notes:
        o = nov.get(n['id'])
        if o and 'staff' in o:
            n['staff'] = int(o['staff'])
        if o and o.get('vpin'):
            n['vpin'] = int(o['vpin'])
    for n in notes:
        if n['grace']:
            n.setdefault('layer', 0)
    layers = {st: assign(notes, st, ctx) for st in (0, 1)}

    lh_at = defaultdict(list)
    for n in layers[1]:
        lh_at[n['on']].append(n['pitch'])
    kept = []
    for n in notes:
        ch = lh_at.get(n['on'], [])
        if n['bass_grace'] and n['pitch'] < 50 and ch and min(ch) >= 68 and max(ch) >= 77:
            continue
        kept.append(n)
    notes = kept

    plan = Plan()
    plan.notes, plan.layers = notes, layers
    plan.graces = [n for n in notes if n['grace']]
    plan.clefs = {1: lh_clefs(plan, ctx, 1)}
    plan.clef2 = plan.clefs[1]
    from .spelling import ledgers
    plan.notes = notes = [n for n in notes if not (n['bass_grace'] and plan.clef2[ctx.bar_of(n['on'])] == 'G'
                                                  and ledgers(n['pitch'], 'G') > 4)]
    plan.graces = [n for n in notes if n['grace']]
    plan.clefs[0] = lh_clefs(plan, ctx, 0)
    plan.local_clefs = {st: local_clefs(plan, ctx, st) for st in (0, 1)}
    plan.clef_tls = {st: clef_timeline(plan, ctx, st) for st in (0, 1)}
    plan.local_clef, plan.clef_tl = plan.local_clefs[1], plan.clef_tls[1]
    plan.layer_keys = {}
    for st in (0, 1):
        ks = []
        for n in layers[st]:
            if n['layer'] not in ks:
                ks.append(n['layer'])
        plan.layer_keys[st] = sorted(ks, key=lambda k: (isinstance(k, str), str(k)))
    plan.EV = {(st, L): events_for(layers, st, L) for st in (0, 1) for L in plan.layer_keys[st]}
    plan.grace_by = defaultdict(list)
    for g in plan.graces:
        plan.grace_by[(g['staff'], g['on'])].append(g)
    for k in plan.grace_by:
        plan.grace_by[k].sort(key=lambda n: n['pitch'])
    plan.ott = {0: ottava_runs(plan, 0, *cfg.ottava_rh, ctx), 1: ottava_runs(plan, 1, *cfg.ottava_lh, ctx)}
    plan.ott_bassa = ottava_bassa_runs(plan, ctx)
    plan.dirs = directions(plan, inp, p1.G, ctx)
    review_mod.displaced(notes, ctx, rv)
    xml = write(plan, ctx, None)

    doc = build_doc(inp, ctx, plan, notes, deleted_rows, rv, base_by_id, edits)
    return Result(xml=xml, doc=doc, log=logf.getvalue())


# ----------------------------------------------------------------------------- document
def _measure_number(ctx, m):
    return m + (0 if ctx.pickup else 1)


def build_doc(inp, ctx, plan, notes, deleted_rows, rv, base_by_id, edits):
    measures = []
    for m in range(ctx.nbars):
        measures.append(dict(index=m, number=_measure_number(ctx, m), start=float(ctx.bars.start(m)),
                             length=float(ctx.bars.length(m)), time=list(ctx.bars.sig(m)), key=int(ctx.keys[m])))
    perf = inp.perf
    out = []

    def row(n, deleted=False):
        m = ctx.bar_of(n['on'])
        sp = Speller(ctx.keys[m])
        step, alt, octv = sp.spell(n)
        i = n['id']
        po, pf = (perf[i][0], perf[i][1]) if i < len(perf) and not n.get('added') else (n['t'], n['t'])
        return dict(id=i, pitch=int(n['pitch']), name=spell_name(step, alt, octv), spell=[step, alt],
                    staff=int(n['staff']) + 1, voice=int(n.get('vnum', 1)),
                    on=round(float(n['on']), 6), dur=round(float(n['dur']), 6), measure=m,
                    beat=round(float(n['on'] - ctx.bars.start(m)), 6), grace=bool(n['grace']),
                    deleted=deleted, added=bool(n.get('added')),
                    perf_on=round(float(po), 4), perf_off=round(float(pf), 4), velocity=int(n.get('vel', 64)),
                    edited=list(n.get('edited') or []) if isinstance(n.get('edited'), list) else [])

    for n in sorted(notes, key=lambda n: (n['on'], n['staff'], -n['pitch'])):
        out.append(row(n))
    for n in deleted_rows:
        out.append(row(n, deleted=True))

    tm = TimeMap([n for n in notes])
    timemap = tm.pairs(step=0.5, end=float(ctx.END))

    review = []
    order = {'high': 0, 'medium': 1, 'low': 2}
    resolved = edits.get('resolved') or {}
    for it in sorted(rv.items, key=lambda it: (order[it['priority']], it['kind'], it['bars'])):
        nums = [int(x) for part in it['bars'].split(',') for x in part.split('-') if x.strip().lstrip('-').isdigit()]
        opts = []
        for k, o in enumerate(it['options']):
            e = o.get('edit')
            supported = e is None or any(key in e for key in ('keys', 'spell', 'notes'))
            opts.append(dict(index=k, label=o['label'], supported=supported))
        review.append(dict(id=it['id'], kind=it['kind'], priority=it['priority'],
                           measures=[min(nums), max(nums)] if nums else None, question=it['question'],
                           evidence=it.get('evidence'), auto=it.get('auto'), options=opts,
                           resolved=resolved.get(it['id'])))
    doc = dict(
        meta=dict(tempo=getattr(plan, 'base_bpm', None), bars=ctx.nbars, pickup=float(ctx.pickup),
                  notes=len(notes), meter=f"{ctx.num}/{ctx.beat_type}"),
        measures=measures, notes=out, timemap=timemap, review=review,
        _review_raw={it['id']: it for it in rv.items},
    )
    return doc
