/**
 * The next ring number: 10000, 10001, … One statement, so concurrent sign-ups
 * never share a number (D1 runs writes one at a time). Numbers are never
 * reused; a sign-up that fails after this point leaves a gap.
 */
export async function nextRingNumber(db: D1Database): Promise<number> {
  const row = await db
    .prepare("UPDATE counters SET value = value + 1 WHERE name = 'ring_number' RETURNING value")
    .first<{ value: number }>();
  if (!row) throw new Error("counters has no 'ring_number' row: apply the migrations");
  return row.value;
}
