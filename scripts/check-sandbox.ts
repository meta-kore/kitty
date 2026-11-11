// Sandbox preflight: run `npm run check` before the first real test.
// It confirms the credentials work and that the app is allowed to use Invoicing and Payouts.
import 'dotenv/config';

const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET;
const line = (ok: boolean, msg: string) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
if (!id || !secret) { line(false, 'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing from .env'); process.exit(1); }

const res = await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
  method: 'POST',
  headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials',
});
const body: any = await res.json().catch(() => ({}));
line(res.ok, res.ok ? 'Sandbox credentials accepted' : `Sandbox credentials rejected: ${body.error_description || res.status}`);
if (!res.ok) process.exit(1);

const scope: string = body.scope || '';
line(/invoicing/i.test(scope), 'Invoicing scope present on the app');
line(/payouts/i.test(scope), 'Payouts scope present on the app (if FAIL: enable Payouts in the app settings, or use a US sandbox business account)');

const auth = { Authorization: `Bearer ${body.access_token}`, 'Content-Type': 'application/json' };
const num = await fetch('https://api-m.sandbox.paypal.com/v2/invoicing/generate-next-invoice-number', { method: 'POST', headers: auth });
line(num.ok, num.ok ? 'Invoicing API reachable' : `Invoicing API call failed (${num.status}): ${(await num.text()).slice(0, 200)}`);

const key = process.env.AI_API_KEY;
line(!!key, key ? `AI key set for provider "${process.env.AI_PROVIDER || 'anthropic'}"` : 'AI_API_KEY missing from .env');
if (key) {
  try {
    const { chat, aiInfo } = await import('../src/ai.js');
    const out = await chat('Reply with the single word: ready', 'Say it.', 500); // room for reasoning models, which spend tokens before answering
    line(!!out.trim(), `AI model ${aiInfo().model} replied: ${out.trim().slice(0, 40)}`);
  } catch (e: any) { line(false, e.message + ' (set AI_MODEL in .env to a model your key can use)'); }
}
