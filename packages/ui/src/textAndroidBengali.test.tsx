import { screen } from '@testing-library/react';
import { Platform } from 'react-native';
import { afterEach, describe, expect, it } from 'vitest';
import { renderUi } from '../test/render';
import { Text } from './Text';

const original = Platform.OS;
afterEach(() => {
  Platform.OS = original;
});

// Android measures Bengali conjuncts narrower than it paints them, which hides the last word of a name that sits in a row.
describe('Text on Android with Bengali', () => {
  it('leaves a little slack after Bengali text so its last word is not clipped', () => {
    Platform.OS = 'android';
    renderUi(<Text verbatim>রহিম উদ্দিন</Text>);
    const text = screen.getByText(/রহিম/).textContent ?? '';
    expect(text.startsWith('রহিম উদ্দিন')).toBe(true);
    expect(text).toMatch(/ {3,}$/);
  });

  it('does not touch Latin text, taka amounts, or any text off Android', () => {
    Platform.OS = 'android';
    renderUi(
      <>
        <Text>Total</Text>
        <Text>৳2,500.00</Text>
      </>,
    );
    expect(screen.getByText('Total').textContent).toBe('Total');
    expect(screen.getByText('৳2,500.00').textContent).toBe('৳2,500.00');
    Platform.OS = 'ios';
    renderUi(<Text verbatim>রহিম উদ্দিন নাম</Text>);
    expect(screen.getByText('রহিম উদ্দিন নাম').textContent).toBe('রহিম উদ্দিন নাম');
  });
});
