import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

export interface MailTestArgs {
  to: string;
  subject: string;
}

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

/** `pnpm mail:test -- --to you@example.com [--subject "..."]`. A bare `--` (added by some pnpm versions) is ignored; anything unknown is refused. */
export function parseMailTestArgs(argv: string[]): MailTestArgs {
  const args = argv.filter((a) => a !== '--');
  let to: string | undefined;
  let subject = 'OrderLoop test email';
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = (name: string): string => {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
      return v;
    };
    if (a === '--to') to = value('--to');
    else if (a.startsWith('--to=')) to = a.slice(5);
    else if (a === '--subject') subject = value('--subject');
    else if (a.startsWith('--subject=')) subject = a.slice(10);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!to) throw new Error('--to <email> is required');
  if (!EMAIL_RE.test(to)) throw new Error('--to is not a valid email address');
  if (subject.length > 120 || /[\r\n]/.test(subject))
    throw new Error('--subject must be one line of at most 120 characters');
  return { to, subject };
}

export interface SmtpProbe {
  /** The server's greeting line. */
  banner: string;
  /** EHLO capabilities worth reporting. */
  starttlsOffered: boolean;
  authMechanisms: string[];
  maxSizeBytes?: number | undefined;
  tls: {
    /** How this probe reached encryption: from the first byte, after STARTTLS, or not at all. */
    mode: 'implicit' | 'starttls' | 'none';
    protocol?: string | undefined;
    cipher?: string | undefined;
    /** Whether the certificate chains to a trusted CA and matches the host name (the real send requires it). */
    certificateTrusted?: boolean | undefined;
    certificateProblem?: string | undefined;
    certificateSubject?: string | undefined;
    certificateValidTo?: string | undefined;
  };
}

/** Reads one SMTP reply (possibly multi-line) from a socket. Resolves with its lines. */
function readReply(socket: Socket, timeoutMs: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => done(new Error('timed out waiting for the server')), timeoutMs);
    const done = (error?: Error, lines?: string[]) => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (error) reject(error);
      else resolve(lines ?? []);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/).filter((l) => l.length > 0);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last) && /\r?\n$/.test(buffer)) done(undefined, lines);
      if (buffer.length > 16_384) done(new Error('the server sent an unexpectedly long reply'));
    };
    const onError = (e: Error) => done(e);
    const onClose = () => done(new Error('the server closed the connection'));
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

/** Parses the lines of an EHLO reply. */
export function parseEhlo(
  lines: string[],
): Pick<SmtpProbe, 'starttlsOffered' | 'authMechanisms' | 'maxSizeBytes'> {
  const caps = lines.map((l) => l.replace(/^\d{3}[- ]/, '').trim());
  const auth = caps.find((c) => /^AUTH[ =]/i.test(c));
  const size = caps.find((c) => /^SIZE\b/i.test(c));
  const sizeValue = size ? Number(size.split(/\s+/)[1]) : Number.NaN;
  return {
    starttlsOffered: caps.some((c) => c.toUpperCase() === 'STARTTLS'),
    authMechanisms: auth
      ? auth
          .split(/[ =]/)
          .slice(1)
          .filter(Boolean)
          .map((m) => m.toUpperCase())
      : [],
    ...(Number.isFinite(sizeValue) && sizeValue > 0 ? { maxSizeBytes: sizeValue } : {}),
  };
}

const send = (socket: Socket, line: string) => socket.write(`${line}\r\n`);

function describeTls(socket: TLSSocket, mode: 'implicit' | 'starttls'): SmtpProbe['tls'] {
  const cert = socket.getPeerCertificate();
  const cipher = socket.getCipher();
  const subject = cert?.subject as { CN?: string } | undefined;
  return {
    mode,
    protocol: socket.getProtocol() ?? undefined,
    cipher: cipher?.name,
    certificateTrusted: socket.authorized,
    ...(socket.authorized ? {} : { certificateProblem: String(socket.authorizationError) }),
    ...(subject?.CN ? { certificateSubject: subject.CN } : {}),
    ...(cert?.valid_to ? { certificateValidTo: cert.valid_to } : {}),
  };
}

/**
 * Looks at the SMTP server the way a client would, WITHOUT authenticating or sending anything: reads the greeting, says EHLO,
 * and upgrades with STARTTLS (or connects with TLS from the first byte) to report the protocol, cipher and certificate. Nothing
 * secret is sent or returned. The certificate is inspected, not enforced here; the real send that follows enforces it.
 */
