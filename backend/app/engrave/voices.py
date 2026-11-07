"""Duplicate removal, voice layers and duration cleanup per staff.

Score Studio fork of DuET's engraving (MIT): generalised from two layers (A/B)
to up to ``cfg.max_voices`` layers per staff, plus user-pinned voices.

Layer keys:
  * ``0 .. max_voices-1`` – automatic layers. 0 is the main layer; higher layers hold
    triplet figures against duple ones and notes sustained under moving notes.
  * ``'v1' .. 'v4'``      – notes the user pinned to MusicXML voice 1..4 of the staff.
The MusicXML writer turns layers into voice numbers per bar (by pitch, pinned layers fixed).
"""
from bisect import bisect_left
from fractions import Fraction as F
from collections import defaultdict


def round_half(v):
    return F(max(1, round(v * 2)), 2)


def dedupe(notes, ctx):
    seen, out = {}, []
    for n in sorted(notes, key=lambda n: (n['on'], n['grace'], -n['dur'])):
        if n['grace']:
            out.append(n); continue
        if (n['staff'], n['on'], n['pitch']) in seen or (1 - n['staff'], n['on'], n['pitch']) in seen:
            if n.get('added') or n.get('edited'):
                out.append(n); continue
            ctx.log(f"duplicate removed p{n['pitch']} ({ctx.where(n['on'])})")
            continue
        seen[(n['staff'], n['on'], n['pitch'])] = n
        out.append(n)
    return out


def _end(n):
    return n['on'] + n['dur']


def assign(notes, staff, ctx):
    """Give every note of a staff a layer and a cleaned duration."""
    cv = ctx.cfg
    N = max(1, min(4, int(getattr(cv, 'max_voices', 2))))
    end_beat = ctx.END
    S = sorted([n for n in notes if n['staff'] == staff and not n['grace']], key=lambda n: (n['on'], n['pitch']))
    onsets = sorted(set(n['on'] for n in S))
    other_on = sorted(set(n['on'] for n in notes if n['staff'] != staff and not n['grace']))

    def next_on(o):
        i = bisect_left(onsets, o)
        while i < len(onsets) and onsets[i] <= o:
            i += 1
        return onsets[i] if i < len(onsets) else None

    frac = lambda o: o - o.numerator // o.denominator
    for n in S:
        n['layer'] = 0
    pinned = [n for n in S if n.get('vpin')]
    for n in pinned:
        n['layer'] = f"v{int(n['vpin'])}"
    auto = [n for n in S if not n.get('vpin')]

    if N >= 2:
        # (a) triplet figures against duple off-beats in the same half bar -> layer 1
        halves = defaultdict(list)
        for n in auto:
            halves[ctx.half_index(n['on'])].append(n)
        for h, grp in halves.items():
            local_compound = ctx.bars.compound(ctx.bar_of(grp[0]['on'])) if ctx.bars else ctx.compound
            if local_compound:
                continue
            dens = set(frac(n['on']).denominator for n in grp)
            duple = {4, 8} if 6 in dens or 12 in dens else {2, 4, 8}
            if any(d % 3 == 0 for d in dens) and any(d in duple for d in dens):
                for n in grp:
                    fr = frac(n['on'])
                    if fr.denominator % 3 == 0 or (fr == 0 and n['dur'].denominator % 3 == 0):
                        n['layer'] = 1
                ctx.log(f"staff{staff + 1} {ctx.where(min(n['on'] for n in grp))}: triplet layer split from duple layer")

        # (b) notes sustained under moving notes -> the first free sustain layer
        cands = []
        for n in auto:
            if n['layer'] != 0:
                continue
            nx = next_on(n['on'])
            if nx is None:
                continue
            over = n['on'] + n['dur'] - nx
            if over >= F(cv.voice_b_over).limit_denominator(24) and n['dur'] >= F(cv.voice_b_min_dur).limit_denominator(24) \
                    and (n['pd'] >= float(nx - n['on']) + cv.voice_b_hold or n.get('crossed') or n.get('dur_lock')):
                restrike = any(m['pitch'] == n['pitch'] and nx <= m['on'] < _end(n) for m in S if m is not n)
                if not restrike:
                    cands.append(n)
        placed = defaultdict(list)            # layer -> notes already in it
        for n in auto:
            if n['layer'] == 1:
                placed[1].append(n)

        def conflicts(n, L):
            for m in placed[L]:
                if m['on'] == n['on']:
                    # chord partner: fine unless the written lengths differ a lot
                    if abs(m['dur'] - n['dur']) > F(1, 2) and L + 1 < N:
                        return True
                    continue
                if m['on'] < _end(n) and n['on'] < _end(m):
                    return True
            return False

        for n in sorted(cands, key=lambda n: (n['on'], -n['pitch'])):
            target = None
            for L in range(1, N):
                if not conflicts(n, L):
                    target = L
                    break
            if target is None:
                target = 1          # no free layer: shares layer 1 and gets cut at its next attack
                ctx.log(f"staff{staff + 1} {ctx.where(n['on'])}: more sustained layers than max_voices={N}")
            n['layer'] = target
            placed[target].append(n)

    layers = []
    for n in S:
        if n['layer'] not in layers:
            layers.append(n['layer'])

    for L in layers:
        pool = [n for n in S if n['layer'] == L]
        ons = sorted(set(n['on'] for n in pool))
        by = defaultdict(list)
        for n in pool:
            by[n['on']].append(n)
        for i, o in enumerate(ons):
            nx = ons[i + 1] if i + 1 < len(ons) else end_beat
            gap = nx - o
            grp = by[o]
            locked = [n for n in grp if n.get('dur_lock')]
            if locked:
                d = max(n['dur'] for n in locked)
                d = min(d, gap) if gap > 0 else d
                for n in grp:
                    n['dur'] = d
                continue
            d = max(n['dur'] for n in grp)
            pd = max(n['pd'] for n in grp)
            if d > gap:
                d = gap
            elif d < gap:
                if cv.extend_by_hold and pd > float(d) + 0.3:     # key held longer: no rest
                    d = min(gap, max(d, round_half(pd)))
                if cv.extend_by_hold and gap - d <= F(1, 4) and pd >= float(d) * 0.6:
                    d = gap
                if 0 < gap - d < F(1, 4):                     # never a rest shorter than a 16th
                    d = gap
                fill = F(cv.rest_fill_max).limit_denominator(24)
                if 0 < gap - d <= fill and gap <= cv.rest_fill_gap and d >= (gap - d) * cv.rest_fill_ratio \
                        and not (bisect_left(other_on, nx) > bisect_left(other_on, o + d)
                                 and bisect_left(other_on, o) == bisect_left(other_on, o + F(1, 100))):
                    d = gap
            e = o + d
            if d == gap and (e - int(e)) == F(1, 4) and int(e) - o >= F(1, 2) and o.denominator in (1, 2, 4):
                d = int(e) - o
            for n in grp:
                n['dur'] = d
    # a note of a secondary layer must not swallow a later attack of the same pitch in another layer
    for n in S:
        if n['layer'] == 0:
            continue
        for m in S:
            if m is not n and m['layer'] != n['layer'] and m['pitch'] == n['pitch'] and n['on'] < m['on'] < _end(n):
                n['dur'] = m['on'] - n['on']
    return S
