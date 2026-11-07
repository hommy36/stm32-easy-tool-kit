const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {existingToolCandidates} = require('../out/tools/existing');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-tools-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}
async function managed(base, id, version, instance, executable, nested = '') {
  const root = path.join(base, id, version, instance), bin = path.join(root, nested);
  await fs.mkdir(bin, {recursive: true});
  await fs.writeFile(path.join(bin, executable), 'not executable: discovery must never launch this');
  await fs.writeFile(path.join(root, 'stm32-easy-installation.json'), JSON.stringify({id, version, installationId: instance, sha256: 'a'.repeat(64)}));
  return {root, bin};
}
test('existing tools includes default/custom downloads, older versions and PATH without executing them', async t => {
  const root = await fixture(t), standard = path.join(root, 'default'), custom = path.join(root, 'custom');
  const a = await managed(standard, 'cmake', '3.31.8', 'one', 'cmake.exe', 'cmake-3.31.8-windows-x86_64/bin');
  const b = await managed(custom, 'cmake', '3.30.0', 'two', 'cmake.exe', 'older-package/bin');
  const external = path.join(root, 'external'); await fs.mkdir(external); await fs.writeFile(path.join(external, 'cmake.exe'), '');
  const found = await existingToolCandidates('cmake', [standard, custom, standard], undefined, ()=>{}, async()=>[a.bin, external]);
  assert.equal(found.length, 3);
  assert.deepEqual(found.filter(x=>x.source==='managed').map(x=>x.version).sort(), ['3.30.0','3.31.8']);
  assert.equal(found.find(x=>x.root===a.bin).installationRoot, a.root);
  assert.equal(found.find(x=>x.root===b.bin).source, 'managed');
});
test('flat Ninja package and current installation outside configured roots are selectable', async t => {
  const root = await fixture(t), base = path.join(root, 'download');
  const ninja = await managed(base, 'ninja', '1.12.1', 'one', 'ninja.exe');
  const active = {id:'ninja', root:ninja.root, source:'managed', version:'1.12.1', executables:{ninja:path.join(ninja.bin,'ninja.exe')}};
  const found = await existingToolCandidates('ninja', [path.join(root,'missing')], active, ()=>{}, async()=>[ninja.bin]);
  assert.equal(found.length, 1); assert.equal(found[0].current, true); assert.equal(found[0].source, 'managed');
  assert.equal(found[0].installationRoot, ninja.root);
});
test('incomplete/staging/corrupt installations are excluded without losing valid packages', async t => {
  const root = await fixture(t);
  const valid = await managed(root, 'ninja', '1', 'good', 'ninja.exe');
  await managed(root, 'ninja', '1', '.staging-incomplete', 'ninja.exe');
  const broken = await managed(root, 'ninja', '1', 'broken', 'ninja.exe');
  await fs.writeFile(path.join(broken.root,'stm32-easy-installation.json'),'{');
  const missing = await managed(root, 'ninja', '1', 'missing', 'ninja.exe');
  await fs.rm(path.join(missing.bin, 'ninja.exe'));
  await managed(root, 'cmake', '1', 'wrong-tool', 'cmake.exe');
  const found = await existingToolCandidates('ninja', [root], undefined, ()=>{}, async()=>[]);
  assert.equal(found.length, 1); assert.equal(found[0].root, valid.bin);
});
test('active managed installation sorts first and is not relabeled external through PATH', async t => {
  const root = await fixture(t);
  await managed(root, 'openocd', '1', 'a', 'openocd.exe', 'xpack-a/bin');
  const b = await managed(root, 'openocd', '2', 'b', 'openocd.exe', 'xpack-b/bin');
  const active = {id:'openocd', root:b.root, source:'managed', version:'2', executables:{openocd:path.join(b.bin,'openocd.exe')}};
  const found = await existingToolCandidates('openocd', [root], active, ()=>{}, async()=>[b.bin]);
  assert.equal(found.length, 2); assert.equal(found[0].current,true); assert.equal(found[0].source,'managed');
});
