import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard,
  FolderPlus,
  FolderOpen,
  Database,
  FlaskConical,
  Moon,
  Settings,
  Sun,
} from "lucide-react";
import { useTheme } from "@/lib/theme";
import { isServerMode } from "@/lib/mode";
import { logout } from "@/lib/api-http";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

const navAll: {
  title: string;
  url: string;
  icon: React.ComponentType<{ className?: string }>;
  desktopOnly?: boolean;
}[] = [
  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
  { title: "New project", url: "/projects/new", icon: FolderPlus },
  { title: "Import research folder", url: "/import-folder", icon: FolderOpen },
  { title: "Settings", url: "/settings", icon: Settings },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const nav = navAll.filter((item) => !item.desktopOnly || !isServerMode);

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full bg-background">
        <Sidebar collapsible="icon">
          <SidebarHeader className="border-b border-border/60">
            <div className="flex items-center gap-2.5 px-2 py-2">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-primary shadow-glow">
                <FlaskConical className="h-4.5 w-4.5 text-white" strokeWidth={2.4} />
              </div>
              <div className="min-w-0 group-data-[collapsible=icon]:hidden">
                <div className="truncate text-sm font-bold tracking-tight text-foreground">
                  Research Data Hub
                </div>
                <div className="truncate text-[11px] font-medium text-muted-foreground">
                  Research data workspace
                </div>
              </div>
            </div>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Workspace</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {nav.map((item) => {
                    const active =
                      pathname === item.url ||
                      (item.url !== "/dashboard" && pathname.startsWith(item.url));
                    return (
                      <SidebarMenuItem key={item.url}>
                        <SidebarMenuButton asChild isActive={active}>
                          <Link to={item.url} className="flex items-center gap-2">
                            <item.icon className="h-4 w-4" />
                            <span>{item.title}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter className="border-t border-border/60">
            <div className="flex items-center gap-2 px-2 py-1.5 group-data-[collapsible=icon]:hidden">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
                <Database className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1 text-xs">
                <div className="truncate font-semibold text-foreground">
                  {isServerMode ? "Lab server" : "Local database"}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {isServerMode ? "Shared Postgres backend" : "Stored on this Mac"}
                </div>
              </div>
            </div>
          </SidebarFooter>
        </Sidebar>
        <div className="flex-1 flex flex-col min-w-0">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border/70 bg-background/80 px-4 backdrop-blur">
            <SidebarTrigger className="text-muted-foreground" />
            <div className="flex-1" />
            {isServerMode && (
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  await logout();
                  navigate({ to: "/login" });
                }}
              >
                Sign out
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={toggle}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          </header>
          <main id="main-content" tabIndex={-1} className="flex-1 min-w-0 outline-none">
            {children}
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
