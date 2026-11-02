# 沿用 CLion 配置

在工程设置顶部或侧栏“更多”中点击 **沿用 CLion 配置…**，依次选择 CMake Profile 和 OpenOCD 运行配置。只有一项时自动选中；多项时明确选择。导入前展示构建目录、CMake 参数、工具路径、OpenOCD 脚本、固件目标和通信参数。

确认后检查工具并保存插件设置。接着点击“读取 / 刷新构建方案”，选择导入的方案并“保存并配置”。导入的 OpenOCD 配置在首次硬件操作时通过弹窗确认，不再勾选芯片确认框。取消、工具检查失败或另一窗口修改设置时，不留下部分导入的工具选择。

## CMake 与工具链

- 读取 `.idea/cmake.xml` 和 `.idea/workspace.xml` 中启用的 Profile；同名本地配置覆盖共享配置。
- 普通 Profile 显示为 `CLion · <名称>`，保留构建类型、构建目录、CMake 参数、环境变量，以及编译并行度和详细输出选项。直接调用 CMake，不生成或改写 Presets。
- 来自 Presets 的 Profile 使用现有 Configure Preset 和 Build Preset。按名称或实际构建目录匹配，无法唯一匹配时要求选择；不会拆分 Profile 名称猜测配置。
- 从 `%APPDATA%/JetBrains/CLion<版本>/options` 读取本地工具链，支持已有 Arm GNU、CMake、Ninja 路径。多版本按新到旧查找对应名称，忽略备份目录。预览会列出实际工具路径。
- 从属于当前源码目录的 CMake 缓存读取实际编译器和构建工具路径；失效路径要求重新选择。工具选择对本机插件工程共享，不修改系统 PATH。
- 仅支持本地 Windows 工具链；WSL、SSH、Docker、环境初始化脚本及无法解析的参数会明确报错。当前仍要求 Arm GNU；非 Ninja 生成器不能进入烧录 / 调试流程。工具链脚本本身仍由 CMake 按工程配置处理。

原始 Profile 和全局工具链文件保留在原处，后续读取方案时重新解析。修改这些文件后需重新配置；更换工具路径后应重新导入并检查。

## OpenOCD

- 读取工程 workspace.xml、`.idea/runConfigurations/*.xml`、`.run/*.xml` 中的 OpenOCD 运行配置，以及 CLion 全局 OpenOCD 程序路径。
- 沿用 `board-config` 的原文件路径和固件目标名称。配置后只在真实 CMake File API 目标中匹配名称，不使用旧 ELF 冒充当前固件。
- 完整 board 脚本负责加载接口、芯片与脚本内的复位配置；插件不重复加载 CMSIS-DAP 接口。执行时检查实际接口为 CMSIS-DAP、传输为 SWD。
- 识别脚本顶层直接声明的 `adapter speed` / `adapter_khz`、CMSIS-DAP backend、`adapter serial`。没有直接声明时使用插件默认通信参数并清除旧序列号；预览列出最终值，可在“高级”中调整。复杂 Tcl 表达式、嵌套脚本内的通信参数不做解释求值。
- CLion 的固定 GDB / Telnet 端口、`download-type` 和运行配置中的 `reset-type` 不直接映射。烧录仍先编译，再完整写入、校验并复位；调试使用插件分配的端口。脚本自身的 `reset_config` 等设置继续生效。
- 导入和工具检查不连接板卡。首次实际硬件操作仍需确认；脚本类型变化会使旧授权失效。未改变的旧 target 模式配置和授权保持兼容。

插件不修改 `.idea`、`.run`、源码、CMakeLists、Presets、链接脚本或调试配置。真实板卡烧录、断点和单步验收见[验证记录](verification.md)。

配置位置和语义参照 JetBrains 官方的 [CMake Profiles](https://www.jetbrains.com/help/clion/cmake-profile.html) 和 [OpenOCD support](https://www.jetbrains.com/help/clion/openocd-support.html)。
