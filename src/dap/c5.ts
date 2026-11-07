import { t } from '../i18n';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

// Pinned EmberProbe commit 5e6fb45, ST reviews 9697/8 and 9699/6, DFP 2.1.0.
export const c5Files: ReadonlyArray<readonly [string, string]> = [
  ['target/stm32c5x.cfg', '9f38050ff1a8751e1d16b9aa44a65dea3066f656b327cc2cb08db0d224731366'],
  ['flash_loaders/stm32c5/STM32C53x_C54x.xldr', '4645574f274f5274de869dbd2a6b35fd79d134f7ec07224c3f17ed2d40c7b8b6'],
  ['flash_loaders/stm32c5/STM32C55x_C56x.xldr', '131784c2e4eb4589200b614e56b83abd21a34906c1fd485ca3d806378d28732d'],
  ['flash_loaders/stm32c5/STM32C59x_C5Ax.xldr', 'b9aacec837613f273b0d88fb3ca41c5c52712752fd26271959dd03a41dab8e53']
];

export function isC5Target(settings: { chipLabel?: string; targetScript?: string }): boolean {
  return /^STM32C5/i.test(settings.chipLabel ?? '') || /(?:^|[\\/])stm32c5x\.cfg$/i.test(settings.targetScript ?? '');
}

// OpenOCD invokes target events in a local Tcl frame. The pinned upstream body
// references these top-level variables without importing them into that frame.
// Apply after sourcing the verified target; leave installed/vendor files intact.
export const c5EventScopeCommand = 'stm32c5x.cpu configure -event examine-end [format {global _CHIPNAME dev_id_loader EXAMINED\n%s} [stm32c5x.cpu cget -event examine-end]]';

/** Support is deliberately limited to the reviewed local-loader configuration. */
export async function verifyC5Files(scripts: string, target?: string): Promise<void> {
  try {
    if (target && (await fs.realpath(target)).toLowerCase() !== (await fs.realpath(path.join(scripts, c5Files[0][0]))).toLowerCase()) {
      throw new Error('Unsupported C5 target configuration.');
    }
    for (const [relative, expected] of c5Files) {
      const file = path.join(scripts, relative), stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 1048576) throw new Error(relative);
      if (createHash('sha256').update(await fs.readFile(file)).digest('hex') !== expected) throw new Error(relative);
    }
  } catch {
    throw new Error(t('STM32C5 配置或本地 Flash loader 缺失/不匹配。请在工具管理中安装“STM32C5 实验支持”，并使用其 target/stm32c5x.cfg；不能仅复制脚本或改用 F4/U5 配置。'));
  }
}

// Configuration only. Explicit shutdown prevents OpenOCD's implicit init.
export const c5CheckCommands = [
  'if {[llength [info commands stldr]] == 0} {error "STM32C5 requires the stldr flash driver"}',
  'if {[adapter name] eq "hla"} {error "STM32C5 requires a direct DAP adapter"}',
  'if {[lsearch -exact [target names] stm32c5x.cpu] < 0} {error "STM32C5 CPU target missing"}',
  'if {[string first {global _CHIPNAME dev_id_loader EXAMINED} [stm32c5x.cpu cget -event examine-end]] != 0} {error "STM32C5 event scope fix missing"}',
  'echo STM32_EASY_C5_READY', 'shutdown'
];
