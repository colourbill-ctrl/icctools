import { createContext, useCallback, useContext, useMemo, useState } from 'react'

// Numeric display base for the tag directory's offset / size / pad columns.
// Persisted like the other settings-blade preferences; default 'hex' because
// ICC byte offsets are conventionally read in hexadecimal. Shared through a
// context (rather than body classes, the way the theme is) because TagTable
// needs the value at render time and must re-render when it changes.
const KEY = 'profiletool.numBase'

function read() {
  const v = localStorage.getItem(KEY)
  return v === 'dec' || v === 'hex' ? v : 'hex'
}

// Format a (possibly negative) integer per the active base. Hex carries a 0x
// prefix; the sign is kept outside the prefix for negatives (e.g. pad overlap
// → "-0x4"). Non-numeric input passes through unchanged.
export function formatInt(n, base) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return n ?? ''
  if (base === 'hex') return (n < 0 ? '-0x' : '0x') + Math.abs(n).toString(16)
  return String(n)
}

const NumberBaseContext = createContext(null)

export function NumberBaseProvider({ children }) {
  const [base, setBaseState] = useState(read)

  const setBase = useCallback((next) => {
    setBaseState(next)
    try { localStorage.setItem(KEY, next) } catch (_) { /* private mode */ }
  }, [])

  // `fmt` is bound to the current base so consumers can call fmt(n) directly.
  const value = useMemo(
    () => ({ base, setBase, fmt: (n) => formatInt(n, base) }),
    [base, setBase],
  )
  return <NumberBaseContext.Provider value={value}>{children}</NumberBaseContext.Provider>
}

export function useNumberBase() {
  const ctx = useContext(NumberBaseContext)
  if (!ctx) throw new Error('useNumberBase must be used inside <NumberBaseProvider>')
  return ctx
}
