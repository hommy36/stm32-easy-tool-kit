const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { optimizationLevels, optimizationLevel, optimizationConfigureArgs, verifyOptimization } = require('../out/build/optimization');
const { validateFeatures } = require('../out/project/features');
const { validateConsoleMessage } = require('../out/ui/consoleProtocol');

test('optimization accepts only known flags in features and webview messages', () => {
  for (const value of optimizationLevels) {
    assert.equal(validateFeatures({ version: 1, build: { optimization: value } }).build.optimization, value);
    assert.equal(validateConsoleMessage({ type:'action', action:'optimization', projectUri:'file:///demo', revision:1, snapshotRevision:1, featureRevision:'a'.repeat(64), value }).value, value);
  }
  for (const value of ['O4','-O2','O2;message(FATAL_ERROR nope)',null,{},1]) {
    assert.throws(() => optimizationLevel(value));
    assert.throws(() => validateFeatures({ version:1, build:{optimization:value} }));
  }
  assert.throws(() => validateFeatures({ version:1, build:{flags:'-O2'} }));
  assert.throws(() => validateConsoleMessage({ type:'action', action:'optimization', projectUri:'file:///demo', revision:1, snapshotRevision:1, value:'O2' }));
});

test('default leaves untouched builds alone and override hooks preserve build type', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-optimization-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const selection = { binaryDirectory:root, optimization:'default' };
  assert.deepEqual(await optimizationConfigureArgs(selection), []);
  assert.deepEqual(await fs.readdir(root), []);
  selection.optimization='O2';
  const args = await optimizationConfigureArgs(selection);
  const hook = path.join(root,'.stm32-easy-optimization/project.cmake');
  const script = await fs.readFile(hook,'utf8');
  assert.ok(!script.includes('CMAKE_BUILD_TYPE'));
  assert.ok(script.includes('LINK_EXECUTABLE'));
  const stat = await fs.stat(hook);
  assert.deepEqual(await optimizationConfigureArgs(selection),args);
  assert.equal((await fs.stat(hook)).mtimeMs,stat.mtimeMs);
  selection.optimization='default';await optimizationConfigureArgs(selection);
  assert.ok(!(await fs.readFile(hook,'utf8')).includes(' -O2'));
  assert.match(await fs.readFile(args[1],'utf8'),/unset\(_STM32_EASY_ORIGINAL_PROJECT_INCLUDE CACHE\)/);
  await fs.writeFile(hook,'user owned content');
  await assert.rejects(optimizationConfigureArgs(selection));
  assert.equal(await fs.readFile(hook,'utf8'),'user owned content');
});

test('effective flags are verified; later conflicting source flags cannot silently win', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'stm32-opt-commands-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const selection={binaryDirectory:root,optimization:'Os'};
  const write=entries=>fs.writeFile(path.join(root,'compile_commands.json'),JSON.stringify(entries));
  await write([{file:'main.c',command:'gcc -O2 @flags.rsp -o main.o -c main.c -Os'},{file:'startup.s',command:'gcc -c startup.s'}]);
  await verifyOptimization(selection);
  await write([{file:'main.cpp',arguments:['g++','-Os','-c','main.cpp','-Ofast']}]);
  await assert.rejects(verifyOptimization(selection));
  await write([{file:'startup.s',command:'gcc -c startup.s'}]);
  await assert.rejects(verifyOptimization(selection));
  await verifyOptimization({...selection,optimization:'default'});
});
