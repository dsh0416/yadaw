#include <cstdint>

#include "pluginterfaces/gui/iplugview.h"

#if defined(_MSC_VER)
#include <windows.h>
#endif

static std::int32_t invokeAttach(Steinberg::IPlugView *view, void *parent,
                                 const char *platform) noexcept {
  try {
    return view->attached(parent, platform);
  } catch (...) {
    return 1;
  }
}

extern "C" std::int32_t heron_vst3_guarded_attach(
    Steinberg::IPlugView *view, void *parent, const char *platform) {
#if defined(_MSC_VER)
  __try {
    return invokeAttach(view, parent, platform);
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    return 1;
  }
#else
  return invokeAttach(view, parent, platform);
#endif
}
