/** Server-rendered pages for sign-in: plain HTML, inline CSS, no scripts. Every value is escaped. */
import type { Response } from 'express';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

const STYLE = `
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --fg: #1d232b; --muted: #5b6573; --line: #dde1e7; --accent: #1f6feb; --danger: #c62828; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111418; --card: #1a1f25; --fg: #e6e9ee; --muted: #9aa4b1; --line: #2c333c; --accent: #4c8dff; --danger: #ef5350; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 40px 16px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
  h1 { font-size: 1.35rem; margin: 0 0 12px; }
  p { margin: 0 0 12px; }
  .muted { color: var(--muted); font-size: .9rem; }
  .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 20px; }
  button { font: inherit; padding: 9px 18px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.danger { color: var(--danger); }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 20px; font-size: .92rem; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
  th { color: var(--muted); font-weight: 600; }
  form.inline { display: inline; margin: 0; }
  .table-wrap { overflow-x: auto; }
`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function errorPage(message: string): string {
  return page('Sign-in problem', `<div class="card"><h1>Something went wrong</h1><p>${escapeHtml(message)}</p></div>`);
}

export function consentPage(c: { consentId: string; csrf: string; clientName: string; redirectHost: string; expiresOn: string }): string {
  const hidden = `<input type="hidden" name="consentId" value="${escapeHtml(c.consentId)}"><input type="hidden" name="csrf" value="${escapeHtml(c.csrf)}">`;
  return page(
    'Allow access to Search Console?',
    `<div class="card">
      <h1>Allow <strong>${escapeHtml(c.clientName)}</strong> to read your Search Console data?</h1>
      <p>Codes will be sent to <strong>${escapeHtml(c.redirectHost)}</strong>. Access ends on <strong>${escapeHtml(c.expiresOn)}</strong>.</p>
      <p class="muted">Approve only if you started this connection yourself just now. Access is read-only, and you can revoke it at any time on the Connected clients page.</p>
      <form method="post" action="/oauth/consent">${hidden}
        <div class="actions"><button class="primary" type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></div>
      </form>
    </div>`,
  );
}

/**
 * Headers for every page: never cached, no scripts, never framed (so the
 * consent buttons can't be clickjacked). No form-action: browsers apply it to
 * the redirect after the consent form, which goes to the client's own URI.
 */
export function sendPage(res: Response, status: number, html: string): void {
  res
    .status(status)
    .set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    })
    .type('html')
    .send(html);
}
