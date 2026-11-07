import { useEffect, useRef, useState } from 'react';
import { PianoPlayback, toQuarter, toSeconds, type PlaybackSource } from '../lib/playback';
import type { ScoreDoc } from '../lib/types';

export function usePlayback(doc: ScoreDoc | null, onError: (message: string) => void) {
  const engine = useRef<PianoPlayback | null>(null);
  const [source, setSource] = useState<PlaybackSource>('synth');
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [speed, updateSpeed] = useState(1);
  const [transpose, updateTranspose] = useState(0);
  const generation = useRef(0);
  const frame = useRef(0);
  const position = useRef(0);
  const settings = useRef({ source: 'synth' as PlaybackSource, speed: 1, transpose: 0 });
  const pending = useRef(false);
  const clock = useRef<{ source: PlaybackSource; from: number; start: number; speed: number } | null>(null);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;

  const endQuarter = Math.max(0, ...doc?.measures.map(measure => measure.start + measure.length) ?? []);
  const duration = doc ? toSeconds(doc, source, endQuarter) : 0;

  function updatePosition(value: number) {
    position.current = value;
    setSeconds(value);
  }

  function currentPosition() {
    const active = clock.current;
    if (!active) return position.current;
    return active.source === 'audio'
      ? engine.current?.audio.currentTime ?? position.current
      : active.from + (performance.now() - active.start) / 1000 * active.speed;
  }

  function stop() {
    updatePosition(currentPosition());
    generation.current += 1;
    clock.current = null;
    pending.current = false;
    engine.current?.stop();
    cancelAnimationFrame(frame.current);
    setPlaying(false);
    setLoading(false);
  }

  useEffect(() => {
    engine.current = new PianoPlayback(message => errorHandler.current(message));
    return () => {
      generation.current += 1;
      clock.current = null;
      pending.current = false;
      cancelAnimationFrame(frame.current);
      engine.current?.dispose();
      engine.current = null;
    };
  }, []);

  useEffect(() => {
    stop();
    updatePosition(0);
    settings.current.source = doc?.meta.has_audio ? 'audio' : 'synth';
    setSource(settings.current.source);
  }, [doc?.id]);

  useEffect(() => {
    stop();
  }, [doc?.version]);

  async function play(from = position.current) {
    if (!doc || !engine.current) return;
    stop();
    updatePosition(from);
    const token = ++generation.current;
    const source = settings.current.source;
    const duration = toSeconds(doc, source, endQuarter);
    pending.current = true;
    setLoading(true);
    try {
      engine.current.setSpeed(settings.current.speed);
      engine.current.setTranspose(settings.current.transpose);
      const started = await engine.current.play(doc, source, from);
      if (!started || token !== generation.current) return;
      pending.current = false;
      setPlaying(true);
      clock.current = { source, from, start: performance.now(), speed: settings.current.speed };
      let lastPaint = 0;
      const tick = () => {
        if (token !== generation.current) return;
        const now = currentPosition();
        if (now >= duration || (source === 'audio' && engine.current?.audio.ended)) {
          stop();
          updatePosition(0);
          return;
        }
        if (performance.now() - lastPaint >= 30) {
          updatePosition(now);
          lastPaint = performance.now();
        }
        frame.current = requestAnimationFrame(tick);
      };
      frame.current = requestAnimationFrame(tick);
    } catch (error) {
      if (token === generation.current) {
        stop();
        errorHandler.current((error as Error).message);
      }
    } finally {
      if (token === generation.current) {
        pending.current = false;
        setLoading(false);
      }
    }
  }

  function seek(value: number) {
    const resume = !!clock.current || pending.current;
    stop();
    const next = Math.max(0, Math.min(duration, value));
    updatePosition(next);
    if (resume) void play(next);
  }

  function changeSource(next: PlaybackSource) {
    if (!doc || next === settings.current.source || (next === 'audio' && !doc.meta.has_audio)) return;
    const quarter = toQuarter(doc, settings.current.source, currentPosition());
    const resume = !!clock.current || pending.current;
    stop();
    settings.current.source = next;
    setSource(next);
    const from = toSeconds(doc, next, quarter);
    updatePosition(from);
    if (resume) void play(from);
  }

  function setSpeed(value: number) {
    if (!Number.isFinite(value)) return;
    const next = Math.max(0.5, Math.min(1.5, value));
    if (next === settings.current.speed) return;
    const from = currentPosition();
    const restart = settings.current.source === 'synth' && (!!clock.current || pending.current);
    settings.current.speed = next;
    updateSpeed(next);
    engine.current?.setSpeed(next);
    if (restart) void play(from);
  }

  function setTranspose(semitones: number) {
    if (!Number.isFinite(semitones)) return;
    const next = Math.max(-12, Math.min(12, Math.round(semitones)));
    if (next === settings.current.transpose) return;
    const from = currentPosition();
    const restart = settings.current.source === 'synth' && (!!clock.current || pending.current);
    settings.current.transpose = next;
    updateTranspose(next);
    engine.current?.setTranspose(next, settings.current.source === 'audio');
    if (restart) void play(from);
  }

  return {
    source, changeSource, playing, loading, seconds, duration, speed, setSpeed, transpose, setTranspose,
    quarter: doc ? toQuarter(doc, source, seconds) : 0,
    seek,
    seekQuarter: (quarter: number) => {
      if (doc) seek(toSeconds(doc, source, quarter));
    },
    toggle: () => clock.current || pending.current ? stop() : void play(position.current >= duration ? 0 : position.current),
  };
}

export type Playback = ReturnType<typeof usePlayback>;
