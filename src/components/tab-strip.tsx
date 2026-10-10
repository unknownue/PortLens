import { useEffect, useRef, useState } from "react";
import { Gauge, LoaderCircle, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n-react";
import { cn } from "@/lib/utils";
import type { PageTab } from "@/types";

type TabStripProps = {
  tabs: PageTab[];
  active: string | null;
  loading: Record<string, boolean>;
  onSelect: (label: string | null) => void;
  onClose: (label: string) => void;
  onRename: (label: string, title: string) => void;
  onNew: () => void;
};

export function TabStrip({ tabs, active, loading, onSelect, onClose, onRename, onNew }: TabStripProps) {
  const t = useT();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = (label: string) => {
    const title = draft.trim();
    setEditing(null);
    if (title) onRename(label, title);
  };

  return (
    <div className="flex h-9 shrink-0 items-stretch gap-1 border-b border-border bg-muted/30 px-2 pt-1">
      <button
        type="button"
        onClick={() => onSelect(null)}
        title={t("tabs.dashboard")}
        className={cn(
          "inline-flex max-w-44 items-center gap-1.5 truncate rounded-t-md border border-b-0 px-2.5 text-xs",
          active === null
            ? "border-border bg-card font-medium text-foreground"
            : "border-transparent text-muted-foreground hover:bg-accent/60",
        )}
      >
        <Gauge className="size-3.5 shrink-0" />
        <span className="truncate">{t("tabs.dashboard")}</span>
      </button>

      <div className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = tab.label === active;
          const isLoading = loading[tab.label] === true;
          return (
            <div
              key={tab.label}
              className={cn(
                "group inline-flex min-w-28 max-w-52 shrink-0 items-center gap-1 rounded-t-md border border-b-0 pl-2.5 pr-1 text-xs",
                isActive
                  ? "border-border bg-card font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-accent/60",
              )}
            >
              {isLoading ? (
                <LoaderCircle
                  className="size-3.5 shrink-0 animate-spin text-primary"
                  aria-label={t("tabs.loading")}
                />
              ) : null}
              {editing === tab.label ? (
                <input
                  ref={inputRef}
                  value={draft}
                  aria-label={t("tabs.rename")}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => commit(tab.label)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commit(tab.label);
                    if (event.key === "Escape") setEditing(null);
                  }}
                  className="h-5 min-w-0 flex-1 rounded-sm border border-input bg-background px-1 text-xs outline-none"
                />
              ) : (
                <button
                  type="button"
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
