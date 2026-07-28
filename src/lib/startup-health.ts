/**
 * Startup health check — runs once in the browser before the app is considered
 * healthy. Verifies that src/styles.css was resolved by Vite and that Tailwind
 * design tokens are actually applied to the document. On failure, throws an
 * Error so the RuntimeErrorOverlay surfaces it with a full stack instead of a
 * silent blank screen.
 */

export type HealthCheckResult = {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
};

let ran = false;
let cached: HealthCheckResult | undefined;

export function runStartupHealthCheck(): HealthCheckResult {
  if (ran && cached) return cached;
  ran = true;

  const checks: HealthCheckResult["checks"] = [];

  // styles.css is imported directly in src/main.tsx (SPA build): Vite injects
  // it as a <style> tag in dev and a hashed <link> in production, so there is
  // no stable <link> to assert on. Verify the *effects* instead:

  // 1. Tailwind design tokens must be defined on :root. If styles.css failed
  //    to transform, --color-background is empty and the app renders unstyled.
  const root = getComputedStyle(document.documentElement);
  const bg = root.getPropertyValue("--color-background").trim();
  const primary = root.getPropertyValue("--color-primary").trim();
  checks.push({
    name: "--color-background token defined",
    ok: bg.length > 0,
    detail: bg || "empty — @theme inline did not apply",
  });
  checks.push({
    name: "--color-primary token defined",
    ok: primary.length > 0,
    detail: primary || "empty",
  });

  // 2. Probe a Tailwind utility class to confirm the compiler ran.
  const probe = document.createElement("div");
  probe.className = "bg-primary";
  probe.style.position = "absolute";
  probe.style.left = "-9999px";
  document.body.appendChild(probe);
  const probeBg = getComputedStyle(probe).backgroundColor;
  document.body.removeChild(probe);
  const utilityOk =
    probeBg !== "" &&
    probeBg !== "rgba(0, 0, 0, 0)" &&
    probeBg !== "transparent";
  checks.push({
    name: "Tailwind utility `bg-primary` compiled",
    ok: utilityOk,
    detail: probeBg || "no background applied",
  });

  const ok = checks.every((c) => c.ok);
  cached = { ok, checks };

  if (!ok) {
    const failed = checks.filter((c) => !c.ok);
    // Group log so it is easy to spot in devtools.
    // eslint-disable-next-line no-console
    console.group("%c[startup-health] FAILED", "color:#dc2626;font-weight:600");
    for (const c of checks) {
      // eslint-disable-next-line no-console
      console.log(`${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail ?? ""}`);
    }
    // eslint-disable-next-line no-console
    console.groupEnd();

    // Throw an Error so the RuntimeErrorOverlay picks it up with a stack.
    const summary = failed.map((c) => `${c.name}: ${c.detail}`).join(" | ");
    // eslint-disable-next-line no-console
    console.error(
      new Error(
        `Startup health check failed — src/styles.css did not apply. ${summary}`,
      ),
    );
  }

  return cached;
}
