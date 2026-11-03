# STM32 Easy Tool Kit

在 VS Code 侧栏完成 STM32 的 **工具准备 → 配置 → 编译 → 烧录 → 调试**，不用手写 `tasks.json` / `launch.json`。

面向 Windows x64、已有 STM32 CMake 工程；支持 **DAPLink / CMSIS-DAP、ST-Link、J-Link** 的 SWD 烧录与调试，调试复用 Cortex-Debug。

> **已在 VS Code Marketplace 上架**（`hommy36.stm32-easy-tool-kit`）。软件侧构建、取消、诊断和界面流程已验收；DAPLink / ST-Link 做过实机准备检查，J-Link 仅完成参数与软件层验证，真实板卡烧录、断点、单步和变量检查尚未全部完成，详见 [验证记录](docs/verification.md)。

## 功能

- **首次设置向导**：一次选好工程、编译工具、构建方案、固件目标、芯片与 OpenOCD 脚本。
- **构建**：直接使用现有 CMake Presets；没有 Presets 时可自动生成本地构建方案，不写工程文件。
- **烧录与调试**：DAPLink、ST-Link、J-Link 的 SWD、OpenOCD、Cortex-Debug；首次确认后可记住授权。
- **CLion 兼容**：导入 CLion 的 CMake Profile、工具链、构建目录和 OpenOCD board 配置（含探针类型）。
- **工程配置共享**：默认写入 `.vscode/stm32-easy.json`，可随 Git 传播，不包含本机工具路径。
- **编辑器补全**：自动同步 `compile_commands.json` 到 Microsoft C/C++ 和 clangd（包括 `--query-driver`）。
- **中英双语**：跟随 VS Code 显示语言；工程名、路径和编译器输出保持原样。
- 构建日志自动展开、GCC 诊断进入“问题”面板，可按源码位置跳转。

## 环境要求

- Windows x64，本地 VS Code 1.96+（Trae 等 VS Code 衍生版可用，但 Microsoft C/C++ 可能受许可证限制，见下文）。
- 工程包含 `CMakeLists.txt`，并满足以下之一：
  - 现有 `CMakePresets.json` / `CMakeUserPresets.json`；
  - CLion CMake Profile（`.idea`）；
  - 由插件自动生成“自动 Debug / 自动 Release”本地方案。
- 编译：CMake、Ninja、Arm GNU Toolchain。
- 烧录/调试：OpenOCD（含 `scripts`）、Cortex-Debug 1.12.1 或兼容 1.x，以及 DAPLink / ST-Link / J-Link 之一。

不支持 Linux/macOS、Windows ARM64、WSL/SSH/容器、虚拟工作区或 Web 版 VS Code；不转换 Keil 工程。

## 安装

在 VS Code 扩展视图搜索 **STM32 Easy Tool Kit**，或直接打开：

https://marketplace.visualstudio.com/items?itemName=hommy36.stm32-easy-tool-kit

也可以从仓库 **Releases** 下载最新的 `stm32-easy-tool-kit-*.vsix`，或自行打包：

```bash
npm ci
npm run package
```

VSIX 安装方式：在 VS Code 扩展视图右上角菜单选择 **从 VSIX 安装**，安装后重载窗口。插件不会自动安装工具或第三方扩展。

## 快速开始

1. 打开 STM32 CMake 工程文件夹，信任工作区。
2. 点击活动栏的芯片图标 **STM32 Easy Tool Kit**。
3. 点击 **配置工程**，按引导选择工程和编译工具；构建方案会自动读取。
4. 点击 **保存并配置**。单一固件目标会自动选用，多目标时选择需要构建的目标。
5. 点击 **编译**。日志在 **输出 → STM32 构建**，错误在 **问题** 面板。
6. 需要烧录或调试时，按提示确认芯片、target 脚本和固件摘要。

日常入口：侧栏按钮、底部状态栏，以及编辑器标签栏右侧的编译 / 烧录 / 调试 / 停止图标（仅已选工程时显示）。

