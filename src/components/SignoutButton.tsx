"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function SignoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const handleSignOut = async () => {
    setLoading(true);
    try {
      await fetch("/api/auth/signout", {
        method: "POST",
      });
      router.push("/signin");
      router.refresh();
    } catch (error) {
      console.error("Sign out failed:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      id="dashboard-signout-btn"
      type="button"
      className="btn btn-secondary"
      onClick={handleSignOut}
      disabled={loading}
      style={{ minWidth: "160px" }}
    >
      {loading ? "Signing out..." : "Sign Out"}
    </button>
  );
}
