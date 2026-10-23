# FinSight

FinSight is an AI-assisted personal finance manager built with Next.js, Clerk, Prisma, Supabase Postgres, Inngest, Arcjet, Gemini, and Resend.

It helps users create accounts, track income and expenses, manage monthly budgets, scan receipts, review account-level analytics, and automate recurring financial workflows.

## Live Demo

Production: [https://fin-sight-beige.vercel.app/](https://fin-sight-beige.vercel.app/)

## What The App Does

- Sign up and sign in with Clerk authentication
- Create and manage multiple financial accounts
- Add income and expense transactions
- Edit existing transactions
- Mark transactions as recurring and process them automatically
- Track monthly budgets and receive budget alerts
- Scan receipts with Gemini-powered extraction
- View dashboard summaries, recent activity, and category breakdown charts
- View account-specific transaction history and analytics
- Receive monthly financial report emails with AI-generated insights

## Core Features

### 1. Account Management

- Create current and savings accounts
- Set a default account
- Track balances automatically as transactions change

### 2. Transaction Tracking

- Add income and expense entries
- Categorize transactions
- Edit transactions from the create/edit flow
- Support recurring schedules: daily, weekly, monthly, yearly

### 3. Budgeting

- Set a monthly budget
- Compare current monthly expenses against the active budget
- Trigger alerts when spending crosses the configured threshold

### 4. AI Features

- Receipt scanning with Gemini
- Monthly report generation with AI-written insights

### 5. Background Automation

Inngest powers scheduled and event-driven jobs for:

- recurring transaction processing
- monthly report generation
- budget alert checks

## Tech Stack

- Next.js 16
- React 19
- Tailwind CSS
- Clerk
- Prisma ORM
- Supabase Postgres
- Inngest
- Arcjet
- Google Gemini
- Resend
- Recharts
- React Hook Form + Zod

## Project Structure

```text
app/                    Next.js App Router pages and API routes
actions/                Server actions for accounts, budgets, transactions, and email
components/             Shared UI components and landing/header sections
data/                   Landing page content and categories
emails/                 React Email templates
lib/                    Prisma, auth helpers, Inngest client/functions, Arcjet setup
prisma/                 Prisma schema and migrations
public/                 Static assets such as logos and banner image
```

## Environment Variables

Create a `.env` file in the project root with:

```env
DATABASE_URL=
DIRECT_URL=

NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/onboarding
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/onboarding

GEMINI_API_KEY=
RESEND_API_KEY=
ARCJET_KEY=
```

### Notes

- `DATABASE_URL` is used by the runtime Prisma adapter.
- `DIRECT_URL` is used by Prisma CLI operations such as migrations.
- If your database password contains special characters like `@`, URL-encode them inside the connection string.

## Local Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure the database

Run a local migration after setting `DATABASE_URL` and `DIRECT_URL`:

```bash
npx prisma migrate dev
```

If you only need the Prisma client generated:

```bash
npx prisma generate
```

### 3. Start the app

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Inngest And Automation

The app exposes the Inngest route at:

`/api/inngest`

Configured jobs include:

- `process-recurring-transaction`
- `trigger-recurring-transactions`
- `generate-monthly-reports`
- budget alert checks every 6 hours

To use these fully in development or production, make sure your Inngest environment is configured to call the app's `/api/inngest` endpoint.

## Email Workflows

The email template system supports:

- monthly financial reports
- budget alert emails

Resend is used for delivery, and React Email is used for composing the templates.

## Security And Protection

The app uses:

- Clerk for authentication
- Arcjet middleware and action-level protection for rate limiting and bot/shield checks

Protected routes include:

- `/dashboard`
- `/account/*`
- `/transaction/*`

## Useful Commands

```bash
npm run dev
npm run build
npm run start
npm run lint
```

## Current Notes

- The landing page and some UI copy still contain older `Welth` naming in a few places. The product itself is now branded as `FinSight`.
- The old placeholder seed endpoint was removed. There is no public seed route.
- Apply the `20261023000000_finance_integrity` migration before deploying this version. It adds recurring-occurrence keys, alert claims, query indexes, and one-default-account enforcement. Use `npx prisma migrate deploy` in a deployment environment after reviewing the target database.
- Receipt images are sent to Gemini to prefill transaction fields and are not stored by this app.

## Screenshot

<img width="1470" alt="FinSight dashboard preview" src="https://github.com/user-attachments/assets/1bc50b85-b421-4122-8ba4-ae68b2b61432">
