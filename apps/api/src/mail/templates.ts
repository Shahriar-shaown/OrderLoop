import type { MailMessage } from './mailer.js';

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function render(
  kind: MailMessage['kind'],
  to: string,
  subject: string,
  paragraphs: string[],
  link?: { label: string; url: string },
): MailMessage {
  const text = [
    ...paragraphs,
    ...(link ? [`${link.label}:\n${link.url}`] : []),
    '-- OrderLoop',
  ].join('\n\n');
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const body = [
    ...paragraphs.map(
      (p) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#334155">${escapeHtml(p)}</p>`,
    ),
    ...(link
      ? [
          `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:8px 0 24px"><tr><td style="border-radius:8px;background:#4f46e5"><a href="${escapeHtml(link.url)}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${escapeHtml(link.label)}</a></td></tr></table>`,
          `<p style="margin:0;font-size:12px;line-height:18px;color:#64748b">If the button does not work, paste this address into your browser:<br><a href="${escapeHtml(link.url)}" style="color:#4f46e5;word-break:break-all">${escapeHtml(link.url)}</a></p>`,
        ]
      : []),
  ].join('\n');
  // Table layout and inline styles only: that is what mail clients reliably render.
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:${font}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px">
<tr><td style="padding:0 0 20px;font-size:22px;font-weight:700;color:#0f172a">Order<span style="color:#4f46e5">Loop</span></td></tr>
<tr><td style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:32px">
<h1 style="margin:0 0 16px;font-size:20px;line-height:28px;color:#0f172a">${escapeHtml(subject)}</h1>
${body}
</td></tr>
<tr><td style="padding:20px 8px 0;font-size:12px;line-height:18px;color:#64748b">You received this because of activity on an OrderLoop account. If that was not you, you can ignore this email.</td></tr>
</table></td></tr></table></body></html>`;
  return { kind, to, subject, text, html };
}

/**
 * `base` is the web app origin; the pages behind these links arrive with the web app (Phase 6).
 *
 * Deliberately no user-supplied text (such as the account name): anyone can register an account for someone else's
 * address, so a name would let a stranger put their own words into a genuine email from us.
 */
export const templates = {
  verifyEmail(to: string, base: string, token: string): MailMessage {
    return render(
      'verify_email',
      to,
      'Confirm your email address',
      [
        'Someone used this email address to create an OrderLoop account. If that was you, confirm the address to finish setting up. The link works once and expires in 24 hours.',
        'If it was not you, ignore this email; the account stays unconfirmed.',
      ],
      {
        label: 'Confirm email address',
        url: `${base}/verify-email?token=${encodeURIComponent(token)}`,
      },
    );
  },

  passwordReset(to: string, base: string, token: string): MailMessage {
    return render(
      'password_reset',
      to,
      'Reset your OrderLoop password',
      [
        'Someone asked to reset the password for this account. If that was you, use the link below within one hour; it works once. If it was not you, ignore this email and your password stays the same.',
      ],
      {
        label: 'Choose a new password',
        url: `${base}/reset-password?token=${encodeURIComponent(token)}`,
      },
    );
  },

  accountExists(to: string, base: string): MailMessage {
    return render(
      'account_exists',
      to,
      'You already have an OrderLoop account',
      [
        'Someone tried to create an OrderLoop account with this email address, but it already has one. If that was you, sign in instead; if you have forgotten your password, you can reset it from the sign-in page.',
        'If it was not you, ignore this email. Nothing about your account has changed.',
      ],
      { label: 'Sign in', url: `${base}/login` },
    );
  },

  passwordChanged(to: string): MailMessage {
    return render('password_changed', to, 'Your OrderLoop password was changed', [
      'The password for your OrderLoop account was just changed, and you were signed out everywhere. If you did not do this, reset your password straight away and contact your workspace owner.',
    ]);
  },

  /** Sent to the OLD address, once the account is gone. No name, no link with a token: there is nothing to act on. */
  accountDeleted(to: string): MailMessage {
    return render('account_deleted', to, 'Your OrderLoop account was deleted', [
      'The OrderLoop account for this email address was deleted, and you were signed out everywhere. Your personal details were removed from the account, and any workspace you were the only member of is scheduled for deletion.',
      'If you did not do this, contact the operator of your OrderLoop service right away. The address can be used to register again.',
    ]);
  },

  /** `purgeAfter` is shown as a UTC date. No business name: see the note above. */
  tenantDeletionScheduled(to: string, base: string, purgeAfter: Date): MailMessage {
    const day = purgeAfter.toISOString().slice(0, 10);
    return render(
      'tenant_deletion_scheduled',
      to,
      'A workspace you belong to is scheduled for deletion',
      [
        `The owner of a workspace you belong to asked for it to be deleted. Nobody can use it any more, and everything in it will be deleted for good on ${day} (UTC) unless the owner cancels before then.`,
        'You can switch to another workspace or sign out from the screen that opens when you sign in.',
      ],
      { label: 'Open OrderLoop', url: `${base}/login` },
    );
  },

  invitation(to: string, base: string, token: string, role: string): MailMessage {
    return render(
      'invitation',
      to,
      'You have been invited to OrderLoop',
      [
        `You have been invited to join a workspace on OrderLoop as ${role}. The invitation works once and expires in 7 days.`,
      ],
      {
        label: 'Accept invitation',
        url: `${base}/accept-invitation?token=${encodeURIComponent(token)}`,
      },
    );
  },
};
