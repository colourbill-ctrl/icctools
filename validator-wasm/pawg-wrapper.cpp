// (c) William Li 2026
/**
 * iccpawg WASM wrapper.
 *
 * Exposes the iccPawgReport tool's machine-readable (--json) ICC Profile
 * Assessment Working Group checklist to the browser without modifying the
 * iccDEV source tree. DumpPawgReport() is a normal extern function, so we just
 * compile PawgReport.cpp alongside this wrapper and call it.
 *
 * The tool writes its JSON to stdout, so we redirect stdout into Emscripten's
 * in-memory filesystem (MEMFS, enabled via -sFORCE_FILESYSTEM=1) for the
 * duration of the call and read the captured report back. The JSON text is
 * returned through an embind std::string — safe because it is ASCII/UTF-8.
 *
 * Built with Emscripten; ships as an ES module (iccpawg.mjs + iccpawg.wasm).
 */

#include "PawgReport.h"   // int DumpPawgReport(const char*, bool bUseRead, bool bJson)

#include <emscripten/bind.h>

#include <cstdio>
#include <string>

#include <sys/stat.h>

namespace {

const char* kWorkDir = "/work";
const char* kInputIcc = "/work/profile.icc";
const char* kOutJson  = "/work/pawg.json";

// Independent ICC-bytes cap at the WASM boundary, mirroring MAX_ICC_BYTES in
// frontend/src/App.jsx — pawgReport stages the bytes into MEMFS, so it
// shouldn't trust the JS caller to have bounded them.
constexpr std::size_t kMaxIccBytes = 256ULL * 1024 * 1024;

bool writeFile(const char* path, const char* data, std::size_t len) {
  FILE* f = fopen(path, "wb");
  if (!f) return false;
  bool ok = (len == 0) || (fwrite(data, 1, len, f) == len);
  fclose(f);
  return ok;
}

std::string readFile(const char* path) {
  FILE* f = fopen(path, "rb");
  if (!f) return std::string();
  std::string out;
  char buf[8192];
  std::size_t n;
  while ((n = fread(buf, 1, sizeof buf, f)) > 0) out.append(buf, n);
  fclose(f);
  return out;
}

} // namespace

// Run the PAWG assessment and return the tool's --json report as a string.
// On any failure returns a JSON object with an "error" field so the caller
// always gets parseable JSON.
static std::string pawgReport(const std::string& bytes) {
  if (bytes.size() > kMaxIccBytes)
    return std::string("{\"error\":\"Profile exceeds size limit\"}");

  mkdir(kWorkDir, 0777);

  if (!writeFile(kInputIcc, bytes.data(), bytes.size()))
    return std::string("{\"error\":\"Unable to stage profile in virtual filesystem\"}");

  // Capture the tool's stdout (its --json output) into a MEMFS file. We don't
  // restore stdout afterwards — each call re-opens the same file in "w" mode,
  // which truncates it, so successive reports never accumulate.
  fflush(stdout);
  if (!freopen(kOutJson, "w", stdout))
    return std::string("{\"error\":\"Unable to capture report output\"}");

  bool threw = false;
  try {
    // bUseRead=true: fall back to eager ReadIccProfile() when the strict
    // validation parse fails, so borderline profiles still get a report.
    DumpPawgReport(kInputIcc, /*bUseRead=*/true, /*bJson=*/true);
  } catch (...) {
    threw = true;
  }
  fflush(stdout);

  std::string json = readFile(kOutJson);
  if (threw && json.empty())
    return std::string("{\"error\":\"PAWG report threw an exception\"}");
  if (json.empty())
    return std::string("{\"error\":\"PAWG report produced no output\"}");
  return json;
}

EMSCRIPTEN_BINDINGS(iccpawg) {
  emscripten::function("pawgReport", &pawgReport);
}
