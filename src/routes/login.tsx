import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { login } from "@/lib/api-http";
import { isServerMode } from "@/lib/mode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/login")({
  beforeLoad: () => {
    if (!isServerMode) {
      throw new Error("Login is only used in server mode");
    }
  },
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await login(email, password);
      toast.success("Signed in");
      navigate({ to: "/dashboard" });
    } catch (err) {
      const message = "Email or password was not recognized.";
      setStatus(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <form
        onSubmit={submit}
        aria-labelledby="login-title"
        className="w-full max-w-md space-y-5 rounded-2xl border border-border/70 bg-card p-8 shadow-card"
      >
        <div>
          <div className="mb-3 inline-flex rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-accent-foreground">
            Shared lab workspace
          </div>
          <h1 id="login-title" className="text-2xl font-extrabold tracking-tight">
            Research Data Hub
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in to access your research projects and shared data.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
        </div>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          Need access? Ask your lab administrator to create an account.
        </p>
        <p aria-live="polite" className="min-h-4 text-center text-xs text-destructive">
          {status}
        </p>
      </form>
    </main>
  );
}