## 构建配置

- **构建方案** 对应 Configure Preset；**构建预设（Build Preset）** 在构建页折叠区选择，保留预设参数语义。
- 工程没有 Presets 和 CLion Profile 时，提供 **自动 Debug / 自动 Release**：
  - 优先使用工程内的 `cmake/gcc-arm-none-eabi.cmake`；
  - 否则显式传入所选 `arm-none-eabi-gcc/g++`、`CMAKE_SYSTEM_NAME=Generic`；
  - 直接执行 `cmake -S . -B build/<配置> -G Ninja`，不生成或改写 Presets。
  - CMakeLists 本身仍需负责 `-mcpu`、`-mfloat-abi` 等芯片相关参数。
- 已有 CLion 配置时，可在 **工程设置 → 沿用 CLion 配置…** 导入，不会改写 CLion 或工程文件。
- 插件不会清除 CMakeCache、不使用 `--fresh`；缓存与生成器/编译器不一致时会停止并说明。

## 烧录与调试

- 侧栏“当前工程”的 **调试探针** 下拉可随时在 DAPLink / CMSIS-DAP、ST-Link、J-Link 之间切换；也可在 **工程设置 → 烧录与调试 → 调试探针** 修改。探针类型会随工程保存，团队配置一致。
- 未选择 OpenOCD 脚本时，插件会根据 `.ioc`、CMake、启动/链接文件推荐唯一匹配的 target 脚本；也可手动选择。
- 首次硬件操作展示工程、芯片、脚本、固件和 SWD 参数摘要；选择 **确认并记住** 后，配置和脚本内容不变时不再重复询问。
- 烧录 = 先编译，成功后烧录当前 ELF、校验并复位运行；编译失败不会烧录旧固件。
- 调试 = 先编译，再通过插件拥有的 OpenOCD 本地服务器接入 Cortex-Debug；不先独立烧录一遍。
- DAPLink 使用 `adapter driver cmsis-dap`，通信方式（auto / HID / USB Bulk）只对 DAPLink 生效；ST-Link 使用 `adapter driver st-link` 或旧版 `interface/stlink.cfg` + `hla_swd`，旧版序列号用 `hla_serial`；J-Link 使用 `adapter driver jlink`。
- 换探针会改变硬件授权条件，首次使用需重新确认。
- 当前 Windows GDB 调试要求源码目录和 ELF 为 **ASCII 路径**；中文路径仍可编译和独立烧录。
- **安全**：连接电机、摩擦轮等执行器时先切断动力电源，仅给控制板供电。停止不能撤销已写入的 Flash；插件不自动重试危险操作。

## 编辑器补全

CMake 配置完成或添加外部目录后，插件自动为整个工作区同步当前 `compile_commands.json`：

- Microsoft C/C++：写入 `C_Cpp.default.compileCommands`。
- clangd：写入 `--compile-commands-dir` 和 `--query-driver`，切换构建方案或编译器后自动更新并重启。

已有配置提供程序、文件夹级设置或 `c_cpp_properties.json` 覆盖会记录到构建日志。Trae 等环境中 Microsoft C/C++ 被许可证限制，使用已安装的 clangd 即可；详见 [技术说明](docs/technical-notes.md)。

## 工具管理

- **使用已有工具**：支持完整发行目录或 `bin`；Arm 需保留库与 GDB，OpenOCD 需保留 `scripts`。
- **安装推荐工具**：固定版本并校验 SHA-256 与大小；支持离线工具包导入。
- 每行的检查/安装只操作该工具，未打开工程也可管理。
- 不修改系统 PATH；可选的 VS Code 工具路径接入只写用户级设置，并可恢复。
- 支持显式 HTTP/HTTPS 代理，不关闭 TLS 校验，不支持 PAC/网页登录代理。

## 工程配置共享

**随工程保存配置**默认勾选，保存时同步写入 `.vscode/stm32-easy.json`；提交该文件以及必要的 `.vscode/stm32-easy/openocd/` 脚本即可让其他电脑读取同一套配置。

