import { inngest } from "./client";
import { db } from "@/lib/prisma";
import EmailTemplate from "@/emails/template";
import { sendEmail } from "@/actions/send-email";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { nextRecurringDate, runSerializable, signedAmount, utcMonthBounds } from "@/lib/finance";

// 1. Recurring Transaction Processing with Throttling
export const processRecurringTransaction = inngest.createFunction(
  {
    id: "process-recurring-transaction",
    name: "Process Recurring Transaction",
    triggers: { event: "transaction.recurring.process" },
    throttle: {
      limit: 10, // Process 10 transactions
      period: "1m", // per minute
      key: "event.data.userId", // Throttle per user
    },
  },
  async ({ event, step }) => {
    // Validate event data
    if (!event?.data?.transactionId || !event?.data?.userId) {
      console.error("Invalid event data:", event);
      return { error: "Missing required event data" };
    }

    await step.run("process-transaction", async () => {
      try {
        return await runSerializable(db, async (tx) => {
          const transaction = await tx.transaction.findFirst({
            where: { id: event.data.transactionId, userId: event.data.userId, isRecurring: true, status: "COMPLETED" },
          });
          if (!transaction?.nextRecurringDate || !transaction.recurringInterval) return { processed: 0 };

          const now = new Date();
          let due = transaction.nextRecurringDate;
          let processed = 0;
          while (due <= now && processed < 31) {
            await tx.transaction.create({
              data: {
                type: transaction.type,
                amount: transaction.amount,
                description: `${transaction.description || "Transaction"} (Recurring)`,
                date: due,
                scheduledFor: due,
                sourceTransactionId: transaction.id,
                category: transaction.category,
                userId: transaction.userId,
                accountId: transaction.accountId,
                isRecurring: false,
              },
            });
            await tx.account.update({
              where: { id: transaction.accountId },
              data: { balance: { increment: signedAmount(transaction.type, transaction.amount) } },
            });
            processed++;
            due = nextRecurringDate(due, transaction.recurringInterval, transaction.date);
          }
          if (processed) {
            await tx.transaction.update({
              where: { id: transaction.id },
              data: { lastProcessed: now, nextRecurringDate: due },
            });
          }
          return { processed };
        });
      } catch (error) {
        if (error.code === "P2002") return { processed: 0, duplicate: true };
        throw error;
      }
    });
  }
);

// Trigger recurring transactions with batching
export const triggerRecurringTransactions = inngest.createFunction(
  {
    id: "trigger-recurring-transactions", // Unique ID,
    name: "Trigger Recurring Transactions",
    triggers: { cron: "0 0 * * *" }, // Daily at midnight
  },
  async ({ step }) => {
    const recurringTransactions = await step.run(
      "fetch-recurring-transactions",
      async () => {
        return await db.transaction.findMany({
          where: {
            isRecurring: true,
            status: "COMPLETED",
            nextRecurringDate: { lte: new Date() },
          },
        });
      }
    );

    // Send event for each recurring transaction in batches
    if (recurringTransactions.length > 0) {
      const events = recurringTransactions.map((transaction) => ({
        name: "transaction.recurring.process",
        data: {
          transactionId: transaction.id,
          userId: transaction.userId,
        },
      }));

      // Send events directly using inngest.send()
      await inngest.send(events);
    }

    return { triggered: recurringTransactions.length };
  }
);

