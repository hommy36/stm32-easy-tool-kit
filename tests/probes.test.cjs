const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
require('../out/i18n').setLanguage('en');
const { defaultProjectSettings, validateProjectSettings, validateAuthorization, authorizationFrom, authorizationMatches } = require('../out/project/types');
const { buildConfigArgs, buildFlashArgs, resolveDapConfiguration } = require('../out/dap/config');
const { portableConfiguration } = require('../out/project/shared');

const hash = 'a'.repeat(64);
function settings(probe, extra = {}) {
  const uri = pathToFileURL('D:/project').toString();
  return { ...defaultProjectSettings(uri, fileURLToPath(uri)), chipConfirmed: true,
    targetScript: 'target/stm32f4x.cfg', configurePreset: 'Debug', configuration: 'Debug', targetId: 'fw', probe, ...extra };
}
const argsOf = (settings, dialect = 'legacy') => buildConfigArgs(settings, 'D:/OpenOCD/scripts', dialect);
const has = (args, value) => args.includes(value);

test('CMSIS-DAP keeps backend selection; ST-Link and J-Link select their own adapter driver', () => {
  const dap = argsOf(settings('cmsis-dap', { backend: 'hid' }), 'modern');
  assert.ok(has(dap, 'adapter driver cmsis-dap')); assert.ok(has(dap, 'cmsis-dap backend hid'));

  const st = argsOf(settings('st-link'), 'modern');
  assert.ok(has(st, 'adapter driver st-link')); assert.ok(has(st, 'transport select swd'));
  assert.equal(st.some(value => value.includes('backend')), false);
  assert.ok(st.some(value => value.startsWith('source ') && value.includes('stm32f4x.cfg')));

  const jl = argsOf(settings('jlink'), 'modern');
  assert.ok(has(jl, 'adapter driver jlink')); assert.equal(jl.some(value => value.includes('backend')), false);
  const legacyJl = argsOf(settings('jlink'), 'legacy');
  assert.ok(has(legacyJl, 'source [find interface/jlink.cfg]')); assert.ok(has(legacyJl, 'transport select swd'));
});

test('legacy ST-Link uses stlink.cfg, hla_swd and hla_serial; legacy J-Link cannot select a serial', () => {
  const serial = 'ST-LINK-1';
  const st = argsOf(settings('st-link', { serial }), 'legacy');
  assert.ok(has(st, 'source [find interface/stlink.cfg]')); assert.ok(has(st, 'transport select hla_swd'));
  assert.ok(has(st, 'hla_serial "ST-LINK-1"')); assert.equal(st.some(value => value.startsWith('adapter serial')), false);

  const modern = argsOf(settings('st-link', { serial }), 'modern');
  assert.ok(has(modern, 'adapter serial "ST-LINK-1"'));

  assert.throws(() => argsOf(settings('jlink', { serial }), 'legacy'), /J-Link/);
  assert.ok(has(argsOf(settings('jlink'), 'legacy'), 'source [find interface/jlink.cfg]'));
});

test('board scripts guard the selected adapter and never load a second interface', () => {
  const board = probe => argsOf(settings(probe, { scriptKind: 'board' }), 'modern');
  assert.ok(board('cmsis-dap').some(value => value.includes('requires CMSIS-DAP')));
  assert.ok(board('st-link').some(value => value.includes('requires ST-Link')));
  assert.ok(board('jlink').some(value => value.includes('requires J-Link')));
  for (const probe of ['cmsis-dap', 'st-link', 'jlink']) {
    const args = board(probe);
    assert.equal(args.some(value => value.startsWith('adapter driver')), false, probe);
    assert.ok(args.some(value => value.includes('requires SWD')), probe);
  }
  assert.ok(buildFlashArgs(settings('st-link'), 'D:/OpenOCD/scripts', 'D:/project/app.elf').at(-1).endsWith('verify reset exit'));
});

