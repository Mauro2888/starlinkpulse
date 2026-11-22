import { lazy, Suspense, useEffect, useState } from "react";
import { Activity, ChartLine, SlidersHorizontal, Sparkles } from "lucide-react";
import { PulseProvider } from "@/state/pulse-context";
import { useCapabilities, useConnection, useSettings } from "@/hooks/use-pulse";
import { AppHeader } from "@/components/app-header";
import { LiveTab } from "@/components/live/live-tab";
import { ControlsTab } from "@/components/controls/controls-tab";
import { AdvisorPanel } from "@/components/advisor/advisor-tab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { Skeleton } from "@/components/ui/skeleton";

// recharts is heavy: load the History tab on demand.
const HistoryTab = lazy(() => import("@/components/history/history-tab").then((m) => ({ default: m.HistoryTab })));

const TABS = [
  { value: "live", label: "Live", icon: Activity },
  { value: "history", label: "History", icon: ChartLine },
  { value: "controls", label: "Controls", icon: SlidersHorizontal },
  { value: "advisor", label: "Advisor", icon: Sparkles },
] as const;

/** Waits for the target tab to render, then scrolls to and focuses an element. */
function focusLater(scrollId: string, focusId?: string) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const section = document.getElementById(scrollId);
      section?.scrollIntoView({ behavior: "smooth", block: "center" });
      const target = (focusId && document.getElementById(focusId)) || section?.querySelector<HTMLElement>("input, button");
      target?.focus();
    }),
  );
}

type TabValue = (typeof TABS)[number]["value"];

function Dashboard() {
  // Initial tab can be deep-linked with #live / #history / #controls / #advisor.
  const [tab, setTab] = useState<TabValue>(() => {
    const h = window.location.hash.slice(1);
    return TABS.some((t) => t.value === h) ? (h as TabValue) : "live";
  });
  const connection = useConnection();
  const capabilities = useCapabilities();
  const { settings } = useSettings();

  // Cmd/Ctrl + 1..4 switches tabs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < TABS.length) {
        e.preventDefault();
        setTab(TABS[idx].value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-3 px-3 pt-3 pb-4 md:px-5 md:pt-4">
      <AppHeader connection={connection} capabilities={capabilities} readOnly={settings?.readOnly ?? null} />
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)} className="gap-3">
        <TabsList className="w-full md:w-fit">
          {TABS.map((t, i) => (
            <TabsTrigger key={t.value} value={t.value} className="px-2 sm:px-3" title={`${t.label} (⌘${i + 1})`}>
              <t.icon aria-hidden />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="live">
          <LiveTab />
        </TabsContent>
        <TabsContent value="history">
          <Suspense fallback={<Skeleton className="h-64 rounded-xl" />}>
            <HistoryTab />
          </Suspense>
        </TabsContent>
        <TabsContent value="advisor">
          <AdvisorPanel
            onOpenApiKey={() => {
              setTab("controls");
              focusLater("api-key", "api-key-input");
            }}
            onOpenModelSettings={() => {
              setTab("controls");
              focusLater("claude-model", "claude-model");
            }}
          />
        </TabsContent>
        <TabsContent value="controls">
          <ControlsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function App() {
  return (
    <TooltipProvider delayDuration={300}>
      <PulseProvider>
        <Dashboard />
      </PulseProvider>
      <Toaster position="bottom-center" closeButton />
    </TooltipProvider>
  );
}

export default App;
