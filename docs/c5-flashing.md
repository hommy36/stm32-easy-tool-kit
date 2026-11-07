# STM32C5 烧录接入 / STM32C5 flashing

0.7.9 新增可选的 **STM32C5 实验支持** 工具包。它使用第三方 EmberProbe OpenOCD 构建，包含 ST 提交的 `stldr` Flash 驱动、C5 目标配置和 DFP 2.1.0 loader。不是 ST 官方或官方 xPack 二进制发行版；软件安装/配置检查通过，实机擦除、写入、校验、复位和调试尚未验收。

## 使用步骤

1. 安装 0.7.11 或以上 VSIX 并重新加载编辑器。
2. **工具管理 → OpenOCD → 安装 → STM32C5 实验支持**，确认来源后下载。安装到独立版本目录并选中，旧工具仍可在“选择已有”中切回。
3. 网络失败时，用 **OpenOCD → 离线导入 → STM32C5 实验支持** 选择原始 `openocd-win32-x64.tar.gz`。在线与离线均校验完整归档 SHA-256；不接受普通 xPack 包冒充此版本。
4. 刷新工作台。在唯一识别到 C5 且尚未指定目标脚本时，插件推荐 `target/stm32c5x.cfg`；如已有手动配置，在工程设置重新识别/选择此脚本。保留原来的探针选择，不改成其他芯片脚本。
5. 在“工具管理”确认 Arm GNU 路径与工程实际编译命令一致，重新配置并编译。CMake/编译器路径问题与 OpenOCD 是独立问题。
6. 用户点击“烧录”后，沿用现有目标确认、当前 ELF/输入验证、编程、校验、复位流程。安装本身不打开探针或烧录。

CMSIS-DAP、直接 DAP 模式的 ST-Link、J-Link 的软件配置加载已在 Windows x64 验证；旧 `hla_swd` 不支持 C5 所需的 MEM-AP。实际探针型号/固件、接线、电源和芯片保护状态仍需上板确认。C5 配置和 loader 会在连接前检查，并在烧录或服务器启动前再次核对；本版只接受下述固定配置/loader 身份，不接受任意改写的 C5 board 脚本。

## 0.7.11 回调修复

若日志出现 `can't read "_CHIPNAME": no such variable`，这是固定工具包的 examine-end 回调未声明全局变量导致 loader 没绑定。0.7.11 在启动参数中修复原回调作用域，烧录和调试共用；无需重新下载 OpenOCD，升级插件并重新加载编辑器即可。使用真实 Tcl 解释器和模拟目标访问已验证三组 loader，但不能代替实机烧录验证。

## Loader 对应关系

| DEV_ID | 设备 | 本地 loader |
|---|---|---|
| 0x44F | C531 / C532 / C542 | STM32C53x_C54x.xldr |
| 0x44E | C551 / C552 / C562 | STM32C55x_C56x.xldr |
| 0x45A | C591 / C593 / C5A3 | STM32C59x_C5Ax.xldr |

实际 loader 由目标配置读取 DEV_ID 后选择。容量由芯片读数决定，不按项目名称硬编码。三个文件随包离线安装，连接过程不下载代码。本版不添加 option bytes、RDP 解锁、解除保护或整片擦除入口。完整烧录仍可能擦写 ELF 涉及的扇区。

## 来源、许可证与固定身份

- [EmberProbe 固定提交](https://github.com/BakeSheep/EmberProbe-MCU-Flash-Debug/tree/5e6fb45b08c6f86b552b49b3c5fa66e35acb0ceb)，构建基于 OpenOCD `e5888bda38f4952e2ae92f7dc5b25fc9a2d1c2b3`（xPack 0.12.0-7 对应源码）。包含其 scatter 扩展，本插件不调用该扩展。
- [ST stldr review 9697/8](https://review.openocd.org/c/openocd/+/9697/8)、[ST C5 配置 review 9699/6](https://review.openocd.org/c/openocd/+/9699/6)，外加改为使用本地 loader 的补丁。
- [Windows 原始工具包](https://raw.githubusercontent.com/BakeSheep/EmberProbe-MCU-Flash-Debug/5e6fb45b08c6f86b552b49b3c5fa66e35acb0ceb/resources/openocd-win32-x64.tar.gz)：2,767,295 bytes；SHA-256 `227754ab5493ed5b2b05500cddfe081cc93f3f3620068c4fb33c67c7688892fe`。
- [对应源码归档](https://raw.githubusercontent.com/BakeSheep/EmberProbe-MCU-Flash-Debug/5e6fb45b08c6f86b552b49b3c5fa66e35acb0ceb/native/openocd/emberprobe-openocd-source.tar.gz)：上游清单 SHA-256 `101f0fb58c800b9d0a2079fa1e392a3974adf364fe973e4bc047d1d652bd5086`。提供实际 OpenOCD/依赖源码、补丁、锁定构建配方。[构建及源码说明](https://github.com/BakeSheep/EmberProbe-MCU-Flash-Debug/blob/5e6fb45b08c6f86b552b49b3c5fa66e35acb0ceb/native/openocd/README.md)。
- OpenOCD 及相关补丁为 GPL-2.0-or-later；依赖许可证保留在工具包的 `distro-info/licenses/`，ST loader 为 BSD-3-Clause，保留其 LICENSE.html。插件通过固定 URL 下载原包，不将 OpenOCD 二进制编入 VSIX。
- [ST DFP loader 来源](https://github.com/STMicroelectronics/stm32c5xx-dfp/tree/a5f65bc64535cfa723e9d25f58d7ce23d0937aed/Flash)。C59/C5A loader SHA-256 `b9aacec837613f273b0d88fb3ca41c5c52712752fd26271959dd03a41dab8e53`。

## 软件验证与边界

`npm run check`、`npm test` 通过。Windows x64 实际离线安装经过归档哈希验证和受限 TAR.GZ 解压；普通版本工具仍使用原 ZIP 流程。预检只执行配置与显式 `shutdown`，不调用 `init`，不连接、暂停或写入目标。

可复现检查：`npm run compile` 后执行 `node scripts/c5-software-smoke.cjs <原始工具包路径>`。只在 `.cache` 中安装测试副本，验证 CMSIS-DAP/ST-Link/J-Link 的配置、准备烧录参数但不执行、修改 loader 后拒绝且恢复测试副本；不改用户工具选择。

本机 PowerShell 下载固定工具包成功；插件 Node HTTPS 下载器一次遇到 `ECONNRESET`，因此在线下载路径不能算本机端到端通过。离线导入已完整验证。

## English quick start

Install VSIX 0.7.11 or later, then choose **Manage Tools → OpenOCD → Install → Experimental STM32C5 support**. For network failures, use **Import archive**, choose the same C5 distribution and select the original TAR.GZ linked above. Refresh the workbench and select the detected `target/stm32c5x.cfg`. Match the selected Arm GNU installation to the actual compile command before rebuilding.

This is a pinned third-party EmberProbe build using ST's pending drivers and local DFP loaders, not an official ST/xPack binary. Software-only checks passed for CMSIS-DAP, direct ST-Link and J-Link. Physical programming/debugging, protected devices and timing remain unverified; legacy HLA is unsupported. Corresponding source and license links are provided above. Installing tools does not initiate hardware access.
