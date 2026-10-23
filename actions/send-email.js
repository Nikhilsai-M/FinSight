"use server";

import { Resend } from "resend";

export async function sendEmail({ to, subject, react }) {
  const resend = new Resend(process.env.RESEND_API_KEY || "");

  try {
    const result = await resend.emails.send({
      from: "Finance App <onboarding@resend.dev>",
      to,
      subject,
      react,
    });

    if (result.error || !result.data?.id) {
      throw new Error(result.error?.message || "Email provider did not confirm the send");
    }
    return { success: true, id: result.data.id };
  } catch (error) {
    console.error("Failed to send email:", error);
    throw error;
  }
}
