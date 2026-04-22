cmake_minimum_required(VERSION 3.16)
project(icc-validator-wasm VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "This project must be configured with emcmake (emscripten).")
endif()

# ── Locate iccDEV source ────────────────────────────────────────────────────
set(ICCDEV_ROOT "/home/colour/code/iccdev" CACHE PATH "Root of iccDEV source tree")
set(ICCPROFLIB_DIR "${ICCDEV_ROOT}/IccProfLib")

if(NOT EXISTS "${ICCPROFLIB_DIR}/IccProfile.h")
  message(FATAL_ERROR "IccProfLib headers not found at ${ICCPROFLIB_DIR}")
endif()

# Authoritative source list — mirrors Build/Cmake/IccProfLib/CMakeLists.txt.
set(ICCPROFLIB_SOURCES
  IccApplyBPC.cpp IccArrayBasic.cpp IccArrayFactory.cpp IccCAM.cpp IccCmm.cpp
  IccConvertUTF.cpp IccEncoding.cpp IccEnvVar.cpp IccEval.cpp IccIO.cpp
  IccMatrixMath.cpp IccMpeACS.cpp IccMpeBasic.cpp IccMpeCalc.cpp IccMpeFactory.cpp
  IccMpeSpectral.cpp IccPrmg.cpp IccPcc.cpp IccProfile.cpp IccSolve.cpp
  IccSparseMatrix.cpp IccStructBasic.cpp IccStructFactory.cpp IccTagBasic.cpp
  IccTagComposite.cpp IccTagDict.cpp IccTagEmbedIcc.cpp IccTagFactory.cpp
  IccTagLut.cpp IccTagMPE.cpp IccTagProfSeqId.cpp IccUtil.cpp IccXformFactory.cpp
  IccMD5.cpp IccCmmSearch.cpp)

list(TRANSFORM ICCPROFLIB_SOURCES PREPEND "${ICCPROFLIB_DIR}/")

# Generated version header — IccProfLib sources #include <IccProfLibVer.h>.
set(ICCPROFLIB_VERSION_STRING "${PROJECT_VERSION}-wasm")
configure_file(
  "${ICCPROFLIB_DIR}/IccProfLibVer.h.in"
  "${CMAKE_CURRENT_BINARY_DIR}/generated/IccProfLibVer.h"
  @ONLY)

# ── nlohmann/json (host system header) ──────────────────────────────────────
# We can't add /usr/include directly to the include path under Emscripten —
# that would pull in host glibc headers and shadow the wasm sysroot. Instead
# we symlink only the nlohmann/ subdir into our build tree and include from
# there.
find_path(NLOHMANN_JSON_SRC
  NAMES nlohmann/json.hpp
  PATHS /usr/include /usr/local/include
  NO_CMAKE_FIND_ROOT_PATH
  NO_DEFAULT_PATH)
if(NOT NLOHMANN_JSON_SRC)
  message(FATAL_ERROR "nlohmann/json.hpp not found — install nlohmann-json3-dev")
endif()
message(STATUS "nlohmann/json host dir : ${NLOHMANN_JSON_SRC}/nlohmann")
file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/third-party")
file(CREATE_LINK
  "${NLOHMANN_JSON_SRC}/nlohmann"
  "${CMAKE_CURRENT_BINARY_DIR}/third-party/nlohmann"
  SYMBOLIC)
set(NLOHMANN_JSON_INCLUDE_DIR "${CMAKE_CURRENT_BINARY_DIR}/third-party")

# ── Target ──────────────────────────────────────────────────────────────────
add_executable(iccprofiledump wrapper.cpp ${ICCPROFLIB_SOURCES})

target_include_directories(iccprofiledump PRIVATE
  "${ICCPROFLIB_DIR}"
  "${CMAKE_CURRENT_BINARY_DIR}/generated"
  "${NLOHMANN_JSON_INCLUDE_DIR}")

target_compile_options(iccprofiledump PRIVATE
  -O3
  -fexceptions
  -Wno-deprecated-declarations)

target_link_options(iccprofiledump PRIVATE
  -O3
  -fexceptions
  -lembind
  -sMODULARIZE=1
  -sEXPORT_ES6=1
  -sEXPORT_NAME=createIccModule
  -sENVIRONMENT=web,worker,node
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=16MB
  -sMAXIMUM_MEMORY=512MB
  -sSTACK_SIZE=1MB
  # Disable emission of new Function()/eval() so the module is CSP-safe.
  # Embind and runtime wrappers fall back to precomputed paths.
  -sDYNAMIC_EXECUTION=0)

# Emscripten outputs .js + .wasm beside the target; rename to .mjs for ES module
set_target_properties(iccprofiledump PROPERTIES
  SUFFIX ".mjs")
