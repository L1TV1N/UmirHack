export interface FefoCandidate {
  id: string;
  remainingMilli: number;
  expiresOn: string;
  receivedOn: string;
}

export interface Allocation {
  batchId: string;
  milli: number;
}

/** Порядок расхода: ближайший срок, затем более ранняя приёмка, затем идентификатор для стабильности. */
export function compareFefo(a: FefoCandidate, b: FefoCandidate): number {
  if (a.expiresOn !== b.expiresOn) return a.expiresOn < b.expiresOn ? -1 : 1;
  if (a.receivedOn !== b.receivedOn) return a.receivedOn < b.receivedOn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function allocateFefo(
  candidates: readonly FefoCandidate[],
  wantedMilli: number,
): { allocations: Allocation[]; shortMilli: number } {
  const allocations: Allocation[] = [];
  let left = wantedMilli;
  for (const batch of [...candidates].sort(compareFefo)) {
    if (left <= 0) break;
    if (batch.remainingMilli <= 0) continue;
    const take = Math.min(batch.remainingMilli, left);
    allocations.push({ batchId: batch.id, milli: take });
    left -= take;
  }
  return { allocations, shortMilli: Math.max(left, 0) };
}
