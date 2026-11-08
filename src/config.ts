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

const bool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1'));

const ConfigSchema = z.object({
  MCP_AUTH_TOKEN: z.string().min(32, 'MCP_AUTH_TOKEN must be at least 32 characters (try `openssl rand -hex 32`)'),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  ALLOWED_HOSTS: csv,
  GSC_ALLOWED_SITES: csv,
  QUOTA_SAFETY_FACTOR: z.coerce.number().gt(0).max(1).default(0.8),
  MAX_QUEUE_WAIT_MS: z.coerce.number().int().min(0).default(15_000),
  MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  GSC_MAX_ROWS_PER_CALL: z.coerce.number().int().min(1).max(100_000).default(25_000),
  CACHE_ENABLED: bool.transform((v) => v ?? true),
  DATA_DIR: z.string().default('./data'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
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
