import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ResultsTable } from "@/components/project/results-table";
import { AnalyzePlotCard } from "@/components/project/analyze-plot-card";
import type { ColumnSchema } from "@/lib/csv";
import { buildAnalyzePlot, createPlotSpec, type AnalyzePlotSpec } from "@/lib/analyze-plot";
import {
  CHAT_REPAIR_ATTEMPTS,
  CHAT_ROW_LIMIT,
  selectRelevantTables,
  CHAT_SUGGESTIONS,
  answerSystemPrompt,
  friendlyQueryError,
  parseChatPlan,
  planSystemPrompt,
  repairPrompt,
  rowsForContext,
  type ChatTable,
} from "@/lib/data-chat";
import { Loader2, MessageSquare, Send, Sparkles, TriangleAlert, User2 } from "lucide-react";

type Dataset = {
  id: string;
  display_name: string;
  table_name: string;
  row_count: number;
  column_schema: ColumnSchema[];
};

type Turn = {
  id: string;
  question: string;
  answer: string;
  sql: string | null;
  columns: string[];
  rows: Record<string, unknown>[];
  plot: AnalyzePlotSpec | null;
  error: string | null;
};

let turnSeq = 0;

export function ChatTab({
  projectId,
  datasets,
}: {
  projectId: string;
  datasets: Dataset[];
}) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [showSqlFor, setShowSqlFor] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const aiAvailable = useQuery({
    queryKey: ["ai-available"],
    queryFn: () => api.isAiAssistAvailable(),
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  const tables: ChatTable[] = datasets.map((d) => ({
    table_name: d.table_name,
    display_name: d.display_name,
    row_count: d.row_count,
    column_schema: d.column_schema,
  }));

  const ask = useMutation({
    mutationFn: async (q: string): Promise<Turn> => {
      turnSeq += 1;
      const id = `turn-${turnSeq}`;
      const base: Turn = {
        id,
        question: q,
        answer: "",
        sql: null,
        columns: [],
        rows: [],
        plot: null,
        error: null,
      };

      // 1. Plan: plain English -> one guarded SELECT. Only the tables that look
      //    relevant are shown, so a small local model isn't drowned in schema.
      const scoped = selectRelevantTables(tables, q);
      const planReply = await api.llmChat(
        [
          { role: "system", content: planSystemPrompt(scoped) },
          // Prior questions only — old result sets would blow up the context.
          ...turns.slice(-4).flatMap((t) => [
            { role: "user", content: t.question },
            { role: "assistant", content: t.answer },
          ]),
          { role: "user", content: q },
        ],
        { temperature: 0.1, maxTokens: 1200 },
      );
      let plan = parseChatPlan(planReply);
      if (!plan.sql) return { ...base, answer: plan.answer };

      // 2. Execute through the same guard the Query tab uses, letting the model
      //    repair its own SQL from the database error. Small local models get a
      //    column name wrong often enough that one-shot would feel broken.
      let rows: Record<string, unknown>[] = [];
      let columns: string[] = [];
      let lastError = "";
      let executed = false;

      for (let attempt = 0; attempt < CHAT_REPAIR_ATTEMPTS && plan.sql; attempt += 1) {
        try {
          const res = await api.runProjectQuery(projectId, plan.sql, CHAT_ROW_LIMIT);
          rows = res.rows;
          columns = res.columns;
          executed = true;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err.message : "That lookup failed.";
          if (attempt === CHAT_REPAIR_ATTEMPTS - 1) break;
          try {
            const retry = await api.llmChat(
              [
                { role: "system", content: planSystemPrompt(scoped) },
                { role: "user", content: q },
                { role: "assistant", content: JSON.stringify({ sql: plan.sql }) },
                { role: "user", content: repairPrompt(plan.sql, lastError) },
              ],
              { temperature: 0, maxTokens: 1200 },
            );
            plan = parseChatPlan(retry);
          } catch {
            break; // keep lastError and report it
          }
        }
      }

      if (!executed) {
        return {
          ...base,
          sql: plan.sql,
          answer: plan.answer,
          error: friendlyQueryError(lastError),
        };
      }

      // 3. Ground the spoken answer in the rows that actually came back.
      let answer = plan.answer;
      try {
        answer = await api.llmChat(
          [
            { role: "system", content: answerSystemPrompt() },
            {
              role: "user",
              content: `Question: ${q}\n\nResults (${rows.length} rows):\n${rowsForContext(rows, columns)}`,
            },
          ],
          { temperature: 0.1, maxTokens: 600 },
        );
      } catch {
        /* keep the planned answer if the summary pass fails */
      }

      let plot: AnalyzePlotSpec | null = null;
      if (plan.chart && columns.includes(plan.chart.x) && columns.includes(plan.chart.y)) {
        plot = createPlotSpec({
          kind: plan.chart.kind,
          xColumn: plan.chart.x,
          yColumn: plan.chart.y,
          aggregation: "mean",
        });
      }

      return { ...base, answer: answer.trim(), sql: plan.sql, rows, columns, plot };
    },
    onSuccess: (turn) => setTurns((prev) => [...prev, turn]),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Could not answer that"),
  });

  const submit = () => {
    const q = question.trim();
    if (!q || ask.isPending) return;
    setQuestion("");
    ask.mutate(q);
  };

  if (datasets.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-secondary/40 p-10 text-center text-sm text-muted-foreground">
        Import or upload data first, then ask questions about it here.
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-4">
      <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-card">
        <div className="flex items-start gap-2">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-foreground">Ask about your data</h2>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Ask in plain English — no SQL needed. Answers are read-only lookups against this
              project's {datasets.length} table{datasets.length === 1 ? "" : "s"}; nothing is ever
              changed.
            </p>
          </div>
        </div>
      </div>

      {aiAvailable.data === false && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-[11px] text-amber-950 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-100">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            No assistant is configured yet, so questions can't be answered. Add a local model
            endpoint under Settings, then come back. Browse, Analyze and Query all work without it.
          </span>
        </div>
      )}

      {turns.length === 0 && (
        <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-card">
          <div className="text-xs font-semibold text-foreground">Try one of these</div>
          <div className="mt-3 flex flex-wrap gap-2">
            {CHAT_SUGGESTIONS.map((s) => (
              <Button
                key={s}
                type="button"
                variant="outline"
                size="sm"
                className="h-auto whitespace-normal py-1.5 text-left text-[11px]"
                onClick={() => ask.mutate(s)}
                disabled={ask.isPending}
              >
                {s}
              </Button>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-4">
        {turns.map((turn) => (
          <div key={turn.id} className="min-w-0 space-y-2">
            <div className="flex items-start gap-2">
              <div className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-secondary">
                <User2 className="h-3.5 w-3.5 text-muted-foreground" />
              </div>
              <div className="min-w-0 pt-0.5 text-sm font-semibold text-foreground">
                {turn.question}
              </div>
            </div>

            <div className="flex items-start gap-2">
              <div className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-gradient-primary shadow-glow">
                <MessageSquare className="h-3.5 w-3.5 text-white" />
              </div>
              <div className="min-w-0 flex-1 space-y-3">
                {turn.error ? (
                  <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                    {turn.error}
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap pt-0.5 text-sm leading-relaxed text-foreground">
                    {turn.answer}
                  </p>
                )}

                {turn.plot &&
                  (() => {
                    const result = buildAnalyzePlot(turn.plot!, turn.rows);
                    return result ? (
                      <AnalyzePlotCard
                        spec={turn.plot!}
                        onChange={(next) =>
                          setTurns((prev) =>
                            prev.map((t) => (t.id === turn.id ? { ...t, plot: next } : t)),
                          )
                        }
                        xOptions={turn.columns}
                        yOptions={turn.columns}
                        result={result}
                      />
                    ) : null;
                  })()}

                {turn.columns.length > 0 && (
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="text-[9px]">
                        {turn.rows.length.toLocaleString()} row
                        {turn.rows.length === 1 ? "" : "s"}
                      </Badge>
                      {turn.sql && (
                        <button
                          type="button"
                          className="text-[10px] font-medium text-muted-foreground underline-offset-2 hover:underline"
                          onClick={() =>
                            setShowSqlFor(showSqlFor === turn.id ? null : turn.id)
                          }
                        >
                          {showSqlFor === turn.id ? "Hide" : "Show"} the lookup it ran
                        </button>
                      )}
                    </div>
                    {showSqlFor === turn.id && turn.sql && (
                      <pre className="overflow-x-auto rounded-xl border border-border/70 bg-secondary/40 p-3 font-mono text-[10px] leading-relaxed text-muted-foreground">
                        {turn.sql}
                      </pre>
                    )}
                    <ResultsTable
                      columns={turn.columns}
                      rows={turn.rows}
                      emptyLabel="That lookup returned no rows"
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}

        {ask.isPending && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Looking at your data...
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="sticky bottom-0 flex items-center gap-2 rounded-2xl border border-border/70 bg-card p-2 shadow-card">
        <Input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. Which mix had the highest fracture energy?"
          className="h-9 border-0 text-sm shadow-none focus-visible:ring-0"
          disabled={ask.isPending}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button
          size="sm"
          className="h-9 shrink-0 gap-1.5"
          onClick={submit}
          disabled={ask.isPending || !question.trim()}
        >
          {ask.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          Ask
        </Button>
      </div>
    </div>
  );
}
