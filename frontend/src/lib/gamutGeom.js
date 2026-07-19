// (c) 2026 William Li
//
// Pure-JS gamut geometry derived from the iccviz boundary MESH (vizPlot.gamutMesh):
// a 2-D constant-plane SLICE and the mesh's Lab bounds for the 3-D view.
//
// Why the slice lives here (not in C++/WASM): the mesh already crossed the WASM
// boundary once, and a slice is a pure geometric projection of it — computing it in
// JS gives instant response to the L*/a*/b* slider (no WASM round-trip per drag) and
// guarantees the slice is exactly consistent with the drawn shell. It reproduces
// chardata's slice algorithm (edge-plane crossings + a 2-D convex hull), but walks
// the mesh's TRIANGLE edges rather than device-grid edges — the convex hull of the
// crossings is identical either way (a diagonal edge's crossing lies between its two
// grid-edge crossings, so it never extends the hull).
//
// Plane / plot convention — matches chardata's renderSlicePlot EXACTLY so the slice
// reads the same in both apps (L* is kept VERTICAL for the a*/b* slices):
//   axis 0  L* = value  → plot (x, y) = (a*, b*)   — equal-aspect
//   axis 1  a* = value  → plot (x, y) = (b*, L*)
//   axis 2  b* = value  → plot (x, y) = (a*, L*)
// Lab component indices: 0 = L*, 1 = a*, 2 = b*. `x`/`y` are the plotted axes.
const PLANE = [
  { x: 1, y: 2 },  // L* slice → x=a*, y=b*
  { x: 2, y: 0 },  // a* slice → x=b*, y=L*
  { x: 1, y: 0 },  // b* slice → x=a*, y=L*
]

// Andrew's monotone chain: convex hull of 2-D points, returned CCW. O(n log n).
// Points are [u,v]. Returns [] for < 3 distinct points.
function convexHull2D(pts) {
  if (pts.length < 3) return []
  const p = pts.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]))
  // Drop exact duplicates (cheap; keeps the cross-product test well-behaved).
  const uniq = []
  for (const q of p) {
    const last = uniq[uniq.length - 1]
    if (!last || last[0] !== q[0] || last[1] !== q[1]) uniq.push(q)
  }
  if (uniq.length < 3) return []
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = []
  for (const q of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper = []
  for (let i = uniq.length - 1; i >= 0; i--) {
    const q = uniq[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  lower.pop(); upper.pop()
  return lower.concat(upper)   // CCW ring
}

// finiteVertex — true when vertex i of the mesh is fully finite.
function finiteV(verts, i) {
  const o = i * 3
  return Number.isFinite(verts[o]) && Number.isFinite(verts[o + 1]) && Number.isFinite(verts[o + 2])
}

// sliceHull — intersect the boundary mesh with the plane {axis == value} and return
// the 2-D convex hull of the crossing points in that plane. `mesh` is the vizPlot
// gamutMesh output ({vertices:Float32Array, triangles:Int32Array}). Returns
// { axis, value, plane:{uComp,vComp}, hull:[[u,v],…], raw:[[u,v],…] } or null when
// too few crossings to form a polygon.
export function sliceHull(mesh, axis, value) {
  if (!mesh || !mesh.vertices || !mesh.triangles) return null
  const { x: xc, y: yc } = PLANE[axis] ?? PLANE[0]
  const verts = mesh.vertices
  const tris = mesh.triangles
  const raw = []

  // One crossing per straddling edge, interpolated onto the plane. `a`/`b` are
  // vertex indices; the sliced component of each is compared to `value`; if they
  // straddle it, lerp the plotted (x,y) coords at the crossing fraction.
  const addCrossing = (a, b) => {
    if (!finiteV(verts, a) || !finiteV(verts, b)) return
    const ca = verts[a * 3 + axis], cb = verts[b * 3 + axis]
    // Straddle test: endpoints on opposite sides of the plane (inclusive of touching).
    if ((ca < value && cb < value) || (ca > value && cb > value)) return
    const denom = cb - ca
    const t = Math.abs(denom) < 1e-9 ? 0 : (value - ca) / denom
    const xa = verts[a * 3 + xc], xb = verts[b * 3 + xc]
    const ya = verts[a * 3 + yc], yb = verts[b * 3 + yc]
    raw.push([xa + (xb - xa) * t, ya + (yb - ya) * t])
  }

  for (let i = 0; i < tris.length; i += 3) {
    const v0 = tris[i], v1 = tris[i + 1], v2 = tris[i + 2]
    addCrossing(v0, v1); addCrossing(v1, v2); addCrossing(v2, v0)
  }
  if (raw.length < 3) return null
  const hull = convexHull2D(raw)
  if (hull.length < 3) return null
  return { axis, value, plane: { xComp: xc, yComp: yc }, hull, raw }
}

// meshBounds — Lab min/max over the mesh's FINITE vertices. Used to frame
// the 3-D view (centre + scale) and to bound the slice slider. Returns null if the
// mesh has no finite vertices.
export function meshBounds(mesh) {
  if (!mesh || !mesh.vertices) return null
  const v = mesh.vertices
  const n = v.length / 3
  let Lmin = Infinity, Lmax = -Infinity, amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity
  let cnt = 0
  for (let i = 0; i < n; i++) {
    const L = v[i * 3], a = v[i * 3 + 1], b = v[i * 3 + 2]
    if (!Number.isFinite(L) || !Number.isFinite(a) || !Number.isFinite(b)) continue
    if (L < Lmin) Lmin = L; if (L > Lmax) Lmax = L
    if (a < amin) amin = a; if (a > amax) amax = a
    if (b < bmin) bmin = b; if (b > bmax) bmax = b
    cnt++
  }
  if (!cnt) return null
  return { L: [Lmin, Lmax], a: [amin, amax], b: [bmin, bmax] }
}

// Combined bounds across several meshes (the 1..N overlay) → one shared frame so all
// gamuts sit in the same coordinate box. Accepts an array of meshBounds() results.
export function unionBounds(boundsList) {
  const bs = boundsList.filter(Boolean)
  if (!bs.length) return null
  const acc = {
    L: [Infinity, -Infinity], a: [Infinity, -Infinity], b: [Infinity, -Infinity],
  }
  for (const b of bs) {
    acc.L[0] = Math.min(acc.L[0], b.L[0]); acc.L[1] = Math.max(acc.L[1], b.L[1])
    acc.a[0] = Math.min(acc.a[0], b.a[0]); acc.a[1] = Math.max(acc.a[1], b.a[1])
    acc.b[0] = Math.min(acc.b[0], b.b[0]); acc.b[1] = Math.max(acc.b[1], b.b[1])
  }
  return acc
}
