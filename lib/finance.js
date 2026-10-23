import { Prisma } from "@prisma/client";
import { z } from "zod";
import { defaultCategories } from "../data/categories.js";

const moneyText = (allowNegative = false) =>
  z
    .union([z.string(), z.number().finite()])
    .transform((value) => String(value).trim())
    .refine(
      (value) =>
        (allowNegative ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/).test(value),
      "Enter an amount with at most two decimal places"
    )
    .transform((value) => new Prisma.Decimal(value));

export const positiveMoney = moneyText().refine(
  (amount) => amount.gt(0),
  "Amount must be greater than zero"
);
export const openingBalance = moneyText(true);

export const accountInput = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(["CURRENT", "SAVINGS"]),
  balance: openingBalance,
  isDefault: z.boolean().default(false),
});

export const transactionInput = z
  .object({
    type: z.enum(["INCOME", "EXPENSE"]),
    amount: positiveMoney,
    description: z.string().trim().max(500).optional().nullable(),
    date: z.date(),
    accountId: z.string().uuid(),
    category: z.string(),
    isRecurring: z.boolean().default(false),
    recurringInterval: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]).optional().nullable(),
  })
  .superRefine((value, ctx) => {
    if (!defaultCategories.some((category) => category.id === value.category && category.type === value.type)) {
      ctx.addIssue({ code: "custom", path: ["category"], message: "Invalid category for transaction type" });
    }
    if (value.isRecurring && !value.recurringInterval) {
      ctx.addIssue({ code: "custom", path: ["recurringInterval"], message: "Recurring interval is required" });
    }
    if (value.date.getTime() > Date.now()) {
      ctx.addIssue({ code: "custom", path: ["date"], message: "Date cannot be in the future" });
    }
  });

export const receiptResult = z.object({
  amount: positiveMoney,
  date: z.union([z.iso.date(), z.iso.datetime({ offset: true })]),
  description: z.string().trim().min(1).max(500),
  merchantName: z.string().trim().max(200).optional(),
  category: z.string(),
}).superRefine((value, ctx) => {
  if (!defaultCategories.some((category) => category.id === value.category && category.type === "EXPENSE")) {
    ctx.addIssue({ code: "custom", path: ["category"], message: "Invalid receipt category" });
  }
});

export function signedAmount(type, amount) {
  return type === "EXPENSE" ? amount.negated() : amount;
}

export async function runSerializable(db, callback) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.$transaction(callback, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10000,
        timeout: 30000,
      });
    } catch (error) {
      if (error.code !== "P2034" || attempt === 2) throw error;
    }
  }
}

export function utcMonthBounds(date) {
  return {
    start: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)),
    end: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)),
  };
}

export function nextRecurringDate(current, interval, anchor = current) {
  const next = new Date(current);
  if (interval === "DAILY") next.setUTCDate(next.getUTCDate() + 1);
  else if (interval === "WEEKLY") next.setUTCDate(next.getUTCDate() + 7);
  else if (interval === "MONTHLY") {
    const year = current.getUTCFullYear();
    const month = current.getUTCMonth() + 1;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    next.setUTCFullYear(year, month, Math.min(anchor.getUTCDate(), lastDay));
  } else if (interval === "YEARLY") {
    const year = current.getUTCFullYear() + 1;
    const month = anchor.getUTCMonth();
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    next.setUTCFullYear(year, month, Math.min(anchor.getUTCDate(), lastDay));
  } else throw new Error("Invalid recurring interval");
  return next;
}
