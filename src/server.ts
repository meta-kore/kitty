import 'dotenv/config';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { makeStore } from './store.js';
import { chat, extractJson, aiInfo } from './ai.js';
import {
  MOCK, createAndSendInvoice, getInvoice, remindInvoice, recordInvoicePayment, createPayout, getPayout, mockPayInvoice,
} from './paypal.js';

type Member = { id: string; name: string; email: string; onTime: number; late: number };
type Contribution = {
  memberId: string; invoiceId: string; number: string; payUrl: string;
  status: 'SENT' | 'PAID' | 'CASH'; reminders: { at: string; subject: string; note: string }[];
};
type Cycle = {
  n: number; recipientId: string; startedAt: string; status: 'collecting' | 'paid_out';
  contributions: Contribution[]; payout?: { batchId: string; status: string; amount: number; at: string }; summary?: string;
  failedPayouts?: { batchId: string; status: string }[];
};
type Circle = { name: string; currency: string; contribution: number; members: Member[]; cycles: Cycle[] };
type Db = { circle: Circle | null };

const store = makeStore<Db>('data/db.json', { circle: null });
const app = express();
app.use(express.json());
app.use(express.static('public'));

const wrap = (fn: express.RequestHandler): express.RequestHandler => (req, res, next) =>
  Promise.resolve().then(() => fn(req, res, next)).catch((e) => res.status(400).json({ error: e.message }));

function circle(): Circle {
  const c = store.get().circle;
  if (!c) throw new Error('No circle yet. Create one first.');
  return c;
}
const current = (c: Circle) => c.cycles[c.cycles.length - 1] as Cycle | undefined;
const isPaid = (x: Contribution) => x.status !== 'SENT';
// Every member must have an invoice, and every invoice must be paid. A cycle whose invoices were only partly sent never counts.
const allPaid = (c: Circle, cy: Cycle) => cy.contributions.length === c.members.length && cy.contributions.every(isPaid);

app.get('/api/state', (_req, res) => res.json({ circle: store.get().circle, mock: MOCK, ai: aiInfo() }));

app.post('/api/circle', wrap((req, res) => {
  const { name, currency = 'USD', contribution, members } = req.body;
  if (!name || !(contribution > 0) || !Array.isArray(members) || members.length < 2)
    throw new Error('A circle needs a name, a contribution amount and at least two members.');
  for (const m of members) if (!m.name || !/^\S+@\S+\.\S+$/.test(m.email || '')) throw new Error('Every member needs a name and a valid PayPal email.');
  store.set({
    circle: {
      name, currency, contribution: Number(contribution), cycles: [],
      members: members.map((m: any) => ({ id: randomUUID().slice(0, 8), name: m.name, email: m.email, onTime: Number(m.onTime) || 0, late: Number(m.late) || 0 })),
    },
  });
  res.json({ ok: true });
}));

app.delete('/api/circle', (_req, res) => { store.set({ circle: null }); res.json({ ok: true }); });

// Start the next cycle: one PayPal invoice per member. The payout order is the member order.
app.post('/api/cycles/start', wrap(async (_req, res) => {
  const c = circle();
  let cycle = current(c);
  if (cycle && cycle.status !== 'paid_out' && cycle.contributions.length >= c.members.length)
    throw new Error('Finish the current cycle before starting the next one.');
  if (!cycle || cycle.status === 'paid_out') {
    const n = c.cycles.length + 1;
    cycle = { n, recipientId: c.members[(n - 1) % c.members.length].id, startedAt: new Date().toISOString(), status: 'collecting', contributions: [] };
    c.cycles.push(cycle);
    store.save();
  }
  // If an earlier attempt failed partway, this resumes it: only members without an invoice get one.
  const n = cycle.n;
  const recipient = c.members.find((m) => m.id === cycle.recipientId)!;
  for (const m of c.members) {
    if (cycle.contributions.some((x) => x.memberId === m.id)) continue;
    const inv = await createAndSendInvoice({
      recipientEmail: m.email, recipientName: m.name, amount: c.contribution, currency: c.currency,
      itemName: `${c.name} - cycle ${n} contribution`,
      note: `Hi ${m.name.split(' ')[0]}, this is your cycle ${n} contribution to ${c.name}. This cycle's pot goes to ${recipient.name}.`,
    });
    cycle.contributions.push({ memberId: m.id, invoiceId: inv.id, number: inv.number, payUrl: inv.payUrl, status: 'SENT', reminders: [] });
    store.save();
  }
  res.json({ ok: true });
}));

