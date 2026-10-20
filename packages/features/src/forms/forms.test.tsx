import { ApiError } from '@orderloop/api-client';
import { LoginBody } from '@orderloop/contracts';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFormState } from './forms';

describe('useFormState', () => {
  it('binds a field to value, change handler and error', () => {
    const { result } = renderHook(() => useFormState({ email: '' }));
    expect(result.current.field('email')).toMatchObject({ value: '', error: undefined });
    act(() => result.current.field('email').onChangeText('a@b.co'));
    expect(result.current.values.email).toBe('a@b.co');
  });

  it('check() returns parsed data, or null with the errors marked on the fields', () => {
    const { result } = renderHook(() => useFormState({ email: 'nope', password: '' }));
    let data: unknown;
    act(() => {
      data = result.current.check(LoginBody, result.current.values);
    });
    expect(data).toBeNull();
    expect(Object.keys(result.current.errors).sort()).toEqual(['email', 'password']);
    expect(result.current.field('email').error).toBeTruthy();

    act(() => {
      result.current.set('email', 'a@b.co');
      result.current.set('password', 'long-enough-password');
    });
    act(() => {
      data = result.current.check(LoginBody, result.current.values);
    });
    expect(data).toMatchObject({ email: 'a@b.co' });
    expect(result.current.errors).toEqual({});
  });

  it('editing a field retires its own error and the summary, and leaves the other fields errors alone', () => {
    const { result } = renderHook(() =>
      useFormState({ name: '', phone: '', city: '' }, { phone: ['customer.phone'] }),
    );
    act(() => {
      result.current.setFormError('Fix the highlighted fields');
      result.current.setErrors({
        name: 'Enter a name',
        'customer.phone': 'Enter a phone',
        'address.city': 'Enter a city',
      });
    });
    act(() => result.current.set('name', 'Rina'));
    expect(result.current.errors).toEqual({
      'customer.phone': 'Enter a phone',
      'address.city': 'Enter a city',
    });
    expect(result.current.formError).toBe('');
    act(() => result.current.set('phone', '017'));
    act(() => result.current.set('city', 'Dhaka')); // "address.city" belongs to "city"
    expect(result.current.errors).toEqual({});
  });

  it('run() ignores a second call while the first is still sending (two Enter presses send once)', async () => {
    const { result } = renderHook(() => useFormState({}));
    let release!: () => void;
    const action = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.run(action);
      second = result.current.run(action);
    });
    expect(await second).toBe(false);
    expect(action).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toBe(true);
    await act(async () => expect(await result.current.run(async () => undefined)).toBe(true)); // usable again
  });

  it('run() is busy while the request runs and resolves to true on success', async () => {
    const { result } = renderHook(() => useFormState({}));
    let release!: () => void;
    let outcome: Promise<boolean>;
    act(() => {
      outcome = result.current.run(() => new Promise<void>((r) => (release = r)));
    });
    expect(result.current.busy).toBe(true);
    await act(async () => {
      release();
      await outcome;
    });
    expect(result.current.busy).toBe(false);
    await expect(outcome!).resolves.toBe(true);
  });

  it('run() shows an API failure on the fields and the form, and resolves to false', async () => {
    const { result } = renderHook(() => useFormState({ sku: '' }));
    let ok = true;
    await act(async () => {
      ok = await result.current.run(() =>
        Promise.reject(
          new ApiError('bad', 422, 'validation_failed', [
            { path: 'body.sku', message: 'Already used' },
          ]),
        ),
      );
    });
    expect(ok).toBe(false);
    expect(result.current.errors).toEqual({ sku: 'Already used' });
    expect(result.current.formError).toBe('Please fix the highlighted fields.');
    expect(result.current.busy).toBe(false);
  });

  it('run() clears the previous errors before trying again', async () => {
    const { result } = renderHook(() => useFormState({ sku: '' }));
    await act(async () => {
      await result.current.run(() => Promise.reject(new ApiError('bad', 409, 'conflict')));
    });
    expect(result.current.formError).toBe('bad');
    await act(async () => {
      await result.current.run(() => Promise.resolve());
    });
    expect(result.current.formError).toBe('');
  });
});
