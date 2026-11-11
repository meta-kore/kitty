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
  amount?: number; loanId?: string; // table banking: the invoice total, and the loan repaid by it
};
// A rotating-pot cycle, or a table-banking meeting. Meetings end as 'closed'; cycles end as 'paid_out'.
type Cycle = {
  n: number; recipientId: string; startedAt: string; status: 'collecting' | 'paid_out' | 'closed';
  contributions: Contribution[]; payout?: { batchId: string; status: string; amount: number; at: string }; summary?: string;
  failedPayouts?: { batchId: string; status: string }[];
};
type Loan = {
  id: string; memberId: string; amount: number; interest: number; purpose: string; requestedAt: string;
  status: 'requested' | 'active' | 'repaid' | 'declined';
  meeting?: number; payout?: { batchId: string; status: string }; failed?: number; declineReason?: string;
};
type ShareOut = { batchId: string; status: string; at: string; total: number; items: { memberId: string; amount: number }[]; summary?: string };
type Circle = {
  name: string; currency: string; contribution: number; members: Member[]; cycles: Cycle[];
  type?: 'rosca' | 'table'; termMeetings?: number; loans?: Loan[]; shareOut?: ShareOut; shareOutFailed?: number;
};
type Db = { circle: Circle | null };

// Table banking rules.
const LOAN_INTEREST = 0.1; // flat, repaid in full at the next meeting
const LOAN_LIMIT_MULTIPLE = 3; // a member can borrow up to three times their own savings

const store = makeStore<Db>(process.env.KITTY_DB || 'data/db.json', { circle: null });
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
function tableCircle(): Circle {
  const c = circle();
  if (!isTable(c)) throw new Error('This group is a rotating pot, not a table banking group.');
  return c;
}
const current = (c: Circle) => c.cycles[c.cycles.length - 1] as Cycle | undefined;
const isTable = (c: Circle) => c.type === 'table';
const isPaid = (x: Contribution) => x.status !== 'SENT';
// Every member must have an invoice, and every invoice must be paid. A cycle whose invoices were only partly sent never counts.
const allPaid = (c: Circle, cy: Cycle) => cy.contributions.length === c.members.length && cy.contributions.every(isPaid);
const r2 = (n: number) => Math.round(n * 100) / 100;
const due = (c: Circle, x: Contribution) => x.amount ?? c.contribution;
const nameOf = (c: Circle, id: string) => c.members.find((m) => m.id === id)?.name ?? 'Unknown';
const keyBase = (c: Circle) => `kitty-${c.name.replace(/\W/g, '').slice(0, 12)}`;
const stamp = (iso: string) => iso.replace(/\D/g, '').slice(0, 14);
const cash = (c: Circle, n: number) => `${n.toFixed(2)} ${c.currency}`;

// ---------- Table banking: the fund and its rules ----------
// Everything is derived from paid invoices and loan states, so the ledger cannot drift from PayPal's record.
function savingsOf(c: Circle, memberId: string) {
  return r2(c.contribution * c.cycles.filter((cy) => cy.contributions.some((x) => x.memberId === memberId && isPaid(x))).length);
}
function fund(c: Circle) {
  const loans = c.loans || [];
  const savings = r2(c.members.reduce((s, m) => s + savingsOf(c, m.id), 0));
  const interest = r2(loans.filter((l) => l.status === 'repaid').reduce((s, l) => s + l.interest, 0));
  const outstanding = r2(loans.filter((l) => l.status === 'active').reduce((s, l) => s + l.amount, 0));
  return { savings, interest, outstanding, cash: r2(savings + interest - outstanding) };
}
// Why a requested loan cannot be paid out right now, or null if it can.
function loanBlock(c: Circle, loan: Loan): string | null {
  const cy = current(c);
  if (c.shareOut) return 'The group has already shared out its fund.';
  if (!cy || cy.status !== 'collecting') return 'There is no meeting in progress.';
  if ((c.loans || []).some((l) => l.memberId === loan.memberId && l.status === 'active')) return `${nameOf(c, loan.memberId)} already has a loan to repay.`;
  const limit = r2(LOAN_LIMIT_MULTIPLE * savingsOf(c, loan.memberId));
  if (loan.amount > limit) return `The loan limit is three times the member's savings: ${cash(c, limit)} for ${nameOf(c, loan.memberId)}.`;
  const f = fund(c);
  if (loan.amount > f.cash) return `The fund only has ${cash(c, f.cash)} available to lend.`;
  return null;
}
// Why the fund cannot be shared out right now, or null if it can.
function shareOutBlock(c: Circle): string | null {
  const cy = current(c);
  if (c.shareOut) return 'The group has already shared out its fund.';
  if (!cy) return 'No meeting has been held yet.';
  if (cy.n < (c.termMeetings || 1)) return `The fund is shared out after meeting ${c.termMeetings}; this is meeting ${cy.n}.`;
  if (!allPaid(c, cy)) return 'Every member must pay in for this meeting first.';
  if ((c.loans || []).some((l) => l.status === 'active')) return 'Every loan must be repaid first. Loans are repaid at the next meeting.';
  return null;
}