// Pull the latest invoice statuses from PayPal.
async function sync(c: Circle) {
  const cy = current(c);
  if (!cy || cy.status !== 'collecting') return;
  for (const x of cy.contributions) {
    if (isPaid(x)) continue;
    const inv = await getInvoice(x.invoiceId);
    if (inv.payUrl) x.payUrl = inv.payUrl;
    if (inv.status === 'PAID' || inv.status === 'MARKED_AS_PAID') markPaid(c, x, inv.status === 'PAID' ? 'PAID' : 'CASH');
  }
  store.save();
}
function markPaid(c: Circle, x: Contribution, status: 'PAID' | 'CASH') {
  x.status = status;
  const m = c.members.find((m) => m.id === x.memberId)!;
  if (x.reminders.length) m.late++; else m.onTime++;
}
app.post('/api/cycles/sync', wrap(async (_req, res) => { await sync(circle()); res.json({ ok: true }); }));

// A member paid the treasurer in cash: record it on the PayPal invoice so the books stay in one place.
app.post('/api/cycles/cash/:memberId', wrap(async (req, res) => {
  const c = circle(); const cy = current(c)!;
  const x = cy.contributions.find((x) => x.memberId === req.params.memberId);
  if (!x || isPaid(x)) throw new Error('No unpaid contribution for that member.');
  await recordInvoicePayment(x.invoiceId, c.contribution, c.currency, 'Paid to the treasurer in cash');
  markPaid(c, x, 'CASH'); store.save();
  res.json({ ok: true });
}));

function snapshot(c: Circle) {
  const cy = current(c);
  return {
    circle: c.name, currency: c.currency, contributionPerMember: c.contribution, today: new Date().toISOString().slice(0, 10),
    members: c.members.map((m) => ({ id: m.id, name: m.name, pastCyclesPaidOnTime: m.onTime, pastCyclesPaidLate: m.late })),
    currentCycle: cy && {
      number: cy.n, startedOn: cy.startedAt.slice(0, 10), status: cy.status,
      potGoesTo: c.members.find((m) => m.id === cy.recipientId)!.name,
      potSize: c.contribution * c.members.length,
      contributions: cy.contributions.map((x) => ({
        memberId: x.memberId, name: c.members.find((m) => m.id === x.memberId)!.name,
        paid: isPaid(x), paidHow: x.status === 'PAID' ? 'PayPal' : x.status === 'CASH' ? 'cash' : null,
        remindersAlreadySent: x.reminders.length,
      })),
    },
    pastCycles: c.cycles.filter((x) => x.status === 'paid_out').map((x) => ({
      number: x.n, potWentTo: c.members.find((m) => m.id === x.recipientId)!.name, amount: x.payout?.amount,
    })),
  };
}

const TREASURER = `You are Kitty, the AI treasurer of a savings circle (also called a chama, tanda, susu or ROSCA).
In a savings circle every member pays the same contribution each cycle, and one member receives the whole pot. Members are friends and family, so trust and goodwill matter more than speed.
You never move money yourself: you propose actions and the human treasurer approves them.`;

// The agent reviews the cycle and proposes what to do next. Guardrails are enforced in code, not left to the model.
app.post('/api/agent/run', wrap(async (_req, res) => {
  const c = circle(); await sync(c);
  const cy = current(c);
  if (!cy || cy.status !== 'collecting') throw new Error('There is no cycle in progress.');
  const reply = await chat(TREASURER, `Here is the circle's current state as JSON:
${JSON.stringify(snapshot(c), null, 2)}

Decide what should happen next and reply with ONLY a JSON object in this shape:
{
  "briefing": "2-3 sentences for the human treasurer on where the cycle stands",
  "actions": [
    { "type": "remind", "memberId": "<id>", "tone": "gentle" | "firm", "subject": "<email subject>", "note": "<message to the member, under 500 characters>", "reason": "<why this tone, one sentence>" },
    { "type": "payout", "reason": "<one sentence>" }
  ]
}
Rules:
- Propose "remind" only for members who have not paid. Choose the tone from their history and how many reminders they have already had: reliable payers get a light nudge, repeat late payers get a firmer but still respectful message. Never shame anyone and never mention other members' payment status.
- Each note must say the amount, who receives the pot this cycle, and that they can pay from the PayPal invoice already in their inbox. Sign off as "Kitty, treasurer of <circle name>".
- Propose "payout" only if every member has paid. If everyone has paid, propose only the payout.`);
  const plan = extractJson<{ briefing: string; actions: any[] }>(reply);
  const unpaid = new Set(cy.contributions.filter((x) => !isPaid(x)).map((x) => x.memberId));
  const actions = (plan.actions || []).filter((a) =>
    (a.type === 'remind' && unpaid.has(a.memberId) && a.subject && a.note) || (a.type === 'payout' && allPaid(c, cy)),
  ).map((a) => ({ ...a, note: a.note ? String(a.note).slice(0, 900) : undefined, id: randomUUID().slice(0, 8) }));
  res.json({ briefing: plan.briefing, actions });
}));

