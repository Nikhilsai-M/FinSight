# FinSight interview guide

This guide is based on the FinSight claim in your resume and the code in this repository. It describes the checked-in implementation, not a hypothetical production finance system. Practice explaining the ideas in your own words. Do not claim a feature or performance result that the code does not show.

## 1. Your opening answer

### 30 seconds

> FinSight is a personal finance app I built with Next.js. A signed-in user can create accounts, record income and expenses, set a monthly budget, view charts, and scan a receipt to prefill a transaction. Clerk handles identity, Prisma stores the finance data in PostgreSQL hosted by Supabase, and Inngest runs recurring transactions and scheduled report and alert jobs. Gemini extracts receipt fields and drafts report insights. My most important backend design choice was to scope data access to the authenticated user and update a transaction and its account balance in one database transaction.

### 90 seconds

> The main entities are User, Account, Transaction, and Budget. Clerk gives me an external user ID; I map that to an internal User row, and Accounts, Transactions, and Budget refer to the internal ID. The dashboard is a server-rendered route that fetches recent activity and category totals from PostgreSQL, then passes the summaries to interactive client components. Mutations use Next.js Server Actions. When a transaction is added, edited, or deleted, the app changes both the transaction row and cached account balance in a serializable Prisma database transaction, then revalidates the affected page. A receipt scan sends an image to Gemini and prefills fields for the user to review before saving; the app does not retain the image. Inngest handles scheduled jobs: a daily scan emits per-transaction events, a monthly report summarizes the prior month and emails insights, and a six-hour budget check can send an alert. I added server-side validation, Decimal arithmetic, occurrence idempotency keys, and database-backed paging while keeping room for stronger audit and delivery guarantees.

If asked "what exactly did you personally implement?", answer from your actual work history. The repository proves what is present; it cannot establish which commits you authored.

## 2. Architecture map

```text
Browser
  |  Clerk session; forms; account and chart UI
  v
Next.js App Router
  |-- proxy.js: Clerk route protection and Arcjet shield/bot checks
  |-- Server Components: fetch initial dashboard/account data
  |-- Server Actions: authenticate, authorize, mutate, revalidate
  |-- /api/inngest: registers background functions
  v
Prisma Client + PrismaPg adapter --> Supabase-hosted PostgreSQL
  |-- User --> Account --> Transaction
  |-- User --> Budget (one row per user)

Receipt image --> scanReceipt Server Action --> Gemini --> suggested form values
Inngest cron/event --> Prisma + Gemini (insights) + Resend (email)
```

**Responsibilities.** Next.js is the full-stack web framework. React client components manage interactions. Clerk authenticates users. Your own database queries authorize access to records. Prisma is the ORM and migration layer. Supabase supplies PostgreSQL; this code does not use Supabase Auth or Storage. Arcjet adds middleware shield/bot rules and token-bucket protection on account and transaction creation. Inngest coordinates scheduled/event-driven work. Gemini is used for receipt extraction and monthly written insights. Resend sends email. Recharts renders charts.

**Important distinction:** Core create/edit/delete operations are Server Actions, not a set of custom REST endpoints. `/api/inngest` is a Route Handler. The placeholder seed endpoint was removed.

## 3. Data model you should be able to draw

| Entity | Key fields | Relationship and reason |
| --- | --- | --- |
| User | `id`, unique `clerkUserId`, unique `email` | Internal row mapped to Clerk identity. Owns accounts, transactions, budget. |
| Account | `id`, `userId`, `type`, Decimal `balance`, `isDefault` | Belongs to one user. Balance is a stored running total. |
| Transaction | `id`, `userId`, `accountId`, `type`, Decimal `amount`, `date`, `category`, recurrence fields, `status` | Belongs to user and account. `INCOME` increases balance; `EXPENSE` decreases it. Generated recurring occurrences have unique `(sourceTransactionId, scheduledFor)` keys. |
| Budget | `id`, unique `userId`, Decimal `amount`, `lastAlertSent`, `alertClaimedAt` | Exactly one budget row per user in the schema; UI compares it with the default account's monthly expenses. The claim timestamp coordinates alert workers. |

