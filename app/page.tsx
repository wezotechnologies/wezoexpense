import { redirect } from "next/navigation";

import { getSessionUser } from "@/lib/rbac";

export default async function RootPage() {
  const user = await getSessionUser().catch(() => null);
  redirect(user ? "/dashboard" : "/login");
}
