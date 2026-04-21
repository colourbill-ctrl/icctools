import express from 'express'
import multer from 'multer'
import { execFile } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { unlink, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'

const PORT = parseInt(process.env.VALIDATOR_PORT || '3003', 10)

// In Docker this is on PATH; override ICC_VALIDATOR_PATH for local dev.
const TOOL_PATH = process.env.ICC_VALIDATOR_PATH || 'iccprofiledump'

const app = express()

// ── CORS ──────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// ── Multer: buffer uploaded file in memory (max 16 MB) ────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
})

// ── Health probe ──────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', tool: TOOL_PATH }))

// ── Main validation endpoint ──────────────────────────────────────────────
app.post('/validate', upload.single('profile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      error: 'No file provided. POST multipart/form-data with field name "profile".',
    })
  }

  const tmpFile = join(tmpdir(), `icc-${randomUUID()}.icc`)
  try {
    await writeFile(tmpFile, req.file.buffer)
    const { stdout, exitCode } = await runTool(TOOL_PATH, [tmpFile])
    const data = JSON.parse(stdout)
    data.filename = req.file.originalname
    data.exitCode = exitCode
    res.json(data)
  } catch (err) {
    console.error('Validation error:', err)
    res.status(500).json({ error: err.message })
  } finally {
    await unlink(tmpFile).catch(() => {})
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────
function runTool(toolPath, args) {
  return new Promise((resolve, reject) => {
    execFile(
      toolPath,
      args,
      { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 },
      (err, stdout, stderr) => {
        if (stderr) console.error('Tool stderr:', stderr)

        // ENOENT means the binary wasn't found at all.
        if (err && err.code === 'ENOENT') {
          return reject(new Error(
            `Validator tool not found: "${toolPath}". ` +
            `Build validator-tool/ with CMake and set ICC_VALIDATOR_PATH.`
          ))
        }

        // iccprofiledump exits 1 for non-compliant/critical profiles — expected.
        const exitCode = (err && typeof err.code === 'number') ? err.code : 0
        const out = (stdout || '').trim()

        if (!out) {
          return reject(new Error(
            `Validator tool "${toolPath}" produced no output` +
            (err ? ` (exit: ${err.code}, message: ${err.message})` : '')
          ))
        }

        resolve({ stdout: out, exitCode })
      }
    )
  })
}

// ── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`icctools validator service listening on port ${PORT}`)
  console.log(`Validator tool: ${TOOL_PATH}`)
})
