# (c) 2026 William Li
cmake_minimum_required(VERSION 3.24)
project(icc-validator-wasm VERSION 1.0.0 LANGUAGES C CXX)

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
  IccColorimetry.cpp
  IccConvertUTF.cpp IccEncoding.cpp IccEnvVar.cpp IccEval.cpp IccIO.cpp
  IccMatrixMath.cpp IccMpeACS.cpp IccMpeBasic.cpp IccMpeCalc.cpp IccMpeFactory.cpp
  IccMpeSpectral.cpp IccPrmg.cpp IccPcc.cpp IccProfile.cpp IccSolve.cpp
  IccSparseMatrix.cpp IccStructBasic.cpp IccStructFactory.cpp IccTagBasic.cpp
  IccTagComposite.cpp IccTagDict.cpp IccTagEmbedIcc.cpp IccTagFactory.cpp
  IccTagLut.cpp IccTagMPE.cpp IccTagProfSeqId.cpp IccUtil.cpp IccXformFactory.cpp
  IccMD5.cpp IccCmmSearch.cpp IccObject.cpp)

list(TRANSFORM ICCPROFLIB_SOURCES PREPEND "${ICCPROFLIB_DIR}/")

# Generated version headers — both libraries #include these.
set(ICCPROFLIB_VERSION_STRING "${PROJECT_VERSION}-wasm")
set(ICCLIBXML_VERSION_STRING  "${PROJECT_VERSION}-wasm")
set(ICCLIBJSON_DIR "${ICCDEV_ROOT}/IccJSON/IccLibJSON")
configure_file(
  "${ICCPROFLIB_DIR}/IccProfLibVer.h.in"
  "${CMAKE_CURRENT_BINARY_DIR}/generated/IccProfLibVer.h"
  @ONLY)
configure_file(
  "${ICCLIBXML_DIR}/IccLibXMLVer.h.in"
  "${CMAKE_CURRENT_BINARY_DIR}/generated/IccLibXMLVer.h"
  @ONLY)