Foreign keys cascade on user/account deletion. Indexes exist on account `userId` and transaction `userId` and `accountId`. The schema has `receiptUrl`, but receipt scans currently prefill a form; they do not upload and retain the receipt. Categories are strings drawn from static UI data, not database Category rows. `PENDING` and `FAILED` transaction statuses exist in the enum, but normal create and recurring flow write completed transactions.

**Balance invariant:** For each account, `current balance = initial balance + sum(income) - sum(expense)` for that account. The initial balance is stored in the same `balance` field, so the system does not preserve a separate opening-balance ledger entry. This makes later reconciliation harder. A stronger design would store an immutable opening balance or ledger entries and derive or reconcile the cached balance.

## 4. Trace the main flows

### Sign-in and user creation

1. Clerk manages login/session. `proxy.js` redirects unauthenticated visitors from dashboard, account, and transaction routes.
2. `Header` calls `checkUser()`: it gets the current Clerk user, looks up `clerkUserId`, and creates a local User row if missing.
3. Server Actions independently call `auth()`, resolve the internal User, and scope database queries by `user.id`. Route protection alone is not sufficient authorization for a callable Server Action.
4. For an account or transaction ID, the important check is `id AND userId`. An authenticated user must not be able to use another user's ID.

### Create a transaction

1. The client form uses React Hook Form with a Zod resolver and sends the amount as a decimal string. The Server Action independently validates and parses it to Prisma Decimal.
2. `createTransaction()` checks Clerk auth, calls Arcjet, resolves the local User, and verifies the target account belongs to that user.
3. It calculates a signed Decimal balance change, creates the transaction, and atomically increments the account balance in a serializable `db.$transaction(...)` with retry on write conflicts.
4. It calls `revalidatePath` for dashboard and account page, then returns a serialized amount to the client.

Example: balance ₹1,000; add ₹200 expense; new balance ₹800. If the balance write fails, the database transaction rolls back the insert. Distinguish **atomicity** from **concurrency safety**: the original code read balance outside the transaction and wrote an absolute balance, which allowed lost updates. The current code uses an atomic `increment` and serializable transactions with retries. A database concurrency test is still valuable before making a strong reliability claim.

### Edit or delete a transaction

For an edit in the same account, compute `new signed effect - old signed effect`. For an account move, reverse the old effect in the old account and apply the new effect in the target account. Example: old ₹100 expense has effect `-100`; new ₹150 expense has effect `-150`; net adjustment is `-50`. `updateTransaction()` handles same-account and moved-account updates in a database transaction. `bulkDeleteTransactions()` reverses each selected transaction's effect, deletes the rows, and adjusts balances in one transaction.

### Receipt scanning

The client accepts JPEG, PNG, or WebP images up to 4 MB. `scanReceipt(file)` checks Clerk auth and an Arcjet rate limit, validates type/size and file signature on the server, converts the image to Base64, and sends it to Gemini. It parses and validates amount/date/description/category before returning suggestions. The form fills fields and the user submits a normal transaction. The image is **not stored**. There is no separate OCR engine, confidence threshold, or full image decoder implemented.

### Budget and charts

There is one `Budget` per user (`userId` unique). The dashboard selects the default account and compares its current-month expenses with the budget. The UI shows progress; Inngest checks budgets every six hours and emails at 80% if an alert has not been sent that month. A database claim reduces concurrent duplicate alerts, and `lastAlertSent` advances only after Resend confirms an accepted send. Recent activity, category totals, chart totals, and transaction pages are queried or aggregated in PostgreSQL; the browser handles selection and display.

### Recurring jobs and reports

The daily Inngest cron finds due recurring transactions and emits a `transaction.recurring.process` event per row. The event function can catch up to 31 missed occurrences, creates each with a unique source/scheduled-date key, updates the account balance, and advances `lastProcessed` and `nextRecurringDate` in a serializable database transaction. Monthly report cron aggregates the previous month's income, expenses, and categories, asks Gemini for three validated insights, and sends a React Email template through Resend. Budget cron checks at six-hour intervals. These jobs need an Inngest integration configured against `/api/inngest`; source code alone does not prove delivery succeeds in deployment.

## 5. Interview questions with answers and likely follow-ups

### A. Product and architecture

**1. Why did you build FinSight?**

> To bring account balances, transactions, budgets, and recurring spending into one dashboard. Receipt prefill lowers data-entry effort, while scheduled reports and alerts make the data useful without requiring a user to check the app every day. I prioritized a functional full-stack workflow first, then identified the consistency and security work needed for production.

