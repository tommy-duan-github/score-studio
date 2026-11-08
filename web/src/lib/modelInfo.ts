import type { Model } from './types';
import { t } from './i18n';

export type ModelGroup = 'core' | 'multi' | 'gpu';

/** Short, user-facing descriptions keyed by model key (findings in docs/MULTI_INSTRUMENT.md). */
const DESCRIPTIONS: Record<string, string> = {
  duet: 'Reads rhythm, bars, hands and key. Used by every transcription.',
  transkun: 'Turns piano audio into notes. Used in Piano mode.',
  'yptf-multi-ps': 'Cleanest instrument labels; did not invent extra parts in testing.',
  'moe-nops': 'Mixture-of-experts encoder and the fastest. May add viola or cello parts for low notes.',
  'moe-ps': 'Mixture-of-experts encoder with pitch-shift training. Least consistent in testing.',
  'yptf-single': 'Single-channel decoder. Finds the most notes, but also the most doubled notes.',
  'ymt3+': 'Original YourMT3+ baseline. Coarse instrument groups, e.g. strings instead of violin.',
  cuda: 'Runs transcription on the NVIDIA GPU, several times faster.',
};

export function modelGroup(model: Pick<Model, 'key' | 'required'>): ModelGroup {
  if (model.key === 'cuda') return 'gpu';
  return model.required || model.key === 'duet' || model.key === 'transkun' ? 'core' : 'multi';
}

/** Model name without the family prefix when it is shown under its family heading. */
export function modelShortName(model: Pick<Model, 'key' | 'name'>) {
  return modelGroup({ key: model.key, required: false }) === 'multi'
    ? model.name.replace(/^YourMT3\+\s*(·\s*)?(?=\S)/, '') || model.name : model.name;
}

export function modelDescription(model: Pick<Model, 'key' | 'purpose'>) {
  const known = DESCRIPTIONS[model.key];
  if (!known) return t(model.purpose);
  if (model.key !== 'cuda') return t(known);
  const gpu = /\(([^)]+)\)\s*$/.exec(model.purpose)?.[1];
  if (/no NVIDIA GPU detected/i.test(model.purpose)) return `${t(known)} ${t('No NVIDIA GPU detected.')}`;
  return gpu ? `${t(known)} (${gpu})` : t(known);
}
