const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
require('../out/i18n').setLanguage('en');

const processModule = require('../out/core/process');
const { checkInstallation } = require('../out/tools/check');

async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.cache/openocd-check-'));
  const scripts = path.join(root, 'scripts');
  await fs.mkdir(path.join(scripts, 'interface'), { recursive: true });
  for (const name of ['cmsis-dap.cfg', 'stlink.cfg', 'jlink.cfg']) await fs.writeFile(path.join(scripts, 'interface', name), '');
  const executable = path.join(root, 'openocd.exe');
  await fs.writeFile(executable, '');
  return { root, scripts, executable, tool: { id: 'openocd', version: '0.12.0', source: 'managed',
    executables: { openocd: executable }, scriptsDirectory: scripts } };
}
const reply = (exitCode, stderr = '') => ({ exitCode, stdout: '', stderr, timedOut: false, cancelled: false });
function stub(run, t) {
  const original = processModule.runProcess, calls = [];
  processModule.runProcess = async request => request.args.includes('--version') ? reply(0) : (calls.push(request.args), run(request.args));
  t.after(() => { processModule.runProcess = original; });
  return calls;
}
const isModernStlink = args => args.includes('source [find interface/stlink.cfg]') && args.includes('transport select swd');

test('the OpenOCD self-check loads the ST-Link interface script and reports the HLA fallback', async t => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const calls = stub(args => isModernStlink(args) ? reply(1, "Error: Transport 'swd' is not selectable.") : reply(0), t);

  const checks = await checkInstallation(f.tool);
  const st = checks.find(check => check.code === 'adapter.st-link');
  assert.equal(st.status, 'ok');
  assert.match(st.summary, /HLA fallback/);
  assert.equal(checks.filter(check => check.code.startsWith('adapter.')).length, 3);

  const attempts = calls.filter(args => args.includes('-s'));
  assert.ok(attempts.length > 0);
  for (const args of attempts) assert.equal(args[args.indexOf('-s') + 1], f.scripts);
  assert.ok(attempts.some(isModernStlink));
  assert.ok(attempts.some(args => args.some(value => value.includes('stlink-hla.cfg')) && args.includes('transport select hla_swd')));
  assert.equal(calls.some(args => args.includes('adapter driver st-link')), false);
});

test('the OpenOCD self-check reports ST-Link unavailable when neither dialect loads', async t => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  stub(args => args.some(value => value.includes('stlink')) ? reply(1, 'Error: open failed') : reply(0), t);

  const checks = await checkInstallation(f.tool);
  const st = checks.find(check => check.code === 'adapter.st-link');
  assert.equal(st.status, 'error');
  assert.match(st.summary, /unavailable/);
  assert.ok(st.evidence.includes('[modern]') && st.evidence.includes('[legacy]'));
});
