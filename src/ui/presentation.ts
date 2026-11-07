import { t } from '../i18n';
import { CheckResult, ToolId, toolNames } from '../core/types';
import { ProjectSettings } from '../project/types';

export type Repair = 'setup' | 'tools' | 'dap' | 'cortex' | 'problems' | 'reload' | 'log';
export interface Availability { enabled: boolean; reason: string; repair?: Repair; }
export interface ToolSummary {
  id: ToolId; name: string; root?: string; version?: string; source?: string;
  available: boolean; status: string; checks: CheckResult[];
}
export function cortexCompatible(version: unknown): boolean {
  const match = typeof version === 'string' ? /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(version) : null;
  return !!match && +match[1] === 1 && (+match[2] > 12 || +match[2] === 12 && +match[3] >= 1);
}
export function capabilities(input: {
  settings?: ProjectSettings; cmakeProject: boolean; tools: ToolSummary[];
  busy: boolean; trusted: boolean; supported: boolean; cortex: boolean; artifact?: string;
}): { build: Availability; flash: Availability; debug: Availability } {
  const blocked = (reason: string, repair?: Repair): Availability => ({ enabled: false, reason, repair });
  let build: Availability = { enabled: true, reason: t("保存并编译；必要时自动配置 CMake") };
  if (!input.supported) build = blocked(t("请在 Windows x64 本地 VS Code 中使用"));
  else if (!input.trusted) build = blocked(t("请先通过 VS Code 管理工作区信任"));
  else if (input.busy) build = blocked(t("当前操作尚未结束"));
  else if (!input.settings) build = blocked(t("请先选择工程"), 'setup');
  else if (!input.cmakeProject) build = blocked(t("源码目录没有 CMakeLists.txt，请选择已有 CMake 工程"), 'setup');
  else {
    const missing = (['armGnu', 'cmake', 'ninja'] as ToolId[]).filter(id => !input.tools.some(tool => tool.id === id && tool.available));
    if (missing.length) build = blocked(t("请配置 {0}", missing.map(id => toolNames[id]).join(', ')), 'tools');
  }
  let flash: Availability = { enabled: true, reason: t("先编译，再烧录、校验并复位运行") };
  if (!build.enabled) flash = build;
  else if (!input.tools.some(tool => tool.id === 'openocd' && tool.available)) flash = blocked(t("请配置 OpenOCD"), 'tools');
  else if (!input.settings?.targetScript) flash = /^STM32C5/i.test(input.settings?.chipLabel ?? '')
    ? blocked(t('当前 OpenOCD 缺少 C5 配置；请在工具管理 → OpenOCD → 安装中选择“STM32C5 实验支持”。'), 'tools')
    : blocked(t('请自动识别或选择芯片配置脚本'), 'dap');
  let debug: Availability = { enabled: true, reason: t("先编译，再启动原生调试") };
  if (!flash.enabled) debug = flash;
  else if (!input.cortex) debug = blocked(t("请安装 Cortex-Debug 1.12.1 或兼容的 1.x"), 'cortex');
  else if ([input.settings?.sourceDirectory, input.artifact].some(file => file && /[^\x20-\x7e]/.test(file))) debug = blocked(t("当前 GDB 调试要求源码和 ELF 使用 ASCII 路径；编译、烧录仍可使用"), 'log');
  return { build, flash, debug };
}
export function repairForError(message: string): Repair {
  if (/Cortex-Debug/.test(message)) return 'cortex';
  if (/Arm/.test(message) && /编译器路径不一致|所选 Arm GCC|Arm compiler paths differ|selected Arm GCC/i.test(message)) return 'tools';
  if (/CMake/.test(message) && /\$<QUOTE>/.test(message)) return 'tools';
  if (/页面已过期|另一窗口|版本|重新加载|stale|another window|revision|reload/i.test(message) && /设置|页面|工程|settings|page|project/i.test(message)) return 'reload';
  if (/芯片|target 脚本|芯片配置脚本|chip|target script/i.test(message)) return 'dap';
  if (/安装|工具链|工具环境|尚未配置|工具.*失效|缺少.*工具|install|toolchain|tool environment|tool.*(?:missing|unavailable)|missing.*tool/i.test(message)) return 'tools';
  if (/编译失败|构建失败|build.*failed|error:|undefined reference/i.test(message)) return 'problems';
  if (/CMakeLists|Presets|构建方案|Configure Preset/i.test(message)) return 'setup';
  return 'log';
}
export function repairLabel(repair: Repair): string {
  const labels: Record<Repair, string> = {
  setup: t("配置工程"), tools: t("管理工具"), dap: t("设置烧录与调试"), cortex: t("安装 / 更新 Cortex-Debug"),
  problems: t("查看问题"), reload: t("重新加载设置"), log: t("查看构建日志")
  };
  return labels[repair];
}
