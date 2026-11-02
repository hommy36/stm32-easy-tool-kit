import { t } from '../i18n';
import { DapBackend, ToolInstallation } from '../core/types';

export function tclWord(value: string): string {
  if (/[\r\n\x00]/.test(value)) throw new Error(t("参数不能包含换行或空字符"));
  return `"${value.replace(/([\\"$\[\]])/g, '\\$1')}"`;
}

export function dapGuide(tool: ToolInstallation | undefined, backend: DapBackend, serial: string): string {
  return [
    t("# 调试探针支持（DAPLink / ST-Link / J-Link）"), '',
    t("本插件只准备工具，不生成/修改你的工程，也不自动连接或烧录目标。"), '',
    t("## 当前选择"),
    `OpenOCD: ${tool?.executables.openocd ?? t("尚未配置")}`,
    `scripts: ${tool?.scriptsDirectory ?? t("尚未配置")}`,
    `CMSIS-DAP backend: ${backend}`, '',
    t("## 给你现有 OpenOCD 配置参考的 Tcl 参数"),
    t("以下是 OpenOCD Tcl，不是可直接粘贴到 PowerShell 的完整烧录命令。"),
    t("推荐发行版 0.12.0 使用以下兼容命令名；其他版本请核对其 help。"),
    '```tcl',
    'source [find interface/cmsis-dap.cfg]',
    `cmsis_dap_backend ${backend}`,
    ...(serial ? [`adapter serial ${tclWord(serial)}`] : []),
    'transport select swd',
    '```',
    t("ST-Link："),
    '```tcl',
    'adapter driver st-link',
    'transport select swd',
    '```',
    t("旧版 OpenOCD 使用 `source [find interface/stlink.cfg]`、`transport select hla_swd`，序列号用 `hla_serial`。"),
    t("J-Link："),
    '```tcl',
    'adapter driver jlink',
    'transport select swd',
    '```', '',
    t("芯片 target 配置、adapter speed、复位策略和 ELF 路径由你的工程决定。"),
    t("Cortex-Debug 的 searchDir 可指向上面的 scripts；configFiles 使用你维护的接口与目标配置。"), '',
    t("## 接口与驱动"),
    t("- CMSIS-DAP v1 使用 USB HID，Windows 一般使用系统 HID 驱动。"),
    t("- CMSIS-DAP v2 USB Bulk 需要适当的 WinUSB/厂商驱动绑定。"),
    t("- auto 尝试 Bulk 后再尝试 HID；具体暴露的接口取决于探针硬件和固件配置。"),
    t("- DAPLink 的 U 盘、串口和调试接口是不同功能，U 盘能打开不代表调试可用。"),
    t("- ST-Link 需要 ST 官方驱动；J-Link 需要 SEGGER 驱动。"),
    t("- 不要给整个复合 USB 设备或 MSC/CDC 接口盲目换驱动。本插件不会安装驱动或升级固件。"), '',
    t("## 检查层级"),
    t("1. 工具层：exe 能运行、scripts 完整、探针通信方式配置命令可用。"),
    t("2. 探针层：实际打开 HID/Bulk/ST-Link/J-Link 成功才算验证；本插件的软件检查不执行此操作。"),
    t("3. 目标层：需要你的芯片配置、供电和 SWD 接线；按实际工程验证 GDB 连接与断点。"),
    '', t("探针与目标芯片通信状态：未验证。没有实际硬件证据时，不报告成功。"), '',
    t("## 常见问题"),
    t("- 找不到探针：核对数据线、USB 接口、后端模式及对应接口驱动。"),
    t("- 设备占用：先结束其他 IDE/OpenOCD 的调试会话。"),
    t("- 已连接探针但 target 初始化失败：核对芯片配置、供电、地线、SWDIO/SWCLK、连接速度和复位策略。"),
    t("- 工具路径不生效：核对工作区设置、Presets 和 launch.json 的显式路径；插件不会覆盖这些值。"),
    '', t("参考：https://openocd.org/doc/html/Debug-Adapter-Configuration.html")
  ].join('\n');
}