// 2. Monthly Report Generation
async function generateFinancialInsights(stats, month) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `
    Analyze this financial data and provide 3 concise, actionable insights.
    Focus on spending patterns and practical advice.
    Keep it friendly and conversational.

    Financial Data for ${month}:
    - Total Income: ₹${stats.totalIncome}
    - Total Expenses: ₹${stats.totalExpenses}
    - Net Income: ₹${stats.totalIncome - stats.totalExpenses}
    - Expense Categories: ${Object.entries(stats.byCategory)
      .map(([category, amount]) => `${category}: ₹${amount}`)
      .join(", ")}

    Format the response as a JSON array of strings, like this:
    ["insight 1", "insight 2", "insight 3"]
  `;

  try {
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();
    const cleanedText = text.replace(/```(?:json)?\n?/g, "").trim();

    return z.array(z.string().trim().min(1).max(300)).length(3).parse(JSON.parse(cleanedText));
  } catch (error) {
    console.error("Error generating insights:", error);
    return [
      "Your highest expense category this month might need attention.",
      "Consider setting up a budget for better financial management.",
      "Track your recurring expenses to identify potential savings.",
    ];
  }
}

export const generateMonthlyReports = inngest.createFunction(
  {
    id: "generate-monthly-reports",
    name: "Generate Monthly Reports",
    triggers: { cron: "0 0 1 * *" }, // First day of each month
  },
  async ({ step }) => {
    const users = await step.run("fetch-users", async () => {
      return await db.user.findMany({
        include: { accounts: true },
      });
    });

    for (const user of users) {
      await step.run(`generate-report-${user.id}`, async () => {
        const now = new Date();
        const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

        const stats = await getMonthlyStats(user.id, lastMonth);
        const monthName = lastMonth.toLocaleString("en-IN", {
          month: "long",
          timeZone: "UTC",
        });

        // Generate AI insights
        const insights = await generateFinancialInsights(stats, monthName);

        await sendEmail({
          to: user.email,
          subject: `Your Monthly Financial Report - ${monthName}`,
          react: EmailTemplate({
            userName: user.name,
            type: "monthly-report",
            data: {
              stats,
              month: monthName,
              insights,
            },
          }),
        });
      });
    }

    return { processed: users.length };
  }
);

// 3. Budget Alerts with Event Batching
export const checkBudgetAlerts = inngest.createFunction(
  {
    name: "Check Budget Alerts",
    triggers: { cron: "0 */6 * * *" }, // Every 6 hours
  },
  async ({ step }) => {
    const budgets = await step.run("fetch-budgets", async () => {
      return await db.budget.findMany({
        include: {
          user: {
            include: {
              accounts: {
                where: {
                  isDefault: true,
                },
              },
            },
          },
        },
      });
    });

    for (const budget of budgets) {
      const defaultAccount = budget.user.accounts[0];
      if (!defaultAccount) continue; // Skip if no default account

      await step.run(`check-budget-${budget.id}`, async () => {
        const now = new Date();
        const { start, end } = utcMonthBounds(now);

        // Calculate total expenses for the default account only
        const expenses = await db.transaction.aggregate({
          where: {
            userId: budget.userId,
            accountId: defaultAccount.id, // Only consider default account
            type: "EXPENSE",
            date: {
              gte: start,
              lt: end,
            },
          },
          _sum: {
            amount: true,
          },
        });

        const totalExpenses = expenses._sum.amount ?? new Prisma.Decimal(0);
        const budgetAmount = budget.amount;
        if (budgetAmount.lte(0)) return;
        const percentageUsed = totalExpenses.div(budgetAmount).mul(100).toNumber();

        // Check if we should send an alert
        if (
          totalExpenses.gte(budgetAmount.mul("0.8"))
        ) {
          const claimed = await db.budget.updateMany({
            where: {
              id: budget.id,
              OR: [{ lastAlertSent: null }, { lastAlertSent: { lt: start } }],
              AND: [{ OR: [{ alertClaimedAt: null }, { alertClaimedAt: { lt: new Date(now.getTime() - 15 * 60 * 1000) } }] }],
            },
            data: { alertClaimedAt: now },
          });
          if (claimed.count !== 1) return;
          try {
            await sendEmail({
            to: budget.user.email,
            subject: `Budget Alert for ${defaultAccount.name}`,
            react: EmailTemplate({
              userName: budget.user.name,
              type: "budget-alert",
              data: {
                percentageUsed,
                budgetAmount: budgetAmount.toFixed(2),
                totalExpenses: totalExpenses.toFixed(2),
                remaining: budgetAmount.minus(totalExpenses).toFixed(2),
                accountName: defaultAccount.name,
              },
            }),
            });
            await db.budget.update({
              where: { id: budget.id },
              data: { lastAlertSent: new Date(), alertClaimedAt: null },
            });
          } catch (error) {
            await db.budget.updateMany({ where: { id: budget.id, alertClaimedAt: now }, data: { alertClaimedAt: null } });
            throw error;
          }
        }
      });
    }
  }
);

async function getMonthlyStats(userId, month) {
  const { start, end } = utcMonthBounds(month);
  const groups = await db.transaction.groupBy({
    by: ["type", "category"],
    where: { userId, date: { gte: start, lt: end } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  const income = groups.filter((group) => group.type === "INCOME").reduce((sum, group) => sum.plus(group._sum.amount ?? 0), new Prisma.Decimal(0));
  const expenses = groups.filter((group) => group.type === "EXPENSE").reduce((sum, group) => sum.plus(group._sum.amount ?? 0), new Prisma.Decimal(0));
  return {
    totalIncome: income.toNumber(),
    totalExpenses: expenses.toNumber(),
    byCategory: Object.fromEntries(groups.filter((group) => group.type === "EXPENSE").map((group) => [group.category, group._sum.amount?.toNumber() ?? 0])),
    transactionCount: groups.reduce((sum, group) => sum + group._count._all, 0),
  };
}