**Follow-up: Why Next.js instead of separate React and Express apps?** Server Components can fetch initial data near the database, Server Actions handle form mutations, and route handlers expose only integration endpoints. One codebase simplifies this prototype. A separate API could make sense for mobile clients or multiple consumers.

**2. Server Component versus Client Component here?**

> Dashboard and account route components fetch authenticated data on the server. Forms, account selectors, charts, filters, and pagination use `"use client"` because they need browser state or events. The updated implementation requests bounded transaction pages and aggregated chart data from the server, so it does not ship a user's full history to the browser.

**3. Server Action versus REST API?**

> A Server Action is a server function callable from the Next.js UI, convenient for mutations and cache revalidation. It is still an externally invocable boundary: it must authenticate, authorize, validate inputs, and control abuse. REST endpoints are better when external/mobile clients need a stable public contract. The project uses a route handler for Inngest, not for normal CRUD.

**4. Why Prisma and PostgreSQL?**

> PostgreSQL gives relational constraints, transactions, indexes, and Decimal columns useful for finance data. Prisma models the relationships and produces a typed query client with migrations. Supabase hosts the PostgreSQL database; Prisma connects through `PrismaPg`. The trade-off is another abstraction and a need to understand the SQL and query plans underneath it.

### B. Auth and security

**5. Authentication versus authorization?**

> Authentication proves which Clerk user is calling. Authorization checks whether that user owns the particular account or transaction. The action resolves Clerk's `userId` to a local User row and queries account/transaction with both record ID and local `userId`. A valid login by itself cannot authorize access to every record.

**6. Why store both Clerk ID and local User ID?**

> Clerk ID is an external identity key. A local UUID allows relational foreign keys and keeps the finance schema independent of an auth provider's ID format. The unique `clerkUserId` mapping prevents two local users for the same Clerk identity. The current creation helper re-reads on a unique-key race; handling email/profile changes remains future work.

**7. What does Arcjet do?**

> `proxy.js` applies shield and bot detection around requests. Account and transaction creation call a token-bucket rule keyed by Clerk user ID, with capacity/refill settings in `lib/arcjet.js`. It reduces abuse but does not replace authentication, authorization, validation, or business rules. Also, not every action has the action-level rate limit.

**8. Can one user read another user's account by guessing an ID?**

> The account page query uses `id` and `userId`, so it returns no account when ownership does not match. `getTransaction` does likewise. The unsafe generic `getUserTransactions(query)` action was removed. The current paginated action accepts only specific sort/filter fields and always applies the trusted user ID.

**9. How would you secure receipt scanning?**

> The Server Action now checks Clerk auth and per-user rate limiting, enforces MIME type, file signature, and a 4 MB byte limit, then validates parsed model output. It does not retain the image. I would still add full image decoding/dimension limits, monitoring of model cost, and a clear privacy notice that a third-party model processes receipts. A browser `accept` attribute and client check alone are not security controls.

### C. Data consistency and money

**10. Why use a database transaction when creating a transaction?**

> The transaction row and cached balance must change together. A partial write would make the dashboard disagree with the history. `db.$transaction` makes the two writes atomic: both commit or both roll back. The current code also uses atomic balance increments and serializable isolation with retries to address concurrent writes.

**11. What is the concurrency bug and fix?**

> The original version could read ₹1,000 twice and write ₹900 and ₹800 for simultaneous ₹100 and ₹200 expenses, leaving the wrong balance. I fixed that by using Decimal `increment` inside a serializable transaction and retrying write conflicts. Editing and deleting also calculate signed adjustments within serializable transactions. I would verify this with two simultaneous requests against a test PostgreSQL database.

**12. Why is `Decimal` better than JavaScript `number` for money?**

> Binary floating point cannot exactly represent many decimal fractions, so repeated arithmetic may drift. The updated mutation paths validate two-decimal strings and use Prisma Decimal for balance math. Display/chart data still becomes JavaScript numbers; that is acceptable for visualization but should not become the source of truth. An alternative is integer paise end to end. Supporting more currencies would require explicit currency and rounding rules.

**13. How do you update an edited or moved transaction?**

> Treat the old transaction as a signed effect on the old account and the new transaction as a signed effect on the new account. Reverse the old effect; apply the new one. In the same account, add only the difference. If moving accounts, adjust both account balances. This is the logic in `updateTransaction()`.

