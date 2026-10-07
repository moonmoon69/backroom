/** A calendar date with no time or time zone. `month` runs from 1 (January) to 12 (December). */
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/** Reads a `YYYY-MM-DD` date. Throws a RangeError for any other shape, a month outside 1..12 or a day outside 1..31. */
export function parseDate(isoDate: string): CalendarDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new RangeError(`expected a YYYY-MM-DD date, got "${isoDate}"`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) throw new RangeError(`month out of range in "${isoDate}"`);
  if (day < 1 || day > 31) throw new RangeError(`day out of range in "${isoDate}"`);
  return { year, month, day };
}

/** Writes a date as `YYYY-MM-DD`. */
export function formatDate(date: CalendarDate): string {
  const year = String(date.year).padStart(4, "0");
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Gregorian leap years: every fourth year, except centuries that are not a multiple of 400. */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** The number of days in a month of a given year (`month` is 1..12). */
export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`month must be 1..12, got ${month}`);
  }
  const february = isLeapYear(year) ? 29 : 28;
  const days = [31, february, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 31;
}

/** The last day of the month that a `YYYY-MM-DD` date falls in: "2026-04-10" gives "2026-04-30". */
export function endOfMonth(isoDate: string): string {
  const { year, month } = parseDate(isoDate);
  return formatDate({ year, month, day: daysInMonth(year, month) });
}

/**
 * Moves a `YYYY-MM-DD` date by whole months (a negative count moves back). The day is kept where the target month
 * has it and otherwise becomes that month's last day, so "2026-03-31" plus one month is "2026-04-30".
 */
export function addMonths(isoDate: string, months: number): string {
  const date = parseDate(isoDate);
  const index = date.year * 12 + (date.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return formatDate({ year, month, day: Math.min(date.day, daysInMonth(year, month)) });
}
