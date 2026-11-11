// Thin PayPal REST client. Sandbox only by design: this project never touches live money.
// Set PAYPAL_MOCK=1 to run without credentials (offline development only).
import { randomUUID } from 'node:crypto';

const BASE = 'https://api-m.sandbox.paypal.com';
export const MOCK = process.env.PAYPAL_MOCK === '1';

let cached: { value: string; exp: number } | null = null;

async function token(): Promise<string> {
  if (cached && Date.now() < cached.exp) return cached.value;
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set (see .env.example)');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}): ${body.error_description || body.error || 'unknown'}`);
  cached = { value: body.access_token, exp: Date.now() + (body.expires_in - 60) * 1000 };
  return cached.value;
}

export async function pp<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const detail = data.details?.map((d: any) => d.description || d.issue).join('; ');
    throw new Error(`PayPal ${method} ${path} failed (${res.status}): ${data.message || data.name || 'error'}${detail ? ' - ' + detail : ''}${data.debug_id ? ' [debug_id ' + data.debug_id + ']' : ''}`);
  }
  return data as T;
}

const money = (n: number) => n.toFixed(2);
const lastSegment = (href: string) => href.split('?')[0].split('/').filter(Boolean).pop()!;

// ---------- Invoicing ----------
export type InvoiceInfo = { id: string; number: string; status: string; payUrl: string };
const mockInvoices = new Map<string, InvoiceInfo>();

export async function createAndSendInvoice(o: {
  recipientEmail: string; recipientName: string; amount: number; currency: string; itemName: string; note: string;
}): Promise<InvoiceInfo> {
  if (MOCK) {
    const id = 'INV2-MOCK-' + randomUUID().slice(0, 8).toUpperCase();
    const inv = { id, number: 'M' + (mockInvoices.size + 1), status: 'SENT', payUrl: `/mock/pay/${id}` };
    mockInvoices.set(id, inv);
    return { ...inv };
  }
  let invoice_number: string | undefined;
  try {
    invoice_number = (await pp('POST', '/v2/invoicing/generate-next-invoice-number')).invoice_number;
  } catch { /* PayPal will assign one */ }
  const [given_name, ...rest] = o.recipientName.split(' ');
  const created = await pp('POST', '/v2/invoicing/invoices', {
    detail: {
      ...(invoice_number ? { invoice_number } : {}),
      currency_code: o.currency,
      note: o.note,
      payment_term: { term_type: 'DUE_ON_RECEIPT' },
    },
    primary_recipients: [{
      billing_info: { name: { given_name, surname: rest.join(' ') || '-' }, email_address: o.recipientEmail },
    }],
    items: [{ name: o.itemName, quantity: '1', unit_amount: { currency_code: o.currency, value: money(o.amount) } }],
  });
  const id: string = created.id || lastSegment(created.href);
  await pp('POST', `/v2/invoicing/invoices/${id}/send`, { send_to_recipient: true, send_to_invoicer: false });
  // The invoice is sent at this point. If the read-back fails, still return it so it is recorded and never sent twice;
  // the pay link is filled in by the next refresh.
  try { return await getInvoice(id); } catch { return { id, number: invoice_number || '', status: 'SENT', payUrl: '' }; }
}

export async function getInvoice(id: string): Promise<InvoiceInfo> {
  if (MOCK) return { ...mockInvoices.get(id)! };
  const inv = await pp('GET', `/v2/invoicing/invoices/${id}`);
  return {
    id,
    number: inv.detail?.invoice_number || '',
    status: inv.status,
    payUrl: inv.detail?.metadata?.recipient_view_url || '',
  };
}

export async function remindInvoice(id: string, subject: string, note: string): Promise<void> {
  if (MOCK) return;
  await pp('POST', `/v2/invoicing/invoices/${id}/remind`, { subject, note, send_to_recipient: true, send_to_invoicer: false });
}

export async function recordInvoicePayment(id: string, amount: number, currency: string, note: string): Promise<void> {
  if (MOCK) { mockInvoices.get(id)!.status = 'MARKED_AS_PAID'; return; }
  await pp('POST', `/v2/invoicing/invoices/${id}/payments`, {
    method: 'CASH',
    payment_date: new Date().toISOString().slice(0, 10),
    amount: { currency_code: currency, value: money(amount) },
    note,
  });
}

export function mockPayInvoice(id: string): boolean {
  const inv = mockInvoices.get(id);
  if (inv) inv.status = 'PAID';
  return !!inv;
}

// ---------- Payouts ----------
export type PayoutInfo = { batchId: string; status: string };

export async function createPayout(o: {
  email: string; amount: number; currency: string; note: string; subject: string; idempotencyKey: string;
}): Promise<PayoutInfo> {
  if (MOCK) return { batchId: 'MOCKBATCH' + randomUUID().slice(0, 8).toUpperCase(), status: 'SUCCESS' };
  const r = await pp('POST', '/v1/payments/payouts', {
    sender_batch_header: { sender_batch_id: o.idempotencyKey, email_subject: o.subject, email_message: o.note },
    items: [{
      recipient_type: 'EMAIL',
      receiver: o.email,
      amount: { value: money(o.amount), currency: o.currency },
      note: o.note,
      sender_item_id: o.idempotencyKey,
    }],
  });
  return { batchId: r.batch_header.payout_batch_id, status: r.batch_header.batch_status };
}

export async function getPayout(batchId: string): Promise<PayoutInfo> {
  if (MOCK) return { batchId, status: 'SUCCESS' };
  const r = await pp('GET', `/v1/payments/payouts/${batchId}`);
  return { batchId, status: r.batch_header.batch_status };
}