**14. Would you store account balance or derive it?**

> Deriving from an immutable ledger is easier to audit but costs aggregation as data grows. A cached balance is fast for dashboards, but every write path must preserve the invariant and periodic reconciliation should detect drift. FinSight stores a mutable balance. A production design could use ledger entries as the source of truth plus an atomically maintained balance projection.

**15. What validation is missing?**

> The client form still gives immediate validation feedback, and exported mutation actions now parse strict server-side schemas. They whitelist fields, require positive two-decimal transaction and budget amounts, validate category/type combinations and dates, and reject recurring entries without an interval. A malicious client can bypass the browser form, so the server check is the important boundary.

### D. Scheduling and AI

**16. Why Inngest?**

> Recurring transactions, monthly reports, and budget checks should run without an open browser session. Inngest supplies scheduled/event triggers, step execution, throttling, and retries around background work. The actual side effects still need safe retry behavior and monitoring; a job framework does not make business logic idempotent by itself.

**17. What does idempotency mean for a recurring transaction?**

> Processing the same occurrence twice must create only one financial entry. The updated function assigns each occurrence a stable `(sourceTransactionId, scheduledFor)` key, enforced by a database unique index. Creation, balance increment, and schedule advance happen in one serializable transaction. A second racing worker cannot commit another row with the same key; it rolls back or observes that the schedule has advanced.

**18. What happens if the scheduler is down for a week?**

> The function now advances from the scheduled date and can backfill up to 31 occurrences per event, then leaves the next due date for a later run. Monthly recurrence clamps to the month's last day and returns to the original anchor day in a later month. Scheduling uses UTC; a future product decision is per-user time zones and an explicit policy for very long outages.

**19. How are monthly report insights generated?**

> The system aggregates numeric totals and categories from PostgreSQL, then asks Gemini to write three short insights. The model is not the source of truth for the numbers. The output must be exactly three bounded strings; parsing/validation failure falls back to generic tips. I would avoid claiming financial advice accuracy.

**20. Why should AI receipt data be reviewed by the user?**

> Receipt layouts vary and image/model extraction can confuse totals, tax, date formats, or merchant names. FinSight validates the model response and uses it to prefill the form; the user still submits it. I would add a confidence or warning UI and never silently post a financial transaction based solely on model output.

**21. How does the budget alert avoid repeat emails?**

> It checks the default account's current-month spending against the budget. At 80%, a database claim allows one worker to attempt the alert; `lastAlertSent` advances only if Resend returns a successful send ID. A stale claim expires after 15 minutes. This reduces duplicates but does not create an exactly-once guarantee across an external email provider: a crash after the provider accepts an email but before the database update could resend it.

### E. Performance, testing, deployment

**22. What breaks when a user has 100,000 transactions?**

> The updated dashboard fetches recent rows and grouped category totals; the account table fetches 10 rows per page and its chart asks PostgreSQL for daily totals. Composite indexes support user/account date filters. Very deep offset pages can still be slow, so I would move to cursor pagination if needed and inspect `EXPLAIN ANALYZE` under realistic data.

**23. What would you test?**

> The repository now has unit tests for Decimal input, transaction rules, receipt-result validation, month bounds, and month-end recurrence. I would add integration tests against a disposable PostgreSQL database for create/edit/move/delete atomicity and cross-user access; concurrency tests for simultaneous writes and duplicate recurring events; provider failure tests; and an end-to-end user flow. The unit suite alone does not prove database concurrency behavior.

**24. How do cache updates work after a mutation?**

> Server Actions call `revalidatePath` so a later render can fetch updated dashboard/account data. This is a Next.js cache/UI refresh concern; it does not replace database transactions. An edit that moves a transaction revalidates both the source and destination account pages as well as the dashboard.

**25. What environment values are needed?**

> The README lists database connection URLs, Clerk keys, Gemini, Resend, and Arcjet keys. Prisma CLI configuration uses `DIRECT_URL` when available; runtime Prisma uses `DATABASE_URL`. Keep server secrets out of client components and version control. Deployment also needs Inngest configured to call `/api/inngest` and a verified email sending domain for reliable delivery.

**26. How would you monitor this in production?**

