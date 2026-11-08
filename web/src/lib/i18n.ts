import { useSyncExternalStore } from 'react';
import zh from './zh-CN.json';

export type Language = 'en' | 'zh-CN';
const KEY = 'score-studio:lang';
function initialLanguage(): Language {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === 'en' || stored === 'zh-CN') return stored;
  } catch { /* Language still works when storage is unavailable. */ }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}
let language = initialLanguage();
document.documentElement.lang = language;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const dictionaries = { en: Object.fromEntries(Object.keys(zh).map(key => [key, key])), 'zh-CN': zh };

export function setLanguage(next: Language) {
  language = next;
  document.documentElement.lang = next;
  try { localStorage.setItem(KEY, next); } catch { /* Optional persistence. */ }
  listeners.forEach(listener => listener());
}

export function t(key: string, values: unknown[] = []): string {
  const translated = Object.hasOwn(zh, key) ? (zh as Record<string, string>)[key] : undefined;
  const result = language === 'zh-CN' ? translated ?? translateMessage(key) : key;
  return result.replace(/\{(\d+)\}/g, (_, index: string) => String(values[Number(index)] ?? ''));
}

/** Known backend messages, preserving unrecognized details verbatim. */
function translateMessage(message: string): string {
  const patterns: [RegExp, (...matches: string[]) => string][] = [
    [/^Transcribing audio to notes \(Transkun\)[.…]*$/, () => '正在将音频转录为音符（Transkun）…'],
    [/^Reading rhythm, bars and hands \(DuET\)(?:\s*[—–-]\s*section (\d+) of (\d+))?[.…]*$/, (_, current, total) => `正在分析节奏、小节与左右手（DuET）${current ? ` — 第 ${current} / ${total} 段` : ''}…`],
    [/^Waiting in queue[.…]*$/, () => '排队等待中…'],
    [/^Done in ([\d.]+) s$/, (_, seconds) => `已完成，用时 ${seconds} 秒`],
    [/^Unsupported file: (.+)$/, (_, file) => `不支持的文件：${file}`],
    [/^Request failed \((\d+)\)$/, (_, status) => `请求失败（${status}）`],
    [/^Core (\d+), (\d+)% load$/, (_, core, load) => `核心 ${core}，负载 ${load}%`],
    [/^(.+) priority\. (.+)$/, (_, priority, question) => `${t(priority)}优先级。${t(question)}`],
  ];
  for (const [pattern, render] of patterns) {
    const match = message.match(pattern);
    if (match) return render(...match);
  }
  return message;
}

export function useLanguage() {
  const current = useSyncExternalStore(subscribe, () => language);
  return { language: current, setLanguage };
}
export function useT() { useLanguage(); return t; }
