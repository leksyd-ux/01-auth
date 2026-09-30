import { NextResponse } from "next/server";
import { getDevOutbox } from "@/lib/services/mail";

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production." }, { status: 404 });
  }

  return NextResponse.json({
    emails: getDevOutbox(),
  });
}