test('unknown probes are rejected and remember/authorize distinguished per probe', () => {
  assert.throws(() => validateProjectSettings({ ...settings('cmsis-dap'), probe: 'black-magic' }), /debug probe type/i);
  assert.throws(() => validateAuthorization({ ...authorizationFrom(settings('cmsis-dap'), hash), probe: 'ftdi' }), /debug probe type/i);

  const accepted = authorizationFrom(settings('st-link'), hash);
  assert.equal(accepted.probe, 'st-link');
  assert.equal(authorizationMatches(settings('st-link'), accepted, hash), true);
  assert.equal(authorizationMatches(settings('cmsis-dap'), accepted, hash), false);

  const older = { ...accepted }; delete older.probe;
  assert.equal(authorizationMatches(settings('cmsis-dap'), older, hash), true);
  assert.equal(authorizationMatches(settings('jlink'), older, hash), false);
});

test('shared configuration persists the probe and defaults older files to CMSIS-DAP', async () => {
  const root = await fs.mkdtemp(path.resolve('.cache/probe-share-')), uri = pathToFileURL(root).toString();
  const value = { ...settings('st-link'), projectUri: uri, sourceDirectory: root };
  const portable = await portableConfiguration(value);
  assert.equal(JSON.parse(portable.text).probe, 'st-link');
  assert.equal(portable.settings.probe, 'st-link');
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.resolve('.cache/probe-dap-')), source = path.join(root, 'source');
  const scripts = path.join(root, 'scripts');
  await fs.mkdir(source); await fs.mkdir(path.join(scripts, 'target'), { recursive: true });
  await fs.writeFile(path.join(scripts, 'target/stm32f4x.cfg'), 'reset_config none');
  return { root, source, scripts };
}
function runtime(scripts, executable, probe) {
  return { tools: [{ id: 'openocd', executables: { openocd: executable }, scriptsDirectory: scripts }], guard() {}, log() {},
    trustScript: async () => true, verify: async () => {}, probe };
}

test('openocd capability check probes the selected probe and detects the dialect', async () => {
  const f = await fixture(), executable = path.join(f.root, 'openocd.exe');
  const calls = [], st = { ...settings('st-link', { projectUri: pathToFileURL(f.source).toString(), sourceDirectory: f.source }) };
  const run = async request => {
    calls.push(request.args);
    return { exitCode: calls.length === 1 ? 1 : 0, timedOut: false, cancelled: false };
  };
  const resolved = await resolveDapConfiguration(st, new AbortController().signal, runtime(f.scripts, executable, run));
  assert.equal(resolved.dialect, 'legacy');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('adapter driver st-link')); assert.ok(calls[0].includes('transport select swd'));
  assert.equal(calls[0].includes('-s'), true);
  assert.ok(calls[1].includes('source [find interface/stlink.cfg]')); assert.ok(calls[1].includes('transport select hla_swd'));
  assert.equal(calls[0].some(value => value.includes('cmsis-dap')), false);
  await fs.rm(f.root, { recursive: true, force: true });
});

test('openocd capability check reports an unsupported probe when every dialect fails', async () => {
  const f = await fixture(), executable = path.join(f.root, 'openocd.exe');
  const jl = { ...settings('jlink', { projectUri: pathToFileURL(f.source).toString(), sourceDirectory: f.source }) };
  await assert.rejects(resolveDapConfiguration(jl, new AbortController().signal,
    runtime(f.scripts, executable, async () => ({ exitCode: 1, timedOut: false, cancelled: false }))), /selected probe/i);
  await fs.rm(f.root, { recursive: true, force: true });
});

test('J-Link legacy capability check fails clearly instead of probing without a serial', async () => {
  const f = await fixture(), executable = path.join(f.root, 'openocd.exe');
  const jl = { ...settings('jlink', { serial: 'JL-1', projectUri: pathToFileURL(f.source).toString(), sourceDirectory: f.source }) };
  const calls = [];
  await assert.rejects(resolveDapConfiguration(jl, new AbortController().signal, runtime(f.scripts, executable, async request => {
    calls.push(request.args);
    return { exitCode: 1, timedOut: false, cancelled: false };
  })), /J-Link/);
  assert.equal(calls.length, 1);
  await fs.rm(f.root, { recursive: true, force: true });
});
