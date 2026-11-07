import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { escapeHtml, getLanguage, webviewLocale } from '../i18n';

export function webviewDocument(webview: vscode.Webview, root: vscode.Uri, title: string, script: string, body: string): string {
  const nonce = randomBytes(24).toString('base64');
  const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, file)).toString();
  return `<!doctype html><html lang="${getLanguage()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource}; form-action 'none'; base-uri 'none'">
<link rel="stylesheet" href="${uri('workbench.css')}"><link rel="stylesheet" href="${uri('memory.css')}"><title>${escapeHtml(title)}</title></head><body>${body}<script nonce="${nonce}">window.stm32Locale=${webviewLocale()};</script><script nonce="${nonce}" src="${uri('i18n.js')}"></script><script nonce="${nonce}" src="${uri(script)}"></script></body></html>`;
}
