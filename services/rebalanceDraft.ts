export type RebalanceDraftV1 = {
  v: 1;
  portfolioId: string;
  savedAt: number;
  valuationDate?: string;
  baseCurrency?: string;
  strategy?: string;
  totalAmount?: number;
  rowAmounts?: Record<string, number>;
  options?: Record<string, any>;
};

const DRAFT_PREFIX = 'rebalance.draft.';

export const getDraftKey = (portfolioId: string) => `${DRAFT_PREFIX}${portfolioId}`;

export const loadDraft = (portfolioId: string): RebalanceDraftV1 | null => {
  if (!portfolioId || typeof localStorage === 'undefined') return null;
  const key = getDraftKey(portfolioId);
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as RebalanceDraftV1;
    if (!parsed || parsed.v !== 1 || parsed.portfolioId !== portfolioId || typeof parsed.savedAt !== 'number') {
      localStorage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
};

export const saveDraft = (portfolioId: string, draft: RebalanceDraftV1) => {
  if (!portfolioId || typeof localStorage === 'undefined') return;
  const key = getDraftKey(portfolioId);
  try {
    localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // ignore storage errors
  }
};

export const clearDraft = (portfolioId: string) => {
  if (!portfolioId || typeof localStorage === 'undefined') return;
  localStorage.removeItem(getDraftKey(portfolioId));
};

export const getDraftAgeLabel = (savedAt: number) => {
  if (!Number.isFinite(savedAt)) return '';
  const diffMs = Date.now() - savedAt;
  if (diffMs < 60_000) return 'ora';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 60) return `${mins} min fa`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h fa`;
  const days = Math.floor(hours / 24);
  return `${days} g fa`;
};
