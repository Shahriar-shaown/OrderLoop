import { describe, expect, it } from 'vitest';
import { AddressFields, CustomerFields, Division, normalizeDivision } from './orders.js';

const address = {
  recipientName: 'Rina Akter',
  phone: '01712-345678',
  line1: 'House 5\nRoad 3\tDhanmondi',
  area: 'Dhanmondi',
  district: 'Dhaka',
  division: 'Dhaka',
};

describe('normalizeDivision', () => {
  it('accepts the canonical names in any case, and common spellings', () => {
    expect(normalizeDivision('dhaka')).toBe('Dhaka');
    expect(normalizeDivision(' Dhaka Division ')).toBe('Dhaka');
    expect(normalizeDivision('Chittagong')).toBe('Chattogram');
    expect(normalizeDivision('BARISAL')).toBe('Barishal');
    expect(normalizeDivision('Mymensing')).toBe('Mymensingh');
    expect(normalizeDivision('Sylet')).toBe('Sylhet');
    expect(normalizeDivision('Paris')).toBeNull();
    expect(normalizeDivision('')).toBeNull();
  });
  it('is applied to API input, which stores the canonical name', () => {
    expect(Division.parse('chittagong')).toBe('Chattogram');
    expect(Division.safeParse('Gotham').success).toBe(false);
    expect(AddressFields.parse({ ...address, division: 'Barisal' }).division).toBe('Barishal');
  });
});

describe('free text', () => {
  it('lets an address and notes keep line breaks and tabs', () => {
    expect(AddressFields.parse(address).line1).toBe('House 5\nRoad 3\tDhanmondi');
    expect(CustomerFields.shape.notes.parse('Call first\r\nthen deliver')).toBe(
      'Call first\r\nthen deliver',
    );
  });
  it('still refuses other control and invisible characters, and line breaks in a name', () => {
    expect(AddressFields.safeParse({ ...address, line1: 'House\u0007 5' }).success).toBe(false);
    expect(AddressFields.safeParse({ ...address, line1: 'House‮5' }).success).toBe(false);
    expect(AddressFields.safeParse({ ...address, recipientName: 'Rina\nAkter' }).success).toBe(
      false,
    );
    expect(CustomerFields.shape.notes.safeParse('x\u0000y').success).toBe(false);
  });
});