export async function probeSmtp(options: {
  host: string;
  port: number;
  secure: boolean;
  timeoutMs?: number;
  clientName?: string;
}): Promise<SmtpProbe> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const clientName = options.clientName ?? 'orderloop-mail-test.invalid';
  const opened = await new Promise<Socket>((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    const socket: Socket = options.secure
      ? tlsConnect(
          {
            host: options.host,
            port: options.port,
            servername: options.host,
            rejectUnauthorized: false,
          },
          () => resolve(socket),
        )
      : netConnect({ host: options.host, port: options.port }, () => resolve(socket));
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('connection timed out')));
    socket.once('error', onError);
  });
  try {
    const greeting = await readReply(opened, timeoutMs);
    const banner = (greeting[greeting.length - 1] ?? '').replace(/^\d{3}[- ]/, '').slice(0, 200);
    if (!greeting[0]?.startsWith('220')) throw new Error('the server did not greet with 220');
    send(opened, `EHLO ${clientName}`);
    let ehlo = parseEhlo(await readReply(opened, timeoutMs));
    let tls: SmtpProbe['tls'] = options.secure
      ? describeTls(opened as TLSSocket, 'implicit')
      : { mode: 'none' };
    let current: Socket = opened;
    if (!options.secure && ehlo.starttlsOffered) {
      send(opened, 'STARTTLS');
      const reply = await readReply(opened, timeoutMs);
      if (reply[0]?.startsWith('220')) {
        const upgraded = await new Promise<TLSSocket>((resolve, reject) => {
          const t = tlsConnect(
            { socket: opened, servername: options.host, rejectUnauthorized: false },
            () => resolve(t),
          );
          t.once('error', reject);
        });
        current = upgraded;
        tls = describeTls(upgraded, 'starttls');
        send(upgraded, `EHLO ${clientName}`);
        // AUTH is only offered (and meaningful) after the upgrade; STARTTLS was offered before it, which is what is reported.
        ehlo = { ...parseEhlo(await readReply(upgraded, timeoutMs)), starttlsOffered: true };
      }
    }
    send(current, 'QUIT');
    return { banner, ...ehlo, tls };
  } finally {
    opened.destroy();
  }
}

export interface MailTestEnv {
  MAIL_PROVIDER: 'console' | 'smtp';
  MAIL_FROM: string;
  SMTP_HOST?: string | undefined;
  SMTP_PORT: number;
  SMTP_SECURE: boolean;
  SMTP_USER?: string | undefined;
  SMTP_PASSWORD?: string | undefined;
  NODE_ENV: 'development' | 'test' | 'production';
}

export interface MailTestReport {
  ok: boolean;
  provider: 'console' | 'smtp';
  /** Nothing was transmitted (console provider). */
  delivered: boolean;
  from: string;
  to: string;
  transport?: {
    host: string;
    port: number;
    secureFromFirstByte: boolean;
    starttlsRequiredByApp: boolean;
    authConfigured: boolean;
    probe?: SmtpProbe | undefined;
    probeError?: string | undefined;
    serverResponse?: string | undefined;
  };
  error?: string | undefined;
  warnings: string[];
}

export interface MailTestDeps {
  probe: (o: { host: string; port: number; secure: boolean }) => Promise<SmtpProbe>;
  /** Sends the message through the same mailer the API uses. Throws on failure; may return the server's final reply line. */
  sendMail: (message: {
    to: string;
    subject: string;
    text: string;
    html: string;
  }) => Promise<string | undefined>;
  now?: () => Date;
}

/** Strips anything that could be a secret from text that came from outside (an SMTP error can echo the login). */
export function redactDiagnostic(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[REDACTED]');
  return out
    .replace(/\b[A-Za-z0-9+/=_-]{32,}\b/g, '[REDACTED]')
    .replace(/(password|pass|token|secret)=\S+/gi, '$1=[REDACTED]')
    .slice(0, 500);
}

