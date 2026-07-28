import { useEffect, useState } from "react";

type CapturedError = {
  id: number;
  message: string;
  stack?: string;
  source: string;
  at: string;
};

let counter = 0;
const listeners = new Set<(e: CapturedError) => void>();
const buffer: CapturedError[] = [];

function push(source: string, err: unknown) {
  const e = err as Error | undefined;
  const entry: CapturedError = {
    id: ++counter,
    message: e?.message ?? String(err),
    stack: e?.stack,
    source,
    at: new Date().toISOString(),
  };
  buffer.push(entry);
  // eslint-disable-next-line no-console
  console.error(`[${source}]`, err);
  listeners.forEach((l) => l(entry));
}

let installed = false;
function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (ev) => {
    push("window.error", ev.error ?? new Error(ev.message));
  });
  window.addEventListener("unhandledrejection", (ev) => {
    push("unhandledrejection", ev.reason);
  });
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    origError.apply(console, args as []);
    // Avoid recursion — only surface Error instances or React error prefixes
    const first = args[0];
    if (first instanceof Error) {
      buffer.push({
        id: ++counter,
        message: first.message,
        stack: first.stack,
        source: "console.error",
        at: new Date().toISOString(),
      });
      listeners.forEach((l) => l(buffer[buffer.length - 1]));
    }
  };
}

export function RuntimeErrorOverlay() {
  const [errors, setErrors] = useState<CapturedError[]>(buffer.slice());
  const [open, setOpen] = useState(true);

  useEffect(() => {
    install();
    const l = (e: CapturedError) => {
      setErrors((prev) => [...prev, e]);
      setOpen(true);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  if (errors.length === 0) return null;

  const latest = errors[errors.length - 1];

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          position: "fixed",
          bottom: 12,
          right: 12,
          zIndex: 2147483647,
          background: "#dc2626",
          color: "white",
          padding: "6px 10px",
          borderRadius: 6,
          fontSize: 12,
          fontFamily: "ui-monospace, monospace",
          border: "none",
          cursor: "pointer",
          boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
        }}
      >
        {errors.length} runtime error{errors.length > 1 ? "s" : ""}
      </button>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        left: 12,
        right: 12,
        bottom: 12,
        maxHeight: "50vh",
        zIndex: 2147483647,
        background: "#0b0b0f",
        color: "#f5f5f5",
        border: "1px solid #dc2626",
        borderRadius: 8,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          borderBottom: "1px solid #27272a",
          background: "#7f1d1d",
          borderTopLeftRadius: 8,
          borderTopRightRadius: 8,
        }}
      >
        <strong>
          Runtime error ({errors.length}) — latest: {latest.source}
        </strong>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => {
              const text = errors
                .map(
                  (e) =>
                    `[${e.at}] ${e.source}: ${e.message}\n${e.stack ?? ""}`,
                )
                .join("\n\n");
              navigator.clipboard?.writeText(text);
            }}
            style={btnStyle}
          >
            Copy
          </button>
          <button
            onClick={() => {
              buffer.length = 0;
              setErrors([]);
            }}
            style={btnStyle}
          >
            Clear
          </button>
          <button onClick={() => setOpen(false)} style={btnStyle}>
            Hide
          </button>
        </div>
      </div>
      <div style={{ overflow: "auto", padding: 12 }}>
        {errors
          .slice()
          .reverse()
          .map((e) => (
            <div
              key={e.id}
              style={{
                marginBottom: 12,
                paddingBottom: 12,
                borderBottom: "1px solid #27272a",
              }}
            >
              <div style={{ color: "#fca5a5", fontWeight: 600 }}>
                {e.source}: {e.message}
              </div>
              <div style={{ color: "#71717a", fontSize: 10, marginTop: 2 }}>
                {e.at}
              </div>
              {e.stack && (
                <pre
                  style={{
                    marginTop: 6,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    color: "#e4e4e7",
                    fontSize: 11,
                  }}
                >
                  {e.stack}
                </pre>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "#18181b",
  color: "white",
  border: "1px solid #3f3f46",
  borderRadius: 4,
  padding: "3px 8px",
  fontSize: 11,
  cursor: "pointer",
  fontFamily: "inherit",
};
