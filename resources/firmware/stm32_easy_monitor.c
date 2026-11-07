/* MIT licensed original implementation. RTT-compatible upward byte buffer. */
#include "stm32_easy_monitor.h"
#include <string.h>
#if STME_USE_FREERTOS
#include "FreeRTOS.h"
#include "task.h"
#endif
#if defined(__GNUC__)
#define STME_ALIGNED __attribute__((aligned(32)))
#define STME_RTT_SECTION __attribute__((section(".stm32_easy_rtt"),used,aligned(32)))
#else
#define STME_ALIGNED
#define STME_RTT_SECTION
#endif
static void barrier(void) {
#if defined(__arm__) || defined(__thumb__)
  __asm volatile("dmb" ::: "memory");
#endif
}
typedef struct { const char *name; char *buffer; uint32_t size; volatile uint32_t write_offset; volatile uint32_t read_offset; uint32_t flags; } stme_rtt_up_t;
typedef struct { char id[16]; uint32_t up_count, down_count; stme_rtt_up_t up[1]; } stme_rtt_control_t;
static char rtt_buffer[STME_BUFFER_BYTES] STME_RTT_SECTION;
stme_rtt_control_t _STM32_EASY_RTT STME_RTT_SECTION;
static char frame[STME_FRAME_BYTES] STME_ALIGNED;
static size_t position;
static uint32_t sequence, dropped, boot, last_heap;
static int initialized;
static char firmware[81];
static stme_heap_provider_t heap_provider;
static uintptr_t stack_low, stack_high;
static uint32_t stack_current=STME_UNKNOWN, stack_peak;
static struct { void *handle; uint32_t capacity; } capacities[STME_MAX_TASKS];
#if STME_USE_FREERTOS && configUSE_TRACE_FACILITY
static TaskStatus_t tasks[STME_MAX_TASKS];
static struct { uint32_t id, state, priority, free, capacity; char name[65]; } task_snapshot[STME_MAX_TASKS];
static UBaseType_t task_count;
static int tasks_incomplete;
static uint32_t last_tasks;
static int sampled_tasks;
#endif
static void append(const char *value) { size_t length=strlen(value); if(position+length>=sizeof(frame)){position=sizeof(frame);return;} memcpy(frame+position,value,length);position+=length; }
static void counter(uint32_t value) { char text[11]; size_t i=sizeof(text)-1; text[i]=0; do { text[--i]=(char)('0'+value%10u);value/=10u; } while(value); append(text+i); }
static void number(uint32_t value) { if(value==STME_UNKNOWN)append("null");else counter(value); }
static void quoted(const char *value,size_t maximum) { append("\""); for(size_t i=0;value[i]&&i<maximum;i++){unsigned char c=(unsigned char)value[i];if(c=='"'||c=='\\'){char escaped[3]={'\\',(char)c,0};append(escaped);}else if(c>=32&&c<127){char text[2]={(char)c,0};append(text);}else append("?");}append("\""); }
static int emit(void) {
  stme_rtt_up_t *up=&_STM32_EASY_RTT.up[0];
  const uint32_t read=up->read_offset, write=up->write_offset;
  if(position>=sizeof(frame)||position>=up->size||read>=up->size||write>=up->size)return 0;
  const uint32_t free_bytes=(read+up->size-write-1u)%up->size;
  if(position>free_bytes)return 0;
  for(size_t i=0;i<position;i++)up->buffer[(write+(uint32_t)i)%up->size]=frame[i];
  barrier();up->write_offset=(write+(uint32_t)position)%up->size;barrier();return 1;
}
void stme_init(const char *id,uint32_t boot_id) {
  initialized=0;memset(&_STM32_EASY_RTT,0,sizeof(_STM32_EASY_RTT));memset(capacities,0,sizeof(capacities));
  sequence=0;dropped=0;boot=boot_id;last_heap=0;position=0;stack_current=STME_UNKNOWN;stack_peak=0;
#if STME_USE_FREERTOS && configUSE_TRACE_FACILITY
  last_tasks=0;sampled_tasks=0;task_count=0;
#endif
  size_t n=0;for(;id&&id[n]&&n<80;n++){char c=id[n];if(!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_'||c=='.'||c=='-'))return;firmware[n]=c;}firmware[n]=0;if(!n||(id&&id[n]))return;
  _STM32_EASY_RTT.up_count=1;_STM32_EASY_RTT.up[0].name="stm32-easy";_STM32_EASY_RTT.up[0].buffer=rtt_buffer;_STM32_EASY_RTT.up[0].size=sizeof(rtt_buffer);_STM32_EASY_RTT.up[0].flags=0;
  barrier();memcpy(_STM32_EASY_RTT.id,"SEGGER RTT",10);barrier();initialized=1;
}
void stme_set_heap_provider(stme_heap_provider_t provider){heap_provider=provider;}
void stme_set_stack_bounds(uintptr_t low,uintptr_t high){stack_low=low;stack_high=high;}
void stme_sample_stack(uintptr_t sp){if(stack_high>stack_low&&sp>=stack_low&&sp<=stack_high&&stack_high-stack_low<UINT32_MAX){stack_current=(uint32_t)(stack_high-sp);if(stack_current>stack_peak)stack_peak=stack_current;}else stack_current=STME_UNKNOWN;}
int stme_register_task(void *handle,uint32_t bytes){if(!handle||!bytes)return 0;for(size_t i=0;i<STME_MAX_TASKS;i++)if(!capacities[i].handle||capacities[i].handle==handle){capacities[i].handle=handle;capacities[i].capacity=bytes;return 1;}return 0;}
void stme_unregister_task(void *handle){for(size_t i=0;i<STME_MAX_TASKS;i++)if(capacities[i].handle==handle){capacities[i].handle=0;capacities[i].capacity=0;}}
uint32_t stme_dropped_frames(void){return dropped;}
void stme_poll(uint32_t ms){
#if defined(__arm__) || defined(__thumb__)
  uint32_t ipsr; __asm volatile("mrs %0, ipsr":"=r"(ipsr)); if(ipsr)return;
#endif
  if(!initialized||(uint32_t)(ms-last_heap)<STME_HEAP_PERIOD_MS)return;
  last_heap=ms;stme_heap_t heap={STME_UNKNOWN,STME_UNKNOWN,STME_UNKNOWN,STME_UNKNOWN};
  int has_heap=0;
#if STME_USE_FREERTOS
#if INCLUDE_xTaskGetSchedulerState
  if(xTaskGetSchedulerState()!=taskSCHEDULER_RUNNING)return;
#endif
#endif
  has_heap=heap_provider?heap_provider(&heap):0;
#if STME_USE_FREERTOS
  if(!heap_provider){
#if STME_HEAP_TOTAL_BYTES > 0
    heap.total=STME_HEAP_TOTAL_BYTES;
#endif
#if STME_HAS_HEAP_STATS
    HeapStats_t stats;vPortGetHeapStats(&stats);heap.free=(uint32_t)stats.xAvailableHeapSpaceInBytes;heap.minimum=(uint32_t)stats.xMinimumEverFreeBytesRemaining;heap.largest=(uint32_t)stats.xSizeOfLargestFreeBlockInBytes;has_heap=1;
#endif
  }
#if configUSE_TRACE_FACILITY
  if(!sampled_tasks||(uint32_t)(ms-last_tasks)>=STME_TASK_PERIOD_MS){
    vTaskSuspendAll();
    task_count=uxTaskGetSystemState(tasks,STME_MAX_TASKS,NULL);tasks_incomplete=(uxTaskGetNumberOfTasks()>STME_MAX_TASKS);
    for(UBaseType_t i=0;i<task_count;i++){
      task_snapshot[i].id=(uint32_t)(uintptr_t)tasks[i].xHandle;
      task_snapshot[i].state=(uint32_t)tasks[i].eCurrentState;task_snapshot[i].priority=(uint32_t)tasks[i].uxCurrentPriority;
      task_snapshot[i].free=(uint32_t)tasks[i].usStackHighWaterMark*sizeof(StackType_t);task_snapshot[i].capacity=STME_UNKNOWN;
      size_t n=0;for(;n<64&&n<configMAX_TASK_NAME_LEN&&tasks[i].pcTaskName[n];n++)task_snapshot[i].name[n]=tasks[i].pcTaskName[n];task_snapshot[i].name[n]=0;
      for(size_t j=0;j<STME_MAX_TASKS;j++)if(capacities[j].handle==(void*)tasks[i].xHandle){task_snapshot[i].capacity=capacities[j].capacity;break;}
    }
    (void)xTaskResumeAll();last_tasks=ms;sampled_tasks=1;
  }
#endif
#endif
  position=0;append("SE1 {\"v\":1,\"fw\":");quoted(firmware,80);append(",\"boot\":");counter(boot);append(",\"seq\":");counter(sequence++);append(",\"ms\":");counter(ms);append(",\"drop\":");counter(dropped);
  if(has_heap){append(",\"heap\":{\"total\":");number(heap.total);append(",\"free\":");number(heap.free);append(",\"min\":");number(heap.minimum);append(",\"largest\":");number(heap.largest);append("}");}
  if(stack_current!=STME_UNKNOWN){append(",\"stack\":{\"current\":");number(stack_current);append(",\"peak\":");number(stack_peak);append(",\"capacity\":");number((uint32_t)(stack_high-stack_low));append("}");}
#if STME_USE_FREERTOS && configUSE_TRACE_FACILITY
  append(",\"tasks_ms\":");counter(last_tasks);append(",\"tasks_incomplete\":");append(tasks_incomplete?"true":"false");append(",\"tasks\":[");for(UBaseType_t i=0;i<task_count;i++){if(i)append(",");append("{\"id\":");counter(task_snapshot[i].id);append(",\"name\":");quoted(task_snapshot[i].name,64);append(",\"state\":");number(task_snapshot[i].state);append(",\"priority\":");number(task_snapshot[i].priority);append(",\"free\":");number(task_snapshot[i].free);append(",\"capacity\":");number(task_snapshot[i].capacity);append("}");}append("]");
#endif
  append("}\n");
  if(position>=sizeof(frame)||position>=STME_BUFFER_BYTES){
    position=0;append("SE1 {\"v\":1,\"fw\":");quoted(firmware,80);append(",\"boot\":");counter(boot);append(",\"seq\":");counter(sequence-1u);append(",\"ms\":");counter(ms);append(",\"drop\":");counter(++dropped);append(",\"frame_overflow\":true}\n");
  }
  if(!emit())dropped++;
}

