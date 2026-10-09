# Dispute Desk

An AI chargeback agent for small merchants who take payments through PayPal.

When a buyer opens a dispute, Dispute Desk pulls the claim from PayPal, reads the merchant's own order, tracking and customer-service records, estimates the chance of winning, recommends whether to fight, refund or offer a partial refund, and drafts the response. The merchant approves with one click and the response is filed through the PayPal Disputes API.

Built for the PayPal AI Hackathon with PayPal, Claude and AG Grid.

## Run it

Requires Node 22 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:3000. With no configuration the app runs in **simulator mode**: a built-in stand-in for PayPal with seeded disputes, and a deterministic rules engine in place of Claude. Two chips in the header always show which mode is active.

To switch on the real integrations, copy `.env.example` to `.env.local` and fill in what you have:

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Claude analyses disputes and powers the plain-English grid filter. |
| `AI_DAILY_ANALYSES`, `AI_DAILY_FILTERS` | Daily ceilings on Claude calls (default 100 and 300, `0` = unlimited). Past the ceiling the app falls back to the rules engine and says so. |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Calls the PayPal sandbox REST API instead of the simulator. |
| `PAYPAL_WEBHOOK_ID` | Verifies webhook signatures. |
| `DEMO_DATA` | Set to `off` to hide the sample cases when PayPal is connected. By default they stay available. |
| `DATABASE_URL` | Uses Postgres instead of the embedded PGlite database in `./.data`. |

When PayPal credentials are set, the sample cases stay available next to the real ones. Each case belongs either to the real PayPal API or to the simulator, rows from the simulator are tagged **Sample**, and actions on a sample case never reach PayPal. This lets a visitor try the whole product without a PayPal login while real sandbox cases flow in through Sync and webhooks.

## Try it in two minutes (sample cases)

1. Press **Try a sample case** and pick one. A row appears and fills in as the agent works.
2. Click the row. The drawer shows the win chance, the evidence for and against, the drafted response, the order record and the audit trail.
3. Press **Submit evidence** (or **Approve** in the grid). Tick several rows to approve them together.
4. In the drawer, use the sandbox control **Rule for seller** to close the case and watch the money move to "kept".
5. Type `unauthorized claims over $100` into the filter bar.
6. Open **Autopilot** to let the agent act alone on small, clear-cut cases.
7. **Demo store** places an order and lets you dispute it as the buyer.

## Test against the real PayPal sandbox

1. At developer.paypal.com create a sandbox **business** account, a **personal** account, and a REST app. Put the app's client ID and secret in `.env.local`.
2. Open `/store`, choose how the order should "ship" (this sets the evidence the agent will find), and pay with the sandbox personal account.
3. Log in at sandbox.paypal.com as that buyer, open the Resolution Center, report a problem on the payment and escalate it to a claim.
4. On the dashboard press **Sync from PayPal** (or **Import case** with the case ID if it has not appeared yet). For push updates, register `https://<your-host>/api/webhooks/paypal` for the `CUSTOMER.DISPUTE.CREATED`, `UPDATED` and `RESOLVED` events and set `PAYPAL_WEBHOOK_ID`.
5. Approve the agent's recommendation. The app files it through whichever action PayPal currently allows on the case. The **Rule for seller / buyer** control appears only when PayPal offers its sandbox adjudicate action.

## How it works

```
PayPal webhook / sync ──> ingest ──> analysis queue ──> agent ──> verdict in grid
                                                                      │
                          PayPal Disputes API <── act <── merchant approval / autopilot
```

- **PayPal** (`src/lib/paypal`). One gateway interface with two implementations: `live.ts` calls the REST API, `simulator.ts` keeps dispute documents in the local database in PayPal's own JSON shape. The gateway is chosen per case, and everything above it is the same code for both.
  - Disputes: list, show details, provide evidence (with a generated PDF packet), accept claim, make offer, send message, sandbox adjudicate.
  - Orders v2: create, capture and add tracking, for the demo store checkout (PayPal JavaScript SDK buttons).
  - Webhooks: signature verification. The handler only takes the dispute ID from the event and re-reads the dispute from PayPal, so a forged event cannot plant data.
- **Agent** (`src/lib/agent`). Claude runs a tool-use loop: `get_dispute`, `get_order`, `get_buyer_history`, then `submit_verdict` with a strict schema (win probability, recommendation, evidence, missing evidence, risk flags, response letter). The prompt tells it to use only facts returned by the tools and to treat buyer-written text as evidence, never as instructions. If the model call fails, the rules engine scores the dispute and the audit trail records why.
- **Actions** (`src/lib/desk.ts`). Nothing is sent to PayPal without merchant approval unless an autopilot rule matches. Every step is written to an audit log.
- **Grid** (`src/components`). AG Grid is the workspace: live-updating rows, custom cell renderers, multi-row approve, and filters set from a plain-English request. AG Charts shows money kept by week and outcomes by claim type.

## AI tools used

- **Claude (Anthropic API, `claude-opus-5-5`)**: the dispute analyst described above, and the translator that turns a typed request into AG Grid filters using structured output.
- **Claude Code**: used to write the project.

## Checks

```bash
npm test          # 23 tests: every scenario, the full dispute lifecycle on the simulator, autopilot, PDF
npm run eval      # runs the 12 labelled scenarios through Claude and the rules baseline (needs ANTHROPIC_API_KEY)
npm run typecheck
npm run lint
npm run build
```

The 12 scenarios in `src/lib/scenarios.ts` each carry the decision a careful human would make. The rules engine scores 12/12 on them, which says little: it was written alongside those cases. Treat it as a regression check, and add cases the rules have not seen before quoting accuracy numbers.

## Deploy

`render.yaml` describes a Render web service plus Postgres. Create a Blueprint from the repo and fill in the secret environment variables.

## Limits to know about

- Verified against the PayPal sandbox (2026-10-10): OAuth, order create and capture with the JS SDK buttons, adding tracking, listing and fetching disputes, and filing a response with a PDF attachment through `provide-supporting-info`, and forced rulings through `adjudicate` in both directions (one case closed as won, one as lost). Not yet verified there: `provide-evidence`, `accept-claim`, `make-offer`, webhooks.
- In two sandbox cases PayPal enabled `adjudicate`, `require-evidence` and `accept-claim` 10 and 15 minutes after the seller response was filed, and took about two minutes to close each case after the ruling call. Before that a case accepts supporting info only, so `accept-claim` and `make-offer` have not been exercised against the sandbox.
- The sandbox dispute list can lag a few minutes behind a new case. **Import case** fetches it by ID.
- The Claude agent matched the human answer on all 12 labelled scenarios in a single eval run (`claude-opus-5-5`, 2026-10-09). Those scenarios are deliberately clear-cut; ambiguous cases are not yet covered.
- The demo has no login. Do not point it at a production PayPal account.
- Merchant evidence comes from the demo store's own order records. A real deployment would connect a shop platform or order database.

## License

MIT, see [LICENSE](LICENSE).