app.get('/api/state', (_req, res) => {
  const c = store.get().circle;
  const table = c && isTable(c) ? {
    fund: fund(c),
    savings: Object.fromEntries(c.members.map((m) => [m.id, savingsOf(c, m.id)])),
    shareOutBlocked: shareOutBlock(c),
    loanBlocks: Object.fromEntries((c.loans || []).filter((l) => l.status === 'requested').map((l) => [l.id, loanBlock(c, l)])),
  } : null;
  res.json({ circle: c, table, mock: MOCK, ai: aiInfo() });
});

app.post('/api/circle', wrap((req, res) => {
  const { name, currency = 'USD', contribution, members, type = 'rosca', termMeetings } = req.body;
  if (!name || !(contribution > 0) || !Array.isArray(members) || members.length < 2)
    throw new Error('A circle needs a name, a contribution amount and at least two members.');
  for (const m of members) if (!m.name || !/^\S+@\S+\.\S+$/.test(m.email || '')) throw new Error('Every member needs a name and a valid PayPal email.');
  if (type !== 'rosca' && type !== 'table') throw new Error('Unknown group type.');
  store.set({
    circle: {
      name, currency, contribution: Number(contribution), cycles: [], type,
      ...(type === 'table' ? { termMeetings: Math.max(1, Math.floor(Number(termMeetings)) || 3), loans: [] } : {}),
      members: members.map((m: any) => ({ id: randomUUID().slice(0, 8), name: m.name, email: m.email, onTime: Number(m.onTime) || 0, late: Number(m.late) || 0 })),
    },
  });
  res.json({ ok: true });
}));

app.delete('/api/circle', (_req, res) => { store.set({ circle: null }); res.json({ ok: true }); });

