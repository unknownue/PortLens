import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Gauge, LoaderCircle, Plus, ScrollText, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n-react";
import { cn } from "@/lib/utils";
import type { LogTab, PageLoadPayload, PageStatusPayload, PageTab } from "@/types";

type TabStripProps = {
  tabs: PageTab[];
  active: string | null;
  loading: Record<string, boolean>;
  logTabs: LogTab[];
  activeLog: string | null;
  onSelect: (label: string | null) => void;
  onClose: (label: string) => void;
  onRename: (label: string, title: string) => void;
  onSelectLog: (id: string) => void;
  onCloseLog: (id: string) => void;
  onRenameLog: (id: string, title: string) => void;
  onNew: () => void;
};

/** Document responses that mean "you are missing credentials / headers". */
function needsHeaders(status: number): boolean {
  return status === 401 || status === 403;
}

const TAB_BASE =
  "group inline-flex min-w-28 max-w-52 shrink-0 items-center gap-1 rounded-t-md border border-b-0 pl-2.5 pr-1 text-xs";
const TAB_IDLE = "border-transparent text-muted-foreground hover:bg-accent/60";
const TAB_ACTIVE = "border-border bg-card font-medium text-foreground";

export function TabStrip({
  tabs,
  active,
  loading,
  logTabs,
  activeLog,
  onSelect,
  onClose,
  onRename,
  onSelectLog,
  onCloseLog,
  onRenameLog,
  onNew,
}: TabStripProps) {
  const t = useT();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** page label -> status of the last 401/403 response; cleared on reload or a new status. */
  const [headerWarn, setHeaderWarn] = useState<Record<string, number>>({});
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // `page-status` only ever carries a label/url/status triple, never header values.
  useEffect(() => {
    let disposed = false;
    const unlisten: UnlistenFn[] = [];

    const track = async (pending: Promise<UnlistenFn>) => {
      try {
        const off = await pending;
        if (disposed) off();
        else unlisten.push(off);
      } catch {
        // Event bridge unavailable: tabs still render, the warning just never appears.
      }
    };

    void track(
      listen<PageStatusPayload>("page-status", (event) => {
        const { label, status } = event.payload;
        setHeaderWarn((prev) => {
          if (needsHeaders(status)) {
            return prev[label] === status ? prev : { ...prev, [label]: status };
          }
          if (prev[label] === undefined) return prev;
          const next = { ...prev };
          delete next[label];
          return next;
        });
      }),
    );
    // A fresh load clears the warning: the next 401/403 will raise it again.
    void track(
      listen<PageLoadPayload>("page-load", (event) => {
        const { label } = event.payload;
        setHeaderWarn((prev) => {
          if (prev[label] === undefined) return prev;
          const next = { ...prev };
          delete next[label];
          return next;
        });
      }),
    );

    return () => {
      disposed = true;
      for (const off of unlisten) off();
    };
  }, []);

  // Drop warnings of labels that no longer exist.
  useEffect(() => {
    setHeaderWarn((prev) => {
      const labels = new Set(tabs.map((tab) => tab.label));
      const kept = Object.entries(prev).filter(([label]) => labels.has(label));
      return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept);
    });
  }, [tabs]);

  const commit = (apply: (title: string) => void) => {
    const title = draft.trim();
    setEditing(null);
    if (title) apply(title);
  };

  const renameInput = (key: string, apply: (title: string) => void) => (
    <input
      ref={editing === key ? inputRef : undefined}
      value={draft}
      aria-label={t("tabs.rename")}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => commit(apply)}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit(apply);
        if (event.key === "Escape") setEditing(null);
      }}
      className="h-5 min-w-0 flex-1 rounded-sm border border-input bg-background px-1 text-xs outline-none"
    />
  );

  return (
    <div className="flex h-9 shrink-0 items-stretch gap-1 border-b border-border bg-muted/30 px-2 pt-1">
      <button
        type="button"
        data-testid="tab-strip-item"
        onClick={() => onSelect(null)}
        title={t("tabs.dashboard")}
        className={cn(
          "inline-flex max-w-44 items-center gap-1.5 truncate rounded-t-md border border-b-0 px-2.5 text-xs",
          active === null && activeLog === null
            ? "border-border bg-card font-medium text-foreground"
            : "border-transparent text-muted-foreground hover:bg-accent/60",
        )}
      >
        <Gauge className="size-3.5 shrink-0" />
        <span className="truncate">{t("tabs.dashboard")}</span>
      </button>

      <div className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = activeLog === null && tab.label === active;
          const isLoading = loading[tab.label] === true;
          const warnStatus = headerWarn[tab.label];
          return (
            <div key={tab.label} className={cn(TAB_BASE, isActive ? TAB_ACTIVE : TAB_IDLE)}>
              {isLoading ? (
                <LoaderCircle
                  className="size-3.5 shrink-0 animate-spin text-primary"
                  aria-label={t("tabs.loading")}
                />
              ) : null}
              {editing === tab.label ? (
                renameInput(tab.label, (title) => onRename(tab.label, title))
              ) : (
                <button
                  type="button"
                  data-testid="tab-strip-item"
                  onClick={() => onSelect(tab.label)}
                  onDoubleClick={() => {
                    setDraft(tab.title);
                    setEditing(tab.label);
                  }}
                  aria-label={t("tabs.activate")}
                  title={`${tab.title}\n${tab.url}\n${t("tabs.renameHint")}`}
                  className="min-w-0 flex-1 truncate py-1 text-left"
                >
                  {tab.title}
                </button>
              )}
              {warnStatus !== undefined ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      title={`HTTP ${warnStatus} — ${t("tabs.needsHeaders")}`}
                      aria-label={t("tabs.needsHeaders")}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelect(tab.label);
                        toast.message(t("tabs.needsHeaders"));
                      }}
                      className="shrink-0 text-amber-600 dark:text-amber-400"
                    >
                      <TriangleAlert className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{`HTTP ${warnStatus} — ${t("tabs.needsHeaders")}`}</TooltipContent>
                </Tooltip>
              ) : null}
              <Button
                variant="ghost"
                size="icon-xs"
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                title={t("tabs.close")}
                aria-label={t("tabs.close")}
                onClick={() => onClose(tab.label)}
              >
                <X />
              </Button>
            </div>
          );
        })}

        {logTabs.map((tab) => {
          const isActive = activeLog === tab.id;
          return (
            <div key={tab.id} className={cn(TAB_BASE, isActive ? TAB_ACTIVE : TAB_IDLE)}>
              <ScrollText className="size-3.5 shrink-0 opacity-70" />
              {editing === `logtab:${tab.id}` ? (
                renameInput(`logtab:${tab.id}`, (title) => onRenameLog(tab.id, title))
              ) : (
                <button
                  type="button"
                  data-testid="tab-strip-item"
                  onClick={() => onSelectLog(tab.id)}
                  onDoubleClick={() => {
                    setDraft(tab.title);
                    setEditing(`logtab:${tab.id}`);
                  }}
                  aria-label={t("tabs.activate")}
                  title={`${tab.title}\n${t("tabs.renameHint")}`}
                  className="min-w-0 flex-1 truncate py-1 text-left"
                >
                  {tab.title}
                </button>
              )}
              <Button
                variant="ghost"
                size="icon-xs"
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                title={t("tabs.close")}
                aria-label={t("tabs.close")}
                onClick={() => onCloseLog(tab.id)}
              >
                <X />
              </Button>
            </div>
          );
        })}
      </div>

      <Button
        variant="ghost"
        size="icon-sm"
        className="mb-1 self-center"
        title={t("tabs.new")}
        aria-label={t("tabs.new")}
        onClick={onNew}
      >
        <Plus />
      </Button>
    </div>
  );
}
