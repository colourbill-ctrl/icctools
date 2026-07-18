// (c) 2026 William Li
/**
 * iccconstruct WASM wrapper — the "construct a profile" module (Group B).
 *
 * Exposes profile-building verbs that take text/parameters and return ICC bytes:
 *   fromCube(string cubeText, string filename) → Uint8Array   (.cube → DeviceLink)
 *
 * (V5→V4 display and ApplyToLink will join this module as Group B lands.)
 *
 * Data flow mirrors the proven json-wrapper.cpp / xml-wrapper.cpp text→ICC path:
 *   - INPUT: the .cube is text. We stage it into Emscripten MEMFS so the ported
 *     CubeFile parser (fromcube-engine.hpp) — which reads through a FILE* — works
 *     unchanged. No host filesystem is touched; MEMFS is an in-memory tmpfs.
 *   - OUTPUT: CIccProfile::Write needs a seekable, grow-on-write IO that
 *     CIccMemIO lacks, so we SaveIccProfile() to a MEMFS path and read the bytes
 *     back — the same MEMFS hop json-wrapper.cpp documents. Both temp files are
 *     unlinked before returning so repeated calls don't grow MEMFS.
 *
 * Error contract matches jsonToIcc: success returns a Uint8Array; any failure
 * throws std::runtime_error(msg), which the JS side unwraps via
 * getExceptionMessage() and shows to the user (so a bad cube reports the exact
 * reason — "LUT too large to process", "1DLUTs are not supported", …).
 */
#include "fromcube-engine.hpp"

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

// A .cube grid is capped at 255 by the engine (255³×3×4 ≈ 190 MB), so the *text*
// that encodes it is far smaller — but this bounds the input the browser can
// hand us before we allocate/stage anything, independent of the JS-side check.
// 32 MB matches kMaxJsonBytes / kMaxXmlBytes. Do NOT reuse the XML DTD/entity
// guard here — .cube is not XML.
constexpr std::size_t kMaxCubeBytes = 32ULL * 1024 * 1024;

// Per-call counter so concurrent/reentrant calls don't collide on a MEMFS path
// (same shape as json-wrapper.cpp::uniqueMemfsPath).
std::string uniqueMemfsPath(const char* prefix, const char* ext) {
  static std::atomic<std::uint64_t> counter{0};
  char buf[64];
  std::snprintf(buf, sizeof(buf), "/tmp/profiletool_%s_%llu.%s",
                prefix,
                static_cast<unsigned long long>(counter.fetch_add(1)),
                ext);
  return std::string(buf);
}

bool writeFile(const char* path, const void* data, std::size_t size) {
  FILE* f = std::fopen(path, "wb");
  if (!f) return false;
  bool ok = size == 0 || std::fwrite(data, 1, size, f) == size;
  std::fclose(f);
  return ok;
}

bool readFile(const char* path, std::vector<std::uint8_t>& out) {
  FILE* f = std::fopen(path, "rb");
  if (!f) return false;
  std::fseek(f, 0, SEEK_END);
  long n = std::ftell(f);
  if (n < 0) { std::fclose(f); return false; }
  std::fseek(f, 0, SEEK_SET);
  out.resize(static_cast<std::size_t>(n));
  bool ok = out.empty() || std::fread(out.data(), 1, out.size(), f) == out.size();
  std::fclose(f);
  return ok;
}

emscripten::val makeUint8Array(const std::uint8_t* data, std::size_t size) {
  emscripten::val u8 = emscripten::val::global("Uint8Array").new_(size);
  u8.call<void>("set",
    emscripten::val(emscripten::typed_memory_view(size, data)));
  return u8;
}

// Best-effort cleanup so a long-lived module doesn't accumulate MEMFS temp files.
void removeQuiet(const std::string& path) { std::remove(path.c_str()); }

emscripten::val fromCubeImpl(const std::string& cubeText, const std::string& filename) {
  if (cubeText.size() > kMaxCubeBytes) {
    throw std::runtime_error(
      "Cube file exceeds " + std::to_string(kMaxCubeBytes / (1024 * 1024)) + " MB limit");
  }
  // A label for the "Device link created from <x>" default texts; the browser
  // has no path, so use the uploaded filename (or a generic stand-in).
  const std::string srcLabel = filename.empty() ? "cube file" : filename;

  const std::string inPath = uniqueMemfsPath("cube_in", "cube");
  const std::string outPath = uniqueMemfsPath("cube_out", "icc");

  // Stage the .cube text so the FILE*-based parser can read it.
  if (!writeFile(inPath.c_str(), cubeText.data(), cubeText.size())) {
    throw std::runtime_error("Internal error staging the cube data");
  }

  std::string err;
  std::vector<std::uint8_t> bytes;
  {
    iccconstruct::CubeFile cube(inPath.c_str());

    // parseHeader / sizeLut3D mirror the CLI's main() gate (iccFromCube.cpp:467-475).
    if (!cube.parseHeader()) {
      removeQuiet(inPath);
      throw std::runtime_error(cube.error().empty() ? "Unable to parse the cube file"
                                                    : cube.error());
    }
    if (!cube.sizeLut3D()) {
      removeQuiet(inPath);
      throw std::runtime_error("No 3DLUT (LUT_3D_SIZE) found in the cube file");
    }

    CIccProfile profile;
    if (!iccconstruct::buildDeviceLinkFromCube(cube, profile, srcLabel, err)) {
      removeQuiet(inPath);
      throw std::runtime_error(err.empty() ? "Unable to build the device link" : err);
    }

    // Serialize via MEMFS (see file header). Default save method = the CLI's
    // SaveIccProfile(path, &profile) two-arg form (icVersionBasedID).
    if (!SaveIccProfile(outPath.c_str(), &profile)) {
      removeQuiet(inPath);
      removeQuiet(outPath);
      throw std::runtime_error("Unable to serialize the generated profile");
    }
    // `profile` (and its attached tags) is freed here as it leaves scope.
  }

  if (!readFile(outPath.c_str(), bytes)) {
    removeQuiet(inPath);
    removeQuiet(outPath);
    throw std::runtime_error("Internal error reading back the generated profile");
  }
  removeQuiet(inPath);
  removeQuiet(outPath);

  return makeUint8Array(bytes.data(), bytes.size());
}

// Exception-safe boundary: rethrow our own runtime_errors verbatim (their
// message is the user-facing reason), and convert any other C++ throw into a
// readable message so no profile can raise an opaque embind exception.
emscripten::val fromCube(const std::string& cubeText, const std::string& filename) {
  try {
    return fromCubeImpl(cubeText, filename);
  } catch (const std::runtime_error&) {
    throw;  // already carries a user-facing message
  } catch (const std::exception& e) {
    throw std::runtime_error(std::string("fromCube failed: ") + e.what());
  } catch (...) {
    throw std::runtime_error("fromCube failed with an unknown error");
  }
}

} // namespace

EMSCRIPTEN_BINDINGS(iccconstruct) {
  emscripten::function("fromCube", &fromCube);
}
