"use server";

import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { GoogleGenerativeAI } from "@google/generative-ai";
import aj from "@/lib/arcjet";
import { request } from "@arcjet/next";
import { transactionInput, receiptResult, signedAmount, nextRecurringDate, runSerializable } from "@/lib/finance";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const serializeAmount = (obj) => ({
  ...obj,
  amount: obj.amount.toNumber(),
});

// Create Transaction
export async function createTransaction(data) {
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

    const input = transactionInput.parse(data);
    const account = await db.account.findFirst({
      where: {
        id: input.accountId,
        userId: user.id,
      },
    });

    if (!account) {
      throw new Error("Account not found");
    }

    const balanceChange = signedAmount(input.type, input.amount);

    // Create transaction and update account balance
    const transaction = await runSerializable(db, async (tx) => {
      const newTransaction = await tx.transaction.create({
        data: {
          ...input,
          userId: user.id,
          recurringInterval: input.isRecurring ? input.recurringInterval : null,
          nextRecurringDate:
            input.isRecurring && input.recurringInterval
              ? nextRecurringDate(input.date, input.recurringInterval)
              : null,
        },
      });

      await tx.account.update({
        where: { id: input.accountId },
        data: { balance: { increment: balanceChange } },
      });

      return newTransaction;
    });

    revalidatePath("/dashboard");
    revalidatePath(`/account/${transaction.accountId}`);

    return { success: true, data: serializeAmount(transaction) };
  } catch (error) {
    throw new Error(error.message);
  }
}
export async function getTransaction(id) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  const transaction = await db.transaction.findFirst({
    where: {
      id,
      userId: user.id,
    },
  });

  if (!transaction) throw new Error("Transaction not found");

  return serializeAmount(transaction);
}

export async function updateTransaction(id, data) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!user) throw new Error("User not found");

    const input = transactionInput.parse(data);
    const { transaction, oldAccountId } = await runSerializable(db, async (tx) => {
      const originalTransaction = await tx.transaction.findFirst({ where: { id, userId: user.id } });
      if (!originalTransaction) throw new Error("Transaction not found");
      const targetAccount = await tx.account.findFirst({ where: { id: input.accountId, userId: user.id } });
      if (!targetAccount) throw new Error("Account not found");
      const oldBalanceChange = signedAmount(originalTransaction.type, originalTransaction.amount);
      const newBalanceChange = signedAmount(input.type, input.amount);
      const netBalanceChange = newBalanceChange.minus(oldBalanceChange);
      const updated = await tx.transaction.update({
        where: { id },
        data: {
          ...input,
          recurringInterval: input.isRecurring ? input.recurringInterval : null,
          nextRecurringDate:
            input.isRecurring && input.recurringInterval
              ? nextRecurringDate(input.date, input.recurringInterval)
              : null,
        },
      });

      if (originalTransaction.accountId === input.accountId) {
        await tx.account.update({
          where: { id: input.accountId },
          data: {
            balance: {
              increment: netBalanceChange,
            },
          },
        });
      } else {
        await tx.account.update({
          where: { id: originalTransaction.accountId },
          data: {
            balance: {
              increment: oldBalanceChange.negated(),
            },
          },
        });

        await tx.account.update({
          where: { id: input.accountId },
          data: {
            balance: {
              increment: newBalanceChange,
            },
          },
        });
      }

      return { transaction: updated, oldAccountId: originalTransaction.accountId };
    });

    revalidatePath("/dashboard");
    revalidatePath(`/account/${input.accountId}`);
    if (oldAccountId !== input.accountId) revalidatePath(`/account/${oldAccountId}`);

    return { success: true, data: serializeAmount(transaction) };
  } catch (error) {
    throw new Error(error.message);
  }
}

// Scan Receipt
export async function scanReceipt(file) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");
    const req = await request();
    const decision = await aj.protect(req, { userId, requested: 1 });
    if (decision.isDenied()) throw new Error("Too many requests. Please try again later.");
    if (!file || typeof file.arrayBuffer !== "function" || file.size > 4 * 1024 * 1024 || file.size === 0) {
      throw new Error("Invalid receipt image");
    }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      throw new Error("Unsupported receipt image type");
    }
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isPng = bytes.length >= 8 && bytes.slice(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index]);
    const isWebp = String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
    if (!({ "image/jpeg": isJpeg, "image/png": isPng, "image/webp": isWebp }[file.type])) {
      throw new Error("Invalid receipt image data");
    }
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    // Convert ArrayBuffer to Base64
    const base64String = Buffer.from(arrayBuffer).toString("base64");

    const prompt = `
      Analyze this receipt image and extract the following information in JSON format:
      - Total amount (just the number)
      - Date (in ISO format)
      - Description or items purchased (brief summary)
      - Merchant/store name
      - Suggested category (one of: housing,transportation,groceries,utilities,entertainment,food,shopping,healthcare,education,personal,travel,insurance,gifts,bills,other-expense )
      
      Only respond with valid JSON in this exact format:
      {
        "amount": number,
        "date": "ISO date string",
        "description": "string",
        "merchantName": "string",
        "category": "string"
      }

      If its not a recipt, return an empty object
    `;

    const result = await model.generateContent([
      {
        inlineData: {
          data: base64String,
          mimeType: file.type,
        },
      },
      prompt,
    ]);

    const response = await result.response;
    const text = response.text();
    const cleanedText = text.replace(/```(?:json)?\n?/g, "").trim();

    try {
      const data = receiptResult.parse(JSON.parse(cleanedText));
      return {
        amount: data.amount.toFixed(2),
        date: new Date(data.date),
        description: data.description,
        category: data.category,
        merchantName: data.merchantName,
      };
    } catch (parseError) {
      console.error("Error parsing JSON response:", parseError);
      throw new Error("Invalid response format from Gemini");
    }
  } catch (error) {
    console.error("Error scanning receipt:", error);
    throw new Error(error.message || "Failed to scan receipt");
  }
}
