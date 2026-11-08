import * as Tone from 'tone';
import { Midi } from '@tonejs/midi';
import { api, MOCK } from './api';
import type { ScoreDoc } from './types';

export const SAMPLE_BASE = import.meta.env.BASE_URL + 'samples/salamander/';
export const PIANO_URLS = {
          A0: 'A0.mp3', C1: 'C1.mp3', 'D#1': 'Ds1.mp3', 'F#1': 'Fs1.mp3',
          A1: 'A1.mp3', C2: 'C2.mp3', 'D#2': 'Ds2.mp3', 'F#2': 'Fs2.mp3',
          A2: 'A2.mp3', C3: 'C3.mp3', 'D#3': 'Ds3.mp3', 'F#3': 'Fs3.mp3',
          A3: 'A3.mp3', C4: 'C4.mp3', 'D#4': 'Ds4.mp3', 'F#4': 'Fs4.mp3',
          A4: 'A4.mp3', C5: 'C5.mp3', A5: 'A5.mp3', C6: 'C6.mp3',
          A6: 'A6.mp3', C7: 'C7.mp3', C8: 'C8.mp3',
        };

export function sustainedSynth(context = Tone.getContext()) {
  const vibrato = new Tone.Vibrato({ context, frequency: 5.2, depth: 0.06 }).toDestination();
  const filter = new Tone.Filter({ context, frequency: 2600, type: 'lowpass' }).connect(vibrato);
  const synth = new Tone.PolySynth({ context, voice: Tone.Synth, options: {
    oscillator: { type: 'fatsawtooth', count: 3, spread: 14 },
    envelope: { attack: 0.07, decay: 0.15, sustain: 0.8, release: 0.3 }, volume: -15,
  }}).connect(filter);
  return { synth, effects: [vibrato, filter] };
}

export type PlaybackSource = 'audio' | 'synth';

export function interpolate(map: [number, number][], value: number, inverse = false): number {
  if (!map.length) return 0;
  const from = inverse ? 1 : 0;
  const to = inverse ? 0 : 1;
  if (value <= map[0][from]) return map[0][to];
  for (let index = 1;index < map.length;index += 1) {
    if (value > map[index][from]) continue;
    const previous = map[index - 1];
    const next = map[index];
    const fraction = (value - previous[from]) / (next[from] - previous[from] || 1);
    return previous[to] + fraction * (next[to] - previous[to]);
  }
  return map[map.length - 1][to];
}

export function toQuarter(doc: ScoreDoc, source: PlaybackSource, seconds: number) {
  return source === 'audio' ? interpolate(doc.timemap, seconds, true) : seconds * doc.meta.tempo / 60;
}

export function toSeconds(doc: ScoreDoc, source: PlaybackSource, quarter: number) {
  return source === 'audio' ? interpolate(doc.timemap, quarter) : quarter * 60 / doc.meta.tempo;
}

/** Owns audio resources; React owns the transport controls and animation clock. */
export class PianoPlayback {
  readonly audio = new Audio();
  private sampler: Tone.Sampler | null = null;
  /** Sustained-tone synth for non-keyboard parts (violin, winds, voice…) of multi-instrument scores. */
  private lead: Tone.PolySynth | null = null;
  private leadFx: Tone.ToneAudioNode[] = [];
  private samples: Promise<void> | null = null;
  private midi: { key: string; data: Midi } | null = null;
  private generation = 0;
  private usingSynth = false;
  private speed = 1;
  private transpose = 0;
  private audioSource: MediaElementAudioSourceNode | null = null;
  private pitchShift: Tone.PitchShift | null = null;
  private routingFailed = false;
  private mockAudio: { id: string; url: string } | null = null;

  constructor(private onError: (message: string) => void = () => {}) {
    this.audio.crossOrigin = 'anonymous';
  }

  setSpeed(value: number) {
    this.speed = value;
    this.audio.playbackRate = value;
    const audio = this.audio as HTMLAudioElement & { webkitPreservesPitch?: boolean; mozPreservesPitch?: boolean };
    audio.preservesPitch = true;
    if ('webkitPreservesPitch' in audio) audio.webkitPreservesPitch = true;
    if ('mozPreservesPitch' in audio) audio.mozPreservesPitch = true;
  }

  setTranspose(semitones: number, original = false) {
    this.transpose = semitones;
    if (original || this.pitchShift) this.transposeAudio();
  }

