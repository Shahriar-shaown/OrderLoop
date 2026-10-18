import AxeBuilder from '@axe-core/playwright';
import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test';
import { MAILPIT, PORTS } from './env';

export const API = `http://localhost:${PORTS.api}`;
/** A test-only password for accounts created on the isolated end-to-end stack. */
export const PASSWORD = 'Orderloop-e2e-2026!';

/**
 * Chrome logs a console error for every failed request. The tests provoke some on purpose (a wrong password, a refused
 * stock change, the anonymous "is there a session?" check), and the app handles them, so a 4xx is expected noise. Anything
 * else in the console (a React warning, a script error, a 5xx) is a bug and fails the test.
 */
const EXPECTED = [/Failed to load resource: the server responded with a status of 4\d\d/];

const allowed = new WeakMap<Page, RegExp[]>();

export const test = base.extend<{ tolerate: (pattern: RegExp) => void }>({
  /** Allow one more kind of console error in this test, when the test provokes it on purpose (for example a server error). */
  tolerate: async ({ page }, use) => {
    await use((pattern) => allowed.get(page)?.push(pattern));
  },
  page: async ({ page }, use) => {
    const extra: RegExp[] = [];
    allowed.set(page, extra);
    const problems: string[] = [];
    page.on('console', (message) => {
      if (message.type() !== 'error' && message.type() !== 'warning') return;
      const text = message.text();
      if (![...EXPECTED, ...extra].some((pattern) => pattern.test(text)))
        problems.push(`${message.type()}: ${text}`);
    });
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    await use(page);
    expect(problems, 'the browser console must stay clean').toEqual([]);
  },
});
export { expect };

export const uniqueEmail = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}@example.test`;

export interface Account {
  email: string;
  name: string;
  shop: string;
}

/** Create an account through the API (fast), for scenarios that are not about signing up. */
export async function createAccount(
  request: APIRequestContext,
  prefix = 'owner',
): Promise<Account> {
  const account = {
    email: uniqueEmail(prefix),
    name: 'Test Owner',
    shop: `Shop ${Math.random().toString(36).slice(2, 7)}`,
  };
  const res = await request.post(`${API}/v1/auth/register`, {
    headers: { 'x-client': 'web' },
    data: {
      name: account.name,
      tenantName: account.shop,
      email: account.email,
      password: PASSWORD,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return account;
}

export async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Sign in through the UI and wait until the app shell shows. */
export async function signInToApp(page: Page, email: string) {
  await signIn(page, email);
  // The shell is up once the account menu exists; the email itself lives inside that menu.
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();
}

interface MailpitMessage {
  ID: string;
}

/** The newest link of `path` (for example "verify-email") that Mailpit received for `email`. Polls, as delivery is asynchronous. */
export async function mailLink(email: string, path: string): Promise<string> {
  const pattern = new RegExp(`http://localhost:${PORTS.web}/${path}\\?token=[A-Za-z0-9_-]+`);
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const search = await fetch(
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    );
    const { messages = [] } = (await search.json()) as { messages?: MailpitMessage[] };
    for (const m of messages) {
      const detail = (await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()) as {
        Text: string;
      };
      const found = detail.Text.match(pattern);
      if (found) return found[0];
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`No "${path}" email arrived for ${email}`);
}

/** Fails with a readable list of WCAG A/AA problems on the current page. */
export async function expectAccessible(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const summary = result.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes
        .map((n) => n.target.join(' '))
        .slice(0, 4)
        .join('\n  ')}`,
  );
  expect(summary, `accessibility problems on ${page.url()}`).toEqual([]);
}

/** The page must not scroll sideways (a common small-screen layout bug). */
export async function expectNoHorizontalOverflow(page: Page) {
  const { overflow, widest } = await page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll('body *')]
      .map((el) => ({ el, right: el.getBoundingClientRect().right }))
      .filter((x) => x.right > limit + 1)
      .sort((a, b) => b.right - a.right)
      .slice(0, 3)
      .map(
        (x) =>
          `${x.el.tagName.toLowerCase()}.${String(x.el.className).slice(0, 40)} right=${Math.round(x.right)}`,
      );
    return { overflow: document.documentElement.scrollWidth - limit, widest: wide };
  });
  expect(
    overflow,
    `horizontal overflow in px on ${page.url()}; widest: ${widest.join(' | ')}`,
  ).toBeLessThanOrEqual(0);
}
