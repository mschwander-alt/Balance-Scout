import { describe, it, expect } from 'vitest';
import { parseAmount, formatChf } from '../src/domain/amount.js';

const c = (s: unknown) => parseAmount(s)?.cents ?? null;

describe('parseAmount', () => {
  it.each([
    ["1'234.50", 123450], ['1’234.50', 123450], ['1 234,50', 123450], ['1.234,50', 123450],
    ['1,234.50', 123450], ['-1234.5', -123450], ["(1'234.50)", -123450], ["1'234.50-", -123450],
    ["CHF 1'234.50", 123450], ["1'234.–", 123400], ['1234', 123400], ["1'234'567.89", 123456789],
    ['0.05', 5], ['−12.00', -1200], ['1.234.567,00', 123456700], ['12,5', 1250], ['1,234', 123400],
    [1234.56, 123456], [-0.1 + 0.3, 20],
  ])('%s -> %s', (input, cents) => expect(c(input)).toBe(cents));

  it.each(['abc', '', '12a', '1.23.4', "12'34.00", '--5', '1,2,3'])('ungültig: %s', s => expect(c(s)).toBeNull());

  it('erkennt explizites Vorzeichen und Dezimalstellen', () => {
    expect(parseAmount('-5.00')).toMatchObject({ explicitSign: true, decimals: 2 });
    expect(parseAmount('5')).toMatchObject({ explicitSign: false, decimals: 0 });
  });

  it('formatChf', () => {
    expect(formatChf(-123456789)).toBe("-1'234'567.89");
    expect(formatChf(5)).toBe('0.05');
  });
});
