import { ApiError } from '@orderloop/api-client';
import type { Reservation } from '@orderloop/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { expectNamedControls } from '../../../test/a11y';
import { mount } from '../../../test/mount';
import { ReservationsTab } from './ReservationsTab';

const uuid = (n: number) => `0197b0a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const reservation = (over: Partial<Reservation>): Reservation => ({
  id: uuid(1),
  variantId: uuid(2),
  locationId: uuid(3),
  quantity: 2,
  status: 'ACTIVE',
  referenceType: null,
  referenceId: null,
  createdAt: '2026-10-21T09:00:00.000Z',
  resolvedAt: null,
  ...over,
});

const api = (items: Reservation[]) => ({
  reservations: {
    list: vi.fn(async () => ({ items, nextCursor: null })),
    release: vi.fn(async () => reservation({ status: 'RELEASED' })),
    fulfil: vi.fn(async () => reservation({ status: 'FULFILLED' })),
  },
});

const manual = reservation({
  id: uuid(10),
  referenceType: 'manual',
  referenceId: 'Holding for a fair',
});
const tiktok = reservation({
  id: uuid(11),
  referenceType: 'tiktok_order',
  referenceId: uuid(500),
  quantity: 3,
});

describe('reservations of TikTok orders', () => {
  it('labels a TikTok reservation, links to its order, and offers no release or fulfil', async () => {
    mount(<ReservationsTab />, api([manual, tiktok]));
    expect(await screen.findByText('Holding for a fair')).toBeTruthy();
    expect(screen.getByText('TikTok order')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the order' })).toHaveAttribute(
      'href',
      `/tiktok-orders/${uuid(500)}`,
    );
    expect(screen.getByText(/released or shipped by TikTok’s status, not by hand/)).toBeTruthy();
    // Only the manual hold has the buttons.
    expect(screen.getAllByRole('button', { name: 'Release' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Fulfil' })).toHaveLength(1);
  });

  it('still lets a manual hold be released', async () => {
    const stub = api([manual]);
    mount(<ReservationsTab />, stub);
    await userEvent.click(await screen.findByRole('button', { name: 'Release' }));
    await waitFor(() => expect(stub.reservations.release).toHaveBeenCalledWith(uuid(10)));
  });

  it('shows the label to a role that cannot change stock, with no buttons', async () => {
    mount(<ReservationsTab />, api([tiktok]), 'ACCOUNTANT');
    expect(await screen.findByText('TikTok order')).toBeTruthy();
    // An accountant cannot change stock: no hint and no buttons either.
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
  });

  it('explains the refusal when the API says the reservation belongs to an order', async () => {
    const stub = api([manual]);
    stub.reservations.release.mockRejectedValueOnce(
      new ApiError(
        'This reservation belongs to an order. Change the order instead of releasing or fulfilling it here.',
        409,
        'conflict',
      ),
    );
    mount(<ReservationsTab />, stub);
    await userEvent.click(await screen.findByRole('button', { name: 'Release' }));
    expect(await screen.findByText(/belongs to an order/)).toBeTruthy();
  });

  it('has named controls', async () => {
    mount(<ReservationsTab />, api([manual, tiktok]));
    await screen.findByText('TikTok order');
    expectNamedControls();
    expect(within(document.body).getAllByRole('link').length).toBeGreaterThan(0);
  });
});
