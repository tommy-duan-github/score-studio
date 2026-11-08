"""MusicXML 4.0 writer (one or more parts, up to four voices per staff, note ids for the editor)."""
import unicodedata
from fractions import Fraction as F
from xml.sax.saxutils import escape

import numpy as np
from .notation import layout_voice, beam, type_of
from .spelling import Speller

DIV = 24
ACC_NAME = {-2: 'flat-flat', -1: 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp'}


def bar_items(evs, lo, hi):
    items = []
    for ev in evs:
        if ev['end'] <= lo or ev['on'] >= hi:
            continue
        s, e = max(ev['on'], lo), min(ev['end'], hi)
        items.append((s - lo, e - lo, dict(ev=ev, tie_in=ev['on'] < lo, tie_out=ev['end'] > hi)))
    return items


def piece_ties(pc):
    """(tie_stop, is_attack) of a laid-out note piece"""
    pl = pc['pl']
    tie_stop = pc['cont_prev'] or pl['tie_in']
    return tie_stop, not tie_stop


def grace_owners(laid, grace_by, st):
    """onset -> (voice index, piece index) of the one attack that carries the grace
    notes before it: when both voices attack together the graces are written once"""
    own = {}
    for vi, pieces in enumerate(laid):
        for k, pc in enumerate(pieces):
            if pc['pl'] is not None and piece_ties(pc)[1]:
                on = pc['pl']['ev']['on']
                if (st, on) in grace_by and on not in own:
                    own[on] = (vi, k)
    return own


def accidentals(laid, graces_in, grace_by, st, sp):
    """which notes print an accidental: the staff's notes in time order across both
    voices (graces before their main note); an accidental holds for that step and
    octave until the bar line; a note tied over from before shows none and sets none"""
    ev = []          # (bar position, order, key, note, tied)
    for vi, pieces in enumerate(laid):
        for k, pc in enumerate(pieces):
            if pc['pl'] is None:
                continue
            tie_stop, attack = piece_ties(pc)
            e = pc['pl']['ev']
            if attack and graces_in.get(e['on']) == (vi, k):
                for j, gn in enumerate(grace_by[(st, e['on'])]):
                    ev.append((pc['s'], 0, ('g', e['on'], j), gn, False))
            for j, n in enumerate(e['notes']):
                ev.append((pc['s'], 1, ('n', vi, k, j), n, tie_stop))
    state, show = {}, {}
    for s, _, key, p, tied in sorted(ev, key=lambda x: (x[0], x[1])):
        if tied:
            continue
        step, alt, octv = sp.spell(p)
        if alt != state.get((step, octv), sp.key_alt[step]):
            show[key] = True
            state[(step, octv)] = alt
    return show




# voice numbers by pitch rank (top first) for k simultaneous streams in one staff:
# odd voices have stems up, even voices stems down (MuseScore convention)
VOICE_ORDER = {1: [1], 2: [1, 2], 3: [1, 3, 2], 4: [1, 3, 4, 2]}


def voice_streams(plan, st, lo, hi, prev_numbers):
    """Streams (layer, items) of one staff in one bar and the MusicXML voice number
    (1..4) of each. Pinned layers ('v1'..'v4') keep their number; a layer that ties
    in from the previous bar keeps the number it had there; the rest are numbered by
    mean pitch (top voice first)."""
    present = []
    for L in plan.layer_keys[st]:
        items = bar_items(plan.EV.get((st, L), []), lo, hi)
        if items:
            present.append((L, items))
    if not present:
        present = [(0, [])]
    k = min(len(present), 4)
    taken, numbers = {}, {}
    for L, items in present:
        if isinstance(L, str):
            numbers[L] = int(L[1:]); taken[int(L[1:])] = L
    for L, items in present:
        if L in numbers:
            continue
        if any(pl['tie_in'] for _, _, pl in items):
            pn = prev_numbers.get((st, L))
            if pn and pn not in taken:
                numbers[L] = pn; taken[pn] = L
    rest = [(L, items) for L, items in present if L not in numbers]
    mean = lambda items: (sum(n['pitch'] for _, _, pl in items for n in pl['ev']['notes'])
                          / max(1, sum(len(pl['ev']['notes']) for _, _, pl in items))) if items else 0
    rest.sort(key=lambda li: -mean(li[1]))
    order = VOICE_ORDER[max(1, k)] + [x for x in (1, 2, 3, 4) if x not in VOICE_ORDER[max(1, k)]]
    free = [x for x in order if x not in taken]
    for (L, items), num in zip(rest, free):
        numbers[L] = num; taken[num] = L
    # overflow (more than four layers in one bar) shares voice 4
    for L, items in rest:
        numbers.setdefault(L, 4)
    for L, _ in present:
        prev_numbers[(st, L)] = numbers[L]
    present.sort(key=lambda li: numbers[li[0]])
    return present, [numbers[L] for L, _ in present]


def keep_direction(td, cfg):
    dtype = td[2]
    if '<pedal' in dtype:
        return getattr(cfg, 'show_pedal', False)
    if '<dynamics' in dtype:
        return getattr(cfg, 'show_dynamics', True)
    if '<metronome' in dtype or '<words' in dtype:
        return getattr(cfg, 'show_tempo', True)
    return True


def clef_xml(c, staff=2):
    return f'<attributes><clef number="{staff}"><sign>{c}</sign><line>{4 if c == "F" else 3 if c == "C" else 2}</line></clef></attributes>'


def write(plan, ctx, path=None):
    NB, END, bars = ctx.nbars, ctx.END, ctx.bars
    DIV = getattr(plan, 'divisions', 24)
    out = []
    w = out.append
    w('<?xml version="1.0" encoding="UTF-8" standalone="no"?>')
    w('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">')
    w('<score-partwise version="4.0">')
    header = getattr(ctx, 'header', None) or {}
    title = (header.get('title') or ctx.title or '').strip()
    subtitle = (header.get('subtitle') or '').strip()
    composer = (header.get('composer') or '').strip()
    # the title is escaped, and wrapped at 52 columns (wide CJK characters count two)
    lines, line, width = [], '', 0
    for char in title:
        size = 2 if unicodedata.east_asian_width(char) in ('W', 'F') else 1
        if width + size > 52:
            lines.append(line)
            line, width = '', 0
        line += char
        width += size
    lines.append(line)
    w(f'<work><work-title>{escape(chr(10).join(lines))}</work-title></work>')
    if subtitle:
        w(f'<movement-title>{escape(subtitle)}</movement-title>')
    w('<identification>' + (f'<creator type="composer">{escape(composer)}</creator>' if composer else '')
      + '<creator type="arranger">Score Studio (Transkun + DuET, engraving fork)</creator>'
      '<encoding><software>engrave</software></encoding></identification>')
    # Page-1 credits carry the title block's text sizes to notation programs (100% = 12 pt).
    if header.get('show', True):
        for kind, text, pct, justify in (('title', title, header.get('title_size', 250), 'center'),
                                         ('subtitle', subtitle, header.get('subtitle_size', 120), 'center'),
                                         ('composer', composer, header.get('composer_size', 110), 'right')):
            if text:
                w(f'<credit page="1"><credit-type>{kind}</credit-type><credit-words font-size="{round(12 * pct / 100, 1)}"'
                  f' justify="{justify}" valign="top">{escape(text)}</credit-words></credit>')
    parts = getattr(plan, 'parts', None)
    if parts is None:
        ov = (getattr(ctx, 'part_overrides', None) or {}).get('P1') or {}     # user rename / instrument change
        name, program = escape(ov.get('name') or 'Piano'), int(ov.get('program', 0))
        w(f'<part-list><score-part id="P1"><part-name>{name}</part-name>'
          f'<score-instrument id="P1-I1"><instrument-name>{name}</instrument-name></score-instrument>'
          f'<midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>{program + 1}</midi-program></midi-instrument>'
          '</score-part></part-list>')
    else:
        w('<part-list>')
        channels = [c for c in range(1, 17) if c != 10]
        for i, p in enumerate(parts):
            pid, name = escape(p['id'], {'"': '&quot;'}), escape(p['name'])
            w(f'<score-part id="{pid}"><part-name>{name}</part-name>'
              f'<score-instrument id="{pid}-I1"><instrument-name>{name}</instrument-name></score-instrument>'
              f'<midi-instrument id="{pid}-I1"><midi-channel>{channels[i % len(channels)]}</midi-channel>'
              f'<midi-program>{p["program"] + 1}</midi-program></midi-instrument></score-part>')
        w('</part-list>')

    def dir_xml(td, staff, rel_from):
        rel, order, dtype, attrs, sound = td
        off = int((rel - rel_from) * DIV)
        return (f'<direction{attrs}><direction-type>{dtype}</direction-type>'
                + (f'<offset>{off}</offset>' if off else '') + f'<staff>{staff}</staff>{sound}</direction>')

    def pitch_el(sp, p, show):
        step, alt, octv = sp.spell(p)
        acc = f'<accidental>{ACC_NAME[alt]}</accidental>' if show else ''
        return f'<pitch><step>{step}</step>{f"<alter>{alt}</alter>" if alt else ""}<octave>{octv}</octave></pitch>', acc

    for part in parts or [dict(id='P1', staves=[1, 2])]:
        staves = [s - 1 for s in part['staves']]
        final_top = max((e['end'] for (st, _), evs in plan.EV.items() if st == staves[0] for e in evs), default=None)
        pid = escape(part['id'], {'"': '&quot;'})
        w(f'<part id="{pid}">')
        prev_key = None
        prev_numbers, piece_no = {}, {}
        for m in range(NB):
            pick = ctx.pickup if (m == 0 and ctx.pickup) else None
            B, lo, hi = bars.length(m), bars.start(m), bars.end(m)
            cmp = bars.compound(m)
            mlen = B - pick if pick else B
            num = m + (0 if ctx.pickup else 1)
            nominal = F(bars.sig(m)[0] * 4, bars.sig(m)[1])
            w(f'<measure number="{num}"' + (' implicit="yes"' if pick or B != nominal else '') + '>')
            sp = Speller(ctx.keys[m])
            attrs = []
            if m == 0:
                attrs.append(f'<divisions>{DIV}</divisions>')
            if ctx.keys[m] != prev_key:
                attrs.append(f'<key><fifths>{ctx.keys[m]}</fifths></key>')
                prev_key = ctx.keys[m]
            sig = bars.sig(m)
            if m == 0 or sig != bars.sig(m - 1):
                attrs.append(f'<time><beats>{sig[0]}</beats><beat-type>{sig[1]}</beat-type></time>')
            if m == 0:
                if len(staves) == 2:
                    attrs.append('<staves>2</staves>')
                for sn, st in enumerate(staves, 1):
                    c0 = plan.clefs[st][0]
                    attrs.append(f'<clef number="{sn}"><sign>{c0}</sign><line>{4 if c0 == "F" else 3 if c0 == "C" else 2}</line></clef>')
            if attrs:
                w('<attributes>' + ''.join(attrs) + '</attributes>')
            written = 0
            for sn, st in enumerate(staves, 1):
                streams, numbers = voice_streams(plan, st, lo, hi, prev_numbers)
                two = len(streams) >= 2
                laid = []
                for L, items in streams:
                    pieces = layout_voice(items, B, cut=pick, compound=cmp)
                    if pick:
                        pieces = [p for p in pieces if p['s'] >= pick]
                    num, den = bars.sig(m)
                    group_span = (F(3, 2) if num == 3 else F(1)) if den == 8 and not cmp else None
                    beam(pieces, B, cmp, group_span=group_span,
                         beat_unit=F(1, 2) if den == 8 and not cmp else F(1))
                    laid.append(pieces)
                graces_in = grace_owners(laid, plan.grace_by, st)
                show_acc = accidentals(laid, graces_in, plan.grace_by, st, sp)
                for vi, ((L, items), pieces) in enumerate(zip(streams, laid)):
                    vnum = numbers[vi]
                    voice = (sn - 1) * 4 + vnum
                    if written:
                        w(f'<backup><duration>{int(mlen * DIV)}</duration></backup>')
                    written += 1
                    timed = [t for t in sorted(plan.dirs.td.get((m, st + 1), []), key=lambda t: (t[0], t[1]))
                             if keep_direction(t, ctx.cfg)] if vi == 0 else []
                    clefs_here = [(t - lo, c) for t, c in plan.clef_tls[st] if lo <= t < hi] if vi == 0 else []
                    hide = ' print-object="no"' if two and vi > 0 else ''
                    if ((len(pieces) == 1 and pieces[0]['pl'] is None) or not pieces) and mlen == nominal:
                        for td in [t for t in timed if t[0] < B]:
                            w(dir_xml(td, sn, pick or F(0)))
                        for rel, c in clefs_here:
                            w(clef_xml(c, sn))
                        w(f'<note{hide}><rest measure="yes"/><duration>{int(mlen * DIV)}</duration><voice>{voice}</voice><staff>{sn}</staff></note>')
                        for td in [t for t in timed if t[0] >= B]:
                            w(dir_xml(td, sn, B))
                        continue
                    for k, pc in enumerate(pieces):
                        here = [t for t in timed if pc['s'] <= t[0] < pc['s'] + pc['d']]
                        for td in here:
                            w(dir_xml(td, sn, pc['s']))
                        timed = [t for t in timed if t not in here]
                        for rel, c in [x for x in clefs_here if x[0] < pc['s'] + pc['d']]:
                            w(clef_xml(c, sn))
                        clefs_here = [x for x in clefs_here if x[0] >= pc['s'] + pc['d']]
                        tname, dots = type_of(pc['d'], pc['reg'] is not None)
                        dur = int(pc['d'] * DIV)
                        tup_xml, tm_xml = '', ''
                        if pc['reg']:
                            # a beat of 1/6 notes is a sextuplet (6:4, same durations as 3:2)
                            sext = pc['reg'][2] == F(1, 3) and any(p2['d'] == F(1, 6) for p2 in pieces if p2['reg'] == pc['reg'])
                            an, nn = (6, 4) if sext else (3, 2)
                            tm_xml = f'<time-modification><actual-notes>{an}</actual-notes><normal-notes>{nn}</normal-notes></time-modification>'
                            r = pc['reg']
                            first = k == 0 or pieces[k - 1]['reg'] != r
                            lastp = k == len(pieces) - 1 or pieces[k + 1]['reg'] != r
                            if first and not lastp:
                                tup_xml = '<tuplet type="start" bracket="yes"/>'
                            elif lastp and not first:
                                tup_xml = '<tuplet type="stop"/>'
                        stem = ('<stem>up</stem>' if vnum % 2 == 1 else '<stem>down</stem>') if two else ''
                        beams = ''.join(f'<beam number="{lv}">{tp}</beam>' for lv, tp in sorted(pc['beam'].items()))
                        if pc['pl'] is None:
                            nots = f'<notations>{tup_xml}</notations>' if tup_xml else ''
                            w(f'<note{hide}><rest/><duration>{dur}</duration><voice>{voice}</voice><type>{tname}</type>{"<dot/>" * dots}{tm_xml}<staff>{sn}</staff>{nots}</note>')
                            continue
                        pl = pc['pl']; ev = pl['ev']
                        first_piece = not pc['cont_prev']
                        last_piece = not pc['cont_next']
                        tie_stop = pc['cont_prev'] or (pl['tie_in'] and first_piece)
                        tie_start = pc['cont_next'] or (pl['tie_out'] and last_piece)
                        is_attack = first_piece and not pl['tie_in']
                        if is_attack and graces_in.get(ev['on']) == (vi, k):
                            gr = plan.grace_by.get((st, ev['on']), [])
                            for j, gn in enumerate(gr):
                                pel, acc = pitch_el(sp, gn, show_acc.get(('g', ev['on'], j)))
                                chord = '<chord/>' if (j > 0 and gn['bass_grace'] and gr[j - 1]['bass_grace']) else ''
                                gn['vnum'] = vnum
                                w(f'<note id="n{gn["i"]}"><grace slash="yes"/>{chord}{pel}<voice>{voice}</voice><type>{"eighth" if gn["bass_grace"] else "16th"}</type>{acc}{stem}<staff>{sn}</staff></note>')
                        fermata = (last_piece and st == staves[0] and
                                   (ev['end'] == final_top if parts is not None else m == NB - 1 and ev['end'] >= END))
                        for j, n in enumerate(ev['notes']):
                            pel, acc = pitch_el(sp, n, show_acc.get(('n', vi, k, j)))
                            ties = ('<tie type="stop"/>' if tie_stop else '') + ('<tie type="start"/>' if tie_start else '')
                            nt = ('<tied type="stop"/>' if tie_stop else '') + ('<tied type="start"/>' if tie_start else '')
                            if j == 0:
                                nt += tup_xml
                            if ev['roll'] and is_attack:
                                nt += '<arpeggiate/>'
                            if fermata and j == len(ev['notes']) - 1:
                                nt += '<fermata type="upright"/>'
                            nots = f'<notations>{nt}</notations>' if nt else ''
                            chord = '<chord/>' if j > 0 else ''
                            bm = beams if j == 0 else ''
                            n['vnum'] = vnum
                            k_t = piece_no.get(n['i'], 0)
                            piece_no[n['i']] = k_t + 1
                            nid = f'n{n["i"]}' if k_t == 0 else f'n{n["i"]}-t{k_t}'
                            w(f'<note id="{nid}">{chord}{pel}<duration>{dur}</duration>{ties}<voice>{voice}</voice><type>{tname}</type>{"<dot/>" * dots}{acc}{tm_xml}{stem}<staff>{sn}</staff>{bm}{nots}</note>')
                    for td in timed:
                        w(dir_xml(td, sn, B if td[0] >= B else td[0]))
            if m == NB - 1:
                w('<barline location="right"><bar-style>light-heavy</bar-style></barline>')
            w('</measure>')
        w('</part>' if parts is not None else '</part></score-partwise>')
    if parts is not None:
        w('</score-partwise>')
    xml = '\n'.join(out)
    if path:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(xml)
    return xml
