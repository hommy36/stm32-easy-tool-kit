import { t } from '../i18n';
import { runJob } from '../core/jobProcess';
import { mergeToolPath, toolBinDirectories } from '../core/paths';
import { BuildEvidence, inspectArmElf } from '../build/artifacts';
import { BuildCancelled, ProcessTreeUncertain } from '../build/service';
import { ProjectSettings } from '../project/types';
import { DapRuntime, buildFlashArgs, resolveDapConfiguration, scriptFingerprint } from './config';

export async function flashFirmware(evidence: BuildEvidence, settings: ProjectSettings, signal: AbortSignal, runtime: DapRuntime): Promise<void> {
  const configuration = await resolveDapConfiguration(settings, signal, runtime);
  await runtime.verify(evidence);
  runtime.guard();
  if (signal.aborted) throw new BuildCancelled();
  if ((await inspectArmElf(evidence.artifact)).sha256 !== evidence.artifactSha256) throw new Error(t("ELF 已变化，拒绝下载"));
  if (await scriptFingerprint(configuration.targetScript) !== configuration.targetSha256) throw new Error(t("OpenOCD 目标脚本已变化，请重新确认"));
  const args = buildFlashArgs({ ...settings, targetScript: configuration.targetScript }, configuration.scriptsDirectory,
    evidence.artifact, configuration.dialect);
  let evidenceLog = '';
  runtime.log('stdout', t("\n[OpenOCD] 烧录并校验，随后复位运行目标。中断可能留下不完整固件。\n"));
  const result = await (runtime.runner ?? runJob)({ executable: configuration.executable, args, cwd: settings.sourceDirectory,
    env: mergeToolPath(process.env, toolBinDirectories(runtime.tools)), timeoutMs: 120000, signal,
    onOutput: (stream, text) => { runtime.log(stream, text); evidenceLog = (evidenceLog + text).slice(-524288); } });
  if (!result.treeExited) throw new ProcessTreeUncertain(t("无法确认 OpenOCD 已退出，保留探针占用；Flash 可能不完整"));
  if (signal.aborted || result.reason === 'cancelled') throw new Error(t("下载已取消，Flash 可能不完整；请在安全状态下重新完整下载"));
  if (result.reason !== 'exit' || result.exitCode !== 0) throw new Error(t("OpenOCD 下载{0} ({1}): {2}", result.reason === 'timeout' ? t("超时") : t("失败"), result.exitCode ?? t("无退出码"), result.error ?? evidenceLog.slice(-4096)));
  const programming = evidenceLog.indexOf('** Programming Started **');
  const programmed = evidenceLog.indexOf('** Programming Finished **', programming + 1);
  const verifying = evidenceLog.indexOf('** Verify Started **', programmed + 1);
  const verified = evidenceLog.indexOf('** Verified OK **', verifying + 1);
  if (programming < 0 || programmed < 0 || verifying < 0 || verified < 0) throw new Error(t("OpenOCD 已退出，但缺少本次完整编程/校验证据，不报告下载成功"));
}
