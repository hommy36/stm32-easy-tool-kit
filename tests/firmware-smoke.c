/* Host-only protocol validation: include the component to inspect its fixed ring. */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "../resources/firmware/stm32_easy_monitor.c"
static int heap(stme_heap_t *h){h->total=1000;h->free=500;h->minimum=300;h->largest=200;return 1;}
static void drain(char *out){stme_rtt_up_t *u=&_STM32_EASY_RTT.up[0];size_t n=0;while(u->read_offset!=u->write_offset){out[n++]=u->buffer[u->read_offset];u->read_offset=(u->read_offset+1)%u->size;}out[n]=0;}
int main(void){char output[STME_BUFFER_BYTES+1];stme_init("native-test",UINT32_MAX);stme_set_heap_provider(heap);stme_set_stack_bounds(1000,2000);stme_sample_stack(1750);stme_poll(1000);drain(output);assert(strstr(output,"\"boot\":4294967295"));assert(strstr(output,"\"current\":250"));assert(strstr(output,"\"largest\":200"));puts(output);
sequence=UINT32_MAX;stme_poll(2000);drain(output);assert(strstr(output,"\"seq\":4294967295"));puts(output);stme_poll(3000);drain(output);assert(strstr(output,"\"seq\":0"));
for(uint32_t ms=4000;ms<40000;ms+=1000)stme_poll(ms);assert(stme_dropped_frames()>0);drain(output);stme_poll(40000);drain(output);assert(!strstr(output,"\"drop\":0"));
stme_init("invalid id",1);stme_poll(1000);assert(!initialized);puts("PASS fixed-buffer firmware protocol, wrap, stack and dropped frames");return 0;}

