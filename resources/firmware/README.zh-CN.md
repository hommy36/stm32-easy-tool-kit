# STM32 Easy Monitor 可选诊断组件

[简体中文](README.zh-CN.md) | [English](README.md)

该组件通过 RTT 输出运行时诊断数据，当前为实验功能。静态内存分析和暂停寄存器快照不需要接入它。

## 推荐：一键配置监测

在插件的 **内存分析 → 运行监测 → 一键配置监测** 中操作：

1. 插件读取当前目标 ELF；尚无构建时会先编译。
2. 已有组件时，自动读取 `_STM32_EASY_RTT` 地址及导出的 `stme_firmware_id` 字符串。旧版手动接入组件没有该字符串时，只需输入一次传给 `stme_init` 的标识。
3. 没有组件时，对标准 CubeMX HAL 裸机或 FreeRTOS 工程生成接入预览。选择 **应用并编译**，自动添加本目录、CMake 接入、USER CODE 调用并编译。
4. 用侧栏 **烧录** 或 **调试** 下载新固件，随后点击 **连接并监测**。配置本身不下载固件、不复位、不连接探针。

自动设置写入 `.vscode/stm32-easy.features.json`，保留原来的预算、SVD 和工具配置。自动模式在每次启动监测或调试前重新读取当前已验证 ELF，避免重新链接后地址移动。连接前仍需当前目标成功构建；历史分析报告不作为连接依据。

自动接入支持的结构：当前目标可定位唯一 `main.c`；HAL 主循环有标准 Includes、2、3 用户区块；或 FreeRTOS 有唯一 RTOS_THREADS 区块，且 `configSUPPORT_STATIC_ALLOCATION`、`INCLUDE_vTaskDelay`、`INCLUDE_xTaskGetSchedulerState` 明确为 1。特殊目录、定制系统和已有半完成接入会打开本说明，不猜调用位置，也不覆盖已有组件目录。

## 调整堆采样频率

运行监测页点击 **停止连接 → 堆采样频率**，可选 **1 / 2 / 5 / 10 Hz**（1000 / 500 / 200 / 100 ms）。预览并应用后，插件为当前目标增加 `STME_HEAP_PERIOD_MS` 编译宏并重新编译；再用原有烧录入口下载新固件，连接后才会生效。此入口支持一键接入生成的组件；手动集成可在自己的目标上设置相同编译宏。

任务栈扫描仍每 5 秒一次，避免提高堆采样率时同步增加扫描成本。FreeRTOS 监测任务每 100 ms 唤醒，以上频率是请求值；调度、RTT 带宽和丢帧会降低实际接收频率。面板根据最近最多 31 个样本的固件时间戳显示接收采样率，批量到达不会被误算成突发高频。GUI 合并刷新约每 200 ms 一次，收到的采样点仍保留在曲线和导出中。

已有丢帧时建议先试 2 或 5 Hz。该组件使用固定缓冲区，不会因设置高频而自动扩大 RAM；长时间暂停目标或探针读取不足时仍可能丢帧。实际应用的 CPU、RTT 吞吐与控制时序需要上板确认。堆值不变时，曲线保持水平是正常结果。

## 自动生成的行为与开销

- 裸机：初始化后调用 `stme_setup_start()`，主循环调用 `stme_setup_poll(HAL_GetTick())`。堆适配器与可靠栈边界需要应用提供；未提供时相应数据保持未知。
- FreeRTOS：在启动调度器前创建空闲优先级静态任务。任务栈为 **512 个 StackType_t**（通常 2048 字节），另有静态 TCB、默认 2048 字节 RTT 环形缓冲区和 2048 字节帧缓冲区及元数据。任务每 100 ms 唤醒，组件默认每秒采堆、每 5 秒采任务栈水位；高优先级任务持续占用 CPU 时可能无法及时采样。
- FreeRTOS 10.3+ 存在已链接的 `vPortGetHeapStats` 时读取空闲量、最低空闲量及最大空闲块；否则按可用 API 降级。自动模式不推断堆总容量，`heap_5` 尤其需要应用提供区域总量。
- `configUSE_TRACE_FACILITY=1` 时提供任务列表；未知任务总栈容量不显示使用百分比。默认最多 8 个任务，超出会提示不完整。
- 自动生成的固件标识用于匹配本次接入，不是每次构建的内容散列。需区分诊断构建时更新 `stme_firmware_id` 并重新编译。
- 启动标识默认取 `SysTick->VAL`，可能重复。需可靠识别重启时覆盖弱函数 `uint32_t stme_setup_boot_id(void)`，返回应用的持久启动计数器；断线重连仍会建立新监测会话。

