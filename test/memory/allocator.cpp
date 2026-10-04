// Test-only requested-byte accounting. Not compiled into firmware.
// Link-wrap C allocators and override C++ new so STL allocations count too.
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <new>
#include <execinfo.h>
extern "C" {
void *__real_malloc(size_t);
void *__real_calloc(size_t, size_t);
void *__real_realloc(void *, size_t);
void __real_free(void *);
}
struct Slot { void *ptr; size_t bytes; void *trace[8]; int frames; };
static Slot slots[16384]; // profiler metadata, excluded from measured memory
static size_t current, peak, largest, allocations;
static unsigned depth;
static size_t slot(void *p) { return (reinterpret_cast<uintptr_t>(p) >> 4) % 16384; }
static void record(void *p, size_t n) {
  if (!p || !depth) return;
  size_t i = slot(p);
  for (unsigned k = 0; k < 16384; k++, i = (i + 1) % 16384) {
    if (!slots[i].ptr) {
      slots[i] = {p, n, {}, 0};
      unsigned saved = depth; depth = 0;
      slots[i].frames = backtrace(slots[i].trace, 8);
      depth = saved;
      current += n; allocations++;
      if (current > peak) peak = current;
      if (n > largest) largest = n;
      return;
    }
  }
  std::abort(); // incomplete accounting must never produce a passing result
}
static size_t forget(void *p) {
  if (!p) return 0;
  size_t i = slot(p);
  // Deletions leave holes, so a missing key requires a full scan.
  for (unsigned k = 0; k < 16384; k++, i = (i + 1) % 16384) {
    if (slots[i].ptr == p) {
      size_t n = slots[i].bytes;
      current -= n; slots[i] = {}; return n;
    }
  }
  return 0;
}
extern "C" void hdht_audit_enter(void) { depth++; }
extern "C" void hdht_audit_leave(void) { depth--; }
extern "C" void hdht_audit_snapshot(const char *stage) {
  std::fprintf(stderr, "MEMORY %s live=%zu peak=%zu largest=%zu allocations=%zu\n",
               stage, current, peak, largest, allocations);
  if (std::getenv("HDHT_AUDIT_LEAKS") && std::strcmp(stage,"destroyed")==0) {
    for (const auto &s : slots) if (s.ptr) {
      std::fprintf(stderr,"LIVE %zu\n",s.bytes);
      backtrace_symbols_fd(s.trace,s.frames,2);
    }
  }
}
extern "C" void *__wrap_malloc(size_t n) {
  void *p = __real_malloc(n); record(p, n); return p;
}
extern "C" void *__wrap_calloc(size_t n, size_t s) {
  void *p = __real_calloc(n, s); record(p, n*s); return p;
}
extern "C" void __wrap_free(void *p) { forget(p); __real_free(p); }
extern "C" void *__wrap_realloc(void *p, size_t n) {
  size_t old = forget(p);
  void *q = __real_realloc(p, n);
  if (q) { if (old && !depth) { depth++; record(q, n); depth--; } else record(q, n); }
  else if (n && old) { depth++; record(p, old); depth--; }
  return q;
}
void *operator new(size_t n) { void *p = __wrap_malloc(n); if (!p) throw std::bad_alloc(); return p; }
void *operator new[](size_t n) { return ::operator new(n); }
void operator delete(void *p) noexcept { __wrap_free(p); }
void operator delete[](void *p) noexcept { __wrap_free(p); }
void operator delete(void *p, size_t) noexcept { __wrap_free(p); }
void operator delete[](void *p, size_t) noexcept { __wrap_free(p); }
