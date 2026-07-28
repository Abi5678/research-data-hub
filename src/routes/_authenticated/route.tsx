import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { fetchMe } from "@/lib/api-http";
import { isServerMode } from "@/lib/mode";

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async () => {
    if (!isServerMode) return;
    const user = await fetchMe();
    if (!user) throw redirect({ to: "/login" });
    return { user };
  },
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
