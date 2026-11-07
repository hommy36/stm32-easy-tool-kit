import { getLanguage } from '../i18n';
import zh from './feature.zh.json';
export function featureText(key: string,...args:unknown[]): string { const text=getLanguage() === 'zh-CN' ? (zh as Record<string,string>)[key] ?? key : key;return text.replace(/\{(\d+)\}/g,(match,index)=>Number(index)<args.length?String(args[Number(index)]):match); }
export function featureLocale(): Record<string,string> { return getLanguage() === 'zh-CN' ? zh : {}; }
