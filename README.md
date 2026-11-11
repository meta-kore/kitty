# Kitty: the AI treasurer for savings circles

Ten friends each put in $100 a month. Each month, one of them takes home the $1,000 pot. That is a **savings circle**, and hundreds of millions of people run one: it is a *chama* in Kenya, a *tanda* in Mexico, a *susu* in West Africa and the Caribbean, a *hui* in China and a *chit fund* in India.

Every circle depends on one unpaid volunteer, the treasurer, who chases contributions by hand and keeps the books in a notebook or a chat thread. When members live in different countries, collecting gets harder still.

**Kitty does the treasurer's job with PayPal and AI**, and the human treasurer only approves.

Built for the PayPal AI Hackathon 2026.

## What it does

1. **Collects**: at the start of a cycle, Kitty sends every member a PayPal invoice for their contribution.
2. **Tracks**: it reads invoice status from PayPal and shows who has paid and how full the pot is.
3. **Chases, thoughtfully**: the AI reviews the cycle and each member's payment history, then drafts reminders in a tone that fits the person: a light nudge for someone who always pays on time, a firmer note for a repeat late payer. The treasurer edits or approves, and PayPal delivers the reminder with the invoice attached.
4. **Pays out**: once everyone has paid, the AI proposes the payout, the treasurer approves, and PayPal Payouts sends the whole pot to that cycle's recipient.
5. **Answers questions**: "Who still owes this cycle?" "Who has been most reliable?"
6. **Reports**: after each payout the AI writes a short summary for the group chat.

## Two kinds of group

Kitty runs either model; you choose when you create the group.

**Rotating pot** (the flow above): everyone pays in each cycle and one member takes the whole pot, in turn.

**Table banking**: the group keeps a fund instead of handing over a pot.

1. **Save**: at each meeting, every member gets a PayPal invoice for the same savings amount. Paid savings build the fund.
2. **Borrow**: a member can ask for a loan from the fund. The AI recommends approving or declining, with reasons based on the rules, the fund and the borrower's history. The treasurer decides, and PayPal Payouts sends the loan.
3. **Repay**: the borrower's next invoice carries their savings plus the loan and its interest as a second line.
4. **Share out**: at the end of the term, one PayPal payout batch returns each member's savings plus their share of the interest earned.

The rules are fixed in code: 10% flat interest, repaid in full at the next meeting; a loan limit of three times the borrower's own savings and never more than the cash in the fund; one loan per member at a time; no share-out while a loan is outstanding. The server enforces them whatever the AI recommends.

## How PayPal is used

| PayPal API | Used for |
|---|---|
| Invoicing v2: create, send | One contribution invoice per member, per cycle |
| Invoicing v2: get | Payment status for the dashboard and the AI |
| Invoicing v2: remind | Delivering the AI-written, treasurer-approved reminder |
| Invoicing v2: record payment | Members who paid the treasurer in cash, so the books stay in one place |
| Payouts | Sending the pot to the cycle's recipient; in table banking, sending loans and the share-out batch |

All calls go to the PayPal **sandbox**. The code cannot point at live PayPal.

## How AI is used

- **Planning agent** (`POST /api/agent/run`): reads the circle's state and returns a structured plan of proposed actions (reminders with tone, subject, message and reasoning; or the payout).
- **Guardrails in code, not in the prompt**: the server discards any proposed reminder for a member who has paid, and any payout proposed before every member has paid. In table banking it turns an "approve" for a loan that breaks the rules into a "decline", and drops a share-out proposed too early. The AI never moves money by itself: every action needs the treasurer's click.
- **Question answering** and **cycle summaries** over the circle's data.

Works with Claude (Anthropic), Groq, Gemini or OpenRouter: set `AI_PROVIDER`, `AI_API_KEY` and optionally `AI_MODEL`.

## Run it

Requires Node.js 20 or later.

```bash
npm install
cp .env.example .env    # then fill it in
npm run check           # confirms your PayPal sandbox and AI keys work
npm start               # http://localhost:3000
```

In `.env`:

- `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`: from a **sandbox** REST app at developer.paypal.com, belonging to a sandbox **business** account (the treasurer's account). Payouts must be enabled for the app, and the account needs enough sandbox balance to cover a pot.
- `AI_PROVIDER`, `AI_API_KEY`: your AI provider and key.

## Test it (about 3 minutes)

You need the sandbox business account above plus a few sandbox **personal** accounts to act as members (developer.paypal.com > Testing Tools > Sandbox Accounts).

1. Open the app and create a circle, entering the sandbox personal-account emails for the members.
2. Click **Start cycle 1 and send PayPal invoices**.
3. Click a member's invoice link, log in with that member's sandbox account and pay. Do this for some members, then click **Refresh from PayPal**.
4. Click **Ask Kitty what to do next**. Review the reminders, edit if you like, and approve one.
5. Pay the remaining invoices (or click **Record cash**), then ask Kitty again. It now proposes the payout.
6. Approve the payout. The recipient's sandbox account receives the pot, and the cycle summary appears under Payout history.

## Project layout

```
src/server.ts   API and the treasurer agent
src/paypal.ts   PayPal sandbox client (Invoicing, Payouts)
src/ai.ts       Provider-agnostic AI client
src/store.ts    JSON-file storage
public/         Single-page dashboard
```

## Limitations

- One circle per deployment, stored in a local JSON file; no member logins.
- Table banking is a minimal version: no fines, social fund or instalment loans, and a term ends at the share-out.
- PayPal fees on received invoice payments are not netted out of the pot.
- Reminders reach members by PayPal email only.
- `PAYPAL_MOCK=1` runs the app without PayPal for offline development. It is not used in the demo.

## AI tools used

### In the running app

Kitty calls a large language model for three jobs, all in `src/server.ts`:

| Job | What the model does |
|---|---|
| Planning (`POST /api/agent/run`) | Reads the circle's state and proposes reminders (tone, subject, message, reasoning) or the payout, as JSON |
| Questions (`POST /api/ask`) | Answers the treasurer's questions from the circle's data only |
| Cycle summary | Writes a short group-chat summary after each payout |

The model is chosen in `.env` and reached through one small client, `src/ai.ts`. It supports Anthropic (Claude), Groq, Gemini and OpenRouter. The end-to-end sandbox test and the demo used **`openai/gpt-oss-120b` hosted on Groq**.

The model never moves money. It only returns proposals; the server checks each one against PayPal's data, and every reminder and payout needs the treasurer's click.

### In development

- **Claude Code** (Anthropic), running Claude Fable 5.2: used for code review, bug fixes and hardening of the payout guardrails, setup of the PayPal sandbox preflight, and driving the end-to-end sandbox test. Commits it contributed to carry a `Co-Authored-By` line.

## Licence

MIT
