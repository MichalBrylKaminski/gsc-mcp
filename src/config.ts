import { createHash } from 'node:crypto';
import { z } from 'zod';

const csv = z
  .string()
  .optional()
  .transform((v) =>
    v
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  );

/**
 * The SDK checks `new URL(`http://${Host}`).hostname` against ALLOWED_HOSTS, so
 * normalize entries the same way: lowercase, punycode, no port, IPv6 in brackets.
 * Returns undefined for entries that aren't a host (a URL, a path).
 */
export function hostnameOnly(host: string): string | undefined {
  const h = host.trim();
  if (!h || h.includes('://') || /[/?#@\s]/.test(h)) return undefined;
  // More than one colon without brackets is a bare IPv6 address, not host:port.
  const bracketed = !h.startsWith('[') && (h.match(/:/g)?.length ?? 0) > 1 ? `[${h}]` : h;
  try {
    return new URL(`http://${bracketed}`).hostname || undefined;
  } catch {
    return undefined;
  }
}

export const MIN_TOKEN_LENGTH = 32;
export const TOKEN_NAME = /^[A-Za-z0-9_.-]{1,32}$/;
/** RFC 6750 b64token: what a bearer token may contain. It has no ":" or spaces, so ":" in an entry is always a separator. */
const TOKEN_CHARS = /^[A-Za-z0-9\-._~+/]+=*$/;

/** A bearer token clients may send, and the label logs show for it. */
export interface AuthToken {
  label: string;
  token: string;
  /** ":YYYY-MM-DD" from the config: the token stops working at 00:00 UTC that day. Required, and only used, with MCP_AUTH_AUTO_EXPIRE. */
  expiresOn?: string;
}

const isRealDate = (d: string) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);

/** A short, non-reversible label for an unnamed token, safe to log. */
export const tokenFingerprint = (token: string) => `sha256:${createHash('sha256').update(token).digest('hex').slice(0, 8)}`;

/**
 * Combines MCP_AUTH_TOKEN and MCP_AUTH_TOKENS ("name:token" or bare tokens,
 * comma-separated, each optionally ending in ":YYYY-MM-DD"). Several tokens
 * let clients move to a new one before the old one is removed, and give each
 * client its own revocable token.
 */
export function parseAuthTokens(
  single: string | undefined,
  list: string[] | undefined,
  /** False when OAuth sign-in is on, so no fixed token is needed. */
  required = true,
): { tokens: AuthToken[]; errors: { variable: string; message: string }[] } {
  const errors: { variable: string; message: string }[] = [];
  const tokens: AuthToken[] = [];
  const add = (label: string | undefined, token: string, expiresOn: string | undefined, source: string) => {
    if (expiresOn !== undefined && !isRealDate(expiresOn)) {
      errors.push({ variable: source, message: `"${expiresOn}" is not a real date (use YYYY-MM-DD)` });
      return;
    }
    if (token.length < MIN_TOKEN_LENGTH) {
      errors.push({ variable: source, message: `every token must be at least ${MIN_TOKEN_LENGTH} characters (try \`openssl rand -hex 32\`)` });
      return;
    }
    if (!TOKEN_CHARS.test(token)) {
      errors.push({ variable: source, message: 'a token may contain only letters, digits and - . _ ~ + / (with = at the end); check for stray spaces or colons' });
      return;
    }
    if (tokens.some((t) => t.token === token)) {
      errors.push({ variable: source, message: 'the same token is listed twice' });
      return;
    }
    const name = label ?? tokenFingerprint(token);
    if (tokens.some((t) => t.label === name)) {
      errors.push({ variable: source, message: `the name "${name}" is used twice` });
      return;
    }
    tokens.push({ label: name, token, ...(expiresOn ? { expiresOn } : {}) });
  };
  // The optional date comes off the end first, so a bare token with a date is never mistaken for a name.
  const split = (raw: string) => {
    const dated = /^(.*?)\s*:\s*(\d{4}-\d{2}-\d{2})$/.exec(raw.trim());
    return dated ? { rest: dated[1]!.trim(), expiresOn: dated[2] } : { rest: raw.trim(), expiresOn: undefined };
  };
  if (single !== undefined && single.trim() !== '') {
    const { rest, expiresOn } = split(single);
    add(undefined, rest, expiresOn, 'MCP_AUTH_TOKEN');
  }
  for (const entry of list ?? []) {
    const { rest, expiresOn } = split(entry);
    const m = /^([^:]*?)\s*:\s*(.*)$/.exec(rest);
    if (m && TOKEN_NAME.test(m[1]!)) add(m[1], m[2]!, expiresOn, 'MCP_AUTH_TOKENS');
    else if (m && m[1] === '') {
      errors.push({ variable: 'MCP_AUTH_TOKENS', message: 'an entry starts with ":"; write name:token or just the token' });
    } else add(undefined, rest, expiresOn, 'MCP_AUTH_TOKENS');
  }
  if (required && !tokens.length && !errors.length) errors.push({ variable: 'MCP_AUTH_TOKEN', message: 'set MCP_AUTH_TOKEN or MCP_AUTH_TOKENS (generate a token with `openssl rand -hex 32`)' });
  return { tokens, errors };
}

/** Days from today that a newly issued token's date is set to. */
export const ttlDaysSchema = z.coerce
  .number()
  .int()
  .min(30, 'MCP_AUTH_TOKEN_TTL_DAYS must be at least 30')
  .max(365, 'MCP_AUTH_TOKEN_TTL_DAYS must be at most 365')
  .default(90);

/** OAuth sign-in settings; present only when all four variables are set. */
export interface OAuthConfig {
  /** The server's public origin and OAuth issuer; `href` ends in "/". */
  publicUrl: URL;
  googleClientId: string;
  googleClientSecret: string;
  /** Lowercased. */
  allowedEmails: string[];
}

/** Paths the OAuth endpoints and pages use at the root of the domain. */
const OAUTH_PATHS = ['/.well-known', '/register', '/authorize', '/token', '/revoke', '/oauth', '/clients'];

const OAUTH_VARIABLES = ['MCP_PUBLIC_URL', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'MCP_OAUTH_ALLOWED_EMAILS'] as const;

/** An origin the SDK accepts as an OAuth issuer: https, or http on localhost; no path, query or fragment. */
function parsePublicUrl(raw: string): URL | string {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'must be a URL such as https://gsc-mcp.example.com';
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return 'must use https (http is allowed only for localhost)';
  if (url.pathname !== '/' || url.search || url.hash || text.endsWith('?') || text.endsWith('#')) {
    return 'must be the bare origin, such as https://gsc-mcp.example.com (no path, query or fragment)';
  }
  if (url.username || url.password) return 'must not contain a user name or password';
  return url;
}

const bool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1'));

const ConfigSchema = z.object({
  MCP_AUTH_TOKEN: z.string().optional(),
  // "name:token" or bare tokens, comma-separated; used together with MCP_AUTH_TOKEN.
  MCP_AUTH_TOKENS: csv,
  // Off by default. On: every token must carry a date and stops working at 00:00 UTC that day.
  MCP_AUTH_AUTO_EXPIRE: bool.transform((v) => v ?? false),
  MCP_AUTH_TOKEN_TTL_DAYS: ttlDaysSchema,
  // OAuth sign-in: on only when all four are set.
  MCP_PUBLIC_URL: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  MCP_OAUTH_ALLOWED_EMAILS: csv,
  // Number of reverse proxies in front of the app (Express "trust proxy"), so rate limits see real client IPs.
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()))
    .refine((v) => v === undefined || (/^\d+$/.test(v) && Number(v) <= 10), 'TRUST_PROXY must be a whole number of proxies from 0 to 10')
    .transform((v) => (v === undefined ? undefined : Number(v))),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Path of the MCP endpoint, e.g. /gsc-mcp when a reverse proxy publishes it under that path.
  MCP_PATH: z
    .string()
    .regex(/^(\/[A-Za-z0-9._~-]+)+$/, 'MCP_PATH must look like /mcp or /gsc-mcp (no trailing slash)')
    .refine((p) => p !== '/healthz', 'MCP_PATH cannot be /healthz')
    .default('/mcp'),
  ALLOWED_HOSTS: csv.transform((hosts, ctx) =>
    hosts?.map((h) => {
      const name = hostnameOnly(h);
      if (name === undefined) ctx.addIssue({ code: 'custom', message: `"${h}" is not a hostname; use e.g. gsc-mcp.example.com (no https:// or path)` });
      return name ?? '';
    }),
  ),
  GSC_ALLOWED_SITES: csv,
  QUOTA_SAFETY_FACTOR: z.coerce.number().gt(0).max(1).default(0.8),
  MAX_QUEUE_WAIT_MS: z.coerce.number().int().min(0).default(15_000),
  MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  // Results are sent twice (text + structuredContent), so keep responses to a few MB.
  GSC_MAX_ROWS_PER_CALL: z.coerce.number().int().min(1).max(50_000).default(25_000),
  CACHE_ENABLED: bool.transform((v) => v ?? true),
  DATA_DIR: z.string().default('./data'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
}).transform((c, ctx) => {
  const oauth = parseOAuth(c, (variable, message) => ctx.addIssue({ code: 'custom', path: [variable], message }));
  const oauthWanted = OAUTH_VARIABLES.some((v) => present(c[v]));
  const { tokens, errors } = parseAuthTokens(c.MCP_AUTH_TOKEN, c.MCP_AUTH_TOKENS, !oauthWanted);
  for (const e of errors) ctx.addIssue({ code: 'custom', path: [e.variable], message: e.message });
  const undated = tokens.filter((t) => !t.expiresOn).map((t) => t.label);
  if (c.MCP_AUTH_AUTO_EXPIRE && undated.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['MCP_AUTH_AUTO_EXPIRE'],
      message: `with auto-expire on, every token needs an expiry date (name:token:YYYY-MM-DD); missing for ${undated.join(', ')}. Create dated tokens with \`node dist/issueToken.js <name>\``,
    });
  }
  const taken = OAUTH_PATHS.find((p) => c.MCP_PATH === p || c.MCP_PATH.startsWith(`${p}/`));
  if (oauth && taken) {
    ctx.addIssue({ code: 'custom', path: ['MCP_PATH'], message: `cannot be ${c.MCP_PATH} with OAuth sign-in on, because ${taken} is an OAuth path` });
  }
  if (oauth && c.ALLOWED_HOSTS?.length && !c.ALLOWED_HOSTS.includes(oauth.publicUrl.hostname)) {
    ctx.addIssue({
      code: 'custom',
      path: ['ALLOWED_HOSTS'],
      message: `must include ${oauth.publicUrl.hostname}, the host of MCP_PUBLIC_URL, or OAuth sign-in would be refused`,
    });
  }
  return { ...c, authTokens: tokens, oauth };
});

