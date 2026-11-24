/**
 * Creates a bearer token dated MCP_AUTH_TOKEN_TTL_DAYS (default 90) from today:
 *   node dist/issueToken.js grok          (or: npm run token -- grok)
 * Prints the MCP_AUTH_TOKENS entry, "name:token:YYYY-MM-DD", on stdout.
 */
import { issueToken } from './auth.js';
import { TOKEN_NAME, ttlDaysSchema } from './config.js';

const name = process.argv[2];
if (!name || !TOKEN_NAME.test(name)) {
  process.stderr.write('Usage: node dist/issueToken.js <name>\n  name: letters, digits, _ . - (up to 32), e.g. grok or claude-code\n');
  process.exit(2);
}
const ttl = ttlDaysSchema.safeParse(process.env.MCP_AUTH_TOKEN_TTL_DAYS);
if (!ttl.success) {
  process.stderr.write(`${ttl.error.issues.map((i) => i.message).join('\n')}\n`);
  process.exit(2);
}
const t = issueToken(name, ttl.data);
process.stdout.write(`${t.entry}\n`);
process.stderr.write(
  `\nExpires ${t.expiresOn} at 00:00 UTC (${ttl.data} days). Add the line above to MCP_AUTH_TOKENS, comma-separated, ` +
    `and give the client only the token part. This is the only time it is shown.\n`,
);
