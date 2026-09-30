export interface DevEmail {
  id: string;
  to: string;
  subject: string;
  type: "verification_code" | "password_reset";
  codeOrToken: string;
  link?: string;
  sentAt: Date;
}

// Development outbox store for automated test assertion and developer inspection
const devOutbox: DevEmail[] = [];

export async function sendVerificationEmail(email: string, code: string): Promise<void> {
  const emailRecord: DevEmail = {
    id: Math.random().toString(36).substring(2, 9),
    to: email,
    subject: "Your Email Verification Code",
    type: "verification_code",
    codeOrToken: code,
    sentAt: new Date(),
  };

  devOutbox.unshift(emailRecord);
  if (devOutbox.length > 50) devOutbox.pop();

  console.log("\n==================== [DEV EMAIL OUTBOX] ====================");
  console.log(`TO:      ${email}`);
  console.log(`SUBJECT: ${emailRecord.subject}`);
  console.log(`CODE:    [ ${code} ] (Expires in 15 minutes)`);
  console.log("============================================================\n");
}

export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const resetLink = `${appUrl}/reset-password?token=${token}`;

  const emailRecord: DevEmail = {
    id: Math.random().toString(36).substring(2, 9),
    to: email,
    subject: "Reset Your Password",
    type: "password_reset",
    codeOrToken: token,
    link: resetLink,
    sentAt: new Date(),
  };

  devOutbox.unshift(emailRecord);
  if (devOutbox.length > 50) devOutbox.pop();

  console.log("\n==================== [DEV EMAIL OUTBOX] ====================");
  console.log(`TO:      ${email}`);
  console.log(`SUBJECT: ${emailRecord.subject}`);
  console.log(`LINK:    ${resetLink} (Expires in 15 minutes)`);
  console.log("============================================================\n");
}

export function getDevOutbox(): DevEmail[] {
  return [...devOutbox];
}
