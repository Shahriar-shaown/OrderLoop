import { describe, expect, it, vi } from 'vitest';
import { SmtpEmailSender, consoleEmailSender } from './smtp-email.js';

describe('SmtpEmailSender', () => {
  it('sends with the configured sender and a stable Message-ID', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const sender = new SmtpEmailSender(
      { host: 'h', port: 1025, secure: false, from: 'OrderLoop <a@b.test>' },
      { sendMail } as never,
    );
    await sender.send({
      to: 'x@y.test',
      subject: 's',
      text: 't',
      html: '<p>t</p>',
      messageId: '<d1@orderloop.local>',
    });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'OrderLoop <a@b.test>',
        to: 'x@y.test',
        messageId: '<d1@orderloop.local>',
      }),
    );
  });
  it('lets a provider failure through, so the delivery is retried or recorded as failed', async () => {
    const sender = new SmtpEmailSender({ host: 'h', port: 1, secure: false, from: 'f' }, {
      sendMail: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('refused'), { responseCode: 550 })),
    } as never);
    await expect(
      sender.send({ to: 'x@y.test', subject: 's', text: 't', html: 'h', messageId: 'm' }),
    ).rejects.toThrow('refused');
  });
  it('the console sender logs neither the address nor the body', async () => {
    const log = vi.fn();
    await consoleEmailSender(log).send({
      to: 'x@y.test',
      subject: 'Low stock',
      text: 'secret body',
      html: 'h',
      messageId: 'm',
    });
    expect(log.mock.calls[0]![0]).not.toContain('x@y.test');
    expect(log.mock.calls[0]![0]).not.toContain('secret body');
  });
});
