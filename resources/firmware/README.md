# Optional STM32 Easy Monitor — experimental

[English](README.md) | [简体中文](README.zh-CN.md)

This component is opt-in. Copying the folder does not change your project. APIs must be serialized from ONE ordinary task/main loop, never an ISR.

## Recommended: one-click setup

Choose **Memory studio → Runtime monitor → One-click monitor setup**. Current ELF symbols provide the RTT address and exported `stme_firmware_id`; legacy integrations ask for their exact ID once. Standard CubeMX HAL main loops and FreeRTOS projects with static task allocation get a complete preview before **Apply and build**. Then use the usual Flash/Debug action to download the new firmware and connect. Setup does not access hardware.

The FreeRTOS adapter requires configSUPPORT_STATIC_ALLOCATION, INCLUDE_vTaskDelay and INCLUDE_xTaskGetSchedulerState equal to 1. It creates an idle-priority static task with 512 StackType_t words plus a static TCB, in addition to fixed component buffers. It polls every 100 ms; component sampling periods remain 1 s / 5 s. Weak allocator APIs provide available fields without assuming total heap capacity. Bare-metal heap statistics and stack boundaries need application adapters. Unknown fields remain unavailable.

The generated firmware ID identifies this integration, not every subsequent build; change it when distinguishing diagnostic firmware builds. Override weak `stme_setup_boot_id()` with a persistent boot counter for reliable reboot identity: its default SysTick value may repeat. No board overhead measurements are implied.

Custom layouts and existing component directories are not overwritten. H7 buffer placement and MPU remain manual. To remove integration, remove the added USER CODE includes/calls, the root CMake monitor block and component directory, disable runtime.enabled, and rebuild. Failed builds retain integration files for repair.

## Manual integration

For generated integrations, **Stop connection → Heap sampling rate** selects 1 / 2 / 5 / 10 Hz (1000 / 500 / 200 / 100 ms). Preview and apply the target's `STME_HEAP_PERIOD_MS` definition, rebuild, then flash using the usual action. This is a firmware change; editing `runtime.samplePeriodMs` alone does not change a running target. Stack task scans remain every 5 s. The fixed 100 ms task wakeup and actual scheduling/RTT throughput bound the received rate. The panel reports accepted samples per device time over up to 31 samples, counting missing sample impact; GUI refresh is coalesced at around 200 ms while received points remain in history/export. Try 2 or 5 Hz first if frames are already being dropped. Hardware timing and throughput still require measurement.

1. Include stm32_easy_monitor.cmake and call stm32_easy_monitor(your_target).
2. Include stm32_easy_monitor.h. Call stme_init("my-build-id", boot_id). Use a different firmware ID for each diagnostic build and a boot value that changes on restart.
3. Call stme_poll(milliseconds) from a low-priority task or main loop. Heap sampling defaults to 1000 ms; stack watermarks refresh every 5000 ms. Compile-time macros can change these periods.
4. Prefer one-click setup after building. To avoid the legacy ID prompt, export a global `const char stme_firmware_id[]` and pass it to stme_init; retain it under LTO with used/externally_visible attributes and -Wl,--undefined=stme_firmware_id. For manual settings, locate _STM32_EASY_RTT in the ELF symbol table. In .vscode/stm32-easy.features.json set runtime.enabled=true, runtime.address to that numeric address, searchBytes=256, channel=0 and firmwareId to the SAME ID.
5. Choose Connect & monitor or start the usual debugger. Mismatching firmware IDs are rejected.

## FreeRTOS

Define STME_USE_FREERTOS=1. Require INCLUDE_xTaskGetSchedulerState=1; enable configUSE_TRACE_FACILITY=1 for task records. For heap_4/heap_5 with vPortGetHeapStats, define STME_HAS_HEAP_STATS=1. Set STME_HEAP_TOTAL_BYTES to the actual heap total, not an assumed configTOTAL_HEAP_SIZE for heap_5. Unknown totals remain unavailable.

Register capacity using stme_register_task(handle, stack_capacity_bytes) after task creation. Call stme_unregister_task before deletion. Serialize registration and polling. Without capacity only the historical minimum free bytes are shown. STME_MAX_TASKS defaults to 8. The component copies task names and scalar fields while scheduling is suspended; it does not retain task-name pointers after deletion. Cached task data has its own tasks_ms timestamp; excess task counts set tasks_incomplete instead of implying an empty system. Stack scanning has execution cost and can suspend scheduling; measure it on the application before use.

## Bare metal

Use stme_set_heap_provider for your allocator; unknown fields are STME_UNKNOWN, not zero. Set verified stack bounds and pass a sampled application SP to stme_sample_stack. This reports observed sampled depth, not an absolute maximum between samples. No existing stack memory is overwritten.

## H7 and cached targets

Both RTT control block and buffer live in .stm32_easy_rtt. Place that section in probe-accessible RAM and configure it as non-cacheable with the application MPU before stme_init. Keep 32-byte alignment. Barriers do not flush caches. Set runtime.cacheCoherent=true only after validating the placement and MPU.

    .stm32_easy_rtt (NOLOAD) : ALIGN(32) {
      KEEP(*(.stm32_easy_rtt))
      . = ALIGN(32);
    } >RAM

Replace RAM with the verified region. Do not assume DTCM or any other region is probe-accessible.

## Limits

Defaults: 2048-byte RTT ring, 2048-byte frame buffer (STME_BUFFER_BYTES / STME_FRAME_BYTES), fixed task metadata. Evaluate small-RAM devices before integration. No heap allocations are performed. Frames are dropped instead of blocking; counters appear in the plugin. This is not a malloc/free tracer.

Original MIT implementation of the RTT upward control-block layout; no SEGGER source files are bundled. Hardware compatibility and actual Flash/RAM/CPU overhead require board measurements.
