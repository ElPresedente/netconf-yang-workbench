import { useState } from 'react';
export function readPreference<T>(key: string, fallback: T): T {
  try { const value = JSON.parse(localStorage.getItem(`workbench.${key}`) || 'null'); return value ?? fallback; } catch { return fallback; }
}
export function writePreference(key: string, value: unknown) {
  try { localStorage.setItem(`workbench.${key}`, JSON.stringify(value)); } catch { /* Preferences are optional. */ }
}
export function usePreference<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => readPreference(key, fallback));
  return [value, next => { setValue(next); writePreference(key, next); }];
}
