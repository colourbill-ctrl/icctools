# Test corpus — malformed ICC profiles

A small set of deliberately malformed/edge-case ICC profiles used to smoke-test
profiletool's validation output (the WASM build of iccDEV's `ValidateIccProfile`).
Each one exercises a specific validation path or formatting case.

These are tiny (≤568 bytes) and not real device profiles — do **not** use them
for colour conversion. They exist only to confirm the validator reports the right
level/status/messages after a WASM rebuild or an upstream iccDEV change.

## Running headlessly

```bash
node test-corpus/run-corpus.mjs                 # uses frontend/public/wasm + this folder
node test-corpus/run-corpus.mjs <wasmDir> <corpusDir>
```

Prints the same `validation` JSON the browser UI renders. Use it to diff output
before/after an iccDEV bump.

## What each profile checks

| Profile | Expected level | Key message(s) |
|---|---|---|
| `added-bytes.icc` | warning | `5 bytes of unexpected data between profileDescriptionTag and mediaWhitePointTag.` + `6 bytes … between greenTRCTag and blueTRCTag.` |
| `version-unknown.icc` | warning | `Major version number (6) is unexpected.` + `Profile declares version 6.30 but uses ICC v2 tag types; …` |
| `bad-illuminant.icc` | warning | `Non D50 Illuminant XYZ values` |
| `bad-CMM.icc` | warning | `Unknown 'EVIL' = 4556494C: Unregistered CMM signature.` |
| `max-redcurvevalue.icc` | warning | `redTRCTag: - Degenerate gamma value (256.0) produces an unusable tone response curve.` |
| `missing-required.icc` | error (non-compliant) | `Required tags missing.` + `Unknown 'xxxx' … Unknown Tag.` |
| `zero-tags.icc` | error (critical) | `No tags present.` |
| `beyond-eof.icc` | — | `Failed to parse ICC profile` (no validation object) |

### Notes

- **Single-dash formatting:** `added-bytes.icc` and `version-unknown.icc` are the
  regression guards for the doubled-dash fix in iccDEV PR #1222 (profiletool 1.1.3).
  Their messages must render `Warning! - <text>` (one dash), not `Warning! -  - <text>`.
  In the UI the `Warning! - ` prefix shows as the ⚠ pill, so the message body must
  start directly with the text (no leading `- `).
- **Tag-level `: -` is correct:** `max-redcurvevalue.icc` shows
  `redTRCTag: - Degenerate gamma value…`. The `: -` there is the intended
  tag-level convention (`prefix + tagPath + " - " + message`), not a bug — leave it.
- **`beyond-eof.icc` is intentionally left "Failed to parse"** rather than
  best-effort inspected: a tag declares an extent past end-of-file, a known
  viral-payload shape. This is a deliberate product decision, not a validator gap.

## Provenance

SHA-256 of the committed files:

```
45eaa55b6a5214c16537a0d02f3dbd72d1ea16807bc8c64f293a14ae914899c8  added-bytes.icc
9837133a568defd5cea1bdfb0f652fbe526bbce056532c6e7cef8e833d6a9e23  bad-CMM.icc
4de2ef4bcfd98e827ce14825638883cd5786001b106076377219af43d5a333d8  bad-illuminant.icc
297afd39c71134dd16e7b3285be4c76af63d29fe13c26481b7bafa911e218e7d  beyond-eof.icc
5adc3d97a7bfd0a5a7bd903e26bbc3c09eab2875aa8f68632993216c9363d4d5  max-redcurvevalue.icc
97c6a7de9905f9d7f574a6c598d1fe1ca53c6bd223dbb509b20e50dc0869a826  missing-required.icc
c5c8248a527c153f34dfd11a424157e8ef053ac2bb14c212e57eba5822afb23e  version-unknown.icc
db6310b314410412233f63dc68e0e41f9db404e637bfd6bb5eaa45fc541d2b1f  zero-tags.icc
```