- 不包含工具路径、探针序列号或硬件授权，每台电脑各自选择工具。
- 不需要共享时在 **工程设置 → 构建** 取消勾选，配置只保存在本机。
- 多窗口保存使用版本号检查，旧页面不会覆盖新设置；异常退出后先核对锁中 PID 再处理锁文件。

详见 [工程配置共享](docs/project-configuration.md)。

## 常见问题

| 情况 | 下一步 |
| --- | --- |
| 没有构建方案 | 检查 `CMakeLists.txt`；无 Presets 时选择“自动 Debug / 自动 Release”，仍失败查看构建日志 |
| 编译按钮不可用 | 查看侧栏“编译环境”，选择工程或配置工具 |
| 未识别固件目标 | 保存并配置 CMake，确认工程定义了可执行目标 |
| 编译报错 | “问题”面板定位源码；完整日志在输出 → STM32 构建 |
| 烧录或调试不可用 | 检查 OpenOCD、所选探针、芯片与 target、Cortex-Debug 及 ASCII 路径要求 |
| 找不到探针 | 确认“调试探针”选择与实物一致；DAPLink 检查 HID/WinUSB，ST-Link 装 ST 驱动，J-Link 装 SEGGER 驱动 |
| 补全不生效 | 确认 clangd 或 Microsoft C/C++ 已安装；查看构建日志中的编译数据库同步信息 |
| 保存提示页面过期 | 保留需要的草稿，再放弃修改并加载最新配置 |
| 提示“已有操作或调试正在进行” | 查看提示中的具体原因；结束调试、等待工具检查或点击停止。无构建/硬件锁时，停止也可清除“上次操作不确定”的内存占用 |

更多支持边界见 [技术说明](docs/technical-notes.md)，变更见 [更新记录](CHANGELOG.md)。

## 开发与测试

```bash
npm ci
npm run check        # TypeScript 类型检查
npm test             # 单元与集成测试（Node test）
npm run test:ui      # 无头 Edge Webview 回归（需要 Edge，可用 EDGE_PATH 指定）
npm run package      # 生成 VSIX
```

`test:ui` 在临时目录启动无头 Edge，验证本机 Webview 的布局、主题和交互，不会访问外部网页。真实编译与 VSIX 宿主验证步骤见 [验证记录](docs/verification.md)。

## 验证状态与已知限制

- 已完成：真实 STM32 CMake 工程配置与编译、ELF/HEX/BIN 产物、取消构建、停止/重试、错误定位、主题与窄宽布局、工程配置共享、无 Presets 自动方案、OpenOCD 对 DAPLink / ST-Link / J-Link 的参数生成与能力检查。
- 未完成：DAPLink 与 ST-Link 实机烧录、main 断点、单步、变量与调用栈；J-Link 尚未实机验证。软件测试和本地假 TCP 调试服务不等于板卡验收。
- 旧版 OpenOCD 的 ST-Link 使用 `hla_swd`；J-Link 在旧版 OpenOCD 下不支持按序列号选探针，请升级 OpenOCD。
- 首版调试仅支持 ASCII 路径；高级工具链或非 Ninja 构建在依赖无法证明时只允许编译，不进入烧录/调试。
- 插件不是任意构建脚本或外部 IDE 的安全沙箱；不要让 CMake Tools、CLion 或另一个窗口同时控制同一构建目录或探针。

## 文档

- [技术说明与支持边界](docs/technical-notes.md)
- [工程配置共享](docs/project-configuration.md)
- [CLion 兼容说明](docs/clion-compatibility.md)
- [验证记录](docs/verification.md)
- [更新记录](CHANGELOG.md)

## 许可证

本项目使用 [MIT License](LICENSE)。

## 贡献

欢迎提交 Issue 和 Pull Request。提交前请运行 `npm run check && npm test`；涉及界面时再运行 `npm run test:ui`。请勿提交 `.cache`、构建产物、本机工具路径或个人工程配置。
