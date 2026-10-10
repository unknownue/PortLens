import { useState } from "react";
import { Ban, ChevronDown, ChevronRight } from "lucide-react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n-react";
import { cn } from "@/lib/utils";
import type { ListenerView } from "@/types";

type ListenerSectionProps = {
  listeners: ListenerView[];
  onStop: (listener: ListenerView, force: boolean) => void;
};

/** Ports listening without a matching service definition (`serviceId === null`). */
export function ListenerSection({ listeners, onStop }: ListenerSectionProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<ListenerView | null>(null);
  const [force, setForce] = useState(false);

  const external = listeners
    .filter((item) => item.serviceId === null)
    .sort((a, b) => a.port - b.port || a.pid - b.pid);

  const confirmStop = () => {
    if (target) onStop(target, force);
    setTarget(null);
    setForce(false);
  };

  return (
    <div className="shrink-0 border-t border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-9 w-full items-center gap-2 px-2.5 text-left text-xs hover:bg-accent/40"
      >
        {open ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
        <span className="font-medium">{t("listeners.title")}</span>
        <Badge variant="secondary">{t("listeners.count", { count: external.length })}</Badge>
        <span className="truncate text-[11px] text-muted-foreground">{t("listeners.hint")}</span>
      </button>

      {open ? (
        external.length === 0 ? (
          <p className="px-3 pb-2 text-[11px] text-muted-foreground">{t("listeners.empty")}</p>
        ) : (
          <div className="max-h-64 overflow-auto border-t border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">{t("listeners.port")}</TableHead>
                  <TableHead className="w-32">{t("listeners.addr")}</TableHead>
                  <TableHead className="w-20">{t("listeners.pid")}</TableHead>
                  <TableHead className="w-40">{t("listeners.name")}</TableHead>
                  <TableHead>{t("listeners.exe")}</TableHead>
                  <TableHead className="w-32">{t("listeners.parent")}</TableHead>
                  <TableHead className="w-20">{t("listeners.established")}</TableHead>
                  <TableHead className="w-16 text-right">{t("listeners.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {external.map((item) => (
                  <TableRow key={`${item.port}-${item.pid}-${item.addr}`}>
                    <TableCell className="font-mono">{item.port}</TableCell>
                    <TableCell className="font-mono text-[11px]">{item.addr}</TableCell>
                    <TableCell className="font-mono text-[11px]">{item.pid}</TableCell>
                    <TableCell className="truncate">{item.name || t("common.unknown")}</TableCell>
                    <TableCell className="max-w-72 truncate font-mono text-[11px] text-muted-foreground" title={item.exe}>
                      {item.exe || "—"}
                    </TableCell>
                    <TableCell className="truncate text-[11px] text-muted-foreground">
                      {item.parentName ? `${item.parentName} (${item.ppid})` : item.ppid > 0 ? String(item.ppid) : "—"}
                    </TableCell>
                    <TableCell className={cn("font-mono text-[11px]", item.established > 0 && "text-foreground")}>
                      {item.established}
                    </TableCell>
                    <TableCell className="text-right">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="text-destructive hover:bg-destructive/10"
                            aria-label={t("action.stop")}
                            onClick={() => {
                              setForce(false);
                              setTarget(item);
                            }}
                          >
                            <Ban />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("action.stop")}</TooltipContent>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )
      ) : null}

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(value) => {
          if (!value) setTarget(null);
        }}
        title={t("listeners.stopTitle")}
        body={t("listeners.stopBody", {
          pid: target?.pid ?? 0,
          name: target?.name || t("common.unknown"),
          port: target?.port ?? 0,
        })}
        confirmLabel={t("action.stop")}
        force={{ checked: force, onChange: setForce }}
        onConfirm={confirmStop}
      />
    </div>
  );
}
