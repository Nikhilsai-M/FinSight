import test from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { accountInput, nextRecurringDate, positiveMoney, receiptResult, runSerializable, signedAmount, transactionInput, utcMonthBounds } from "../lib/finance.js";

test("money validation keeps decimal arithmetic exact", () => {
  const first = positiveMoney.parse("0.10");
  const second = positiveMoney.parse("0.20");
  assert.equal(first.plus(second).toFixed(2), "0.30");
  assert.equal(signedAmount("EXPENSE", second).toFixed(2), "-0.20");
  for (const invalid of ["0", "-1", "1.001", "abc", Infinity]) {
    assert.equal(positiveMoney.safeParse(invalid).success, false);
  }
  assert.equal(accountInput.parse({ name: "Main", type: "CURRENT", balance: "-20.00" }).balance.toFixed(2), "-20.00");
});

test("transaction input checks ownership-independent business rules", () => {
  const valid = { type: "EXPENSE", amount: "12.50", date: new Date("2026-01-02T00:00:00Z"), accountId: "11111111-1111-4111-8111-111111111111", category: "food", isRecurring: true, recurringInterval: "MONTHLY" };
  assert.equal(transactionInput.parse(valid).amount.toFixed(2), "12.50");
  assert.equal(transactionInput.safeParse({ ...valid, category: "salary" }).success, false);
  assert.equal(transactionInput.safeParse({ ...valid, recurringInterval: null }).success, false);
});

test("receipt suggestions require a supported expense category", () => {
  assert.equal(receiptResult.safeParse({ amount: "23.40", date: "2026-01-02", description: "Lunch", category: "food" }).success, true);
  assert.equal(receiptResult.safeParse({ amount: "23.40", date: "yesterday", description: "Lunch", category: "food" }).success, false);
});

test("month bounds include the entire last day", () => {
  const { start, end } = utcMonthBounds(new Date("2026-02-28T23:59:59Z"));
  assert.equal(start.toISOString(), "2026-02-01T00:00:00.000Z");
  assert.equal(end.toISOString(), "2026-03-01T00:00:00.000Z");
});

test("monthly recurrence clamps to month end then returns to anchor day", () => {
  const anchor = new Date("2025-01-31T10:00:00Z");
  const february = nextRecurringDate(anchor, "MONTHLY", anchor);
  const march = nextRecurringDate(february, "MONTHLY", anchor);
  assert.equal(february.toISOString(), "2025-02-28T10:00:00.000Z");
  assert.equal(march.toISOString(), "2025-03-31T10:00:00.000Z");
  assert.equal(new Prisma.Decimal("0.1").plus("0.2").toFixed(2), "0.30");
});

test("serializable transaction retries only write conflicts", async () => {
  let calls = 0;
  const database = { $transaction: async (callback, options) => {
    assert.equal(options.isolationLevel, Prisma.TransactionIsolationLevel.Serializable);
    calls++;
    if (calls === 1) throw Object.assign(new Error("write conflict"), { code: "P2034" });
    return callback({ id: "tx" });
  } };
  assert.equal(await runSerializable(database, async (tx) => tx.id), "tx");
  assert.equal(calls, 2);
});
