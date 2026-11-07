#ifndef STM32_EASY_MONITOR_H
#define STM32_EASY_MONITOR_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
#ifndef STME_BUFFER_BYTES
#define STME_BUFFER_BYTES 2048u
#endif
#ifndef STME_MAX_TASKS
#define STME_MAX_TASKS 8u
#endif
#ifndef STME_FRAME_BYTES
#define STME_FRAME_BYTES 2048u
#endif
#ifndef STME_HEAP_PERIOD_MS
#define STME_HEAP_PERIOD_MS 1000u
#endif
#ifndef STME_TASK_PERIOD_MS
#define STME_TASK_PERIOD_MS 5000u
#endif
#ifndef STME_USE_FREERTOS
#define STME_USE_FREERTOS 0
#endif
#ifndef STME_HAS_HEAP_STATS
#define STME_HAS_HEAP_STATS 0
#endif
#ifndef STME_HEAP_TOTAL_BYTES
#define STME_HEAP_TOTAL_BYTES 0u
#endif
#define STME_UNKNOWN UINT32_MAX
#if STME_BUFFER_BYTES < 512 || STME_FRAME_BYTES < 512 || STME_MAX_TASKS < 1 || STME_MAX_TASKS > 128
#error Invalid STM32 Easy Monitor buffer or task limits
#endif
typedef struct { uint32_t total, free, minimum, largest; } stme_heap_t;
typedef int (*stme_heap_provider_t)(stme_heap_t *result);
void stme_init(const char *firmware_id, uint32_t boot_id);
/* Call from ONE ordinary task or the main loop, never from an ISR. */
void stme_poll(uint32_t milliseconds);
void stme_set_heap_provider(stme_heap_provider_t provider);
void stme_set_stack_bounds(uintptr_t low, uintptr_t high);
void stme_sample_stack(uintptr_t stack_pointer);
/* Remove before task deletion, register after creation. */
int stme_register_task(void *task_handle, uint32_t stack_capacity_bytes);
void stme_unregister_task(void *task_handle);
uint32_t stme_dropped_frames(void);
#ifdef __cplusplus
}
#endif
#endif

