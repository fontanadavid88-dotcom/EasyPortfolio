import { addDays, differenceInCalendarDays, format, subDays } from 'date-fns';

export const isYmd = (value?: string | null): value is string => {
  if (!value) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
};

export const parseYmdLocal = (ymd: string): Date => {
  if (!isYmd(ymd)) return new Date(ymd);
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
};

export const diffDaysYmd = (a: string, b: string): number => {
  return differenceInCalendarDays(parseYmdLocal(a), parseYmdLocal(b));
};

export const addDaysYmd = (ymd: string, days: number): string => {
  return format(addDays(parseYmdLocal(ymd), days), 'yyyy-MM-dd');
};

export const subDaysYmd = (ymd: string, days: number): string => {
  return format(subDays(parseYmdLocal(ymd), days), 'yyyy-MM-dd');
};
