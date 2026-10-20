import { z } from 'zod';

const isCalendarDate = (value: string): boolean => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};

/** A real calendar date as YYYY-MM-DD: `2026-13-45` and `2026-02-30` are refused, not passed on to the database. */
export const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(isCalendarDate, 'Not a real date');
