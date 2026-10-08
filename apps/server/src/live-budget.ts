import { ProbeError } from './model-error.js';

export function createLiveRequestBudget() {
  let requests = 0;
  return {
    reserve(approved: string | undefined, limit: string | undefined): number {
      if (approved !== '1') throw new ProbeError('LIVE_NOT_APPROVED');
      if (limit === 'unlimited') return ++requests;
      const max = Number(limit ?? 0);
      if (!Number.isSafeInteger(max) || max < 1) throw new ProbeError('LIVE_NOT_APPROVED');
      if (requests >= max) throw new ProbeError('LIVE_REQUEST_BUDGET_EXCEEDED');
      return ++requests;
    },
  };
}
// One process-wide counter for FIXTURE diagnosis and local repair LIVE requests.
export const sharedLiveBudget = createLiveRequestBudget();
