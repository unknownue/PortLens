import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { CirclePause, CirclePlay, Copy, Eraser, Regex, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { useT } from "@/lib/i18n-react";
import { cn } from "@/lib/utils";
import { filterLogLines, joinLines, noisyLine, warnLine } from "@/logtab";
import type { LogPayload, ServiceView } from "@/types";

const LOG_LIMIT = 300;
const LOG_POLL_MS = 1000;
const MAX_LINES = 2000;

type LogViewProps = {
  service: ServiceView | null;
  onOpenChange?: (open: boolean) => void;
};

/**
 * Log tab content: a live view of one service's log (process output or a tailed file).
 * Owns its own snapshot + `service-log` subscription, so nothing is buffered while hidden.
 */
export function LogView({ service }: LogViewProps) {
  const t = useT();
  const id = service?.id ?? null;
  const [lines, setLines] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);
  const [clearedAt, setClearedAt] = useState(0);
  const pausedRef = useRef(paused);
  const boxRef = useRef<HTMLDivElement | null>(null);

  pausedRef.current = paused;
  const droppedRef = useRef(false);

  const fetchSnapshot = useCallback(async () => {
    if (!id) return;
    try {
      const fetched = await api.getServiceLogs(id, LOG_LIMIT);
      setLines(fetched.slice(-MAX_LINES));
    } catch {
      // Service removed while the tab is open; keep what we have.
    }
  }, [id]);

  // Snapshot on open / when the bound service changes; poll as a safety net (events can be
  // missed while a modal is open) — the ring buffer makes a repeat read cheap.
  useEffect(() => {
    setLines([]);
    setQuery("");
    setPaused(false);
    setFollow(true);
    if (!id) return;
    void fetchSnapshot();
    const timer = window.setInterval(() => {
      if (!pausedRef.current && !droppedRef.current) void fetchSnapshot();
    }, LOG_POLL_MS * 3);
    return () => window.clearInterval(timer);
  }, [id, fetchSnapshot]);

  // Live lines for this service only.
  useEffect(() => {
    if (!id) return;
    let disposed = false;
    let off: (() => void) | null = null;
    void listen<LogPayload>("service-log", (event) => {
      if (event.payload.id !== id || pausedRef.current) return;
      setLines((prev) => [...prev, ...event.payload.lines].slice(-MAX_LINES));
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else off = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      off?.();
    };
  }, [id]);

  const visible = useMemo(() => filterLogLines(lines, query, useRegex), [lines, query, useRegex]);

  // Follow the tail unless the user scrolled up.
  useEffect(() => {
    if (!follow || paused) return;
    const box = boxRef.current;
    if (!box) return;
    box.scrollTop = box.scrollHeight;
  }, [visible, follow, paused, clearedAt]);

  const onScroll = () => {
    const box = boxRef.current;
    if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    setFollow(atBottom);
  };

  const clear = async () => {
    if (!id) return;
    try {
      await api.clearServiceLogs(id);
      setLines([]);
      setClearedAt(Date.now());
      toast.message(t("logtab.cleared"));
    } catch (error) {
      toast.error(t("toast.failed", { message: String(error) }));
    }
  };

  const copy = async () => {
    const ok = await copyText(joinLines(visible));
    if (ok) toast.success(t("logtab.copied", { count: visible.length }));
    else toast.error(t("toast.failed", { message: "clipboard" }));
  };

  const togglePause = () => {
    setPaused((prev) => {
      const next = !prev;
      if (!next) {
        // Resuming: the ring kept receiving lines, so re-read instead of replaying events.
        droppedRef.current = false;
        void fetchSnapshot();
      } else {
        droppedRef.current = true;
      }
      return next;
    });
  };

  const logSource = service?.logSource;
  const sourceLabel =
    logSource?.type === "file" && (logSource.path ?? "").trim()
      ? t("logtab.sourceFile", { path: (logSource.path ?? "").trim() })
      : t("logtab.sourceProcess");
  const externalProcess =
    logSource?.type !== "file" && service !== null && service.status.pid === null;

  return (
    <div className="absolute inset-0 flex flex-col" data-testid="log-tab">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
        <span className="font-medium" data-testid="log-tab-title">
          {service ? service.name : t("drawer.title")}
        </span>
        <span className="text-muted-foreground">{sourceLabel}</span>
        <span className="rounded-sm bg-muted px-1.5 py-0.5 text-muted-foreground">
          {t("logtab.count", { visible: visible.length, total: lines.length })}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <div className="relative">
            <Search className="pointer-events-none absolute left-1.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              data-testid="log-tab-filter"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("logtab.filterPlaceholder")}
              className="h-6 w-52 pl-6 text-xs"
            />
          </div>
          <Button
            variant={useRegex ? "secondary" : "ghost"}
            size="icon-xs"
            title={t("logtab.regex")}
            aria-label={t("logtab.regex")}
            data-testid="log-tab-regex"
            onClick={() => setUseRegex((prev) => !prev)}
          >
            <Regex />
          </Button>
          <Button
            variant={follow ? "secondary" : "ghost"}
            size="icon-xs"
            title={t("logtab.follow")}
            aria-label={t("logtab.follow")}
            data-testid="log-tab-follow"
            onClick={() => setFollow((prev) => !prev)}
          >
            <span className="text-[10px] leading-none">{follow ? "▼" : "▽"}</span>
          </Button>
          <Button
            variant={paused ? "secondary" : "ghost"}
            size="icon-xs"
            title={paused ? t("logtab.resume") : t("logtab.pause")}
            aria-label={paused ? t("logtab.resume") : t("logtab.pause")}
            data-testid="log-tab-pause"
            onClick={togglePause}
          >
            {paused ? <CirclePlay /> : <CirclePause />}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            title={t("logtab.copy")}
            aria-label={t("logtab.copy")}
            data-testid="log-tab-copy"
            onClick={() => void copy()}
          >
            <Copy />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            title={t("logtab.clear")}
            aria-label={t("logtab.clear")}
            data-testid="log-tab-clear"
            onClick={() => void clear()}
          >
            <Eraser />
          </Button>
        </div>
      </div>

      <div
        ref={boxRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto bg-[#0d1117] px-3 py-2 font-mono text-[11.5px] leading-5 text-foreground"
      >
        {visible.length === 0 ? (
          <p className="text-muted-foreground" data-testid="log-tab-empty">
            {externalProcess ? t("logtab.emptyExternal") : t("logtab.empty")}
          </p>
        ) : (
          <div data-testid="log-tab-lines">
            {visible.map((line, index) => (
              <div
                key={`${index}-${line.slice(0, 24)}`}
                className={cn(
                  "whitespace-pre-wrap break-all",
                  noisyLine(line) && "text-rose-400",
                  warnLine(line) && "text-amber-400",
                )}
              >
                {line}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
