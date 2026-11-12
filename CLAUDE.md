# Kitty: notes for Claude Code

Kitty is an AI treasurer for savings circles, built for the PayPal AI Hackathon 2026 (deadline Thu 12 Nov 2026, 20:00 UTC). Read README.md first.

## Commands

- `npm install` then `npm start` (http://localhost:3000). `npm run dev` restarts on change.
- `npm run check`: sandbox preflight. Verifies PayPal credentials, Invoicing and Payouts scopes, and the AI key. Run this first.
- `npm run typecheck`: must pass before any commit.
- `PAYPAL_MOCK=1 npm start`: runs without PayPal, for UI work only. Never use it for the demo or the video.

## Rules

- PayPal sandbox only. `src/paypal.ts` hard-codes the sandbox host; do not add a live mode.
- Never print, log or commit the contents of `.env`. Never put real credentials in the README.
- The AI proposes; the human approves. Do not add any path where the model moves money without a click. Keep the server-side guardrails in `POST /api/agent/run` and `POST /api/actions/payout`.
- Keep it small: Express, one HTML file, JSON-file storage. No new frameworks.

## Sandbox setup the app expects

- One sandbox **business** account (the treasurer) that owns the REST app in `.env`. A US account is the safest choice: USD, Invoicing and Payouts all work. It needs enough balance to pay a pot.
- Three or four sandbox **personal** accounts (the members), each with balance to pay an invoice.

## First real test (do these in order and stop at the first failure)

1. `npm run check`. All lines should say PASS.
2. `npm start`, open the app, create a circle with the members' sandbox emails, contribution 10.
3. Start cycle 1. Expect one invoice link per member. If this fails, the error shows PayPal's message and debug_id; fix the request body in `createAndSendInvoice` in `src/paypal.ts` against the Invoicing v2 docs.
4. Pay one invoice as a member (open the link, log in with that sandbox personal account), then "Refresh from PayPal". Expect "Paid via PayPal".
5. "Ask Kitty what to do next". Expect reminders only for unpaid members, with different tones for reliable and late payers. Approve one; expect no error from the remind call.
6. "Record cash" for one member; pay the rest. Ask Kitty again; expect only a payout proposal.
7. Approve the payout. Expect a batch id and, after "Refresh payout status", SUCCESS. Check the recipient's sandbox balance.

## Table banking (second group type)

Chosen on the setup form (`type: 'table'`). Meetings reuse the cycle records; loans and the share-out live on the circle. The fund is derived from paid invoices and loan states (`fund` in `src/server.ts`), never stored. Rules are constants and checks in code (`loanBlock`, `shareOutBlock`): 10% flat interest repaid at the next meeting, limit of three times own savings and never more than the fund's cash, one loan per member, no share-out with a loan outstanding or before `termMeetings`.

Sandbox test, with 4 members, savings 10, 2 meetings before share-out:

1. Start meeting 1; pay or record cash for all four. Fund shows 40.
2. Add a loan request of 20 for one member and one of 50 for another. Ask Kitty: expect "approve" for the 20 and "decline" for the 50.
3. Approve the 20. Expect a payout batch id, and the fund at 20 with 20 out on loan.
4. Start meeting 2. The borrower's invoice should be 32 with two lines; the others 10.
5. Pay all four. Fund shows 82 with 2 interest. Ask Kitty: expect only the share-out.
6. Approve the share-out. Expect one batch with four items of 20.50 and, after refresh, SUCCESS.

## Rotation schedule (Bryntum Scheduler, rotating pot only)

- Installed with `npm install @bryntum/scheduler@npm:@bryntum/scheduler-trial` (v7.3.8). Served from `node_modules/@bryntum/scheduler` at `/vendor/bryntum`; no bundler. `public/index.html` loads `scheduler.module.js`, `scheduler.css`, `svalbard-light.css`, `fontawesome/css/fontawesome.css` and `fontawesome/css/solid.css`.
- Bryntum API names change between versions. Check them against `node_modules/@bryntum/scheduler/scheduler.d.ts` before changing the panel; do not guess.
- The circle has `startDate`, `cycleDays` (default 30) and `payoutOrder` (member ids). `fillDefaults` in `src/server.ts` fills them for older saved data. The recipient of cycle n is `payoutOrder[(n - 1) % members.length]`, fixed on the cycle when it starts.
- `PUT /api/circle/order { payoutOrder }` accepts only a permutation of the member ids and refuses to change a position whose cycle has started in the rotation shown.
- The panel is rebuilt from `/api/state` (`schedule`) after every render, so a rejected drag reverts by itself.
- The trial lasts 45 days from a browser's first load of the page (start time in local storage, per browser and per origin). After that the panel is empty with a "Trial expired" link.
- `KITTY_DB=path npm start` uses another data file, for tests that should not touch `data/db.json`.

Drag test: with cycle 1 in progress, drag the cycle 2 "receives the pot" bar to another member's row. Start cycle 2 after cycle 1 is paid out; the invoice note and the payout should name the new recipient.

## Verified against the real sandbox (11 Nov 2026)

- Rotating pot, three full cycles: invoice create, send, remind and record payment; `recipient_view_url` returned straight after sending; Payouts; prompt quality with `openai/gpt-oss-120b` on Groq.

- Table banking, one full two-meeting term: a loan payout, an invoice with two line items paid through PayPal, and a share-out batch with four items.

- Rotation schedule (12 Nov 2026): cycle 2's turn dragged from Carlos to Priya while cycle 1 was running; cycle 2's invoice notes and its payout (read back from PayPal) both went to Priya.

## Not yet verified against the real sandbox

- The denied-payout retry paths (pot, loan and share-out).
- Recording a cash payment on a two-line invoice, and sending a reminder for one.