// The human treasurer approved a reminder: PayPal delivers it with the invoice attached.
app.post('/api/actions/remind', wrap(async (req, res) => {
  const c = circle(); const cy = current(c)!;
  const { memberId, subject, note } = req.body;
  const x = cy.contributions.find((x) => x.memberId === memberId);
  if (!x || isPaid(x)) throw new Error('That member has no unpaid contribution.');
  if (!subject || !note) throw new Error('A reminder needs a subject and a note.');
  await remindInvoice(x.invoiceId, String(subject).slice(0, 200), String(note).slice(0, 900));
  x.reminders.push({ at: new Date().toISOString(), subject, note }); store.save();
  res.json({ ok: true });
}));

// The human treasurer approved the payout: the whole pot goes to this cycle's recipient through PayPal Payouts.
app.post('/api/actions/payout', wrap(async (_req, res) => {
  const c = circle(); await sync(c);
  const cy = current(c);
  if (!cy || cy.status !== 'collecting') throw new Error('There is no cycle in progress.');
  if (!allPaid(c, cy)) throw new Error('The pot can only be paid out once every member has contributed.');
  const recipient = c.members.find((m) => m.id === cy.recipientId)!;
  const amount = c.contribution * c.members.length;
  const p = await createPayout({
    email: recipient.email, amount, currency: c.currency,
    subject: `${c.name}: your cycle ${cy.n} pot has arrived`,
    note: `It's your turn! Here is the cycle ${cy.n} pot from ${c.name}.`,
    idempotencyKey: `kitty-${c.name.replace(/\W/g, '').slice(0, 12)}-${cy.n}-${cy.startedAt.replace(/\D/g, '').slice(0, 14)}${cy.failedPayouts?.length ? '-r' + cy.failedPayouts.length : ''}`,
  });
  cy.payout = { ...p, amount, at: new Date().toISOString() };
  cy.status = 'paid_out'; store.save();
  try {
    cy.summary = await chat(TREASURER, `Cycle ${cy.n} has just been paid out. Write a warm 3-4 sentence summary for the members' group chat: who received the pot and how much, a thank-you, and who receives the next pot (${c.members[cy.n % c.members.length].name}). Do not single out anyone who paid late. Plain text only.

State: ${JSON.stringify(snapshot(c))}`, 1200);
    store.save();
  } catch (e: any) { cy.summary = `(AI summary unavailable: ${e.message})`; store.save(); }
  res.json({ ok: true });
}));

app.post('/api/payout/refresh', wrap(async (_req, res) => {
  const c = circle();
  const dead = ['DENIED', 'CANCELED'];
  for (const cy of c.cycles) {
    if (!cy.payout || ['SUCCESS', ...dead].includes(cy.payout.status)) continue;
    cy.payout.status = (await getPayout(cy.payout.batchId)).status;
    // PayPal rejected the whole batch, so no money moved: reopen the cycle so the treasurer can approve the payout again.
    if (dead.includes(cy.payout.status) && cy === current(c)) {
      cy.failedPayouts = [...(cy.failedPayouts || []), { batchId: cy.payout.batchId, status: cy.payout.status }];
      delete cy.payout; delete cy.summary;
      cy.status = 'collecting';
    }
  }
  store.save(); res.json({ ok: true });
}));

app.post('/api/ask', wrap(async (req, res) => {
  const c = circle(); await sync(c);
  const q = String(req.body.question || '').slice(0, 500);
  if (!q) throw new Error('Ask a question first.');
  const answer = await chat(TREASURER, `Answer the treasurer's question using only this data. Be brief and concrete. If the data cannot answer it, say so.

Data: ${JSON.stringify(snapshot(c))}

Question: ${q}`, 1200);
  res.json({ answer });
}));

// Offline development only: lets a mock invoice be "paid".
if (MOCK) app.get('/mock/pay/:id', (req, res) => res.send(mockPayInvoice(req.params.id) ? 'Mock invoice paid. Go back and press Refresh.' : 'Unknown invoice'));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Kitty is running on http://localhost:${port}${MOCK ? '  (PAYPAL_MOCK=1: no real PayPal calls)' : '  (PayPal sandbox)'}`));
