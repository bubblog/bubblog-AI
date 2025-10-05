// Minimal KST time utilities and range normalization

const KST_OFFSET_MINUTES = 9 * 60; // UTC+9

const toDate = (isoOrDate: string | Date): Date => (isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate));

export const nowUtc = (): Date => new Date();

export const toKst = (d: Date): Date => {
  // Convert UTC date to KST by adding offset
  return new Date(d.getTime() + KST_OFFSET_MINUTES * 60 * 1000);
};

export const fromKstToUtc = (d: Date): Date => {
  return new Date(d.getTime() - KST_OFFSET_MINUTES * 60 * 1000);
};

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
const endOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

export const startOfMonth = (year: number, monthIndex0: number): Date => new Date(year, monthIndex0, 1, 0, 0, 0, 0);
export const endOfMonth = (year: number, monthIndex0: number): Date => new Date(year, monthIndex0 + 1, 0, 23, 59, 59, 999);

export const startOfQuarter = (year: number, quarter: number): Date => {
  const m0 = (quarter - 1) * 3; // 0-based month index
  return new Date(year, m0, 1, 0, 0, 0, 0);
};
export const endOfQuarter = (year: number, quarter: number): Date => {
  const m0 = quarter * 3 - 1; // end month index
  return new Date(year, m0 + 1, 0, 23, 59, 59, 999);
};

export type AbsoluteRange = { from: string; to: string };

export const toAbsoluteRangeKst = (input: { type: string; [k: string]: any }, base: Date = nowUtc()): AbsoluteRange | null => {
  try {
    const baseKst = toKst(base);
    const year = baseKst.getFullYear();
    if (input.type === 'relative') {
      const unit = String(input.unit);
      const value = Math.max(1, parseInt(String(input.value || '1'), 10));
      const toK = endOfDay(baseKst);
      const fromK = new Date(toK.getTime());
      if (unit === 'day') fromK.setDate(fromK.getDate() - value + 1);
      else if (unit === 'week') fromK.setDate(fromK.getDate() - value * 7 + 1);
      else if (unit === 'month') fromK.setMonth(fromK.getMonth() - value);
      else if (unit === 'year') fromK.setFullYear(fromK.getFullYear() - value);
      const fromUtc = fromKstToUtc(startOfDay(fromK));
      const toUtc = fromKstToUtc(toK);
      return { from: fromUtc.toISOString(), to: toUtc.toISOString() };
    }
    if (input.type === 'absolute') {
      const from = new Date(input.from);
      const to = new Date(input.to);
      return { from: from.toISOString(), to: to.toISOString() };
    }
    if (input.type === 'month') {
      const m = Math.max(1, Math.min(12, parseInt(String(input.month), 10)));
      const y = input.year ? parseInt(String(input.year), 10) : year;
      const fromK = startOfMonth(y, m - 1);
      const toK = endOfMonth(y, m - 1);
      return { from: fromKstToUtc(fromK).toISOString(), to: fromKstToUtc(toK).toISOString() };
    }
    if (input.type === 'year') {
      const y = parseInt(String(input.year), 10);
      const fromK = startOfMonth(y, 0);
      const toK = endOfMonth(y, 11);
      return { from: fromKstToUtc(fromK).toISOString(), to: fromKstToUtc(toK).toISOString() };
    }
    if (input.type === 'quarter') {
      const q = Math.max(1, Math.min(4, parseInt(String(input.quarter), 10)));
      const y = input.year ? parseInt(String(input.year), 10) : year;
      const fromK = startOfQuarter(y, q);
      const toK = endOfQuarter(y, q);
      return { from: fromKstToUtc(fromK).toISOString(), to: fromKstToUtc(toK).toISOString() };
    }
  } catch {
    // ignore
  }
  return null;
};

