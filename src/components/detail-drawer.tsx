import { useEffect, useRef, useState } from "react";
import { Eraser, ScrollText, X } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatClock, formatDateTime, formatLatency, formatUptime } from "@/format";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n-react";
import { cn } from "@/lib/utils";
import { asLogSource, type LogSourceType, type ServiceView } from "@/types";

const LOG_LIMIT = 300;
const LOG_POLL_MS = 1000;
const MAX_LOG_LINES = 2000;

/** `service-log` events are forwarded here while a drawer is open. */
export type LogSink = (id: string, lines: string[]) => void;

type DetailDrawerProps = {
  service: ServiceView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registerLogSink: (sink: LogSink | null) => void;
  onClearLogs: (id: string) => Promise<void>;
};

export function DetailDrawer({
  service,
  open,
  onOpenChange,
  registerLogSink,
  onClearLogs,
}: DetailDrawerProps) {
  const t = useT();
  const id = service?.id ?? null;
  const [lines, setLines] = useState<string[]>([]);
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Lines that arrive while `get_service_logs` is in flight are already covered by
  // that response, so the sink is muted for the duration instead of double-appending.
  const inflight = useRef(false);

  useEffect(() => {
    setLines([]);
  }, [id]);

  useEffect(() => {
    if (!open || !id) return;
    let alive = true;

    const poll = async () => {
      inflight.current = true;
      try {
        const fetched = await api.getServiceLogs(id, LOG_LIMIT);
        if (alive) setLines(fetched.slice(-MAX_LOG_LINES));
      } catch {
        // Service removed or backend busy: the next tick retries.
      }
      inflight.current = false;
    };

    void poll();
    const timer = window.setInterval(() => void poll(), LOG_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
      inflight.current = false;
    };
  }, [open, id]);

  useEffect(() => {
    if (!open || !id) {
      registerLogSink(null);
      return;
    }
    const sink: LogSink = (incomingId, incoming) => {
      if (incomingId !== id || inflight.current) return;
      setLines((prev) => [...prev, ...incoming].slice(-MAX_LOG_LINES));
    };
    registerLogSink(sink);
    return () => registerLogSink(null);
  }, [open, id, registerLogSink]);

  useEffect(() => {
    if (!follow) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines, follow]);

  const clear = async () => {
    if (!id) return;
    setLines([]);
    await onClearLogs(id);
  };

  const logSource = asLogSource(service?.logSource);
  const logPath = (logSource.path ?? "").trim();
  const logPathMissing = logSource.type === "file" && !logPath;
  const logSourceLabel =
    logSource.type === "file" && logPath
      ? t("drawer.logSourceFile", { path: logPath })
      : t(logSourceLabelKey(logSource.type));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showClose={false}
        className="left-auto right-0 top-0 flex h-full max-h-none w-[560px] max-w-[92vw] translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0"
      >
        {service ? (
          <>
            <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border p-3">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  {t("drawer.title")}
                </span>
                <DialogTitle className="truncate">{service.name}</DialogTitle>
                <div className="flex items-center gap-2">
                  <StatusBadge status={service.status} />
                  <span className="font-mono text-[11px] text-muted-foreground">:{service.port}</span>
                </div>
              </div>
              <DialogClose asChild>
                <Button size="icon-sm" variant="ghost" aria-label={t("action.close")}>
                  <X />
                </Button>
              </DialogClose>
            </div>

            <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
              <div className="shrink-0 border-b border-border px-3 py-2">
                <TabsList>
                  <TabsTrigger value="overview">{t("drawer.overview")}</TabsTrigger>
                  <TabsTrigger value="logs">
                    <ScrollText />
                    {t("drawer.logs")}
                  </TabsTrigger>
                  <TabsTrigger value="config">{t("drawer.config")}</TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="overview" className="min-h-0 flex-1 overflow-auto p-3">
                <div className="flex flex-col gap-3">
                  <section className="flex flex-col gap-1.5">
                    <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      {t("drawer.timeline")}
                    </Label>
                    <Sparkline history={service.status.history} />
                  </section>

                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[12px]">
                    <Row
                      label={t("drawer.pid")}
                      value={service.status.pid === null ? "—" : String(service.status.pid)}
                      mono
                    />
                    <Row label={t("drawer.latency")} value={formatLatency(service.status.latencyMs)} mono />
                    <Row
                      label={t("drawer.uptime")}
                      value={service.status.state === "healthy" ? formatUptime(service.status.uptimeMs) : "—"}
                      mono
                    />
                    <Row
                      label={t("drawer.since")}
                      value={formatClock(service.status.sinceMs)}
                      title={formatDateTime(service.status.sinceMs)}
                      mono
                    />
                    <Row
                      label={t("drawer.exitCode")}
                      value={service.status.exitCode === null ? "—" : String(service.status.exitCode)}
                      mono
                    />
                    <Row label={t("drawer.probeType")} value={t(probeLabelKey(service.health.type))} />
                    <Row label={t("drawer.detail")} value={service.status.detail || t("common.none")} wide />
                  </dl>
                </div>
              </TabsContent>

              <TabsContent value="logs" className="flex min-h-0 flex-1 flex-col gap-2 p-3">
                <div
                  className="flex shrink-0 flex-col gap-0.5 rounded-md border border-border bg-muted/20 px-2 py-1.5 text-[11px]"
                  title={t("drawer.logSourceHint")}
                >
                  <span className="text-muted-foreground">
                    {t("drawer.logSource")}:{" "}
                    <span
                      className={logSource.type === "file" ? "font-mono text-foreground" : "text-foreground"}
                      title={logSourceLabel}
                    >
                      {logSourceLabel}
                    </span>
                  </span>
                  {logPathMissing ? (
                    <span className="text-amber-700 dark:text-amber-300">
                      {t("drawer.logSourceFileMissing")}
                    </span>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <div className="flex items-center gap-2">
                    <Switch id="drawer-follow" checked={follow} onCheckedChange={setFollow} />
                    <Label htmlFor="drawer-follow">{t("action.follow")}</Label>
                  </div>
                  <span className="flex-1 text-right font-mono text-[11px] text-muted-foreground">
                    {lines.length}
                  </span>
                  <Button size="sm" variant="outline" onClick={() => void clear()}>
                    <Eraser />
                    {t("drawer.clearLogs")}
                  </Button>
                </div>
                <div
                  ref={scrollRef}
                  className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed"
                >
                  {lines.length === 0 ? (
                    <p className="text-muted-foreground">{t("drawer.logsEmpty")}</p>
                  ) : (
                    lines.map((line, index) => (
                      <div key={index} className="whitespace-pre-wrap break-all">
                        {line}
                      </div>
                    ))
                  )}
                </div>
              </TabsContent>

              <TabsContent value="config" className="min-h-0 flex-1 overflow-auto p-3">
                <dl className="grid grid-cols-1 gap-y-2 text-[12px]">
                  <Row label={t("drawer.id")} value={service.id} mono />
                  <Row label={t("table.port")} value={String(service.port)} mono />
                  <Row
                    label={t("table.command")}
                    value={service.command?.trim() ? service.command : t("table.monitorOnly")}
                    mono
                  />
                  <Row label={t("table.cwd")} value={service.cwd?.trim() ? service.cwd : "—"} mono />
                  <Row label={t("drawer.probeType")} value={t(probeLabelKey(service.health.type))} />
                  {service.health.type === "http" ? (
                    <Row label={t("table.path")} value={service.health.path || "—"} mono />
                  ) : null}
                  {service.health.type === "exec" ? (
                    <Row label={t("table.probeCommand")} value={service.health.command || "—"} mono />
                  ) : null}
                  <Row label={t("table.interval")} value={`${service.health.intervalMs} ms`} mono />
                  <Row label={t("table.timeout")} value={`${service.health.timeoutMs} ms`} mono />
                  <Row label={t("table.threshold")} value={String(service.health.failureThreshold)} mono />
                  <Row label={t("drawer.logSource")} value={t(logSourceLabelKey(logSource.type))} />
                  {logSource.type === "file" ? (
                    <Row label={t("service.logPath")} value={logPath || "—"} mono />
                  ) : null}
                  {logSource.type === "file" ? (
                    <Row label={t("service.logEncoding")} value={logSource.encoding ?? "utf-8"} mono />
                  ) : null}
                </dl>
              </TabsContent>
            </Tabs>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function probeLabelKey(type: string) {
  return (type === "http" || type === "exec" || type === "none" ? `probe.${type}` : "probe.tcp") as
    | "probe.tcp"
    | "probe.http"
    | "probe.exec"
    | "probe.none";
}

function logSourceLabelKey(type: LogSourceType) {
  return (type === "file" ? "logSource.file" : "logSource.process") as
    | "logSource.file"
    | "logSource.process";
}

function Row({
  label,
  value,
  title,
  mono,
  wide,
}: {
  label: string;
  value: string;
  title?: string;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", wide && "col-span-2")}>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className={cn("truncate", mono && "font-mono text-[11px]")} title={title ?? value}>
        {value}
      </dd>
    </div>
  );
}

/** `status.history` sparkline: one bar per probe, newest on the right. */
function Sparkline({ history }: { history: boolean[] }) {
  const t = useT();
  if (history.length === 0) {
    return <p className="text-[11px] text-muted-foreground">{t("drawer.timelineEmpty")}</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      <div
        className="flex h-5 items-end gap-px overflow-hidden"
        title={t("drawer.timelineHint", { count: history.length })}
      >
        {history.map((ok, index) => (
          <span
            key={index}
            className={cn(
              "h-full w-1 shrink-0 rounded-[1px]",
              ok ? "bg-emerald-500/80" : "bg-red-500/80",
            )}
          />
        ))}
      </div>
      <span className="text-[11px] text-muted-foreground">
        {t("drawer.timelineHint", { count: history.length })}
      </span>
    </div>
  );
}
