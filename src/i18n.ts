import english from './i18n/en.json';

export type Language = 'en' | 'zh-CN';
let language: Language = 'en';
export function setLanguage(locale: string): void {
  language = /^zh(?:-|_|$)/i.test(locale) ? 'zh-CN' : 'en';
}
export function getLanguage(): Language { return language; }
export function translations(): Record<string, string> { return language === 'en' ? english : {}; }

/** Translate owned messages only; arguments (paths, project names, tool output) stay literal. */
export function t(message: string, ...args: unknown[]): string {
  const translated = language === 'en' ? (english as Record<string, string>)[message] ?? message : message;
  return translated.replace(/\{(\d+)\}/g, (token, index: string) => Number(index) < args.length ? String(args[Number(index)]) : token);
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

/** Safe inside a nonce-protected script, including translations containing HTML-like text. */
export function webviewLocale(): string {
  return JSON.stringify({ language, messages: translations() }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
