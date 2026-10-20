import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { makeNavigation, renderUi } from '../../test/render';
import { Button } from '../Button';
import { Link } from './Link';
import { NavLink } from './NavLink';
import { Tabs } from './Tabs';

describe('Button', () => {
  it('calls onPress', async () => {
    const onPress = vi.fn();
    renderUi(<Button onPress={onPress}>Save</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('ignores presses while loading or disabled, and says so', async () => {
    const onPress = vi.fn();
    renderUi(
      <>
        <Button loading onPress={onPress}>
          Busy
        </Button>
        <Button disabled onPress={onPress}>
          Off
        </Button>
      </>,
    );
    // Disabled buttons have pointer-events: none, so a real click cannot land; force it, as a script or assistive tech might.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByRole('button', { name: 'Busy' }));
    await user.click(screen.getByRole('button', { name: 'Off' }));
    expect(onPress).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Busy' })).toHaveAttribute('aria-busy', 'true');
  });

  it('with an href it is a real link that navigates through the app router', async () => {
    const { navigation } = renderUi(<Button href="/products/new">New product</Button>);
    const link = screen.getByRole('link', { name: 'New product' });
    expect(link).toHaveAttribute('href', '/products/new');
    await userEvent.click(link);
    expect(navigation.push).toHaveBeenCalledWith('/products/new');
  });
});

describe('Link', () => {
  it('is an anchor with the href, and a plain click uses the router', async () => {
    const { navigation } = renderUi(<Link href="/login">Sign in</Link>);
    const a = screen.getByRole('link', { name: 'Sign in' });
    expect(a).toHaveAttribute('href', '/login');
    await userEvent.click(a);
    expect(navigation.push).toHaveBeenCalledWith('/login');
  });

  it('leaves "open in a new tab" clicks to the browser', () => {
    const { navigation } = renderUi(<Link href="/login">Sign in</Link>);
    // jsdom would try to follow the link (the browser's job here); stop that so only our handler is under test.
    const stop = (e: Event) => e.preventDefault();
    document.addEventListener('click', stop, true);
    fireEvent.click(screen.getByRole('link', { name: 'Sign in' }), { ctrlKey: true });
    fireEvent.click(screen.getByRole('link', { name: 'Sign in' }), { metaKey: true });
    document.removeEventListener('click', stop, true);
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('opens an external link in a new tab, without opener access, and without the router', async () => {
    const { navigation } = renderUi(
      <Link href="https://example.com" external>
        Docs
      </Link>,
    );
    const a = screen.getByRole('link', { name: 'Docs' });
    // jsdom cannot navigate; stop the click's default action so only our own handler is under test.
    const stop = (e: Event) => e.preventDefault();
    document.addEventListener('click', stop, true);
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', expect.stringContaining('noopener'));
    fireEvent.click(a);
    document.removeEventListener('click', stop, true);
    expect(navigation.push).not.toHaveBeenCalled();
  });
});

describe('NavLink', () => {
  it('marks the current page, including its sub-pages', () => {
    renderUi(
      <>
        <NavLink href="/products">Products</NavLink>
        <NavLink href="/inventory">Stock</NavLink>
      </>,
      makeNavigation('/products/abc'),
    );
    expect(screen.getByRole('link', { name: 'Products' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Stock' })).not.toHaveAttribute('aria-current');
  });
});

describe('Tabs', () => {
  const items = [
    { value: 'a', label: 'First' },
    { value: 'b', label: 'Second' },
  ];

  it('exposes tab semantics and reports a change', async () => {
    const onChange = vi.fn();
    renderUi(<Tabs label="Views" items={items} value="a" onChange={onChange} />);
    expect(screen.getByRole('tablist', { name: 'Views' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'First' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Second' })).toHaveAttribute('aria-selected', 'false');
    await userEvent.click(screen.getByRole('tab', { name: 'Second' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });
});
