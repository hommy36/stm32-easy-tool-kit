#include <assert.h>
#include <stdio.h>
#include "../resources/firmware/stm32_easy_monitor.c"
int main(void) {
  stme_init("rate-test", 1);
  for (uint32_t ms = 50; ms <= 1000; ms += 50) {
    stme_poll(ms);
    _STM32_EASY_RTT.up[0].read_offset = _STM32_EASY_RTT.up[0].write_offset;
  }
  assert(sequence == 1000u / STME_HEAP_PERIOD_MS);
  assert(dropped == 0);
  printf("PASS actual firmware sampling: %u frames per 1000 ms, period %u ms\n", (unsigned)sequence, (unsigned)STME_HEAP_PERIOD_MS);
  return 0;
}
