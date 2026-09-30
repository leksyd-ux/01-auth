import { NextResponse } from "next/server";
import { destroySession } from "@/lib/security/session";

export async function POST() {
  try {
    await destroySession();
    return NextResponse.json({
      success: true,
      message: "Signed out successfully.",
    });
  } catch (error) {
    console.error("Signout error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred during signout." },
      { status: 500 }
    );
  }
}
