/** Bengali numerals, and the Bangla names of months, weekdays and AM/PM. */

const BENGALI_DIGITS = '০১২৩৪৫৬৭৮৯';

export const localizeDigits = (text: string): string =>
  text.replace(/[0-9]/g, (digit) => BENGALI_DIGITS[Number(digit)]!);

const MONTHS: [RegExp, string][] = [
  [/\bJan(?:uary)?\b/g, 'জানুয়ারি'],
  [/\bFeb(?:ruary)?\b/g, 'ফেব্রুয়ারি'],
  [/\bMar(?:ch)?\b/g, 'মার্চ'],
  [/\bApr(?:il)?\b/g, 'এপ্রিল'],
  // "May" is also an ordinary word: only before a day number or a comma, or after one.
  [/\bMay\b(?=\s+\d|,)/g, 'মে'],
  [/(?<=\d\s)May\b/g, 'মে'],
  [/\bJun(?:e)?\b/g, 'জুন'],
  [/\bJul(?:y)?\b/g, 'জুলাই'],
  [/\bAug(?:ust)?\b/g, 'আগস্ট'],
  [/\bSep(?:t(?:ember)?)?\b/g, 'সেপ্টেম্বর'],
  [/\bOct(?:ober)?\b/g, 'অক্টোবর'],
  [/\bNov(?:ember)?\b/g, 'নভেম্বর'],
  [/\bDec(?:ember)?\b/g, 'ডিসেম্বর'],
];

const WEEKDAYS: [RegExp, string][] = [
  [/\bMonday\b/g, 'সোমবার'],
  [/\bTuesday\b/g, 'মঙ্গলবার'],
  [/\bWednesday\b/g, 'বুধবার'],
  [/\bThursday\b/g, 'বৃহস্পতিবার'],
  [/\bFriday\b/g, 'শুক্রবার'],
  [/\bSaturday\b/g, 'শনিবার'],
  [/\bSunday\b/g, 'রবিবার'],
];

const BANGLA_MONTHS =
  'জানুয়ারি|ফেব্রুয়ারি|মার্চ|এপ্রিল|মে|জুন|জুলাই|আগস্ট|সেপ্টেম্বর|অক্টোবর|নভেম্বর|ডিসেম্বর';

/** A date or time once the month is in Bangla: "19 অক্টোবর 2026", "অক্টোবর 19, 2026, 7:36 PM", "17:30". */
const DATE_OR_TIME = new RegExp(
  [
    `(?:\\d{1,2}\\s)?(?:${BANGLA_MONTHS})`, // [day] month
    `(?:\\s\\d{1,2}(?!\\d))?`, // [day]
    `(?:,?\\s\\d{4})?`, // [year]
    `(?:,?\\s\\d{1,2}:\\d{2}(?:\\s?(?:AM|PM))?)?`, // [time]
    `|\\b\\d{1,2}:\\d{2}(?:\\s?(?:AM|PM))?`, // or a time alone
  ].join(''),
  'g',
);

/**
 * Month and weekday names, AM/PM and the digits of dates and times, in Bangla. Everything else (including digits in codes
 * and names) is left alone.
 */
export function localizeDateText(text: string): string {
  if (!/[A-Za-z]/.test(text) && !/\d:\d/.test(text)) return text;
  let result = text;
  for (const [pattern, bangla] of [...MONTHS, ...WEEKDAYS])
    result = result.replace(pattern, bangla);
  return result.replace(DATE_OR_TIME, (dateOrTime) =>
    localizeDigits(dateOrTime)
      .replace(/\bAM\b/, 'পূর্বাহ্ণ')
      .replace(/\bPM\b/, 'অপরাহ্ণ'),
  );
}
