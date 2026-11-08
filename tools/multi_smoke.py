"""Multi-part engraving and classic XML regression checks; never writes to data/."""
import importlib.util
import os
from pathlib import Path
import shutil
import sys
import tempfile
from collections import defaultdict
from fractions import Fraction as F
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))


def check_xml(result, expected_parts=None):
    root = ET.fromstring(result.xml)
    parts = root.findall('part')
    if expected_parts:
        assert [p.findtext('part-name') for p in root.findall('part-list/score-part')] == expected_parts
    assert len(parts) == len(result.doc['parts'])
    ids = [n.get('id') for n in root.findall('.//note[@id]')]
    assert len(ids) == len(set(ids)), 'duplicate note ids'
    rows = {n['id']: n for n in result.doc['notes']}
    all_measures = []
    for part, meta in zip(parts, result.doc['parts']):
        assert part.get('id') == meta['id']
        measures = part.findall('measure')
        all_measures.append([(m.get('number'), m.get('implicit')) for m in measures])
        assert len(measures) == len(result.doc['measures'])
        first = measures[0].find('attributes')
        assert first.find('key') is not None and first.find('time') is not None
        assert first.findtext('staves') == ('2' if meta['kind'] == 'grand' else None)
        if meta['kind'] == 'single':
            clef = first.find('clef')
            assert (clef.findtext('sign'), clef.findtext('line')) == (meta['clef'], {'G': '2', 'F': '4', 'C': '3'}[meta['clef']])
            assert not part.findall('.//octave-shift')
            assert not part.findall('.//pedal')
        if part is not parts[0]:
            assert not part.findall('.//metronome')
            assert not part.findall('.//sound[@tempo]')
        divisions = 24
        for mi, measure in enumerate(measures):
            divisions = int(measure.findtext('attributes/divisions', divisions))
            md = result.doc['measures'][mi]
            length = F(str(md['length'])).limit_denominator(48)
            if mi == 0:
                length -= F(str(result.doc['meta']['pickup'])).limit_denominator(48)
            expected = length * divisions
            cursor, totals, intervals = 0, defaultdict(int), defaultdict(list)
            last_start = {}
            for el in measure:
                if el.tag == 'backup':
                    assert cursor == expected, (meta['name'], mi, 'backup from', cursor, expected)
                    cursor -= int(el.findtext('duration'))
                    assert cursor == 0
                elif el.tag == 'note':
                    voice = int(el.findtext('voice'))
                    staff = int(el.findtext('staff'))
                    assert 1 <= staff <= len(meta['staves'])
                    assert (staff - 1) * 4 < voice <= staff * 4
                    if el.get('id'):
                        nid = int(el.get('id').split('-')[0][1:])
                        row = rows[nid]
                        assert row['part'] == meta['id'], (nid, row, meta)
                        assert row['staff'] == meta['staves'][staff - 1]
                    if el.find('grace') is not None:
                        continue
                    dur = int(el.findtext('duration'))
                    if el.find('chord') is None:
                        last_start[voice] = cursor
                        intervals[voice].append((cursor, cursor + dur))
                        cursor += dur
                        totals[voice] += dur
                    else:
                        assert last_start[voice] + dur <= expected
            assert cursor == expected, (meta['name'], mi, cursor, expected)
            for voice, total in totals.items():
                assert total == expected, (meta['name'], mi, voice, total, expected)
                assert intervals[voice][0][0] == 0 and intervals[voice][-1][1] == expected
                assert all(a[1] == b[0] for a, b in zip(intervals[voice], intervals[voice][1:]))
        assert measures[-1].findtext('barline/bar-style') == 'light-heavy'
    assert all(ms == all_measures[0] for ms in all_measures)
    return root


