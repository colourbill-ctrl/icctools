cmake_minimum_required(VERSION 3.16)
project(icc-validator-tool VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ── Locate IccProfLib ────────────────────────────────────────────────────────
# Expected layout when built from iccDEV:
#   /opt/iccdev/IccProfLib/          ← headers
#   /opt/iccdev/Build/IccProfLib/    ← compiled library
#
# Override ICCDEV_ROOT to point elsewhere.
set(ICCDEV_ROOT "/opt/iccdev" CACHE PATH "Root of the iccDEV source/build tree")

find_path(ICCPROFLIB_INCLUDE_DIR
  NAMES IccProfile.h
  PATHS "${ICCDEV_ROOT}/IccProfLib"
  NO_DEFAULT_PATH
  REQUIRED)

find_library(ICCPROFLIB_LIB
  NAMES IccProfLib2-static IccProfLib2-static.lib IccProfLib2 IccProfLib2.lib
  PATHS
    "${ICCDEV_ROOT}/Build/IccProfLib"       # Linux CMake build output
    "${ICCDEV_ROOT}/IccProfLib/Debug"       # Windows MSVC Debug
    "${ICCDEV_ROOT}/IccProfLib/Release"     # Windows MSVC Release
  NO_DEFAULT_PATH
  REQUIRED)

message(STATUS "IccProfLib headers : ${ICCPROFLIB_INCLUDE_DIR}")
message(STATUS "IccProfLib library : ${ICCPROFLIB_LIB}")

# ── nlohmann/json ────────────────────────────────────────────────────────────
find_package(nlohmann_json REQUIRED)

# ── Target ───────────────────────────────────────────────────────────────────
add_executable(iccprofiledump main.cpp)

target_include_directories(iccprofiledump PRIVATE "${ICCPROFLIB_INCLUDE_DIR}")

target_link_libraries(iccprofiledump PRIVATE
  "${ICCPROFLIB_LIB}"
  nlohmann_json::nlohmann_json)

# IccProfLib uses pthreads on Linux for some operations
if(UNIX)
  find_package(Threads REQUIRED)
  target_link_libraries(iccprofiledump PRIVATE Threads::Threads)
endif()

install(TARGETS iccprofiledump DESTINATION bin)
