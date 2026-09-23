export const DEFAULT_SETTINGS = Object.freeze({ moveSpeed: 3.5, turnMode: 'none', heightOffset: 0, dominantHand: 'right', volume: 1, skySize: 4096 });
const KEY = 'webxr-begain2.settings.v1';
export function sanitizeSettings(value = {}) {
  const v = value && typeof value === 'object' ? value : {};
  const number = (key, min, max) => Number.isFinite(v[key]) ? Math.max(min, Math.min(max, v[key])) : DEFAULT_SETTINGS[key];
  return {
    moveSpeed: number('moveSpeed', 0, 5), volume: number('volume', 0, 1), heightOffset: number('heightOffset', -0.5, 1),
    turnMode: ['none', 'snap', 'smooth'].includes(v.turnMode) ? v.turnMode : 'none',
    dominantHand: v.dominantHand === 'left' ? 'left' : 'right', skySize: v.skySize === 2048 ? 2048 : 4096,
  };
}
export function loadSettings() {
  try { return sanitizeSettings(JSON.parse(localStorage.getItem(KEY))); } catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(value) {
  const settings = sanitizeSettings(value);
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private browsing still supports session settings */ }
  return settings;
}
