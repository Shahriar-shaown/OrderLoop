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
  const html = [
    ...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    ...(link
      ? [
          `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>`,
          `<p style="color:#666;font-size:12px">If the button does not work, paste this address into your browser:<br>${escapeHtml(link.url)}</p>`,
        ]
      : []),
    '<p style="color:#666;font-size:12px">OrderLoop</p>',
  ].join('\n');
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

  passwordChanged(to: string): MailMessage {
    return render('password_changed', to, 'Your OrderLoop password was changed', [
      'The password for your OrderLoop account was just changed, and you were signed out everywhere. If you did not do this, reset your password straight away and contact your workspace owner.',
    ]);
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
