// Real CMake / Arm GNU integration, isolated fixture; never accesses a probe.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { optimizationConfigureArgs, verifyOptimization } = require('../out/build/optimization');
const { commandWords } = require('../out/build/dependencies');

async function main() {
  const cmake = process.env.STM32_TEST_CMAKE || 'cmake';
  const gcc = process.env.STM32_TEST_GCC || 'D:/STM32CubeCLT_1.18.0/GNU-tools-for-STM32/bin/arm-none-eabi-gcc.exe';
  const gpp = gcc.replace(/gcc(\.exe)?$/, 'g++$1');
  const root = await fs.mkdtemp(path.resolve('.cache/optimization smoke 中文-'));
  const source = path.join(root, 'source'), binary = path.join(root, 'build');
  await fs.mkdir(path.join(source, 'lib'), { recursive: true });
  await fs.writeFile(path.join(source, 'original.cmake'), 'add_compile_definitions(KEEP_HOOK=1)\n');
  await fs.writeFile(path.join(source, 'CMakeLists.txt'), `cmake_minimum_required(VERSION 3.20)
project(fixture C CXX)
if(NOT CMAKE_BUILD_TYPE STREQUAL "debug_GCC_CHIP")
  message(FATAL_ERROR "Build type was changed")
endif()
set(CMAKE_C_FLAGS "-O2 -g -mcpu=cortex-m33 -mthumb")
set(CMAKE_CXX_FLAGS "-O2 -g -mcpu=cortex-m33 -mthumb")
add_executable(fixture main.c)
target_compile_options(fixture PRIVATE -Og)
set_source_files_properties(main.c PROPERTIES COMPILE_OPTIONS "-O0")
target_link_options(fixture PRIVATE -O3 --specs=nosys.specs)
add_subdirectory(lib)
target_link_libraries(fixture PRIVATE nested)
`);
  await fs.writeFile(path.join(source, 'main.c'), '#ifndef KEEP_HOOK\n#error lost include hook\n#endif\nint nested(void); int main(void) { return nested(); }\n');
  await fs.writeFile(path.join(source, 'lib/CMakeLists.txt'), 'project(nested CXX)\nadd_library(nested STATIC nested.cpp)\ntarget_compile_options(nested PRIVATE -Os)\nset_source_files_properties(nested.cpp PROPERTIES COMPILE_OPTIONS "-O1")\n');
  await fs.writeFile(path.join(source, 'lib/nested.cpp'), 'extern "C" int nested(void) { volatile int n=2; return n*7; }\n');
  await fs.writeFile(path.join(source, 'CMakePresets.json'), JSON.stringify({ version: 3, configurePresets: [{ name: 'debug_GCC_CHIP', generator: 'Ninja', binaryDir: binary.replace(/\\/g,'/'), cacheVariables: {
    CMAKE_BUILD_TYPE: '${presetName}', CMAKE_TRY_COMPILE_TARGET_TYPE: 'STATIC_LIBRARY', CMAKE_SYSTEM_NAME: 'Generic', CMAKE_C_COMPILER: gcc, CMAKE_CXX_COMPILER: gpp, CMAKE_PROJECT_INCLUDE: '${sourceDir}/original.cmake', CMAKE_EXPORT_COMPILE_COMMANDS: true
  }}] }));
  const run = args => execFileSync(cmake, args, { cwd: source, encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['ignore','pipe','pipe'] });
  const selection = { sourceDirectory: source, binaryDirectory: binary };
  for (const level of ['default','O0','Og','O1','O2','O3','Os','Oz','default']) {
    selection.optimization = level;
    run(['--preset', 'debug_GCC_CHIP', ...await optimizationConfigureArgs(selection)]);
    await verifyOptimization(selection);
    const entries = JSON.parse(await fs.readFile(path.join(binary, 'compile_commands.json'), 'utf8'));
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      const flags = commandWords(entry.command).filter(word => /^-O/.test(word));
      assert.equal(flags.at(-1), level === 'default' ? entry.file.endsWith('.cpp') ? '-O1' : '-O0' : `-${level}`);
      assert.ok(entry.command.includes('-g'), 'debug info retained');
    }
    run(['--build', binary]);
    const cache = await fs.readFile(path.join(binary, 'CMakeCache.txt'), 'utf8');
    assert.match(cache, /CMAKE_BUILD_TYPE:STRING=debug_GCC_CHIP/);
    assert.ok(cache.includes('original.cmake'), 'existing include preserved');
    if (level === 'default') assert.ok(!cache.split('\n').find(line => line.startsWith('CMAKE_PROJECT_INCLUDE:')).includes('.stm32-easy-optimization'));
    console.log(`PASS ${level}: C/C++, nested project, per-source flags, existing hook, real Arm build`);
  }
  // Defaults also restore correctly when the original hook was supplied only by cache.
  selection.optimization = 'O2'; run(['-S', source, '-B', binary, ...await optimizationConfigureArgs(selection)]);
  selection.optimization = 'default'; run(['-S', source, '-B', binary, ...await optimizationConfigureArgs(selection)]);
  const restored = await fs.readFile(path.join(binary, 'CMakeCache.txt'), 'utf8');
  assert.ok(!restored.split('\n').find(line => line.startsWith('CMAKE_PROJECT_INCLUDE:')).includes('.stm32-easy-optimization'));
  console.log('PASS cache-only hook restoration');
  await fs.writeFile('.cache/optimization-smoke-latest.json', JSON.stringify({ root, cmake, gcc, levels: ['default','O0','Og','O1','O2','O3','Os','Oz','default'] }, null, 2));
}
main().catch(error => { console.error(error.stderr?.toString() || error); process.exitCode = 1; });
