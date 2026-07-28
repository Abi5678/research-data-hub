import { createFileRoute, redirect } from "@tanstack/react-router";
import { fetchMe } from "@/lib/api-http";
import { isServerMode } from "@/lib/mode";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    if (isServerMode) {
      const user = await fetchMe();
      throw redirect({ to: user ? "/dashboard" : "/login" });
    }
    throw redirect({ to: "/dashboard" });
  },
  component: () => null,
});
