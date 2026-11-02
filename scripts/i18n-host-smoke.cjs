// Run with an isolated VS Code profile, installed VSIX and --locale en / zh-cn.
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
exports.run = async () => {
  const extension = vscode.extensions.getExtension('local-stm32-tools.stm32-easy-tool-kit');
  assert.ok(extension);
  await extension.activate();
  const { getLanguage, t } = require(path.join(extension.extensionPath, 'out', 'i18n'));
  const expected = /^zh/i.test(vscode.env.language) ? 'zh-CN' : 'en';
  assert.equal(getLanguage(), expected);
  assert.equal(extension.packageJSON.contributes.viewsContainers.activitybar[0].title, 'STM32 Easy Tool Kit');
  assert.equal(extension.packageJSON.contributes.views.stm32Easy[0].name, 'STM32 Easy Tool Kit');
  const command = extension.packageJSON.contributes.commands.find(command => command.command === 'stm32Easy.workbench.build');
  // VS Code resolves package.nls before exposing the extension manifest.
  assert.equal(typeof command.title === 'string' ? command.title : command.title.value, expected === 'en' ? 'STM32: Build' : 'STM32: 编译');
  await vscode.commands.executeCommand('stm32Easy.workbench.tools');
  await vscode.commands.executeCommand('stm32Easy.project.focus');
  const result = { version: extension.packageJSON.version, locale: vscode.env.language, language: getLanguage(), build: t('编译'), nativeCommand: command.title, extensionPath: extension.extensionPath, panelsOpened: true, hardwareTested: false };
  await fs.writeFile(path.resolve(__dirname, `../.cache/i18n-host-${vscode.env.language}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (process.env.STM32_I18N_INSPECT === '1') await new Promise(resolve => setTimeout(resolve, 45000));
};
