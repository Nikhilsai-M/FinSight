"use server";

import { db } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { runSerializable, signedAmount } from "@/lib/finance";

const serializeDecimal = (obj) => {
  const serialized = { ...obj };
  if (obj.balance && typeof obj.balance.toNumber === "function") {
    serialized.balance = obj.balance.toNumber();
  }
  if (obj.amount && typeof obj.amount.toNumber === "function") {
    serialized.amount = obj.amount.toNumber();
  }
  return serialized;
};

export async function getAccountWithTransactions(accountId) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  const account = await db.account.findFirst({
    where: {
      id: accountId,
      userId: user.id,
    },
    include: {
      transactions: {
        orderBy: [{ date: "desc" }, { id: "desc" }],
        take: 10,
      },
      _count: {
        select: { transactions: true },
      },
    },
  });

  if (!account) return null;

  return {
    ...serializeDecimal(account),
    transactions: account.transactions.map(serializeDecimal),
  };
}

export async function getAccountTransactions(accountId, options = {}) {
  options = options && typeof options === "object" ? options : {};
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  const user = await db.user.findUnique({ where: { clerkUserId: userId } });
  if (!user) throw new Error("User not found");
  const account = await db.account.findFirst({ where: { id: accountId, userId: user.id }, select: { id: true } });
  if (!account) throw new Error("Account not found");

  const page = Number.isInteger(options.page) ? Math.min(Math.max(options.page, 1), 10000) : 1;
  const field = ["date", "amount", "category"].includes(options.field) ? options.field : "date";
  const direction = options.direction === "asc" ? "asc" : "desc";
  const search = typeof options.search === "string" ? options.search.trim().slice(0, 100) : "";
  const where = {
    accountId,
    userId: user.id,
    ...(search ? { description: { contains: search, mode: "insensitive" } } : {}),
    ...(["INCOME", "EXPENSE"].includes(options.type) ? { type: options.type } : {}),
    ...(options.recurring === "recurring" ? { isRecurring: true } : options.recurring === "non-recurring" ? { isRecurring: false } : {}),
  };
  const [transactions, total] = await Promise.all([
    db.transaction.findMany({ where, orderBy: [{ [field]: direction }, { id: direction }], skip: (page - 1) * 10, take: 10 }),
    db.transaction.count({ where }),
  ]);
  return { transactions: transactions.map(serializeDecimal), total };
}

export async function getAccountChartData(accountId, range = "1M") {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");
  const user = await db.user.findUnique({ where: { clerkUserId: userId } });
  if (!user) throw new Error("User not found");
  const account = await db.account.findFirst({ where: { id: accountId, userId: user.id }, select: { id: true } });
  if (!account) throw new Error("Account not found");

  const ranges = { "7D": 7, "1M": 30, "3M": 90, "6M": 180, ALL: null };
  const days = Object.hasOwn(ranges, range) ? ranges[range] : 30;
  const end = new Date();
  const start = days === null ? new Date(0) : new Date(end.getTime() - days * 86400000);
  const rows = await db.$queryRaw`
    SELECT DATE("date")::text AS day,
      SUM(CASE WHEN "type" = 'INCOME' THEN "amount" ELSE 0 END)::text AS income,
      SUM(CASE WHEN "type" = 'EXPENSE' THEN "amount" ELSE 0 END)::text AS expense
    FROM "transactions"
    WHERE "accountId" = ${accountId} AND "userId" = ${user.id}
      AND "date" >= ${start} AND "date" <= ${end}
    GROUP BY day ORDER BY day
  `;
  return rows.map((row) => ({ day: row.day, date: new Date(`${row.day}T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", day: "2-digit", timeZone: "UTC" }), income: Number(row.income), expense: Number(row.expense) }));
}

export async function bulkDeleteTransactions(transactionIds) {
  try {
    if (!Array.isArray(transactionIds) || transactionIds.length === 0 || transactionIds.length > 100 || !transactionIds.every((id) => typeof id === "string")) {
      throw new Error("Select between 1 and 100 transactions");
    }
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!user) throw new Error("User not found");

    const changedAccounts = await runSerializable(db, async (tx) => {
      const transactions = await tx.transaction.findMany({
        where: {
          id: { in: transactionIds },
          userId: user.id,
        },
      });
      if (transactions.length !== new Set(transactionIds).size) throw new Error("Transaction not found");
      const changes = new Map();
      for (const transaction of transactions) {
        const reverse = signedAmount(transaction.type, transaction.amount).negated();
        changes.set(transaction.accountId, (changes.get(transaction.accountId) ?? new Prisma.Decimal(0)).plus(reverse));
      }
      const deleted = await tx.transaction.deleteMany({ where: { id: { in: transactionIds }, userId: user.id } });
      if (deleted.count !== transactions.length) throw new Error("Transaction changed; please retry");
      for (const [accountId, balanceChange] of changes) {
        await tx.account.update({
          where: { id: accountId },
          data: { balance: { increment: balanceChange } },
        });
      }
      return [...changes.keys()];
    });

    revalidatePath("/dashboard");
    for (const accountId of changedAccounts) revalidatePath(`/account/${accountId}`);

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function updateDefaultAccount(accountId) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!user) {
      throw new Error("User not found");
    }

    const account = await runSerializable(db, async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
      const owned = await tx.account.findFirst({ where: { id: accountId, userId: user.id } });
      if (!owned) throw new Error("Account not found");
      await tx.account.updateMany({ where: { userId: user.id, isDefault: true }, data: { isDefault: false } });
      return tx.account.update({ where: { id: accountId }, data: { isDefault: true } });
    });

    revalidatePath("/dashboard");
    return {
      success: true,
      data: serializeDecimal({ ...account, isDefault: true }),
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