// Start the next cycle (rotating pot) or meeting (table banking): one PayPal invoice per member.
// Rotating pot: the payout order is the member order. Table banking: a borrower's invoice also carries their loan repayment.
app.post('/api/cycles/start', wrap(async (_req, res) => {
  const c = circle(); const table = isTable(c);
  if (c.shareOut) throw new Error('This group has shared out its fund. Reset to start a new term.');
  let cur = current(c);
  if (cur && cur.status === 'collecting' && cur.contributions.length >= c.members.length) {
    if (!table) throw new Error('Finish the current cycle before starting the next one.');
    await sync(c);
    if (!allPaid(c, cur)) throw new Error('Every member must pay in before the next meeting starts.');
    cur.status = 'closed';
  }
  if (!cur || cur.status !== 'collecting') {
    const n = c.cycles.length + 1;
    cur = { n, recipientId: table ? '' : c.members[(n - 1) % c.members.length].id, startedAt: new Date().toISOString(), status: 'collecting', contributions: [] };
    c.cycles.push(cur);
    store.save();
  }
  // If an earlier attempt failed partway, this resumes it: only members without an invoice get one.
  const cycle: Cycle = cur; const n = cycle.n;
  for (const m of c.members) {
    if (cycle.contributions.some((x) => x.memberId === m.id)) continue;
    const first = m.name.split(' ')[0];
    // A loan paid out in an earlier meeting is repaid, with interest, on this meeting's invoice.
    const loan = table ? (c.loans || []).find((l) => l.memberId === m.id && l.status === 'active' && (l.meeting ?? 0) < n) : undefined;
    const items = [{ name: table ? `${c.name} - meeting ${n} savings` : `${c.name} - cycle ${n} contribution`, amount: c.contribution }];
    if (loan) items.push({ name: `Loan repayment: ${loan.amount.toFixed(2)} plus ${loan.interest.toFixed(2)} interest`, amount: r2(loan.amount + loan.interest) });
    const inv = await createAndSendInvoice({
      recipientEmail: m.email, recipientName: m.name, currency: c.currency, items,
      note: table
        ? `Hi ${first}, this is your meeting ${n} savings for ${c.name}.${loan ? ' It also includes your loan repayment with interest.' : ''}`
        : `Hi ${first}, this is your cycle ${n} contribution to ${c.name}. This cycle's pot goes to ${nameOf(c, cycle.recipientId)}.`,
    });
    cycle.contributions.push({
      memberId: m.id, invoiceId: inv.id, number: inv.number, payUrl: inv.payUrl, status: 'SENT', reminders: [],
      ...(table ? { amount: r2(items.reduce((s, i) => s + i.amount, 0)), loanId: loan?.id } : {}),
    });
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
  const loan = x.loanId ? (c.loans || []).find((l) => l.id === x.loanId) : undefined;
  if (loan) loan.status = 'repaid';
}
app.post('/api/cycles/sync', wrap(async (_req, res) => { await sync(circle()); res.json({ ok: true }); }));

// A member paid the treasurer in cash: record it on the PayPal invoice so the books stay in one place.
app.post('/api/cycles/cash/:memberId', wrap(async (req, res) => {
  const c = circle(); const cy = current(c);
  const x = cy?.status === 'collecting' ? cy.contributions.find((x) => x.memberId === req.params.memberId) : undefined;
  if (!x || isPaid(x)) throw new Error('No unpaid contribution for that member.');
  await recordInvoicePayment(x.invoiceId, due(c, x), c.currency, 'Paid to the treasurer in cash');
  markPaid(c, x, 'CASH'); store.save();
  res.json({ ok: true });
}));

function snapshot(c: Circle) {
  if (isTable(c)) return snapshotTable(c);
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
function snapshotTable(c: Circle) {
  const cy = current(c); const f = fund(c);
  return {
    group: c.name, model: 'table banking', currency: c.currency, savingsPerMemberPerMeeting: c.contribution, today: new Date().toISOString().slice(0, 10),
    rules: {
      loanInterest: "10% flat, repaid in full together with the next meeting's savings",
      loanLimit: "three times the borrower's own savings, and never more than the cash in the fund",
      oneLoanAtATimePerMember: true,
      shareOutAfterMeeting: c.termMeetings,
    },
    fund: { cashAvailableToLend: f.cash, totalSavings: f.savings, interestEarned: f.interest, outOnLoan: f.outstanding },
    members: c.members.map((m) => ({ id: m.id, name: m.name, savings: savingsOf(c, m.id), pastMeetingsPaidOnTime: m.onTime, pastMeetingsPaidLate: m.late })),
    currentMeeting: cy && {
      number: cy.n, startedOn: cy.startedAt.slice(0, 10), status: cy.status,
      contributions: cy.contributions.map((x) => ({
        memberId: x.memberId, name: nameOf(c, x.memberId), amountDue: due(c, x), includesLoanRepayment: !!x.loanId,
        paid: isPaid(x), paidHow: x.status === 'PAID' ? 'PayPal' : x.status === 'CASH' ? 'cash' : null,
        remindersAlreadySent: x.reminders.length,
      })),
    },
    loans: (c.loans || []).map((l) => ({
      id: l.id, borrower: nameOf(c, l.memberId), memberId: l.memberId, amount: l.amount, interest: l.interest, purpose: l.purpose, status: l.status,
      ...(l.status === 'requested' ? { eligibleNow: !loanBlock(c, l), whyNotEligible: loanBlock(c, l) || undefined } : {}),
    })),
    shareOutAllowedNow: !shareOutBlock(c), shareOutBlockedBecause: shareOutBlock(c) || undefined,
    shareOut: c.shareOut && { total: c.shareOut.total, perMember: c.shareOut.items.map((i) => ({ name: nameOf(c, i.memberId), amount: i.amount })) },
  };
}

const TREASURER = `You are Kitty, the AI treasurer of a savings circle (also called a chama, tanda, susu or ROSCA).
In a savings circle every member pays the same contribution each cycle, and one member receives the whole pot. Members are friends and family, so trust and goodwill matter more than speed.
You never move money yourself: you propose actions and the human treasurer approves them.`;

const TABLE_TREASURER = `You are Kitty, the AI treasurer of a table banking group (a kind of chama, also known as a village savings and loan group).
In table banking every member saves the same amount at each meeting. The pooled savings form a fund that members can borrow from at interest. At the end of the term the fund, including the interest earned, is shared out to the members in proportion to their savings. Members are friends and family, so trust and goodwill matter more than speed.
You never move money yourself: you propose actions and the human treasurer approves them.`;

const persona = (c: Circle) => (isTable(c) ? TABLE_TREASURER : TREASURER);

const ROSCA_PLAN = `Decide what should happen next and reply with ONLY a JSON object in this shape:
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
- Propose "payout" only if every member has paid. If everyone has paid, propose only the payout.`;

const TABLE_PLAN = `Decide what should happen next and reply with ONLY a JSON object in this shape:
{
  "briefing": "2-3 sentences for the human treasurer on where the meeting and the fund stand",
  "actions": [
    { "type": "remind", "memberId": "<id>", "tone": "gentle" | "firm", "subject": "<email subject>", "note": "<message to the member, under 500 characters>", "reason": "<why this tone, one sentence>" },
    { "type": "loan_decision", "loanId": "<id>", "decision": "approve" | "decline", "reason": "<one or two sentences for the treasurer>" },
    { "type": "share_out", "reason": "<one sentence>" }
  ]
}
Rules:
- Propose "remind" only for members who have not paid this meeting. Choose the tone from their history and how many reminders they have already had: reliable payers get a light nudge, repeat late payers get a firmer but still respectful message. Never shame anyone and never mention other members' payments or loans.
- Each note must say the member's own amountDue, that it is their savings for this meeting (and their loan repayment with interest, if includesLoanRepayment is true), and that they can pay from the PayPal invoice already in their inbox. Sign off as "Kitty, treasurer of <group name>".
- Give exactly one "loan_decision" for every loan whose status is "requested", and none for other loans. If eligibleNow is false, decline and explain using whyNotEligible. If eligibleNow is true, weigh the borrower's payment history, the purpose, and how much of the fund the loan would use, then recommend approve or decline.
- Propose "share_out" only if shareOutAllowedNow is true, and then propose nothing else.
- Quote money amounts exactly as they appear in the data (for example fund.cashAvailableToLend). Do not add them up or work out new totals yourself.`;

// The agent reviews the cycle or meeting and proposes what to do next. Guardrails are enforced in code, not left to the model.
app.post('/api/agent/run', wrap(async (_req, res) => {
  const c = circle(); await sync(c);
  const cy = current(c); const table = isTable(c);
  if (!cy || cy.status !== 'collecting' || c.shareOut) throw new Error(table ? 'There is no meeting in progress.' : 'There is no cycle in progress.');
  const reply = await chat(persona(c), `Here is the ${table ? "group's" : "circle's"} current state as JSON:
${JSON.stringify(snapshot(c), null, 2)}

${table ? TABLE_PLAN : ROSCA_PLAN}`);
  const plan = extractJson<{ briefing: string; actions: any[] }>(reply);
  const unpaid = new Set(cy.contributions.filter((x) => !isPaid(x)).map((x) => x.memberId));
  const seenLoans = new Set<string>();
  const actions = (plan.actions || []).flatMap((a): any[] => {
    if (a.type === 'remind') return unpaid.has(a.memberId) && a.subject && a.note ? [{ ...a, note: String(a.note).slice(0, 900) }] : [];
    if (!table) return a.type === 'payout' && allPaid(c, cy) ? [a] : [];
    if (a.type === 'loan_decision') {
      const loan = (c.loans || []).find((l) => l.id === a.loanId && l.status === 'requested');
      if (!loan || seenLoans.has(loan.id)) return [];
      seenLoans.add(loan.id);
      // The model can recommend, but it cannot approve a loan the rules forbid.
      const block = loanBlock(c, loan);
      if (block) return [{ ...a, decision: 'decline', reason: block }];
      return [{ ...a, decision: a.decision === 'approve' ? 'approve' : 'decline' }];
    }
    if (a.type === 'share_out') return shareOutBlock(c) ? [] : [a];
    return [];
  }).map((a) => ({ ...a, id: randomUUID().slice(0, 8) }));
  res.json({ briefing: plan.briefing, actions });
}));

// The human treasurer approved a reminder: PayPal delivers it with the invoice attached.
app.post('/api/actions/remind', wrap(async (req, res) => {
  const c = circle(); const cy = current(c);
  const { memberId, subject, note } = req.body;
  const x = cy?.status === 'collecting' ? cy.contributions.find((x) => x.memberId === memberId) : undefined;
  if (!x || isPaid(x)) throw new Error('That member has no unpaid contribution.');
  if (!subject || !note) throw new Error('A reminder needs a subject and a note.');
  await remindInvoice(x.invoiceId, String(subject).slice(0, 200), String(note).slice(0, 900));
  x.reminders.push({ at: new Date().toISOString(), subject, note }); store.save();
  res.json({ ok: true });
}));

// The human treasurer approved the payout: the whole pot goes to this cycle's recipient through PayPal Payouts.
app.post('/api/actions/payout', wrap(async (_req, res) => {
  const c = circle(); await sync(c);
  if (isTable(c)) throw new Error('A table banking group shares out its fund instead of paying out a pot.');
  const cy = current(c);
  if (!cy || cy.status !== 'collecting') throw new Error('There is no cycle in progress.');
  if (!allPaid(c, cy)) throw new Error('The pot can only be paid out once every member has contributed.');
  const recipient = c.members.find((m) => m.id === cy.recipientId)!;
  const amount = c.contribution * c.members.length;
  const p = await createPayout({
    currency: c.currency,
    subject: `${c.name}: your cycle ${cy.n} pot has arrived`,
    note: `It's your turn! Here is the cycle ${cy.n} pot from ${c.name}.`,
    idempotencyKey: `${keyBase(c)}-${cy.n}-${stamp(cy.startedAt)}${cy.failedPayouts?.length ? '-r' + cy.failedPayouts.length : ''}`,
    items: [{ email: recipient.email, amount }],
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

// ---------- Table banking: loans and share-out ----------
// A member asks to borrow. Nothing moves until the treasurer approves.
app.post('/api/loans', wrap((req, res) => {
  const c = tableCircle();
  const { memberId, purpose } = req.body; const amount = r2(Number(req.body.amount));
  if (c.shareOut) throw new Error('The group has already shared out its fund.');
  if (!c.members.some((m) => m.id === memberId)) throw new Error('Choose the member who is borrowing.');
  if (!(amount > 0)) throw new Error('A loan needs an amount.');
  if ((c.loans || []).some((l) => l.memberId === memberId && (l.status === 'requested' || l.status === 'active')))
    throw new Error(`${nameOf(c, memberId)} already has a loan or a request open.`);
  (c.loans ||= []).push({
    id: randomUUID().slice(0, 8), memberId, amount, interest: r2(amount * LOAN_INTEREST),
    purpose: String(purpose || '').slice(0, 200), requestedAt: new Date().toISOString(), status: 'requested',
  });
  store.save(); res.json({ ok: true });
}));

// The human treasurer approved a loan: the rules are checked again, then PayPal Payouts sends it to the borrower.
app.post('/api/loans/:id/approve', wrap(async (req, res) => {
  const c = tableCircle(); await sync(c);
  const loan = (c.loans || []).find((l) => l.id === req.params.id);
  if (!loan || loan.status !== 'requested') throw new Error('That loan is not waiting for a decision.');
  const block = loanBlock(c, loan);
  if (block) throw new Error(block);
  const m = c.members.find((m) => m.id === loan.memberId)!;
  const p = await createPayout({
    currency: c.currency,
    subject: `${c.name}: your loan has arrived`,
    note: `Here is your loan of ${cash(c, loan.amount)} from ${c.name}. ${cash(c, r2(loan.amount + loan.interest))} is due with your savings at the next meeting.`,
    idempotencyKey: `${keyBase(c)}-loan-${loan.id}${loan.failed ? '-r' + loan.failed : ''}`,
    items: [{ email: m.email, amount: loan.amount }],
  });
  loan.status = 'active'; loan.meeting = current(c)!.n; loan.payout = p;
  store.save(); res.json({ ok: true });
}));

app.post('/api/loans/:id/decline', wrap((req, res) => {
  const c = tableCircle();
  const loan = (c.loans || []).find((l) => l.id === req.params.id);
  if (!loan || loan.status !== 'requested') throw new Error('That loan is not waiting for a decision.');
  loan.status = 'declined'; loan.declineReason = String(req.body.reason || 'Declined by the treasurer.').slice(0, 300);
  store.save(); res.json({ ok: true });
}));

// The human treasurer approved the share-out: every member gets their savings plus their share of the interest, in one PayPal payout batch.
app.post('/api/shareout', wrap(async (_req, res) => {
  const c = tableCircle(); await sync(c);
  const block = shareOutBlock(c);
  if (block) throw new Error(block);
  const f = fund(c);
  const items = c.members.map((m) => ({ memberId: m.id, amount: r2((savingsOf(c, m.id) * f.cash) / f.savings) })).filter((i) => i.amount > 0);
  // Put any rounding remainder on the last share so the batch total equals the fund exactly.
  items[items.length - 1].amount = r2(items[items.length - 1].amount + f.cash - items.reduce((s, i) => s + i.amount, 0));
  const p = await createPayout({
    currency: c.currency,
    subject: `${c.name}: your share-out has arrived`,
    note: `Here is your share of the ${c.name} fund: your savings plus your share of the interest earned.`,
    idempotencyKey: `${keyBase(c)}-share-${stamp(c.cycles[0].startedAt)}${c.shareOutFailed ? '-r' + c.shareOutFailed : ''}`,
    items: items.map((i) => ({ email: c.members.find((m) => m.id === i.memberId)!.email, amount: i.amount })),
  });
  c.shareOut = { ...p, at: new Date().toISOString(), total: f.cash, items };
  current(c)!.status = 'closed'; store.save();
  try {
    c.shareOut.summary = await chat(TABLE_TREASURER, `The group has just shared out its fund. Write a warm 3-4 sentence summary for the members' group chat: the total shared out, how much interest the fund earned from loans, what each member received, and a thank-you. Do not single out anyone who paid late or who borrowed. Use the amounts exactly as given in the data. Plain text only: no markdown and no asterisks.

State: ${JSON.stringify(snapshot(c))}`, 1200);
    store.save();
  } catch (e: any) { c.shareOut.summary = `(AI summary unavailable: ${e.message})`; store.save(); }
  res.json({ ok: true });
}));

app.post('/api/payout/refresh', wrap(async (_req, res) => {
  const c = circle();
  const dead = ['DENIED', 'CANCELED'];
  const settled = (s: string) => ['SUCCESS', ...dead].includes(s);
  for (const cy of c.cycles) {
    if (!cy.payout || settled(cy.payout.status)) continue;
    cy.payout.status = (await getPayout(cy.payout.batchId)).status;
    // PayPal rejected the whole batch, so no money moved: reopen the cycle so the treasurer can approve the payout again.
    if (dead.includes(cy.payout.status) && cy === current(c)) {
      cy.failedPayouts = [...(cy.failedPayouts || []), { batchId: cy.payout.batchId, status: cy.payout.status }];
      delete cy.payout; delete cy.summary;
      cy.status = 'collecting';
    }
  }
  for (const loan of c.loans || []) {
    if (!loan.payout || settled(loan.payout.status)) continue;
    loan.payout.status = (await getPayout(loan.payout.batchId)).status;
    // A rejected loan payout goes back to "requested", unless its repayment has already been invoiced.
    if (dead.includes(loan.payout.status) && loan.status === 'active' && !c.cycles.some((cy) => cy.contributions.some((x) => x.loanId === loan.id))) {
      loan.status = 'requested'; loan.failed = (loan.failed || 0) + 1;
      delete loan.payout; delete loan.meeting;
    }
  }
  if (c.shareOut && !settled(c.shareOut.status)) {
    c.shareOut.status = (await getPayout(c.shareOut.batchId)).status;
    if (dead.includes(c.shareOut.status)) {
      delete c.shareOut; c.shareOutFailed = (c.shareOutFailed || 0) + 1;
      current(c)!.status = 'collecting';
    }
  }
  store.save(); res.json({ ok: true });
}));

app.post('/api/ask', wrap(async (req, res) => {
  const c = circle(); await sync(c);
  const q = String(req.body.question || '').slice(0, 500);
  if (!q) throw new Error('Ask a question first.');
  const answer = await chat(persona(c), `Answer the treasurer's question using only this data. Be brief and concrete. If the data cannot answer it, say so.

Data: ${JSON.stringify(snapshot(c))}

Question: ${q}`, 1200);
  res.json({ answer });
}));

// Offline development only: lets a mock invoice be "paid".
if (MOCK) app.get('/mock/pay/:id', (req, res) => res.send(mockPayInvoice(req.params.id) ? 'Mock invoice paid. Go back and press Refresh.' : 'Unknown invoice'));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Kitty is running on http://localhost:${port}${MOCK ? '  (PAYPAL_MOCK=1: no real PayPal calls)' : '  (PayPal sandbox)'}`));
