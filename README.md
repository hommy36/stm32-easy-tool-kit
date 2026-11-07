# STM32 Easy Tool Kit

[English](README.md) | [简体中文 / 完整中文说明](README.zh-CN.md)

A local VS Code workbench for existing STM32 CMake projects: prepare tools, configure, build, flash, debug and inspect memory without maintaining tasks.json or launch.json.

**Platform:** Windows x64, local VS Code 1.96+. Supports CMSIS-DAP / DAPLink, ST-Link and J-Link through OpenOCD and Cortex-Debug. Existing CLion profiles and clangd integration remain supported.

The extension is available on [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=hommy36.stm32-easy-tool-kit). **0.7.12** adds the memory workbench, C5 fixes and quick optimization selection. Runtime monitoring and C5 tool support remain experimental; hardware coverage is recorded per tested combination. See [verification records](docs/verification-0.7.md).

## Quick optimization override

Use **Optimize** beside the build preset in the sidebar. **Default** follows the preset; `-O0`, `-Og`, `-O1`, `-O2`, `-O3`, `-Os`, and `-Oz` override C/C++ optimization on the next build. The choice is stored per project in `.vscode/stm32-easy.features.json` and remains selected when switching presets. Select Default to restore the preset flags.

This changes optimization only, not the build type, debug information, or `NDEBUG`. The extension reconfigures automatically and verifies effective compiler commands. It uses generated hooks in the build directory without editing CMake source files; existing project include hooks are preserved. The generated build directory retains the override for direct command-line builds until Default is selected and configured/built again. `-Oz` requires compiler support; unsupported flags report a compiler error. Custom rules that replace the override must use Default or be adjusted.

## Quick start

1. Open and trust an existing STM32 CMake workspace.
2. Open the STM32 Easy Tool Kit sidebar and select **Configure project**.
3. Select tools, a build preset and the firmware target; save and configure.
4. Build. Compiler diagnostics appear in Problems and the STM32 build output.
5. Select the probe and target script before flashing or debugging. The existing hardware confirmation shows the exact target and artifact.

Build prerequisites: Arm GNU Toolchain, CMake and Ninja. Flash/debug additionally need OpenOCD with scripts and a supported probe; debugging uses Cortex-Debug 1.12.1 or compatible 1.x. There is no automatic tool or third-party extension installation. Debugger paths currently need to be ASCII.

For CubeMX2/C5 projects using `$<QUOTE>`, select **CMake 3.30 or later** in Manage Tools; CubeCLT 1.18.0 includes CMake 3.28.1, which cannot configure these expressions. The regenerated STM32C593RET6/USBX sample passed compilation and static memory analysis with CMake 4.3.2 and Arm GCC 13.3.1. Keep the generated preset's `TOOLCHAIN_FILE` and configuration name. The toolchain filename alone does not prove which compiler version is installed; check the build log.

**STM32C5:** In **Manage Tools → OpenOCD → Install**, select **Experimental STM32C5 support**. This optional, pinned third-party EmberProbe build includes ST stldr patches, the C5 target and local DFP loaders. The standard xPack 0.12.0-6 option still has no C5 support. Configuration loading passed with CMSIS-DAP, direct ST-Link and J-Link; physical flashing/debugging remain unverified. See [setup, provenance and limits](docs/c5-flashing.md). If dependency verification reports that compile commands use a different Arm compiler, select the same compiler installation shown in `CMAKE_C_COMPILER` / `compile_commands.json` and reconfigure.

## One-click monitor setup

Open **Memory studio → Runtime monitor → One-click monitor setup**, or run **STM32: One-click monitor setup** from the Command Palette.

- Existing component: resolve the RTT control-block address and exported firmware identity directly from the current verified ELF. Legacy components require their exact stme_init identity once.
- First integration: standard CubeMX HAL / FreeRTOS projects get a complete file preview. **Apply and build** adds the component, CMake integration and USER CODE calls, then builds the target.
- Download the new firmware with the usual Flash or Debug action, then **Connect & monitor**. Setup itself does not connect, flash or reset hardware.
- Later connections resolve addresses again from the current successful build, so relinking does not require copying addresses into JSON.
- Heap sampling supports 1 / 2 / 5 / 10 Hz through **Stop connection → Heap sampling rate**. Preview and apply the firmware build change, then flash to activate it. The panel reports the observed receive rate using device timestamps; task stack scans stay at 5 s.

FreeRTOS automation requires static task allocation and the documented configuration macros; it uses a low-priority task with 512 stack words, a static TCB and fixed component buffers. Custom projects get the integration guide. H7 requires manually verified accessible, non-cacheable RTT memory. Heap totals and task stack capacities remain unknown unless supplied by the application.

See the [English firmware guide](resources/firmware/README.md) or [中文组件接入说明](resources/firmware/README.zh-CN.md). Static analysis and basic paused snapshots work without the component.

## Memory workbench

- ELF/MAP analysis after successful builds; actual linker regions, load/run addresses, reservations and gaps.
- Interactive region/object/symbol explorer with reversible zoom, animation and verified ELF HEX/ASCII bytes. BSS/NOLOAD has no invented file bytes.
- Searchable symbols, previous-build or pinned-baseline comparison, JSON/CSV/self-contained HTML export.
- Optional RTT telemetry for heap trends and task stack watermarks, plus read-only snapshots of owned paused debug sessions.
- Dark, light and high-contrast themes, English/Chinese UI and narrow layouts.

Read [memory workbench details](docs/memory-workbench.md). Runtime support for F1/F4/H7/C5/U5 remains experimental until each exact board, tool and probe combination is tested.

## Developer workflow

- Existing CMake Presets; local automatic Debug/Release choices when presets are absent; CLion profile import.
- Build diagnostics, cancellation, artifact access, project health checks and probe evidence.
- compile_commands.json integration with Microsoft C/C++ and clangd.
- Serial terminal, CubeMX change notifications, attach debugging, explicit SVD and fault register support.
- Shareable project configuration in .vscode/stm32-easy.json; optional workbench features in .vscode/stm32-easy.features.json. Machine tool paths and hardware authorization stay local.

Linux/macOS, Windows ARM64, remote/WSL/container/web workspaces and Keil conversion are outside this release. Hardware verification is incomplete; see the [support limits](docs/technical-notes.md) and [existing verification record](docs/verification.md).

## Install and develop

Install from Marketplace, or use **Extensions → Install from VSIX** with a locally built package. With Node.js 22+:

```sh
npm ci
npm run check
npm test
npm run test:ui
npm run test:memory-ui
npm run package
```

UI tests use a local headless Edge instance; set EDGE_PATH if necessary. Software tests are not board acceptance tests.

## Documentation

- [完整中文 README](README.zh-CN.md)
- [Technical notes and support boundaries](docs/technical-notes.md)
- [Shared project configuration](docs/project-configuration.md)
- [CLion compatibility](docs/clion-compatibility.md)
- [Memory workbench](docs/memory-workbench.md)
- [Changelog](CHANGELOG.md)

Licensed under [MIT](LICENSE). Issues and pull requests are welcome; run the relevant checks before contributing and exclude caches, local tool paths and personal project settings.
