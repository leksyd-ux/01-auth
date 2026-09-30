import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/security/session";
import SignoutButton from "@/components/SignoutButton";

export default async function DashboardPage() {
  const session = await getCurrentSession();

  if (!session) {
    redirect("/signin");
  }

  return (
    <main className="dashboard-page">
      <div className="dashboard-card">
        <h1 className="dashboard-greeting">
          Welcome, <span className="dashboard-user-name">{session.user.name}</span>
        </h1>
        <SignoutButton />
      </div>
    </main>
  );
}
