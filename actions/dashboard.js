"use server";

import aj from "@/lib/arcjet";
import { db } from "@/lib/prisma";
import { request } from "@arcjet/next";
import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { accountInput, runSerializable, utcMonthBounds } from "@/lib/finance";

const serializeTransaction = (obj) => {
  const serialized = { ...obj };
  if (obj.balance) {
    serialized.balance = obj.balance.toNumber();
  }
  if (obj.amount) {
    serialized.amount = obj.amount.toNumber();
  }
  return serialized;
};

export async function getUserAccounts() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) {
    throw new Error("User not found");
  }

  try {
    const accounts = await db.account.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: {
            transactions: true,
          },
        },
      },
    });

    // Serialize accounts before sending to client
    const serializedAccounts = accounts.map(serializeTransaction);

    return serializedAccounts;
  } catch (error) {
    console.error(error.message);
  }
}

export async function createAccount(data) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    // Get request data for ArcJet
    const req = await request();

    // Check rate limit
    const decision = await aj.protect(req, {
      userId,
      requested: 1, // Specify how many tokens to consume
    });

    if (decision.isDenied()) {
      if (decision.reason.isRateLimit()) {
        const { remaining, reset } = decision.reason;
        console.error({
          code: "RATE_LIMIT_EXCEEDED",
          details: {
            remaining,
            resetInSeconds: reset,
          },
        });

        throw new Error("Too many requests. Please try again later.");
      }

      throw new Error("Request blocked");
    }

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!user) {
      throw new Error("User not found");
    }

    const input = accountInput.parse(data);
    const account = await runSerializable(db, async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
      const existingCount = await tx.account.count({ where: { userId: user.id } });
      const shouldBeDefault = existingCount === 0 || input.isDefault;
      if (shouldBeDefault) {
        await tx.account.updateMany({ where: { userId: user.id, isDefault: true }, data: { isDefault: false } });
      }
      return tx.account.create({
        data: { ...input, userId: user.id, isDefault: shouldBeDefault },
      });
    });

    // Serialize the account before returning
    const serializedAccount = serializeTransaction(account);

    revalidatePath("/dashboard");
    return { success: true, data: serializedAccount };
  } catch (error) {
    throw new Error(error.message);
  }
}

export async function getDashboardData() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) {
    throw new Error("User not found");
  }

  const accounts = await db.account.findMany({ where: { userId: user.id }, select: { id: true } });
  const { start, end } = utcMonthBounds(new Date());
  const [groups, recentLists] = await Promise.all([
    db.transaction.groupBy({
      by: ["accountId", "category"],
      where: { userId: user.id, type: "EXPENSE", date: { gte: start, lt: end } },
      _sum: { amount: true },
    }),
    Promise.all(accounts.map((account) => db.transaction.findMany({
      where: { userId: user.id, accountId: account.id },
      orderBy: [{ date: "desc" }, { id: "desc" }],
      take: 5,
    }))),
  ]);
  return Object.fromEntries(accounts.map((account, index) => [account.id, {
    recent: recentLists[index].map(serializeTransaction),
    categories: groups.filter((group) => group.accountId === account.id).map((group) => ({ name: group.category, value: group._sum.amount?.toNumber() ?? 0 })),
  }]));
}