def edge_cases():
    """Small shared grids exercise absent/extra keyboards, fixed clefs and rests."""
    import numpy as np
    from app import edits
    from app.engrave import studio
    from app.engrave.config import Config
    from app.engrave.context import Ctx, Bars
    from app.engrave.inputs import Inputs
    from app.engrave.parts import score_parts
    from app.engrave.pipeline import sanitize
    from app.engrave.quantize import quantize
    from app.engrave.voices import dedupe

    cfg = Config(auto_keys=False, auto_spelling=False)
    cases = [[dict(id=f'S{i}', name=f'String {i}', program=40 + i % 3,
                   kind='single', clef=('C', 'F', 'G')[i % 3]) for i in range(10)],
             [dict(id='V', name='Viola', program=41, kind='single', clef='C'),
              dict(id='K', name='Piano', program=0, kind='grand', clef='G'),
              dict(id='O', name='Organ', program=19, kind='grand', clef='G'),
              dict(id='C', name='Cello', program=42, kind='single', clef='F'),
              dict(id='E', name='Empty', program=73, kind='single', clef='G')]]
    for parts in cases:
        raw, perf, part_of = [], [], []
        # Part 0 and every other sounding part share a real unison on beat 1.
        for pi in range(len(parts) - 1):
            for pitch, on, dur in [(60, 1, 1), (48, 2, 3), (72, 4, 1),
                                   (74, 5, F(1, 3)), (76, F(16, 3), F(1, 3)),
                                   (77, F(17, 3), F(1, 3)), (78, F(23, 4), 0), (79, 6, 1)]:
                raw.append([pitch, float(on), float(dur), int(pitch < 60)])
                perf.append((float(on) / 2, float(on + max(dur, F(1, 8))) / 2, pitch, 50 + pi * 3))
                part_of.append(pi)
        score = dict(notes=np.array(raw), is_grace=np.array([r[2] == 0 for r in raw]))
        inp = Inputs(perf=perf, pedal=[(1.0, 127), (3.0, 0)], score=score,
                     frames=None, parts=parts, part_of=part_of)
        bars = Bars([0, 4, 7], [(4, 4), (3, 4), (6, 8)])
        ctx = Ctx(cfg=cfg, log=lambda _: None, nbars=3, pickup=F(1), bars=bars, keys=[0, 2, -1])
        ctx.parts = score_parts(inp)
        G = np.arange(12) / 2
        notes = quantize(inp, G, lambda _: 0, ctx)
        sanitize(notes, ctx)
        notes = dedupe(notes, ctx)
        assert len([n for n in notes if n['pitch'] == 60 and n['on'] == 1]) == len(parts) - 1
        for n in notes:
            n['id'] = n['i']
        p1 = studio.Phase1(ctx, notes, G, lambda _: 0, '', list(ctx.keys))
        result = studio.render(inp, p1, cfg)
        root = check_xml(result)
        channels = [int(p.findtext('midi-instrument/midi-channel')) for p in root.findall('part-list/score-part')]
        assert 10 not in channels and len(channels) == len(set(channels))
        for part in root.findall('part'):
            assert part.findall('.//notations/fermata') or part.get('id') == parts[-1]['id']
            assert part.findall('measure')[1].find('attributes/key') is not None
            assert part.findall('measure')[1].find('attributes/time') is not None
        if parts[1]['kind'] == 'grand':
            organ = next(p for p in result.doc['parts'] if p['id'] == 'O')
            note = next(n for n in result.doc['notes'] if n['part'] == 'O' and not n['grace'])
            assert all(n['staff'] == organ['staves'][int(n['pitch'] < 60)]
                       for n in result.doc['notes'] if n['part'] == 'O')
            target = next(s for s in organ['staves'] if s != note['staff'])
            state = edits.apply_ops({}, [dict(op='set_staff', ids=[note['id']], staff=1)], result.doc)
            assert not state['notes'], 'cannot move organ notes into the piano'
            state = edits.apply_ops({}, [dict(op='set_staff', ids=[note['id']], staff=target)], result.doc)
            edited = studio.render(inp, p1, cfg, state)
            check_xml(edited)
            assert next(n for n in edited.doc['notes'] if n['id'] == note['id'])['staff'] == target
    print('edge cases: no keyboards / two keyboards, C/F clefs, unisons, empty parts, pickup, meter/key changes, channel 10 skipped')