> Track action error rate/latency, database query latency, recurring events processed versus due, duplicate attempts, monthly reports sent/failed, budget alerts sent/failed, Gemini parse failures, and email provider errors. Use correlation IDs in logs, alert on stuck jobs, and reconcile balances periodically. Avoid logging full receipt contents or sensitive transaction details.

## 6. Honest answers to likely code review challenges

| Interviewer challenge | Answer to give |
| --- | --- |
| "Is this a bank-grade ledger?" | "No. It is a personal finance tracker. It uses Decimal arithmetic, serializable multi-row writes, and unique recurring occurrence keys, but it lacks double-entry accounting, an immutable audit log, bank reconciliation, and a complete external-delivery guarantee. I would add those before handling bank-grade money movement." |
| "Does scanning store the receipt?" | "No. The scan extracts suggestions into the form. The schema has a `receiptUrl` field, but this flow does not upload or save the image." |
| "Is Supabase used for authentication?" | "No. Clerk handles auth. Supabase hosts PostgreSQL, accessed through Prisma." |
| "Are budgets per category or per account?" | "There is one budget row per user. The dashboard and alerts compare it against expenses of the user's default account; per-category budgets are not implemented." |
| "Are all routes and actions secure?" | "The current account, transaction, and receipt actions check Clerk identity and apply ownership or rate limits where appropriate; the unsafe generic query and placeholder seed endpoint are removed. I would still run a complete security review and add database-backed access tests before describing the app as production hardened." |
| "How reliable is email delivery?" | "The code now checks Resend's accepted-send response and only marks a budget alert sent after success. Accepted is not the same as inbox delivery. A crash between external send and database update can still duplicate an email; provider webhooks and a persistent delivery ledger would improve observability." |
| "What was the hardest bug?" | Give an incident that actually happened to you. If you did not personally debug one, discuss the lost-balance-update or recurring retry issue as a code risk you found and fixed; do not invent an incident. |

## 7. Related concepts worth studying beyond this code

### Web and React

- **Rendering:** server rendering creates initial HTML/data server-side; client components hydrate to become interactive. Explain why charts/forms need client state and why secrets/database calls stay server-side.
- **Cache/revalidation:** distinguish cached UI data from database commit. A successful write can still be followed by stale UI if invalidation is wrong.
- **React Hook Form/Zod:** forms collect state and report validation errors; schemas encode input requirements. Client validation improves UX; repeat it at the server trust boundary.
- **Pagination:** offset pagination is simple but gets slower and unstable under inserts; cursor pagination uses a stable ordered key for large histories.

### Databases

- **ACID:** atomicity (all writes or none), consistency (invariants), isolation (concurrent requests), durability (committed data survives). Know why an atomic transaction can still have a lost-update race if reads and writes are poorly structured.
- **Indexes:** B-tree indexes speed selective filters/orders but cost storage and write work. Match index columns to query predicates and order; measure query plans.
- **Foreign keys and cascades:** prevent dangling account/user references, but cascading financial history deletion may be inappropriate for regulated/audited systems.
- **Normalization versus projections:** User/Account/Transaction are normalized relationships; `Account.balance` is a denormalized projection for speed.
- **Idempotency and outbox:** retries are normal in distributed jobs. A unique operation key prevents duplicate rows. A transactional outbox couples a database state change to eventual event delivery.

### Finance domain

- **Money representation:** use integer minor units or decimal libraries, never rely on floating point for exact currency arithmetic. Decide rounding rules and currency handling.
- **Transfers:** a transfer needs two linked entries, one debit and one credit, performed atomically. FinSight does not implement transfers.
- **Double-entry ledger:** each financial event has balanced debit/credit postings, aiding audit and reconciliation. This is an improvement concept, not the current architecture.
- **Opening balance and reconciliation:** keep opening balance separately, compare stored balance against opening balance plus transactions, and detect drift.
- **Date/time:** choose a user's timezone and clear inclusive start/exclusive end boundaries (`>= monthStart`, `< nextMonthStart`). Cron timing, receipt dates, and recurring dates all depend on this policy.

### Security and AI