组件不自行分配堆内存；输出非阻塞，满时丢帧并上报计数。实际 Flash、RAM 和执行时间必须在目标板测量，不承诺零开销。自动接入后可按应用需要调整生成的 C/H 文件；插件不会覆盖这些调整。

## 手动接入

1. 将组件复制到工程，包含 `stm32_easy_monitor.cmake`，调用 `stm32_easy_monitor(your_target)`。
2. 包含 `stm32_easy_monitor.h`，定义全局常量 `const char stme_firmware_id[] = "my-build-id";`，在启动时调用 `stme_init(stme_firmware_id, boot_id)`。标识限定 1–80 个字母、数字、点、下划线或连字符。
3. 从**一个**普通任务或主循环周期调用 `stme_poll(milliseconds)`，不在中断中采集。用 LTO 时给常量添加 `used, externally_visible` 属性，并添加链接选项 `-Wl,--undefined=stme_firmware_id`，确保可自动读取。
4. 编译后运行 **一键配置监测**，无需手填 RTT 地址；也可在高级 JSON 中手动设置 `enabled/address/searchBytes/channel/firmwareId`。

FreeRTOS：定义 `STME_USE_FREERTOS=1`；使用支持的 heap_4/heap_5 且具备 `vPortGetHeapStats` 时可设置 `STME_HAS_HEAP_STATS=1`。`STME_HEAP_TOTAL_BYTES` 必须是实际堆总量，不要把 heap_5 的总量直接当作 `configTOTAL_HEAP_SIZE`。调用 `stme_register_task(handle, capacity_bytes)` 注册已知栈容量，删除任务前调用 `stme_unregister_task`；这些 API 必须和采样串行使用。

裸机：用 `stme_set_heap_provider` 接入自己的分配器；未知字段使用 `STME_UNKNOWN`。可靠边界用 `stme_set_stack_bounds(low, high)` 指定，应用采样 SP 后交给 `stme_sample_stack(sp)`。这是观测峰值，不保证捕捉两次采样之间的最大栈深，不会改写现有栈。

## H7、缓存与安全域

H7 不自动修改链接脚本或 MPU。控制块和数据缓冲区都在 `.stm32_easy_rtt` 段，必须放入探针可访问且配置为不可缓存的 RAM，保持 32 字节对齐，初始化前完成 MPU 配置。例如：

```ld
.stm32_easy_rtt (NOLOAD) : ALIGN(32) {
  KEEP(*(.stm32_easy_rtt))
  . = ALIGN(32);
} >RAM
```

`RAM` 需要替换为实测可访问区域；不要假设 DTCM 或任意 RAM 都可用。内存屏障不会刷新缓存。完成验证后才设置 `runtime.cacheCoherent=true`。C5/U5 及安全域工程只允许访问当前调试上下文可读区域；没有实测的组合仍是实验性。

## 恢复与移除

- 编译失败：接入文件保留以便修复；监测配置不会被标记为完成。修复后再次编译并运行一键配置。
- 预览后文件改变或有未保存编辑：停止应用，保存后重新生成预览。
- 移除自动接入：移除 USER CODE 内新增的 include/调用和根 CMakeLists 的 STM32 Easy Monitor 区块；删除 `stm32-easy-monitor` 目录，将 `runtime.enabled` 设为 false，重新编译。
- 无数据：确认下载的是当前 ELF、固件已运行、组件初始化和采样已执行、RTT 区域可访问。使用暂停快照时需暂停插件拥有的调试会话。

该组件是 MIT 许可的原创 RTT 上行布局实现，不打包 SEGGER 源码，不提供逐次 malloc/free 追踪。
