"""Part metadata and isolated staff layout on the shared score grid."""
from collections import defaultdict
from dataclasses import replace

from .hands import playability, cross_over
from .layout import Plan, Directions, directions, events_for
from .voices import assign


def validate(inp):
    if not inp.parts or inp.part_of is None or len(inp.part_of) != len(inp.perf):
        raise ValueError('parts.json must assign every performance row to a part')
    ids = set()
    for p in inp.parts:
        if not isinstance(p['id'], str) or not p['id'] or p['id'] in ids:
            raise ValueError('part ids must be unique non-empty strings')
        ids.add(p['id'])
        if p['kind'] not in ('grand', 'single') or p['clef'] not in ('G', 'F', 'C'):
            raise ValueError('invalid part kind or clef')
        if type(p['program']) is not int or not 0 <= p['program'] <= 127:
            raise ValueError('invalid MIDI program')
    if any(type(i) is not int or not 0 <= i < len(inp.parts) for i in inp.part_of):
        raise ValueError('part_of contains an invalid part index')


def score_parts(inp):
    raw = inp.parts if inp.parts is not None else [dict(id='P1', name='Piano', program=0, kind='grand', clef='G')]
    parts = [{k: p[k] for k in ('id', 'name', 'program', 'kind', 'clef')} for p in raw]
    first = next((i for i, p in enumerate(parts) if p['kind'] == 'grand'), None)
    staff = 0
    for i in ([first] if first is not None else []) + [i for i in range(len(parts)) if i != first]:
        count = 2 if parts[i]['kind'] == 'grand' else 1
        parts[i]['staves'] = list(range(staff + 1, staff + count + 1))
        staff += count
    return parts


def layout(notes, inp, ctx, G, nov, piano_layout):
    """Reuse the piano layout in local 0/1 coordinates, then restore global staves."""
    parts = score_parts(inp)
    plan = Plan()
    plan.parts, plan.notes = parts, []
    for name in ('layers', 'clefs', 'local_clefs', 'clef_tls', 'layer_keys', 'EV', 'ott'):
        setattr(plan, name, {})
    plan.grace_by = defaultdict(list)
    plan.dirs = Directions(ctx)
    for pi, part in enumerate(parts):
        staves = [s - 1 for s in part['staves']]
        pool = [n for n in notes if n['part'] == part['id']]
        for n in pool:
            n['staff'] = staves.index(n['staff'])
        if part['kind'] == 'grand' and staves[0] == 0:
            pool, _ = playability(pool, ctx)
            cross_over(pool, ctx)
        for n in pool:
            o = nov.get(n['id'], {})
            if o.get('staff') in staves and part['kind'] == 'grand':
                n['staff'] = staves.index(o['staff'])
            if o.get('vpin'):
                n['vpin'] = int(o['vpin'])
        if part['kind'] == 'grand':
            local = piano_layout(pool, ctx)
        else:
            local = Plan()
            local.notes, local.graces = pool, [n for n in pool if n['grace']]
            local.layers = {0: assign(pool, 0, ctx)}
            local.clefs, local.local_clefs, local.clef_tls = {0: [part['clef']] * ctx.nbars}, {0: {}}, {0: []}
            local.layer_keys = {0: sorted({n['layer'] for n in local.layers[0]}, key=lambda k: (isinstance(k, str), str(k)))}
            local.EV = {(0, L): events_for(local.layers, 0, L) for L in local.layer_keys[0]}
            local.grace_by = defaultdict(list)
            for n in local.graces:
                local.grace_by[(0, n['on'])].append(n)
            for gs in local.grace_by.values():
                gs.sort(key=lambda n: n['pitch'])
            local.ott, local.ott_bassa = {0: [], 1: []}, []
        local.dirs = directions(local, replace(inp, pedal=inp.pedal if part['kind'] == 'grand' else []), G, ctx)
        if pi == 0:
            plan.base_bpm = local.base_bpm
        for (m, s), ds in local.dirs.td.items():
            for td in ds:
                tempo = '<metronome' in td[2] or '<words' in td[2]
                if tempo and pi != 0:
                    continue
                plan.dirs.td[(m, staves[s - 1] + 1)].append(td)
        for n in local.notes:
            n['staff'] = staves[n['staff']]
        plan.notes.extend(local.notes)
        for name in ('layers', 'clefs', 'local_clefs', 'clef_tls', 'layer_keys', 'ott'):
            for s in range(len(staves)):
                getattr(plan, name)[staves[s]] = getattr(local, name)[s]
        for (s, L), ev in local.EV.items():
            plan.EV[(staves[s], L)] = ev
        for (s, on), gs in local.grace_by.items():
            plan.grace_by[(staves[s], on)] = gs
    plan.graces = [n for n in plan.notes if n['grace']]
    return plan
