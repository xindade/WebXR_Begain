// Squared distance to a swept segment; no allocations in collision loops.
export function pointSegmentDistanceSq(p, a, b) {
  const x = b.x - a.x, y = b.y - a.y, z = b.z - a.z;
  const lengthSq = x * x + y * y + z * z;
  const t = lengthSq > 1e-12
    ? Math.max(0, Math.min(1, ((p.x - a.x) * x + (p.y - a.y) * y + (p.z - a.z) * z) / lengthSq)) : 0;
  return (p.x - a.x - t * x) ** 2 + (p.y - a.y - t * y) ** 2 + (p.z - a.z - t * z) ** 2;
}
