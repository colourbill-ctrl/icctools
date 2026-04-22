cmake_minimum_required(VERSION 3.24)
project(icc-validator-wasm VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "This project must be configured with emcmake (emscripten).")
endif()

# ── Locate iccDEV source ────────────────────────────────────────────────────
set(ICCDEV_ROOT "/home/colour/code/iccdev" CACHE PATH "Root of iccDEV source tree")
set(ICCPROFLIB_DIR "${ICCDEV_ROOT}/IccProfLib")
set(ICCLIBXML_DIR  "${ICCDEV_ROOT}/IccXML/IccLibXML")

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

# Generated version headers — both libraries #include these.
set(ICCPROFLIB_VERSION_STRING "${PROJECT_VERSION}-wasm")
set(ICCLIBXML_VERSION_STRING  "${PROJECT_VERSION}-wasm")
configure_file(
  "${ICCPROFLIB_DIR}/IccProfLibVer.h.in"
  "${CMAKE_CURRENT_BINARY_DIR}/generated/IccProfLibVer.h"
  @ONLY)
configure_file(
  "${ICCLIBXML_DIR}/IccLibXMLVer.h.in"
  "${CMAKE_CURRENT_BINARY_DIR}/generated/IccLibXMLVer.h"
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

# ── iccprofiledump (read-only validator, shipped since the start) ───────────
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


# ── iccxml (ICC ↔ XML, lazy-loaded) ─────────────────────────────────────────
# Not enabled by default — opt in with `cmake -DBUILD_ICCXML=ON`. This adds
# libxml2 (built via FetchContent) + IccLibXML to the output, so the module
# is ~2.5 MB vs 740 KB for iccprofiledump. We ship it as a separate .mjs/.wasm
# pair so the browser only downloads it when the user clicks Convert to XML.
option(BUILD_ICCXML "Build the lazy-loaded ICC↔XML converter module" ON)

if(BUILD_ICCXML)
  # --- libxml2: vendored via FetchContent, static, minimal config -----------
  # Emscripten ships no libxml2 port, so we build it from upstream. Pinning
  # via GIT_TAG keeps the build reproducible without needing a tarball hash.
  include(FetchContent)

  # Features we genuinely don't need in the browser:
  set(LIBXML2_WITH_PYTHON   OFF CACHE BOOL "" FORCE)
  set(LIBXML2_WITH_TESTS    OFF CACHE BOOL "" FORCE)
  set(LIBXML2_WITH_PROGRAMS OFF CACHE BOOL "" FORCE)
  set(LIBXML2_WITH_ICONV    OFF CACHE BOOL "" FORCE)
  set(LIBXML2_WITH_LZMA     OFF CACHE BOOL "" FORCE)
  set(LIBXML2_WITH_ZLIB     OFF CACHE BOOL "" FORCE)
  set(LIBXML2_WITH_HTTP     OFF CACHE BOOL "" FORCE)
  set(LIBXML2_WITH_THREADS  OFF CACHE BOOL "" FORCE)
  set(LIBXML2_WITH_THREAD_ALLOC OFF CACHE BOOL "" FORCE)
  set(LIBXML2_WITH_MODULES  OFF CACHE BOOL "" FORCE)
  set(LIBXML2_WITH_CATALOG  OFF CACHE BOOL "" FORCE)
  set(LIBXML2_WITH_FTP      OFF CACHE BOOL "" FORCE)
  set(LIBXML2_WITH_HTML     OFF CACHE BOOL "" FORCE)
  set(LIBXML2_WITH_LEGACY   OFF CACHE BOOL "" FORCE)
  # Kept ON (IccLibXML pulls them in transitively via headers or runtime):
  #   LIBXML2_WITH_TREE, _SAX, _SAX1, _READER, _WRITER, _OUTPUT,
  #   _VALID, _SCHEMAS, _SCHEMATRON, _XPATH, _XPTR, _XINCLUDE,
  #   _PATTERN, _REGEXPS, _UNICODE, _ISO8859X, _C14N
  # (RelaxNG is unconditionally #included by IccProfileXml.h even though we
  #  pass an empty RelaxNG dir at runtime to skip validation.)

  set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

  FetchContent_Declare(
    libxml2
    GIT_REPOSITORY https://gitlab.gnome.org/GNOME/libxml2.git
    GIT_TAG        v2.12.6
    GIT_SHALLOW    TRUE
  )
  FetchContent_MakeAvailable(libxml2)

  # --- IccLibXML sources ----------------------------------------------------
  set(ICCLIBXML_SOURCES
    IccIoXml.cpp IccMpeXml.cpp IccMpeXmlFactory.cpp IccProfileXml.cpp
    IccTagXml.cpp IccTagXmlFactory.cpp IccUtilXml.cpp)
  list(TRANSFORM ICCLIBXML_SOURCES PREPEND "${ICCLIBXML_DIR}/")

  add_executable(iccxml xml-wrapper.cpp ${ICCPROFLIB_SOURCES} ${ICCLIBXML_SOURCES})

  target_include_directories(iccxml PRIVATE
    "${ICCPROFLIB_DIR}"
    "${ICCLIBXML_DIR}"
    "${CMAKE_CURRENT_BINARY_DIR}/generated"
    "${NLOHMANN_JSON_INCLUDE_DIR}")

  # libxml2's CMake build exposes its target as LibXml2::LibXml2 (the static
  # library when BUILD_SHARED_LIBS is OFF). This brings its INTERFACE include
  # dir along, so <libxml/parser.h> resolves automatically.
  target_link_libraries(iccxml PRIVATE LibXml2::LibXml2)

  target_compile_options(iccxml PRIVATE
    -O3
    -fexceptions
    -Wno-deprecated-declarations)

  target_link_options(iccxml PRIVATE
    -O3
    -fexceptions
    -lembind
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createIccXmlModule
    -sENVIRONMENT=web,worker,node
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=32MB
    -sMAXIMUM_MEMORY=512MB
    -sSTACK_SIZE=1MB
    -sDYNAMIC_EXECUTION=0
    # Expose getExceptionMessage() so JS callers can read the throw's what()
    # string — embind otherwise surfaces an opaque CppException pointer.
    -sEXPORTED_RUNTIME_METHODS=getExceptionMessage,decrementExceptionRefcount
    # FILESYSTEM stays ON (default) — xml-wrapper.cpp routes I/O through MEMFS
    # because IccLibXML's LoadXml() / SaveIccProfile() both take file paths.
    -sFORCE_FILESYSTEM=1)

  set_target_properties(iccxml PROPERTIES SUFFIX ".mjs")
endif()