- **OWASP-style basics:** never trust client input; check auth plus record ownership; rate limit expensive operations; avoid exposing PII in logs; protect secrets; validate uploads; and consider CSRF/session protections supplied by the framework while still validating business requests.
- **Prompt injection and structured output:** a receipt may contain arbitrary text. Treat model output as untrusted data, use structured JSON/schema validation, enforce allowed categories, and let the user confirm.
- **Privacy:** receipt images can include names, card fragments, and addresses. Send only needed data to the model, understand provider retention terms, and define deletion/storage policy before production.

## 8. What was fixed, what remains

The fixes below are in this checkout. The migration `20261023000000_finance_integrity` must be applied to the target database before deploying the new code. A successful build does not prove the migration or external services have run in production.

| Earlier weakness | Current implementation |
| --- | --- |
| Lost balance updates and float arithmetic | Decimal signed adjustments, atomic balance increments, serializable transactions with retry. |
| Client-only money validation | Strict server-side schemas parse transaction, account, budget, and receipt-result values. |
| User filter override | Unused generic transaction query was removed; paginated account queries whitelist filters and verify account ownership. |
| Unprotected receipt scanning | Clerk auth, Arcjet limit, image size/type/signature checks, and Gemini-response validation. The image is still not stored, by design. |
| Duplicate recurring occurrences | Unique `(sourceTransactionId, scheduledFor)` index; schedule and balance updates share a transaction. Bounded catch-up advances from due dates. |
| Incomplete month-end windows | UTC start-inclusive/end-exclusive month windows for budget and monthly reports. |
| Racing default account writes | Per-user row lock, one database transaction, and a partial unique index allowing at most one default account per user. |
| Alert sent flag despite email failure | Resend errors throw; a database lease coordinates attempts and `lastAlertSent` updates after an accepted send. |
| Exposed placeholder seed route | Removed. |
| Full-history browser pagination | Bounded server pages and PostgreSQL chart/category aggregation. |
| No focused tests | Added finance-rule unit tests. Lint, Prisma validation, and a webpack production build pass locally. |

**Remaining limits to defend honestly:** This is not a double-entry or immutable ledger; there is no automatic balance reconciliation or bank integration. The database uniqueness index prevents duplicate recurring rows only after the migration is applied. The budget alert lease cannot guarantee exactly-once email across a crash after provider acceptance. Monthly report sends likewise need a persistent delivery ledger for stronger retry safety. Full image decoding and dimension limits are not implemented. The UI converts Decimal totals to numbers for charts, although mutation arithmetic stays Decimal. User-local timezone scheduling, deep cursor pagination, integration/concurrency tests, and production delivery monitoring remain useful next steps.

## 9. Practice: answer aloud, then compare with the guide

1. Walk me through one transaction from the browser to PostgreSQL and back to the UI.
2. Two expenses are submitted at the same instant. Show the incorrect balance that could result and your fix.
3. How does a user prove they own an account? Show exactly where authorization happens.
4. What is the difference between a Prisma database transaction and a financial transaction?
5. Why should a failed or retried Inngest event not charge an account twice?
6. What if Gemini returns `{ "amount": "abc", "date": "yesterday" }`?
7. How do you define "this month" for a user in India while a cron runs in UTC?
8. Which queries become expensive at 100,000 transactions, and what index/aggregation would you add?
9. What does your resume's phrase "protected server-side actions" mean precisely, and where does it have exceptions?
10. Which part of this project would you redesign first before accepting real users, and why?

For every response, use this pattern: **what the current code does → why that design was chosen → a concrete example → its limitation → a specific improvement**. That is stronger than memorizing definitions or pretending the current code is flawless.

## 10. Code reading map

- Data model: `prisma/schema.prisma`
- Auth and request protection: `proxy.js`, `lib/checkUser.js`, `lib/arcjet.js`
- Prisma connection: `lib/prisma.js`, `prisma.config.ts`
- Account/budget/transaction actions: `actions/account.js`, `actions/dashboard.js`, `actions/budget.js`, `actions/transaction.js`
- Receipt UI and form validation: `app/(main)/transaction/_components/recipt-scanner.jsx`, `app/(main)/transaction/_components/transaction-form.jsx`, `app/lib/schema.js`
- Dashboard and account UI: `app/(main)/dashboard/page.jsx`, `app/(main)/dashboard/_components/transaction-overview.jsx`, `app/(main)/account/[id]/page.jsx`
- Background jobs and emails: `lib/inngest/function.js`, `app/api/inngest/route.js`, `actions/send-email.js`, `emails/template.jsx`