  private transposeAudio() {
    if (this.routingFailed || (!this.transpose && !this.pitchShift)) return;
    try {
      if (!this.pitchShift) {
        // Build the effect first: creating a media source permanently takes over the element's output.
        this.pitchShift = new Tone.PitchShift(this.transpose).toDestination();
        this.audioSource = Tone.getContext().createMediaElementSource(this.audio);
        Tone.connect(this.audioSource, this.pitchShift);
      }
      this.pitchShift.pitch = this.transpose;
      this.pitchShift.wet.value = this.transpose === 0 ? 0 : 1;
    } catch {
      this.routingFailed = true;
      // If the element was already captured, retain a dry path instead of silencing it.
      this.audioSource?.disconnect();
      this.pitchShift?.dispose();
      this.pitchShift = null;
      if (this.audioSource) this.audioSource.connect(Tone.getContext().rawContext.destination);
      this.onError('Original audio transposition is unavailable in this browser. Playing without transposition.');
    }
  }

  stop() {
    this.generation += 1;
    this.audio.pause();
    if (this.usingSynth) {
      Tone.getTransport().stop();
      Tone.getTransport().cancel();
      this.sampler?.releaseAll();
      this.lead?.releaseAll();
    }
    this.usingSynth = false;
  }

  private loadPiano() {
    if (this.samples) return this.samples;
    this.samples = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Piano samples timed out. Try again.')), 25000);
      this.sampler = new Tone.Sampler({
        urls: PIANO_URLS,
        baseUrl: SAMPLE_BASE,
        release: 1,
        onload: () => {
          clearTimeout(timer);
          resolve();
        },
        onerror: () => {
          clearTimeout(timer);
          reject(new Error('Could not load piano samples'));
        },
      }).toDestination();
    }).catch(error => {
      this.sampler?.dispose();
      this.sampler = null;
      this.samples = null;
      throw error;
    });
    return this.samples;
  }

  private leadSynth() {
    if (this.lead) return this.lead;
    const { synth, effects } = sustainedSynth();
    this.leadFx = effects;
    this.lead = synth;
    return this.lead;
  }

  async play(doc: ScoreDoc, source: PlaybackSource, seconds: number): Promise<boolean> {
    this.stop();
    const token = this.generation;
    // Invoke while still in the play button / shortcut's user gesture. Plain original audio skips it, so
    // audio.play() is not delayed past the gesture (iOS Safari); it only needs Web Audio once pitch-shifted.
    if (source === 'synth' || this.transpose || this.pitchShift) await Tone.start();
    if (token !== this.generation) return false;
    if (source === 'audio') {
      if (MOCK && this.mockAudio?.id !== doc.id) {
        const { blob } = await api.originalAudio(doc);
        if (token !== this.generation) return false;
        if (this.mockAudio) URL.revokeObjectURL(this.mockAudio.url);
        this.mockAudio = { id: doc.id, url: URL.createObjectURL(blob) };
      }
      const url = MOCK ? this.mockAudio!.url : api.url(doc.id, 'audio');
      if (this.audio.getAttribute('src') !== url) this.audio.src = url;
      this.setSpeed(this.speed);
      this.transposeAudio();
      this.audio.currentTime = seconds;
      await this.audio.play();
      if (token !== this.generation) return false;
      return true;
    }

    const key = `${doc.id}:${doc.version}`;
    const [, midi] = await Promise.all([
      this.loadPiano(),
      this.midi?.key === key ? this.midi.data : api.midi(doc).then(data => new Midi(data)),
    ]);
    if (token !== this.generation) return false;
    this.midi = { key, data: midi };
    this.usingSynth = true;
    const transport = Tone.getTransport();
    transport.cancel();
    const speed = this.speed;
    const transpose = this.transpose;
    for (const track of midi.tracks) {
      // GM 0–23 keyboards / mallets / organ and 46 harp use the piano sampler; other programs a sustained synth.
      const program = track.instrument.number;
      const lead = track.notes.length > 0 && !(program <= 23 || program === 46) ? this.leadSynth() : null;
      for (const note of track.notes) {
        if (note.time + note.duration <= seconds) continue;
        const duration = Math.max(0.03, note.duration - Math.max(0, seconds - note.time)) / speed;
        // No piano-range clamp: the sampler repitches its nearest sample, and clamping would merge notes.
        const pitch = Math.max(0, Math.min(127, note.midi + transpose));
        transport.schedule(time => {
          (lead ?? this.sampler)?.triggerAttackRelease(Tone.Frequency(pitch, 'midi').toNote(), duration, time, note.velocity);
        }, Math.max(0, note.time - seconds) / speed);
      }
    }
    transport.seconds = 0;
    transport.start();
    return true;
  }

  dispose() {
    this.stop();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.mockAudio) URL.revokeObjectURL(this.mockAudio.url);
    this.audioSource?.disconnect();
    this.pitchShift?.dispose();
    this.sampler?.dispose();
    this.lead?.dispose();
    this.leadFx.forEach(node => node.dispose());
  }
}
