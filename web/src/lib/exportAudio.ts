import { Midi } from '@tonejs/midi';
import { api } from './api';
import { PIANO_URLS, SAMPLE_BASE } from './playback';
import type { ScoreDoc } from './types';

const yieldUI = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Chunk encoding to keep the editor responsive even for several minutes of stereo audio. */
export async function encodeWav(buffer: AudioBuffer, progress: (value: number) => void) {
  const channels = buffer.numberOfChannels;
  const bytes = new ArrayBuffer(44 + buffer.length * channels * 2);
  const data = new DataView(bytes);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => data.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF'); data.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, channels, true);
  data.setUint32(24, buffer.sampleRate, true); data.setUint32(28, buffer.sampleRate * channels * 2, true);
  data.setUint16(32, channels * 2, true); data.setUint16(34, 16, true); text(36, 'data');
  data.setUint32(40, bytes.byteLength - 44, true);
  const samples = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
  for (let start = 0; start < buffer.length; start += 65536) {
    const end = Math.min(buffer.length, start + 65536);
    for (let frame = start; frame < end; frame++) for (let channel = 0; channel < channels; channel++) {
      const value = Math.max(-1, Math.min(1, samples[channel][frame]));
      data.setInt16(44 + (frame * channels + channel) * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }
    progress(end / buffer.length); await yieldUI();
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

const NOTE_PC: Record<string, number> = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
const noteMidi = (name: string) => {
  const match = /^([A-G]#?)(\d)$/.exec(name);
  return match ? (Number(match[2]) + 1) * 12 + NOTE_PC[match[1]] : 60;
};
const isKeyboard = (program: number) => program <= 23 || program === 46;

/**
 * Renders the score MIDI to a WAV file with the same sounds as playback: the piano samples (repitched from the
 * nearest sample, 1 s release) for keyboard parts and a detuned-saw "sustained synth" (lowpass, slight vibrato) for
 * the rest. Notes are scheduled straight onto a native OfflineAudioContext, so rendering runs at native speed
 * (Tone.Offline steps its clock in JavaScript and takes minutes for a few minutes of music).
 */
export async function renderAudio(doc: ScoreDoc, progress: (value: number) => void) {
  progress(0);
  const midi = new Midi(await api.midi(doc));
  const rate = 44100;
  const duration = Math.max(0.1, midi.duration) + 2.5;
  const context = new OfflineAudioContext(2, Math.ceil(duration * rate), rate);

  // piano samples, decoded at the render rate
  const entries = Object.entries(PIANO_URLS);
  let loaded = 0;
  const samples = await Promise.all(entries.map(async ([name, file]) => {
    const response = await fetch(SAMPLE_BASE + file);
    if (!response.ok) throw new Error('Could not load piano samples');
    const buffer = await context.decodeAudioData(await response.arrayBuffer());
    progress(++loaded / entries.length * 15);
    return { pitch: noteMidi(name), buffer };
  }));
  const nearest = (pitch: number) => samples.reduce((best, s) => Math.abs(s.pitch - pitch) < Math.abs(best.pitch - pitch) ? s : best);

  // output: master gain -> gentle limiter (many simultaneous notes would clip otherwise)
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -3; limiter.knee.value = 6; limiter.ratio.value = 12;
  limiter.attack.value = 0.003; limiter.release.value = 0.25;
  limiter.connect(context.destination);
  const master = context.createGain();
  master.gain.value = 0.8;
  master.connect(limiter);

  // sustained synth bus: lowpass 2.6 kHz, -15 dB, vibrato 5.2 Hz as a modulated delay (like Tone.Vibrato)
  const leadBus = context.createBiquadFilter();
  leadBus.type = 'lowpass'; leadBus.frequency.value = 2600;
  const vibrato = context.createDelay(0.05);
  vibrato.delayTime.value = 0.005;
  const lfo = context.createOscillator();
  lfo.frequency.value = 5.2;
  const lfoDepth = context.createGain();
  lfoDepth.gain.value = 0.0006;
  lfo.connect(lfoDepth).connect(vibrato.delayTime);
  lfo.start(0);
  const leadGain = context.createGain();
  leadGain.gain.value = 10 ** (-15 / 20);
  leadBus.connect(vibrato).connect(leadGain).connect(master);

  const notes = midi.tracks.flatMap(track => track.notes.map(note => ({ note, keyboard: isKeyboard(track.instrument.number) })))
    .sort((a, b) => a.note.time - b.note.time);
  const addNote = ({ note, keyboard }: (typeof notes)[number]) => {
    const start = note.time;
    const end = start + Math.max(0.03, note.duration);
    const velocity = Math.max(0.05, note.velocity);
    const gain = context.createGain();
    if (keyboard) {
      const sample = nearest(note.midi);
      const source = context.createBufferSource();
      source.buffer = sample.buffer;
      source.playbackRate.value = 2 ** ((note.midi - sample.pitch) / 12);
      gain.gain.setValueAtTime(velocity, start);
      gain.gain.setValueAtTime(velocity, end);
      gain.gain.linearRampToValueAtTime(0, end + 1);          // 1 s release, as the playback sampler
      source.connect(gain).connect(master);
      source.start(start);
      source.stop(end + 1.05);
      return;
    }
    const sustain = velocity * 0.8;                          // attack 0.07, decay 0.15, sustain 0.8, release 0.3
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(velocity, start + 0.07);
    gain.gain.linearRampToValueAtTime(sustain, Math.min(end, start + 0.22));
    gain.gain.setValueAtTime(sustain, end);
    gain.gain.linearRampToValueAtTime(0, end + 0.3);
    gain.connect(leadBus);
    const frequency = 440 * 2 ** ((note.midi - 69) / 12);
    for (const detune of [-14, 0, 14]) {                    // "fatsawtooth": three detuned saws
      const osc = context.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = frequency;
      osc.detune.value = detune;
      const voice = context.createGain();
      voice.gain.value = 1 / 3;
      osc.connect(voice).connect(gain);
      osc.start(start);
      osc.stop(end + 0.35);
    }
  };

  // Nodes waiting in the graph cost render time even before they start, so each note is created just before it
  // plays: the render suspends every WINDOW seconds, adds the next window's notes, reports progress and resumes.
  const WINDOW = 4;
  let next = 0;
  const addUntil = (time: number) => {
    while (next < notes.length && notes[next].note.time < time) addNote(notes[next++]);
  };
  addUntil(WINDOW + 0.5);
  for (let t = WINDOW; t < duration - 0.1; t += WINDOW) {
    const at = t;
    void context.suspend(at).then(() => {
      addUntil(at + WINDOW + 0.5);
      progress(15 + at / duration * 65);
      void context.resume();
    });
  }
  const audio = await context.startRendering();
  progress(80);
  const blob = await encodeWav(audio, fraction => progress(80 + fraction * 20));
  saveBlob(blob, `${doc.title}.wav`);
}

export async function downloadOriginal(doc: ScoreDoc) {
  const { blob, filename } = await api.originalAudio(doc);
  saveBlob(blob, filename);
}
