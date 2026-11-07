import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { runProcess } from '../core/process';
import { CheckResult, ToolInstallation, errorText } from '../core/types';
import { probeLabel } from '../project/types';
import { c5CheckCommands, verifyC5Files, c5EventScopeCommand } from '../dap/c5';

export async function checkInstallation(tool: ToolInstallation, signal?: AbortSignal): Promise<CheckResult[]> {
  signal?.throwIfAborted();
  const checks: CheckResult[] = [];
  for (const [name, executable] of Object.entries(tool.executables)) {
    signal?.throwIfAborted();
    let valid = false;
    try { valid = path.isAbsolute(executable) && (await fs.stat(executable)).isFile(); } catch (error) {
      checks.push({ code: 'file', status: 'error', summary: t("工具文件不可访问: {0}", name), evidence: [executable, errorText(error)] });
      continue;
    }
    if (!valid) { checks.push({ code: 'file', status: 'error', summary: t("工具路径必须指向绝对 exe 文件"), evidence: [executable] }); continue; }
    const result = await runProcess({ executable, args: ['--version'], timeoutMs: 10000, signal });
    const evidence = [result.stdout.trim() || result.stderr.trim(), executable];
    const success = result.exitCode === 0 && !result.timedOut && !result.cancelled;
    checks.push({ code: name === Object.keys(tool.executables)[0] ? 'version' : `version.${name}`,
      status: success ? 'ok' : 'error', summary: success ? t("{0} 可运行", name) : t("{0} 无法运行（退出码 {1}）", name, result.exitCode),
      evidence: success ? evidence : [...evidence, result.stderr, result.timedOut ? t("执行超时") : t("请检查 DLL 和安装完整性")] });
  }
  if (tool.id === 'armGnu' && tool.executables.gcc) {
    const result = await runProcess({ executable: tool.executables.gcc, args: ['-dumpmachine'], timeoutMs: 10000, signal });
    checks.push({ code: 'target', status: result.exitCode === 0 && result.stdout.trim() === 'arm-none-eabi' ? 'ok' : 'error', summary: t("编译器目标必须为 arm-none-eabi"), evidence: [result.stdout.trim(), result.stderr] });
  }
  if (tool.id === 'openocd') {
    if (tool.version === '0.12.0-7-emberprobe-c5.5e6fb45') {
      try {
        if (!tool.scriptsDirectory) throw new Error('Missing scripts directory');
        await verifyC5Files(tool.scriptsDirectory);
        const result = await runProcess({ executable: tool.executables.openocd,
          args: ['-s', tool.scriptsDirectory, '-c', 'adapter driver cmsis-dap', '-c', 'transport select swd', '-f', 'target/stm32c5x.cfg', '-c', c5EventScopeCommand,
            ...c5CheckCommands.flatMap(command => ['-c', command])], timeoutMs: 10000, signal });
        const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled && `${result.stdout}\n${result.stderr}`.includes('STM32_EASY_C5_READY');
        checks.push({ code: 'c5', status: ok ? 'ok' : 'error', summary: t('STM32C5 stldr 与本地 loader 配置检查（不连接硬件）'), evidence: [result.stdout, result.stderr] });
      } catch (error) {
        checks.push({ code: 'c5', status: 'error', summary: t('STM32C5 组件检查失败'), evidence: [errorText(error)] });
      }
    }
    const scripts: [string, string][] = [['cmsis-dap', 'interface/cmsis-dap.cfg'], ['st-link', 'interface/stlink.cfg'], ['jlink', 'interface/jlink.cfg']];
    let complete = true;
    for (const [probe, relative] of scripts) {
      const script = tool.scriptsDirectory ? path.join(tool.scriptsDirectory, relative) : '';
      let found = false;
      try { found = Boolean(script) && (await fs.stat(script)).isFile(); } catch (error) {
        checks.push({ code: `scripts.${probe}`, status: 'error', summary: t("OpenOCD 脚本不可访问"), evidence: [errorText(error)] });
      }
      if (!found) complete = false;
      checks.push({ code: `scripts.${probe}.found`, status: found ? 'ok' : 'warning',
        summary: found ? t("找到 {0} 接口脚本", relative) : t("缺少 {0} 接口脚本", relative), evidence: [script] });
    }
    if (complete) {
      for (const probe of ['cmsis-dap', 'st-link', 'jlink'] as const) {
        const result = await runProcess({ executable: tool.executables.openocd, args: ['-c', `adapter driver ${probe}`, '-c', 'shutdown'], timeoutMs: 10000, signal });
        checks.push({ code: `adapter.${probe}`, status: result.exitCode === 0 ? 'ok' : 'error',
          summary: t("{0} 驱动配置能力{1}", probeLabel(probe), result.exitCode === 0 ? t("可用") : t("不可用")),
          evidence: [result.stdout, result.stderr] });
      }
      for (const backend of ['hid', 'usb_bulk']) {
        const result = await runProcess({ executable: tool.executables.openocd,
          args: ['-c', 'adapter driver cmsis-dap', '-c', `cmsis_dap_backend ${backend}`, '-c', 'shutdown'], timeoutMs: 10000, signal });
        checks.push({ code: `dap.${backend}`, status: result.exitCode === 0 ? 'ok' : 'error',
          summary: t("CMSIS-DAP {0} 配置能力{1}", backend, result.exitCode === 0 ? t("可用") : t("不可用")),
          evidence: [result.stdout, result.stderr] });
      }
    }
    checks.push({ code: 'hardware', status: 'unverified', summary: t("探针与目标芯片通信未验证"), evidence: [t("软件配置检查不会打开探针、复位或烧录目标。")] });
  }
  if (tool.source === 'external') checks.push({ code: 'compatibility', status: 'warning', summary: t("外部安装未纳入固定版本组合认证"), evidence: [t("可运行性已单独检查，硬件兼容性需按实际组合验证。")] });
  return checks;
}