def main():
    with tempfile.TemporaryDirectory(prefix='score-multi-') as temp:
        os.environ['SCORE_STUDIO_DATA'] = temp
        projects = Path(temp) / 'projects'
        for pid, source in [('mduet001', ROOT / 'tools/fixtures/multi-duet')] + [
                (pid, ROOT / 'data/projects' / pid) for pid in ('5438e1e2', '2b264c0e')]:
            shutil.copytree(source, projects / pid, ignore=shutil.ignore_patterns('source.*', '*.musicxml', 'review.json'))
        from app import engine, store, edits
        for pid in ('5438e1e2', '2b264c0e'):
            result = engine.render(store.get(pid))
            baseline = (ROOT / 'tools/fixtures/regression' / f'{pid}.musicxml').read_bytes()
            # engine returns LF text and writes native newlines (CRLF on Windows).
            baseline_path = ROOT / 'tools/fixtures/regression' / f'{pid}.musicxml'
            assert result.xml == baseline_path.read_text(encoding='utf-8'), f'{pid}: classic XML changed'
            assert (projects / pid / 'score.musicxml').read_bytes() == baseline, f'{pid}: XML bytes changed'
            assert result.doc['parts'] == [dict(id='P1', name='Piano', program=0, kind='grand', clef='G', staves=[1, 2])]
            assert all(n['part'] == 'P1' for n in result.doc['notes'])
            print(f'{pid}: byte-identical ({len(baseline):,} bytes)', flush=True)
        project = store.get('mduet001')
        result = engine.render(project, edits={})
        root = check_xml(result, ['Violin', 'Piano'])
        assert [p.findtext('midi-instrument/midi-program') for p in root.findall('part-list/score-part')] == ['41', '1']
        assert [p.findtext('midi-instrument/midi-channel') for p in root.findall('part-list/score-part')] == ['1', '2']
        violin, piano = result.doc['parts']
        assert violin['staves'] == [3] and piano['staves'] == [1, 2]
        vn = next(n for n in result.doc['notes'] if n['part'] == violin['id'] and not n['grace'])
        pn = next(n for n in result.doc['notes'] if n['part'] == piano['id'] and not n['grace'])
        state = edits.apply_ops({}, [dict(op='set_staff', ids=[vn['id']], staff=1)], result.doc)
        assert not state['notes']
        assert engine.render(project, edits=state).xml == result.xml
        target = 3 - pn['staff']
        state = edits.apply_ops(state, [dict(op='set_staff', ids=[vn['id'], pn['id']], staff=target),
                                      dict(op='add_note', pitch=81, staff=3, on=str(vn['on']), dur='1/2', voice=3)], result.doc)
        edited = engine.render(project, edits=state)
        check_xml(edited, ['Violin', 'Piano'])
        assert next(n for n in edited.doc['notes'] if n['id'] == pn['id'])['staff'] == target
        added = next(n for n in edited.doc['notes'] if n['added'])
        assert (added['part'], added['staff'], added['voice']) == ('P1', 3, 3), added
        parser = None
        if importlib.util.find_spec('music21'):
            from music21 import converter
            parsed = converter.parse(result.xml, format='musicxml')
            assert len(parsed.parts) == 3  # music21 splits the piano's two PartStaffs
            parser = 'music21'
        elif importlib.util.find_spec('partitura'):
            import partitura
            path = Path(temp) / 'duet.musicxml'
            path.write_text(result.xml, encoding='utf-8')
            parsed = partitura.load_musicxml(path)
            assert len(parsed.parts) == 2
            parser = 'partitura'
        print(f'duet: Violin + Piano, {result.doc["meta"]["bars"]} measures/part, '
              f'{result.doc["meta"]["notes"]:,} notes; balanced voices and edits OK; parser={parser or "unavailable"}')
        edge_cases()


if __name__ == '__main__':
    main()
