const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { t, setLanguage, getLanguage, webviewLocale, escapeHtml } = require('../out/i18n');
const english = require('../out/i18n/en.json');
const { settingsBody } = require('../out/ui/settingsHtml');
const { consoleBody } = require('../out/ui/consoleHtml');
const { repairForError, repairLabel, capabilities } = require('../out/ui/presentation');
const { diagnose, redact } = require('../out/ui/diagnostics');

test('display language follows VS Code locale; unsupported languages fall back to English', () => {
  for (const locale of ['zh-CN', 'zh-cn', 'zh-tw', 'zh']) {
    setLanguage(locale); assert.equal(getLanguage(), 'zh-CN'); assert.equal(t('编译'), '编译');
  }
  for (const locale of ['en', 'en-US', 'fr', 'ja', '']) {
    setLanguage(locale); assert.equal(getLanguage(), 'en'); assert.equal(t('编译'), 'Build');
  }
});

test('every runtime translation preserves placeholders and is translated into English', () => {
  const tokens = value => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
  for (const [source, translation] of Object.entries(english)) {
    assert.ok(translation.length, source);
    assert.equal(/[\u3400-\u9fff]/.test(translation), false, source);
    assert.deepEqual(tokens(translation), tokens(source), source);
  }
});

test('owned UI strings are translated explicitly and all keys exist in the shared catalog', () => {
  let keys = 0;
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!/\.(ts|js)$/.test(file)) continue;
      const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isCallExpression(node) && node.expression.getText(sf) === 't') {
          assert.ok(ts.isStringLiteral(node.arguments[0]), `Use literal translation keys: ${file}`);
          assert.ok(Object.hasOwn(english, node.arguments[0].text), `${file}: ${node.arguments[0].text}`);
          keys++;
        }
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /[\u3400-\u9fff]/.test(node.text)) {
          assert.ok(ts.isCallExpression(node.parent) && node.parent.expression.getText(sf) === 't' && node.parent.arguments[0] === node,
            `Untranslated literal: ${file}: ${node.text}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(sf);
    }
  }
  walk('src'); walk('resources/workbench'); assert.ok(keys > 700);
});

test('manifest names the product and has complete native command/settings translations', () => {
  const manifest = require('../package.json');
  const en = require('../package.nls.json'), zh = require('../package.nls.zh-cn.json');
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].title, manifest.displayName);
  assert.equal(manifest.contributes.views.stm32Easy[0].name, manifest.displayName);
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const [, key] of JSON.stringify(manifest).matchAll(/%([^%]+)%/g)) {
    assert.ok(en[key], key); assert.ok(zh[key], key);
  }
  assert.equal(/[\u3400-\u9fff]/.test(JSON.stringify(en)), false);
});

test('host and webview translators preserve user data and do not recursively substitute placeholders', () => {
  const value = 'D:\\工程\\{1}\\<script>$&.elf';
  for (const locale of ['en', 'zh-CN']) {
    setLanguage(locale);
    const window = { stm32Locale: JSON.parse(webviewLocale()) };
    vm.runInNewContext(fs.readFileSync('resources/workbench/i18n.js', 'utf8'), { window });
    for (const key of Object.keys(english)) assert.equal(window.stm32I18n.t(key, value, 'second'), t(key, value, 'second'));
    assert.ok(t('固件：{0}', value).endsWith(value));
    assert.equal(t('unknown {0}', '$&'), 'unknown $&');
  }
  assert.equal(escapeHtml('<script>"&'), '&lt;script&gt;&quot;&amp;');
  assert.equal(webviewLocale().includes('</script>'), false);
});

test('static settings and console translate at render time, including accessible labels', () => {
  setLanguage('en');
  assert.equal(/[\u3400-\u9fff]/.test(settingsBody(false) + consoleBody()), false);
  assert.match(settingsBody(false), /aria-label="Project settings categories"/);
  assert.match(consoleBody(), /STM32 Easy Tool Kit/);
  setLanguage('zh-CN');
  assert.match(settingsBody(false), /工程设置/); assert.match(consoleBody(), /当前工程/);
});

test('repair destinations and diagnostics remain useful in both languages', () => {
  const cases = [['请先选择或安装 CMake', 'tools'], ['页面已过期或工程已切换，请放弃修改并重新加载设置', 'reload'],
    ['工程设置已被另一窗口更新，请重新加载后保存', 'reload'], ['请确认芯片与芯片配置脚本', 'dap'],
    ['请安装 Cortex-Debug 1.12.1 或兼容的 1.x', 'cortex'], ['构建方案已失效，请刷新方案列表', 'setup']];
  for (const locale of ['en', 'zh-CN']) {
    setLanguage(locale);
    for (const [message, repair] of cases) assert.equal(repairForError(t(message)), repair, message);
    assert.equal(repairForError('error: undefined reference to main'), 'problems');
    assert.equal(repairLabel('tools'), t('管理工具'));
    assert.equal(diagnose(t('工具包大小不匹配，拒绝创建快照')), t('工具包与固定清单不一致：重新下载所选版本，或导入匹配的离线 ZIP。'));
    assert.equal(redact('https://user:secret@host/?token=private').includes('secret'), false);
    assert.equal(redact('https://user:secret@host/?token=private').includes('private'), false);
    const state = capabilities({ cmakeProject: false, tools: [], busy: false, trusted: true, supported: true, cortex: false });
    assert.equal(state.build.reason, t('请先选择工程')); assert.equal(state.build.repair, 'setup');
  }
});
