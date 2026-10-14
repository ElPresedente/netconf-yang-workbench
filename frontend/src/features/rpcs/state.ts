import type { RetrievalProvenance } from '../../../../shared/types';

export function afterRpc(previous: RetrievalProvenance | null): RetrievalProvenance | null {
  return previous ? { ...previous, stale: true } : null;
}
