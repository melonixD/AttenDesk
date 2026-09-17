export function createMailer() {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "AttenDesk <attendance@example.com>";
  const production = process.env.NODE_ENV === "production";

  return {
    async sendOtp({ email, code, purpose }) {
      if (!apiKey) {
        if (production) throw new Error("RESEND_API_KEY is required in production");
        console.log(`[DEV OTP] ${purpose} code for ${email}: ${code}`);
        return { delivered: false, developmentCode: code };
      }
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: [email],
          subject: purpose === "registration" ? "Verify your AttenDesk registration" : "Your AttenDesk login code",
          html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px"><h2>AttenDesk</h2><p>Your one-time verification code is:</p><div style="font-size:34px;font-weight:800;letter-spacing:8px;padding:18px;background:#eef8f3;border-radius:12px;text-align:center">${code}</div><p>This code expires in 10 minutes. Do not share it with anyone.</p></div>`
        })
      });
      if (!response.ok) throw new Error(`Email provider rejected the message (${response.status})`);
      return { delivered: true };
    }
  };
}
