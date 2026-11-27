import { describe, expect, it } from 'vitest';
import { SPOKEN_TIME } from './time.ts';

const matchesTime = (text: string): boolean => SPOKEN_TIME.test(text);

describe('SPOKEN_TIME', () => {
  it.each([
    "It's 8.",
    "It's 08:30.",
    "It's 7.30 p.m.",
    'The time is 0730.',
    "It's eight.",
    "It's eight a.m. in the morning.",
    "It's seven thirty.",
    "It's half past seven.",
    "It's quarter to eight.",
    "It's eight o'clock.",
    "It's 8 in the afternoon.",
    "It's 20:12.",
    'It is noon.',
    'It is midnight.',
    "It's twenty past seven.",
  ])('accepts %s', (text) => {
    expect(matchesTime(text)).toBe(true);
  });

  it.each(['I cannot tell the time.', "I don't know what time it is."])('rejects %s', (text) => {
    expect(matchesTime(text)).toBe(false);
  });
});
