import { screen } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderUi } from '../../test/render';
import { DataTable } from '../data/DataTable';
import { Pagination } from '../data/Pagination';
import { StatCard } from '../data/StatCard';
import { Spinner } from '../feedback/Spinner';
import { Checkbox } from '../inputs/Checkbox';
import { Switch } from '../inputs/Controls';
import { QuantityStepper } from '../inputs/QuantityStepper';
import { SearchField } from '../inputs/SearchField';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { Breadcrumbs } from '../layout/Breadcrumbs';
import { Tabs } from '../navigation/Tabs';
import { SelectMenu } from '../overlays/SelectMenu';
import { registerCatalog } from './catalog';
import { I18nProvider } from './I18nProvider';

// Sample strings of the kind a screen passes in (the shared catalogue is checked by catalog.test.ts).
beforeAll(() =>
  registerCatalog('bn', {
    'Search orders': 'অর্ডার খুঁজুন',
    'Find by number': 'নম্বর দিয়ে খুঁজুন',
    'Pay on delivery': 'ডেলিভারিতে পেমেন্ট',
    Quantity: 'পরিমাণ',
    Courier: 'কুরিয়ার',
    Revenue: 'আয়',
    'Order status': 'অর্ডারের অবস্থা',
    Home: 'হোম',
  }),
);

const bangla = (ui: React.ReactElement) => renderUi(<I18nProvider initial="bn">{ui}</I18nProvider>);

describe('accessible names in Bangla', () => {
  it('translate on inputs: search box (label and placeholder), checkbox, switch, stepper, segmented control', () => {
    bangla(
      <>
        <SearchField label="Search orders" placeholder="Find by number" />
        <Checkbox checked={false} onChange={() => undefined} label="Pay on delivery" hideLabel />
        <Switch label="Pay on delivery" value onChange={() => undefined} />
        <QuantityStepper value="2" onChange={() => undefined} label="Quantity" />
        <SegmentedControl
          label="Colour theme"
          value="auto"
          onChange={() => undefined}
          segments={[{ value: 'auto', label: 'Auto' }]}
        />
      </>,
    );
    expect(screen.getByRole('searchbox', { name: 'অর্ডার খুঁজুন' })).toHaveAttribute(
      'placeholder',
      'নম্বর দিয়ে খুঁজুন',
    );
    expect(screen.getByRole('checkbox', { name: 'ডেলিভারিতে পেমেন্ট' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'ডেলিভারিতে পেমেন্ট' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'পরিমাণ' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'পরিমাণ কমান' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'রঙের থিম' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'অটো' })).toBeInTheDocument();
  });

  it('translate on menus, navigation and data: select menu, tabs, pagination, breadcrumbs, stat card, spinner', () => {
    bangla(
      <>
        <SelectMenu
          label="Language"
          value="a"
          onChange={() => undefined}
          options={[{ value: 'a', label: 'Light' }]}
        />
        <Tabs
          label="Order status"
          value="a"
          onChange={() => undefined}
          items={[{ value: 'a', label: 'Courier' }]}
        />
        <Pagination summary="1" hasNext onNext={() => undefined} />
        <Breadcrumbs items={[{ label: 'Home' }]} />
        <StatCard label="Revenue" value="৳10" />
        <Spinner />
      </>,
    );
    expect(screen.getByRole('combobox', { name: 'ভাষা: লাইট' })).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'অর্ডারের অবস্থা' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'পাতা' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'ব্রেডক্রাম্ব' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'আয়: ৳১০' })).toBeInTheDocument();
    expect(screen.getByLabelText('লোড হচ্ছে')).toBeInTheDocument();
  });

  it('translate on a table: its name, its scroll region and the select boxes', () => {
    bangla(
      <DataTable
        label="Courier"
        rowKey={(r) => r.id}
        rows={[{ id: '1001' }]}
        selection={{ selected: [], onChange: () => undefined }}
        columns={[{ key: 'id', header: 'Order', render: (r) => r.id }]}
      />,
    );
    expect(screen.getByRole('table', { name: 'কুরিয়ার' })).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'কুরিয়ার, পাশে স্ক্রল করা যায়' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'সব সারি বাছুন' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '১০০১ বাছুন' })).toBeInTheDocument();
  });
});
