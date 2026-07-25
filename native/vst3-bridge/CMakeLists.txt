set(YADAW_VST3_SDK_ROOT "${CMAKE_SOURCE_DIR}/third_party/vst3sdk")
set(YADAW_VST3_PLATFORM_SOURCE)
if(WIN32)
  set(YADAW_VST3_PLATFORM_SOURCE
    "${YADAW_VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module_win32.cpp")
elseif(APPLE)
  set(YADAW_VST3_PLATFORM_SOURCE
    "${YADAW_VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module_mac.mm")
else()
  set(YADAW_VST3_PLATFORM_SOURCE
    "${YADAW_VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module_linux.cpp")
endif()

add_executable(yadaw-vst3-probe
  src/probe.cpp
  "${YADAW_VST3_SDK_ROOT}/public.sdk/source/vst/hosting/plugprovider.cpp"
  ${YADAW_VST3_PLATFORM_SOURCE}
)

target_compile_features(yadaw-vst3-probe PRIVATE cxx_std_17)
target_link_libraries(yadaw-vst3-probe PRIVATE sdk_hosting)
target_include_directories(yadaw-vst3-probe PRIVATE "${YADAW_VST3_SDK_ROOT}")
set_target_properties(yadaw-vst3-probe PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${CMAKE_BINARY_DIR}/bin"
)
set_target_properties(yadaw-vst3-probe PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${CMAKE_BINARY_DIR}/bin"
)

if(APPLE)
  set_source_files_properties(${YADAW_VST3_PLATFORM_SOURCE}
    PROPERTIES COMPILE_FLAGS "-fobjc-arc")
  find_library(COCOA_FRAMEWORK Cocoa REQUIRED)
  target_link_libraries(yadaw-vst3-probe PRIVATE ${COCOA_FRAMEWORK})
endif()

smtg_target_setup_universal_binary(yadaw-vst3-probe)
