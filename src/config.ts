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
): { tokens: AuthToken[]; errors: { variable: string; message: string }[] } {
  const errors: { variable: string; message: string }[] = [];
  const tokens: AuthToken[] = [];
  const add = (label: string | undefined, raw: string, source: string) => {
    const dated = /^(.*):(\d{4}-\d{2}-\d{2})$/.exec(raw);
    const token = dated ? dated[1]!.trim() : raw;
    const expiresOn = dated?.[2];
    if (expiresOn !== undefined && !isRealDate(expiresOn)) {
      errors.push({ variable: source, message: `"${expiresOn}" is not a real date (use YYYY-MM-DD)` });
      return;
    }
    if (token.length < MIN_TOKEN_LENGTH) {
      errors.push({ variable: source, message: `every token must be at least ${MIN_TOKEN_LENGTH} characters (try \`openssl rand -hex 32\`)` });
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
  if (single !== undefined && single !== '') add(undefined, single.trim(), 'MCP_AUTH_TOKEN');
  for (const entry of list ?? []) {
    const sep = entry.indexOf(':');
    const name = sep > 0 ? entry.slice(0, sep) : undefined;
    if (name !== undefined && TOKEN_NAME.test(name)) add(name, entry.slice(sep + 1).trim(), 'MCP_AUTH_TOKENS');
    else add(undefined, entry, 'MCP_AUTH_TOKENS');
  }
  if (!tokens.length && !errors.length) errors.push({ variable: 'MCP_AUTH_TOKEN', message: 'set MCP_AUTH_TOKEN or MCP_AUTH_TOKENS (generate a token with `openssl rand -hex 32`)' });
  return { tokens, errors };
}

/** Days from today that a newly issued token's date is set to. */
export const ttlDaysSchema = z.coerce
  .number()
  .int()
  .min(30, 'MCP_AUTH_TOKEN_TTL_DAYS must be at least 30')
  .max(365, 'MCP_AUTH_TOKEN_TTL_DAYS must be at most 365')
  .default(90);

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
  const { tokens, errors } = parseAuthTokens(c.MCP_AUTH_TOKEN, c.MCP_AUTH_TOKENS);
  for (const e of errors) ctx.addIssue({ code: 'custom', path: [e.variable], message: e.message });
  const undated = tokens.filter((t) => !t.expiresOn).map((t) => t.label);
  if (c.MCP_AUTH_AUTO_EXPIRE && undated.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['MCP_AUTH_AUTO_EXPIRE'],
      message: `with auto-expire on, every token needs an expiry date (name:token:YYYY-MM-DD); missing for ${undated.join(', ')}. Create dated tokens with \`node dist/issueToken.js <name>\``,
    });
  }
  return { ...c, authTokens: tokens };
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
