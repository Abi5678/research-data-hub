import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { inviteProjectMember, listProjectMembers } from "@/lib/api-http";
import { isServerMode } from "@/lib/mode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function ProjectSharing({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("viewer");

  const members = useQuery({
    queryKey: ["members", projectId],
    queryFn: () => listProjectMembers(projectId),
    enabled: isServerMode,
  });

  const invite = useMutation({
    mutationFn: () => inviteProjectMember(projectId, email.trim(), role),
    onSuccess: () => {
      toast.success("Member added");
      setEmail("");
      qc.invalidateQueries({ queryKey: ["members", projectId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed"),
  });

  if (!isServerMode) return null;

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-card">
      <h3 className="text-sm font-bold text-foreground">Project access</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Invite colleagues by email. Viewers can query and export; editors can upload data.
      </p>
      <div className="mt-4 flex flex-wrap items-end gap-2">
        <div className="min-w-[200px] flex-1 space-y-1">
          <Label className="text-xs">Email</Label>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
        </div>
        <div className="w-32 space-y-1">
          <Label className="text-xs">Role</Label>
          <Select value={role} onValueChange={(v) => setRole(v as "editor" | "viewer")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="viewer">Viewer</SelectItem>
              <SelectItem value="editor">Editor</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => invite.mutate()} disabled={!email.trim() || invite.isPending}>
          Invite
        </Button>
      </div>
      {members.data && members.data.length > 0 && (
        <ul className="mt-4 space-y-1 text-xs text-muted-foreground">
          {members.data.map((m) => (
            <li key={m.email}>
              {m.email} — <span className="font-semibold text-foreground">{m.role}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