set(ICCLIBJSON_VERSION_STRING "${PROJECT_VERSION}-wasm")
configure_file(
  "${ICCLIBJSON_DIR}/IccLibJSONVer.h.in"
  "${CMAKE_CURRENT_BINARY_DIR}/generated/IccLibJSONVer.h"
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


# ── iccjson (ICC ↔ JSON, lazy-loaded) ───────────────────────────────────────
# Sibling of iccxml but *much* lighter: IccLibJSON has no third-party
# dependency (nlohmann/json is already on the include path for wrapper.cpp),
# so there's no FetchContent step and the output module is roughly half the
# size of iccxml.{mjs,wasm}. Shipped as a separate artifact so the browser
# still only downloads it when the user clicks Convert to JSON.
option(BUILD_ICCJSON "Build the lazy-loaded ICC↔JSON converter module" ON)

if(BUILD_ICCJSON)
  set(ICCLIBJSON_SOURCES
    IccIoJson.cpp IccMpeJson.cpp IccMpeJsonFactory.cpp IccProfileJson.cpp
    IccTagJson.cpp IccTagJsonFactory.cpp IccUtilJson.cpp)
  list(TRANSFORM ICCLIBJSON_SOURCES PREPEND "${ICCLIBJSON_DIR}/")

  add_executable(iccjson json-wrapper.cpp ${ICCPROFLIB_SOURCES} ${ICCLIBJSON_SOURCES})

  target_include_directories(iccjson PRIVATE
    "${ICCPROFLIB_DIR}"
    "${ICCLIBJSON_DIR}"
    "${CMAKE_CURRENT_BINARY_DIR}/generated"
    "${NLOHMANN_JSON_INCLUDE_DIR}")

  target_compile_options(iccjson PRIVATE
    -O3
    -fexceptions
    -Wno-deprecated-declarations)

  target_link_options(iccjson PRIVATE
    -O3
    -fexceptions
    -lembind
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createIccJsonModule
    -sENVIRONMENT=web,worker,node
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=16MB
    -sMAXIMUM_MEMORY=512MB
    -sSTACK_SIZE=1MB
    -sDYNAMIC_EXECUTION=0
    # Same exception-unwrap exports as iccxml so JS sees readable .what() text.
    -sEXPORTED_RUNTIME_METHODS=getExceptionMessage,decrementExceptionRefcount
    # MEMFS needed only for the write side (CIccProfile::Write patches header
    # size via seek; CIccMemIO doesn't grow). Reads go through MEMFS too to
    # keep the code structure identical to xml-wrapper.cpp.
    -sFORCE_FILESYSTEM=1)

  set_target_properties(iccjson PROPERTIES SUFFIX ".mjs")
endif()


# ── iccconstruct (build profiles from text/params — Group B, lazy-loaded) ───
# The "construct" module: verbs that take text/parameters and emit ICC bytes.
# First capability is fromCube (.cube → DeviceLink); V5→V4 and ApplyToLink will
# join it. No third-party dependency — construct-wrapper.cpp needs only
# IccProfLib (the .cube parser + tag construction are ported inline in
# fromcube-engine.hpp, beside the wrapper, so the quoted #include resolves via
# the compiler's own source-dir search — no extra include dir needed).
option(BUILD_ICCCONSTRUCT "Build the lazy-loaded profile-construction module" ON)

if(BUILD_ICCCONSTRUCT)
  add_executable(iccconstruct construct-wrapper.cpp ${ICCPROFLIB_SOURCES})

  target_include_directories(iccconstruct PRIVATE
    "${ICCPROFLIB_DIR}"
    "${CMAKE_CURRENT_BINARY_DIR}/generated")

  target_compile_options(iccconstruct PRIVATE
    -O3
    -fexceptions
    -Wno-deprecated-declarations)

  target_link_options(iccconstruct PRIVATE
    -O3
    -fexceptions
    -lembind
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createIccConstructModule
    -sENVIRONMENT=web,worker,node
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=16MB
    # 1 GB ceiling (grows lazily): headroom for large DeviceLink grids and the chunked
    # image apply's per-chunk transients. Image rasters stream in ~1 MP chunks via the
    # imageApplyBegin/Chunk/End session (construct-wrapper.cpp), so a big CMYK TIFF no
    # longer needs the whole float image resident (which bad_alloc'd at 512 MB).
    -sMAXIMUM_MEMORY=1024MB
    # 8 MB stack: the Invert Transform (iccApplySearch / CIccCmmSearch) drives a
    # Nelder-Mead search whose cost function recurses through the inverted profile's
    # transform tree per iteration; deep v5/MPE transforms overflowed the former 1 MB
    # stack and hard-trapped the module. Everything else here is shallow.
    -sSTACK_SIZE=8MB
    -sDYNAMIC_EXECUTION=0
    # Same exception-unwrap exports as iccjson so JS reads the throw's .what().
    -sEXPORTED_RUNTIME_METHODS=getExceptionMessage,decrementExceptionRefcount
    # MEMFS: the .cube text is staged in and CIccProfile::Write goes out through
    # a MEMFS path (CIccMemIO doesn't grow-on-write). See construct-wrapper.cpp.
    -sFORCE_FILESYSTEM=1)

  set_target_properties(iccconstruct PROPERTIES SUFFIX ".mjs")
endif()


# ── iccimage (canonical image codecs: libtiff + libpng + libjpeg) ───────────
# Replaces the hand-rolled JS image reader/writers (imageIO.js) and the JS
# embedded-profile parsers (embeddedProfile.js) with real libraries compiled to
# WASM — the tiffview reference (~/code/tiffview/tiff-wasm). libtiff via
# FetchContent pinned to iccDEV's vendored 4.7.1 source (SOURCE_DIR = no network);
# zlib/libpng/libjpeg via Emscripten ports (embuilder-staged by build-wasm.sh,
# passed in through ICCIMG_EM_SYSROOT). Codec set mirrors tiffview: zlib(Deflate)
# on, lzw/packbits/ccitt default-on, everything heavy off.
option(BUILD_ICCIMAGE "Build the image-codec module (libtiff/libpng/libjpeg)" ON)

if(BUILD_ICCIMAGE)
  set(ICCIMG_EM_SYSROOT "" CACHE PATH "Emscripten sysroot with the staged zlib/png/jpeg ports")
  if(ICCIMG_EM_SYSROOT)
    # Point libtiff's find_package(ZLIB) at the Emscripten zlib port.
    set(ZLIB_INCLUDE_DIR "${ICCIMG_EM_SYSROOT}/include" CACHE PATH "" FORCE)
    set(ZLIB_LIBRARY "${ICCIMG_EM_SYSROOT}/lib/wasm32-emscripten/libz.a" CACHE FILEPATH "" FORCE)
  endif()

  set(ICCIMG_TIFF_SRC "${ICCDEV_ROOT}/third_party/libtiff")
  if(NOT EXISTS "${ICCIMG_TIFF_SRC}/CMakeLists.txt")
    message(FATAL_ERROR "libtiff source not found at ${ICCIMG_TIFF_SRC} (BUILD_ICCIMAGE)")
  endif()

  include(FetchContent)
  set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
  set(tiff-tools      OFF CACHE BOOL "" FORCE)
  set(tiff-tests      OFF CACHE BOOL "" FORCE)
  set(tiff-contrib    OFF CACHE BOOL "" FORCE)
  set(tiff-docs       OFF CACHE BOOL "" FORCE)
  set(tiff-deprecated OFF CACHE BOOL "" FORCE)
  set(tiff-install    OFF CACHE BOOL "" FORCE)
  set(cxx             OFF CACHE BOOL "" FORCE)
  set(libdeflate      OFF CACHE BOOL "" FORCE)
  set(zlib            ON  CACHE BOOL "" FORCE)
  set(jpeg            OFF CACHE BOOL "" FORCE)
  set(old-jpeg        OFF CACHE BOOL "" FORCE)
  set(jbig            OFF CACHE BOOL "" FORCE)
  set(lzma            OFF CACHE BOOL "" FORCE)
  set(zstd            OFF CACHE BOOL "" FORCE)
  set(webp            OFF CACHE BOOL "" FORCE)
  set(pixarlog        OFF CACHE BOOL "" FORCE)
  FetchContent_Declare(tiff SOURCE_DIR "${ICCIMG_TIFF_SRC}")
  FetchContent_MakeAvailable(tiff)

  add_executable(iccimage iccimage-wrapper.cpp)
  target_link_libraries(iccimage PRIVATE TIFF::tiff)

  target_compile_options(iccimage PRIVATE
    -O3 -fexceptions -Wno-deprecated-declarations
    -sUSE_ZLIB=1 -sUSE_LIBPNG=1 -sUSE_LIBJPEG=1)

  target_link_options(iccimage PRIVATE
    -O3 -fexceptions -lembind
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createIccImageModule
    -sENVIRONMENT=web,worker,node
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=32MB -sMAXIMUM_MEMORY=2048MB -sSTACK_SIZE=1MB
    -sDYNAMIC_EXECUTION=0
    -sEXPORTED_RUNTIME_METHODS=getExceptionMessage,decrementExceptionRefcount
    -sUSE_ZLIB=1 -sUSE_LIBPNG=1 -sUSE_LIBJPEG=1
    # MEMFS: image bytes are staged in / results read back through MEMFS paths
    # (simplest libtiff/libpng/libjpeg I/O; see iccimage-wrapper.cpp).
    -sFORCE_FILESYSTEM=1)

  set_target_properties(iccimage PROPERTIES SUFFIX ".mjs")
endif()


# ── iccplot (data-first visualization model, lazy-loaded) ──────────────────
# Wraps the IccVizModel engine (profiletool/iccviz/IccVizModel.cpp) — a
# standalone re-implementation of the iccProfileVisualize plots that returns DATA
# (2-D point series + axis hints for graphs) and ICC-normalized samples (for the
# CLUT raster) instead of a PDF/TIFF report. The engine lives HERE in profiletool
# (parallel to iccDEV, which is left untouched — we code around it, never modify
# it); plot-wrapper.cpp is the local embind binding. IccVizModel depends only on
# iccDEV's IccProfLib *library* (compiled in-place via ICCPROFLIB_SOURCES) +
# its own self-contained IccVizMath.hpp / spectralLocus.hpp. No MEMFS (graphs
# cross as JSON, rasters as a Uint8Array), so no FORCE_FILESYSTEM. Fetched only
# when the Profile Plot tab opens. Kept separable so it can be offered back to
# iccDEV's Tools structure later as a discrete PR.
option(BUILD_ICCPLOT "Build the lazy-loaded data-first visualization module" ON)

if(BUILD_ICCPLOT)
  # The IccVizModel engine lives parallel, inside profiletool — NOT in the iccDEV
  # tree (IccVizModel.cpp/.hpp + IccVizMath.hpp + spectralLocus.hpp are all
  # self-contained in profiletool/iccviz/). Only IccProfLib comes from iccDEV.
  set(ICCPLOT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../iccviz")
  if(NOT EXISTS "${ICCPLOT_DIR}/IccVizModel.cpp")
    message(FATAL_ERROR "IccVizModel not found at ${ICCPLOT_DIR}")
  endif()

  add_executable(iccplot plot-wrapper.cpp
    "${ICCPLOT_DIR}/IccVizModel.cpp" ${ICCPROFLIB_SOURCES})

  target_include_directories(iccplot PRIVATE
    "${ICCPROFLIB_DIR}"
    "${ICCPLOT_DIR}"
    "${CMAKE_CURRENT_BINARY_DIR}/generated"
    "${NLOHMANN_JSON_INCLUDE_DIR}")

  target_compile_options(iccplot PRIVATE
    -O3
    -fexceptions
    -Wno-deprecated-declarations)

  target_link_options(iccplot PRIVATE
    -O3
    -fexceptions
    -lembind
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createIccPlotModule
    -sENVIRONMENT=web,worker,node
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=32MB
    -sMAXIMUM_MEMORY=512MB
    -sSTACK_SIZE=1MB
    -sDYNAMIC_EXECUTION=0
    -sEXPORTED_RUNTIME_METHODS=getExceptionMessage,decrementExceptionRefcount)

  set_target_properties(iccplot PROPERTIES SUFFIX ".mjs")
endif()


# ── iccpawg (PAWG assessment report, lazy-loaded) ───────────────────────────
# Wraps the iccPawgReport tool (Tools/CmdLine/IccPawgReport), which emits the
# ICC Profile Assessment Working Group checklist. DumpPawgReport() is a normal
# extern function, so pawg-wrapper.cpp just compiles PawgReport.cpp alongside
# it and captures the tool's --json stdout via MEMFS. No third-party deps (the
# JSON is hand-rolled), so the module stays small. Shipped separately, fetched
# only when the user opens the PAWG tab.
option(BUILD_ICCPAWG "Build the lazy-loaded PAWG assessment module" ON)

if(BUILD_ICCPAWG)
  set(ICCPAWG_DIR "${ICCDEV_ROOT}/Tools/CmdLine/IccPawgReport")
  if(NOT EXISTS "${ICCPAWG_DIR}/PawgReport.cpp")
    message(FATAL_ERROR "iccPawgReport sources not found at ${ICCPAWG_DIR}")
  endif()

  add_executable(iccpawg pawg-wrapper.cpp ${ICCPROFLIB_SOURCES}
    "${ICCPAWG_DIR}/PawgReport.cpp")

  target_include_directories(iccpawg PRIVATE
    "${ICCPROFLIB_DIR}"
    "${ICCPAWG_DIR}"
    "${CMAKE_CURRENT_BINARY_DIR}/generated"
    "${NLOHMANN_JSON_INCLUDE_DIR}")

  target_compile_options(iccpawg PRIVATE
    -O3
    -fexceptions
    -Wno-deprecated-declarations)

  target_link_options(iccpawg PRIVATE
    -O3
    -fexceptions
    -lembind
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createIccPawgModule
    -sENVIRONMENT=web,worker,node
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=32MB
    -sMAXIMUM_MEMORY=512MB
    -sSTACK_SIZE=1MB
    -sDYNAMIC_EXECUTION=0
    -sEXPORTED_RUNTIME_METHODS=getExceptionMessage,decrementExceptionRefcount
    # The tool writes its report to stdout; we redirect that into MEMFS.
    -sFORCE_FILESYSTEM=1)

  set_target_properties(iccpawg PROPERTIES SUFFIX ".mjs")
endif()