/** Sends one test email and reports what the connection looked like. Pure orchestration: every side effect is in `deps`. */
export async function runMailTest(
  env: MailTestEnv,
  args: MailTestArgs,
  deps: MailTestDeps,
): Promise<MailTestReport> {
  const now = (deps.now ?? (() => new Date()))();
  const secrets = [env.SMTP_PASSWORD, env.SMTP_USER];
  const warnings: string[] = [];
  const message = {
    to: args.to,
    subject: args.subject,
    text: `This is a test email from OrderLoop (mail:test), sent ${now.toISOString()}.\n\nIf you can read this, the API's mail settings work. Nothing needs to be done.`,
    html: `<p>This is a test email from OrderLoop (<code>mail:test</code>), sent ${now.toISOString()}.</p><p>If you can read this, the API's mail settings work. Nothing needs to be done.</p>`,
  };
  if (env.MAIL_PROVIDER === 'console') {
    await deps.sendMail(message);
    return {
      ok: true,
      provider: 'console',
      delivered: false,
      from: env.MAIL_FROM,
      to: args.to,
      warnings: [
        'MAIL_PROVIDER=console: the message was printed, not sent. Set MAIL_PROVIDER=smtp to test a real server.',
      ],
    };
  }
  const host = env.SMTP_HOST ?? '';
  const transport: NonNullable<MailTestReport['transport']> = {
    host,
    port: env.SMTP_PORT,
    secureFromFirstByte: env.SMTP_SECURE,
    starttlsRequiredByApp: env.NODE_ENV === 'production' && !env.SMTP_SECURE,
    authConfigured: Boolean(env.SMTP_USER && env.SMTP_PASSWORD),
  };
  try {
    transport.probe = await deps.probe({ host, port: env.SMTP_PORT, secure: env.SMTP_SECURE });
  } catch (e) {
    transport.probeError = redactDiagnostic(e instanceof Error ? e.message : String(e), secrets);
  }
  const p = transport.probe;
  if (p) {
    if (p.tls.mode === 'none')
      warnings.push('The connection was NOT encrypted (no TLS, no STARTTLS offered).');
    if (p.tls.certificateTrusted === false)
      warnings.push(
        `The server certificate is not trusted (${p.tls.certificateProblem ?? 'unknown reason'}): a production send is refused.`,
      );
    if (transport.authConfigured && p.authMechanisms.length === 0 && p.tls.mode === 'none')
      warnings.push(
        'Credentials are configured but the server offers no AUTH on this unencrypted connection.',
      );
  }
  if (!transport.authConfigured && env.NODE_ENV === 'production')
    warnings.push('No SMTP_USER/SMTP_PASSWORD configured: most providers require them.');
  try {
    transport.serverResponse =
      redactDiagnostic((await deps.sendMail(message)) ?? '', secrets) || undefined;
    return {
      ok: true,
      provider: 'smtp',
      delivered: true,
      from: env.MAIL_FROM,
      to: args.to,
      transport,
      warnings,
    };
  } catch (e) {
    return {
      ok: false,
      provider: 'smtp',
      delivered: false,
      from: env.MAIL_FROM,
      to: args.to,
      transport,
      error: redactDiagnostic(e instanceof Error ? e.message : String(e), secrets),
      warnings,
    };
  }
}

/** Human-readable report; never includes credentials. */
export function formatMailReport(r: MailTestReport): string[] {
  const lines = [`mail:test  provider=${r.provider}  from=${r.from}  to=${r.to}`];
  const t = r.transport;
  if (t) {
    lines.push(
      `  server      ${t.host}:${t.port}  (${t.secureFromFirstByte ? 'TLS from the first byte' : t.starttlsRequiredByApp ? 'STARTTLS required by the app' : 'STARTTLS optional (not production)'})`,
    );
    lines.push(
      `  login       ${t.authConfigured ? 'configured (user and password not shown)' : 'not configured'}`,
    );
    if (t.probeError) lines.push(`  probe       FAILED: ${t.probeError}`);
    if (t.probe) {
      lines.push(`  banner      ${t.probe.banner}`);
      const tls = t.probe.tls;
      lines.push(
        tls.mode === 'none'
          ? '  tls         none'
          : `  tls         ${tls.mode}, ${tls.protocol ?? '?'}, ${tls.cipher ?? '?'}; certificate ${tls.certificateTrusted ? 'trusted' : 'NOT trusted'}${tls.certificateSubject ? ` (CN=${tls.certificateSubject}` : ' ('}${tls.certificateValidTo ? `, valid to ${tls.certificateValidTo})` : ')'}`,
      );
      lines.push(
        `  offers      STARTTLS=${t.probe.starttlsOffered ? 'yes' : 'no'}  AUTH=${t.probe.authMechanisms.join(',') || 'none'}${t.probe.maxSizeBytes ? `  max message ${t.probe.maxSizeBytes} bytes` : ''}`,
      );
    }
    if (t.serverResponse) lines.push(`  server said ${t.serverResponse}`);
  }
  for (const w of r.warnings) lines.push(`  WARNING     ${w}`);
  lines.push(
    r.ok
      ? r.delivered
        ? '  RESULT      the server accepted the message. Check the inbox AND the spam folder; accepted is not the same as delivered.'
        : '  RESULT      printed only (nothing sent).'
      : `  RESULT      FAILED: ${r.error ?? 'unknown error'}`,
  );
  return lines;
}
