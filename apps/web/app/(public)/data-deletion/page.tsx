import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Data deletion instructions' };

/**
 * Where to send a person who wants their data deleted. Public, static, no sign-in: this is the address given to Meta as the
 * "Data deletion instructions URL" (docs/meta.md). It describes what the product can do technically (docs/privacy-and-deletion.md);
 * it is not legal advice and makes no compliance claim. Set NEXT_PUBLIC_PRIVACY_CONTACT to the operator's real address.
 */
const CONTACT = process.env.NEXT_PUBLIC_PRIVACY_CONTACT ?? 'privacy@your-operator.example';

const h2 = { margin: '24px 0 8px', fontSize: 18, lineHeight: '26px', fontWeight: 600 } as const;
const p = { margin: '0 0 12px', fontSize: 15, lineHeight: '24px' } as const;
const li = { marginBottom: 6, fontSize: 15, lineHeight: '24px' } as const;

export default function DataDeletionPage() {
  return (
    <main id="main" style={{ maxWidth: 680, margin: '0 auto', padding: '32px 16px' }}>
      <h1 style={{ margin: 0, fontSize: 28, lineHeight: '36px', fontWeight: 600 }}>
        Data deletion instructions
      </h1>
      <p style={{ ...p, marginTop: 8, color: 'var(--ol-muted)' }}>
        How to have your data removed from OrderLoop, an order and delivery tool used by small
        online shops.
      </p>

      <h2 style={h2}>If you wrote to a shop on Facebook or Instagram</h2>
      <p style={p}>
        Messages you sent to a shop&rsquo;s Page or Instagram account can be read by the shop
        through OrderLoop. You can have them removed in either of two ways:
      </p>
      <ol style={{ paddingLeft: 22, margin: '0 0 12px' }}>
        <li style={li}>
          In Facebook, open{' '}
          <strong>Settings &amp; privacy &rarr; Settings &rarr; Business integrations</strong>, find
          OrderLoop and choose <strong>Remove</strong>. Meta then asks OrderLoop to delete the
          conversation data it holds about you, and gives you a confirmation code you can keep.
        </li>
        <li style={li}>
          Ask the shop to erase your details. A shop owner or admin can do this from{' '}
          <strong>Customers &rarr; the customer &rarr; Erase personal data</strong>, which removes
          your name, phone number, address and chat messages from the shop&rsquo;s OrderLoop.
        </li>
      </ol>

      <h2 style={h2}>If you have an OrderLoop account</h2>
      <ul style={{ paddingLeft: 22, margin: '0 0 12px' }}>
        <li style={li}>
          <strong>Delete your account:</strong> sign in, open the account menu, choose{' '}
          <strong>Your account</strong>, then <strong>Delete my account</strong>. You are asked for
          your password. Your name, email, password and registered phones are removed and you are
          signed out everywhere.
        </li>
        <li style={li}>
          <strong>Delete a business you own:</strong> open <strong>Settings</strong> and choose{' '}
          <strong>Delete this business</strong>. Type the business name and your password. The
          business stops working at once and everything in it is deleted for good after a grace
          period, during which you can cancel.
        </li>
      </ul>

      <h2 style={h2}>If you cannot do this yourself</h2>
      <p style={p}>
        Write to{' '}
        <a href={`mailto:${CONTACT}`} style={{ color: 'var(--ol-primary)' }}>
          {CONTACT}
        </a>{' '}
        and say which shop or account it is about. We will pass a request about a shop&rsquo;s
        customer to that shop, because the shop decides what it keeps.
      </p>

      <h2 style={h2}>What stays</h2>
      <ul style={{ paddingLeft: 22, margin: '0 0 12px' }}>
        <li style={li}>
          A shop keeps its own order and money records, with the personal details removed, so its
          accounts still add up.
        </li>
        <li style={li}>
          Backups made before a deletion keep the old data until they expire. Couriers and Meta keep
          their own copies; OrderLoop cannot remove those.
        </li>
      </ul>
      <p style={{ ...p, color: 'var(--ol-muted)', fontSize: 13 }}>
        This page describes what the product can do. It is not legal advice and not a statement
        about any law.
      </p>
    </main>
  );
}
