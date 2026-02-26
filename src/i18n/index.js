import en from './en.js';

const LOCALES = { en };

function normalizeLanguage(lang) {
  if (!lang || typeof lang !== 'string') return 'en';
  return lang.toLowerCase().replace('_', '-');
}

function resolveLocale(lang) {
  const normalized = normalizeLanguage(lang);
  return LOCALES[normalized] || LOCALES[normalized.split('-')[0]] || LOCALES.en;
}

function getByPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc && acc[key] != null ? acc[key] : undefined), obj);
}

function interpolate(str, vars) {
  if (!vars || typeof str !== 'string') return str;
  return str.replace(/\{(\w+)\}/g, (_m, key) => (vars[key] != null ? String(vars[key]) : ''));
}

export function getFrontendLanguage(hass) {
  return normalizeLanguage(
    hass?.language ||
    hass?.locale?.language ||
    (typeof navigator !== 'undefined' ? navigator.language : 'en'),
  );
}

export function t(hass, key, fallback = '', vars) {
  const locale = resolveLocale(getFrontendLanguage(hass));
  const english = LOCALES.en;
  const value = getByPath(locale, key) ?? getByPath(english, key) ?? fallback;
  return interpolate(value, vars);
}

export function tForHass(hass) {
  return (key, fallback = '', vars) => t(hass, key, fallback, vars);
}

