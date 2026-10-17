import { ApiError } from '@orderloop/api-client';
import { LoginBody } from '@orderloop/contracts';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
