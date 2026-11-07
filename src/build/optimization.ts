import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { t } from '../i18n';
import { commandWords } from './dependencies';
import { ResolvedSelection } from './presets';

export const optimizationLevels = ['default', 'O0', 'Og', 'O1', 'O2', 'O3', 'Os', 'Oz'] as const;
export type OptimizationLevel = typeof optimizationLevels[number];
export function optimizationLevel(value: unknown): OptimizationLevel {
  if (typeof value !== 'string' || !optimizationLevels.includes(value as OptimizationLevel)) throw new Error(t('无效的优化等级'));
  return value as OptimizationLevel;
}

const marker = '# STM32 Easy Tool Kit optimization hook v1\n';
async function writeOwned(file: string, contents: string): Promise<void> {
  try {
    const old = await fs.readFile(file, 'utf8');
    if (!old.startsWith(marker)) throw new Error(t('优化配置文件已被替换，请使用新的构建目录：{0}', file));
    if (old === contents) return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await fs.writeFile(file, contents);
}

/** Append to the compiler rule, after target AND source flags (including response files).
 * Keep the preset's build type, toolchain, defines, debug info and existing include hooks.
 * The generated hook also survives CMake's automatic regeneration during a build. */
export async function optimizationConfigureArgs(selection: ResolvedSelection): Promise<string[]> {
  const level = optimizationLevel(selection.optimization ?? 'default');
  const directory = path.join(selection.binaryDirectory, '.stm32-easy-optimization');
  const hook = path.join(directory, 'project.cmake'), preload = path.join(directory, 'preload.cmake');
  if (level === 'default') {
    try { await fs.access(hook); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  if (/[;\r\n\[\]]/.test(directory)) throw new Error(t('优化覆盖不支持此构建目录路径：{0}', directory));
  await fs.mkdir(directory, { recursive: true });
  let script = marker + `if(_STM32_EASY_ORIGINAL_PROJECT_INCLUDE)
  foreach(_stm32_original IN LISTS _STM32_EASY_ORIGINAL_PROJECT_INCLUDE)
    include("\${_stm32_original}")
  endforeach()
  unset(_stm32_original)
endif()
`;
  if (level !== 'default') script += `
foreach(_stm32_lang C CXX)
  if(CMAKE_\${_stm32_lang}_COMPILER_LOADED)
    if(NOT CMAKE_\${_stm32_lang}_COMPILER_ID MATCHES "^(GNU|Clang)$")
      message(FATAL_ERROR "STM32 Easy optimization override requires GNU or Clang; select Default for this compiler.")
    endif()
    foreach(_stm32_rule COMPILE_OBJECT LINK_EXECUTABLE CREATE_SHARED_LIBRARY CREATE_SHARED_MODULE)
      set(_stm32_key "CMAKE_\${_stm32_lang}_\${_stm32_rule}")
      if(DEFINED \${_stm32_key})
        list(LENGTH \${_stm32_key} _stm32_count)
        if(NOT _stm32_count EQUAL 1)
          message(FATAL_ERROR "STM32 Easy cannot override a multi-command compiler rule; select Default.")
        endif()
        if(NOT "\${\${_stm32_key}}" MATCHES " -${level}$")
          string(APPEND \${_stm32_key} " -${level}")
        endif()
      endif()
    endforeach()
  endif()
endforeach()
unset(_stm32_lang)
unset(_stm32_rule)
unset(_stm32_key)
unset(_stm32_count)
`;
  await writeOwned(hook, script);
  const hookPath = hook.replace(/\\/g, '/');
  // CMake < 3.29 accepts only one project include, so chain the original through ours.
  // -C sees the current preset cache values, including updates since the previous run.
  const restore = `if("\${CMAKE_PROJECT_INCLUDE}" STREQUAL [=[${hookPath}]=])
  if(_STM32_EASY_ORIGINAL_PROJECT_INCLUDE)
    set(CMAKE_PROJECT_INCLUDE "\${_STM32_EASY_ORIGINAL_PROJECT_INCLUDE}" CACHE STRING "Project include hook" FORCE)
  else()
    unset(CMAKE_PROJECT_INCLUDE CACHE)
    unset(CMAKE_PROJECT_INCLUDE)
  endif()
endif()
unset(_STM32_EASY_ORIGINAL_PROJECT_INCLUDE CACHE)
`;
  const install = `if(NOT "\${CMAKE_PROJECT_INCLUDE}" STREQUAL [=[${hookPath}]=])
  set(_STM32_EASY_ORIGINAL_PROJECT_INCLUDE "\${CMAKE_PROJECT_INCLUDE}" CACHE INTERNAL "Original project include" FORCE)
endif()
set(CMAKE_PROJECT_INCLUDE [=[${hookPath}]=] CACHE STRING "Project include hook" FORCE)
`;
  await writeOwned(preload, marker + (level === 'default' ? restore : install));
  return ['-C', preload];
}

/** Fail explicitly if a custom project overwrote our rule after project(). */
export async function verifyOptimization(selection: ResolvedSelection): Promise<void> {
  const level = optimizationLevel(selection.optimization ?? 'default');
  if (level === 'default') return;
  const file = path.join(selection.binaryDirectory, 'compile_commands.json');
  if ((await fs.stat(file)).size > 64 * 1024 * 1024) throw new Error(t('编译命令数据库过大，无法确认优化等级'));
  const entries: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(entries)) throw new Error(t('无法确认实际编译优化等级'));
  let checked = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.file !== 'string' || !/\.(?:c|cc|cpp|cxx|c\+\+)$/i.test(entry.file)) continue;
    const words = Array.isArray(entry.arguments) ? entry.arguments : commandWords(entry.command);
    const actual = words.filter((word: unknown) => typeof word === 'string' && /^-O(?:[0-3sgz]|fast)?$/.test(word)).at(-1);
    if (actual !== `-${level}`) throw new Error(t('工程覆盖了优化参数，未能应用 -{0}：{1}。请选择默认或检查自定义编译规则。', level, entry.file));
    checked++;
  }
  if (!checked) throw new Error(t('没有可验证的 C/C++ 编译命令，无法应用优化覆盖'));
}
