import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mount } from '../../test/mount';
import { QueryBoundary } from './QueryBoundary';
import { SectionBoundary } from './SectionBoundary';

const base = { isPending: false, isError: false, error: null, refetch: vi.fn() };

describe('QueryBoundary', () => {
  it('shows the data once loaded and a spinner while there is none', () => {
    const { rerender } = mount(
      <QueryBoundary {...base} isPending label="Loading orders">
        Orders
      </QueryBoundary>,
      {},
    );
    expect(screen.getByRole('progressbar', { name: 'Loading orders' })).toBeInTheDocument();
    rerender(<QueryBoundary {...base}>Orders</QueryBoundary>);
    expect(screen.getByText('Orders')).toBeInTheDocument();
  });

  it('shows an error with a retry when there is nothing to show', async () => {
    const refetch = vi.fn();
    mount(
      <QueryBoundary {...base} isError error={new Error('boom')} refetch={refetch}>
        Orders
      </QueryBoundary>,
      {},
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Orders')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('keeps cached data when a refresh fails, with a small notice instead of an error', async () => {
    const refetch = vi.fn();
    mount(
      <QueryBoundary {...base} isError error={new Error('boom')} data={[1]} refetch={refetch}>
        Orders
      </QueryBoundary>,
      {},
    );
    expect(screen.getByText('Orders')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Could not refresh');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('says it is offline, instead of spinning for ever, when nothing is loaded and the fetch is paused', async () => {
    const refetch = vi.fn();
    mount(
      <QueryBoundary {...base} isPending fetchStatus="paused" refetch={refetch}>
        Orders
      </QueryBoundary>,
      {},
    );
    expect(screen.getByText('You are offline')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('still spins while a fetch is under way', () => {
    mount(
      <QueryBoundary {...base} isPending fetchStatus="fetching">
        Orders
      </QueryBoundary>,
      {},
    );
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.queryByText('You are offline')).not.toBeInTheDocument();
  });
});

describe('SectionBoundary', () => {
  const props = { ...base, label: 'Loading costs' };

  it('shows placeholders announced as its label while loading', () => {
    mount(
      <SectionBoundary {...props} isPending>
        x
      </SectionBoundary>,
      {},
    );
    expect(screen.getByRole('status', { name: 'Loading costs' })).toBeInTheDocument();
  });

  it('says it is offline when nothing is loaded and the fetch is paused', () => {
    mount(
      <SectionBoundary {...props} isPending fetchStatus="paused">
        x
      </SectionBoundary>,
      {},
    );
    expect(screen.getByText('You are offline')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading costs' })).not.toBeInTheDocument();
  });

  it('keeps cached data when a refresh fails', () => {
    mount(
      <SectionBoundary {...props} isError error={new Error('boom')} data={{}}>
        Costs
      </SectionBoundary>,
      {},
    );
    expect(screen.getByText('Costs')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
