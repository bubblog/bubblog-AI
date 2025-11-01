// KST 기반 시간 계산과 범위 정규화 유틸리티

const KST_OFFSET_MINUTES = 9 * 60; // UTC+9 오프셋(분)

const toDate = (isoOrDate: string | Date): Date => (isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate));

export const nowUtc = (): Date => new Date();

export const toKst = (d: Date): Date => {
  // UTC 시각에 오프셋을 더해 KST로 변환
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
  const m0 = (quarter - 1) * 3; // 0부터 시작하는 분기 첫 달 인덱스
  return new Date(year, m0, 1, 0, 0, 0, 0);
};
export const endOfQuarter = (year: number, quarter: number): Date => {
  const m0 = quarter * 3 - 1; // 분기 마지막 달 인덱스
  return new Date(year, m0 + 1, 0, 23, 59, 59, 999);
};

export type AbsoluteRange = { from: string; to: string };

// 다양한 시간 필터 입력을 KST 기준 ISO 범위로 변환
export const toAbsoluteRangeKst = (input: { type: string; [k: string]: any }, base: Date = nowUtc()): AbsoluteRange | null => {
  try {
    const baseKst = toKst(base);
    const year = baseKst.getFullYear();
    // 미리 정의된 기간 프리셋 처리
    if (input.type === 'named') {
      const p = String(input.preset || '').toLowerCase();
      const endK = endOfDay(baseKst);
      const beginOfTodayK = startOfDay(baseKst);
      const endUtc = fromKstToUtc(endK).toISOString();
      const todayStartUtc = fromKstToUtc(beginOfTodayK).toISOString();
      if (p === 'all' || p === 'all_time') return null; // 시간 필터 없음
      if (p === 'today') return { from: todayStartUtc, to: endUtc };
      if (p === 'yesterday') {
        const yK = new Date(beginOfTodayK.getTime());
        yK.setDate(yK.getDate() - 1);
        return { from: fromKstToUtc(startOfDay(yK)).toISOString(), to: fromKstToUtc(endOfDay(yK)).toISOString() };
      }
      const daysBack = (n: number) => {
        const toK = endK;
        const fromK = new Date(toK.getTime());
        fromK.setDate(fromK.getDate() - (n - 1));
        return { from: fromKstToUtc(startOfDay(fromK)).toISOString(), to: fromKstToUtc(toK).toISOString() };
      };
      if (p === 'last_7_days') return daysBack(7);
      if (p === 'last_14_days') return daysBack(14);
      if (p === 'last_30_days') return daysBack(30);
      if (p === 'this_month') {
        const fromK = startOfMonth(year, baseKst.getMonth());
        const toK = endOfMonth(year, baseKst.getMonth());
        return { from: fromKstToUtc(fromK).toISOString(), to: fromKstToUtc(toK).toISOString() };
      }
      if (p === 'last_month') {
        const m = baseKst.getMonth();
        const yAdj = m === 0 ? year - 1 : year;
        const mAdj = m === 0 ? 11 : m - 1;
        const fromK = startOfMonth(yAdj, mAdj);
        const toK = endOfMonth(yAdj, mAdj);
        return { from: fromKstToUtc(fromK).toISOString(), to: fromKstToUtc(toK).toISOString() };
      }
      return null; // 알 수 없는 프리셋이면 필터 제거
    }
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
    if (input.type === 'label') {
      const raw = String(input.label || '').trim();
      if (!raw) return null;
      const s = raw.replace(/\s+/g, '').toLowerCase();
      const endK = endOfDay(baseKst);
      // 라벨 형식으로 표현된 공통 기간 패턴 지원
      const startTodayK = startOfDay(baseKst);
      const toUtcStr = fromKstToUtc(endK).toISOString();
      const fromTodayUtcStr = fromKstToUtc(startTodayK).toISOString();
      const daysBack = (n: number) => {
        const toK = endK;
        const fromK = new Date(toK.getTime());
        fromK.setDate(fromK.getDate() - (n - 1));
        return { from: fromKstToUtc(startOfDay(fromK)).toISOString(), to: fromKstToUtc(toK).toISOString() };
      };
      if (s === 'all' || s === 'all_time') return null; // 필터 제거
      if (s === 'today') return { from: fromTodayUtcStr, to: toUtcStr };
      if (s === 'yesterday') {
        const yK = new Date(startTodayK.getTime());
        yK.setDate(yK.getDate() - 1);
        return { from: fromKstToUtc(startOfDay(yK)).toISOString(), to: fromKstToUtc(endOfDay(yK)).toISOString() };
      }
      if (s === 'last_7_days') return daysBack(7);
      if (s === 'last_14_days') return daysBack(14);
      if (s === 'last_30_days') return daysBack(30);
      if (s === 'this_month') {
        const fromK = startOfMonth(year, baseKst.getMonth());
        const toK = endOfMonth(year, baseKst.getMonth());
        return { from: fromKstToUtc(fromK).toISOString(), to: fromKstToUtc(toK).toISOString() };
      }
      if (s === 'last_month') {
        const m = baseKst.getMonth();
        const yAdj = m === 0 ? year - 1 : year;
        const mAdj = m === 0 ? 11 : m - 1;
        const fromK = startOfMonth(yAdj, mAdj);
        const toK = endOfMonth(yAdj, mAdj);
        return { from: fromKstToUtc(fromK).toISOString(), to: fromKstToUtc(toK).toISOString() };
      }
      // 1) YYYY_to_now / YYYY-to-now 패턴
      let m = s.match(/^(\d{4})(?:_|-|to)+now$/);
      if (m) {
        const y = parseInt(m[1], 10);
        const fromK = startOfMonth(y, 0);
        return { from: fromKstToUtc(fromK).toISOString(), to: fromKstToUtc(endK).toISOString() };
      }
      // 2) YYYY-YYYY / YYYY..YYYY / YYYY_to_YYYY 패턴
      m = s.match(/^(\d{4})(?:\.|_|-|to){1,2}(\d{4})$/);
      if (m) {
        const y1 = parseInt(m[1], 10);
        const y2 = parseInt(m[2], 10);
        const a = Math.min(y1, y2);
        const b = Math.max(y1, y2);
        const fromK = startOfMonth(a, 0);
        const toK = endOfMonth(b, 11);
        return { from: fromKstToUtc(fromK).toISOString(), to: fromKstToUtc(toK).toISOString() };
      }
      // 3) YYYY-Qn 또는 Qn-YYYY 패턴
      m = s.match(/^(\d{4})(?:-|_)q([1-4])$/);
      if (m) {
        const y = parseInt(m[1], 10);
        const q = parseInt(m[2], 10);
        const fromK = startOfQuarter(y, q);
        const toK = endOfQuarter(y, q);
        return { from: fromKstToUtc(fromK).toISOString(), to: fromKstToUtc(toK).toISOString() };
      }
      m = s.match(/^q([1-4])(?:-|_)?(\d{4})$/);
      if (m) {
        const q = parseInt(m[1], 10);
        const y = parseInt(m[2], 10);
        const fromK = startOfQuarter(y, q);
        const toK = endOfQuarter(y, q);
        return { from: fromKstToUtc(fromK).toISOString(), to: fromKstToUtc(toK).toISOString() };
      }
      // 4) YYYY-MM 형식
      m = s.match(/^(\d{4})(?:-|_)?(\d{1,2})$/);
      if (m) {
        const y = parseInt(m[1], 10);
        const month = Math.max(1, Math.min(12, parseInt(m[2], 10)));
        const fromK = startOfMonth(y, month - 1);
        const toK = endOfMonth(y, month - 1);
        return { from: fromKstToUtc(fromK).toISOString(), to: fromKstToUtc(toK).toISOString() };
      }
      // 5) YYYY 단일 연도
      m = s.match(/^(\d{4})$/);
      if (m) {
        const y = parseInt(m[1], 10);
        const fromK = startOfMonth(y, 0);
        const toK = endOfMonth(y, 11);
        return { from: fromKstToUtc(fromK).toISOString(), to: fromKstToUtc(toK).toISOString() };
      }
      return null; // 해석할 수 없는 라벨
    }
  } catch {
    // 무시
  }
  return null;
};