const present = (v: string | string[] | undefined) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v.trim() !== '');

function parseOAuth(
  c: { MCP_PUBLIC_URL?: string; GOOGLE_OAUTH_CLIENT_ID?: string; GOOGLE_OAUTH_CLIENT_SECRET?: string; MCP_OAUTH_ALLOWED_EMAILS?: string[] },
  issue: (variable: string, message: string) => void,
): OAuthConfig | undefined {
  const set = OAUTH_VARIABLES.filter((v) => present(c[v]));
  if (!set.length) return undefined;
  if (set.length < OAUTH_VARIABLES.length) {
    for (const v of OAUTH_VARIABLES.filter((v) => !set.includes(v))) {
      issue(v, `OAuth sign-in needs all of ${OAUTH_VARIABLES.join(', ')}; this one is missing`);
    }
    return undefined;
  }
  const publicUrl = parsePublicUrl(c.MCP_PUBLIC_URL!);
  if (typeof publicUrl === 'string') {
    issue('MCP_PUBLIC_URL', publicUrl);
    return undefined;
  }
  return {
    publicUrl,
    googleClientId: c.GOOGLE_OAUTH_CLIENT_ID!.trim(),
    googleClientSecret: c.GOOGLE_OAUTH_CLIENT_SECRET!.trim(),
    allowedEmails: c.MCP_OAUTH_ALLOWED_EMAILS!.map((e) => e.toLowerCase()),
  };
}

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
