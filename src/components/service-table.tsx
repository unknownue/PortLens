import {
  CircleStop,
  Ellipsis,
  Gauge,
  Pencil,
  Play,
  Radar,
  RotateCw,
  MonitorPlay,
  Trash,
} from "lucide-react";
import type { ReactNode } from "react";

import { RiskyBadge, StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatClock, formatDateTime, formatLatency, formatUptime } from "@/format";
import { useT } from "@/lib/i18n-react";
import { canStart, canStop, compareBySeverity } from "@/status";
import type { ServiceView } from "@/types";

type ServiceTableProps = {
  services: ServiceView[];
  onStart: (view: ServiceView) => void;
  onStop: (view: ServiceView) => void;
  onRestart: (view: ServiceView) => void;
  onProbe: (view: ServiceView) => void;
  onOpenPage: (view: ServiceView) => void;
  onEdit: (view: ServiceView) => void;
  onDelete: (view: ServiceView) => void;
  onDetails: (view: ServiceView) => void;
};

function hasCommand(view: ServiceView): boolean {
  return Boolean(view.command && view.command.trim());
}

export function ServiceTable({
  services,
  onStart,
  onStop,
  onRestart,
  onProbe,
  onOpenPage,
  onEdit,
  onDelete,
  onDetails,
}: ServiceTableProps) {
  const t = useT();
  const rows = [...services].sort(
    (a, b) => compareBySeverity(a.status.state, b.status.state) || a.name.localeCompare(b.name),
  );

  if (rows.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-xs text-muted-foreground">
        {t("table.empty")}
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("table.service")}</TableHead>
          <TableHead className="w-20">{t("table.port")}</TableHead>
          <TableHead className="w-32">{t("table.status")}</TableHead>
          <TableHead className="w-20">{t("table.pid")}</TableHead>
          <TableHead className="w-20">{t("table.latency")}</TableHead>
          <TableHead className="w-24">{t("table.uptime")}</TableHead>
          <TableHead className="w-24">{t("table.changed")}</TableHead>
          <TableHead className="w-52 text-right">{t("table.actions")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((view) => {
          const managed = hasCommand(view);
          return (
            <TableRow
              key={view.id}
              className="cursor-pointer"
              onClick={() => onDetails(view)}
              data-state={view.status.state}
            >
              <TableCell>
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{view.name}</span>
                    {view.risky ? <RiskyBadge /> : null}
                  </div>
                  <span className="max-w-72 truncate font-mono text-[11px] text-muted-foreground" title={view.command ?? view.id}>
                    {managed ? view.command : `${view.id} · ${t("table.monitorOnly")}`}
                  </span>
                </div>
              </TableCell>
              <TableCell className="font-mono">{view.port}</TableCell>
              <TableCell>
                <StatusBadge status={view.status} />
              </TableCell>
              <TableCell className="font-mono text-[11px] text-muted-foreground">
                {view.status.pid ?? "—"}
              </TableCell>
              <TableCell className="font-mono text-[11px]">
                {formatLatency(view.status.latencyMs)}
              </TableCell>
              <TableCell className="font-mono text-[11px]">
                {view.status.state === "healthy" ? formatUptime(view.status.uptimeMs) : "—"}
              </TableCell>
              <TableCell className="font-mono text-[11px] text-muted-foreground">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>{formatClock(view.status.sinceMs)}</span>
                  </TooltipTrigger>
                  <TooltipContent>{formatDateTime(view.status.sinceMs)}</TooltipContent>
                </Tooltip>
              </TableCell>
              <TableCell onClick={(event) => event.stopPropagation()}>
                <div className="flex items-center justify-end gap-0.5">
                  <ActionButton
                    label={t("action.start")}
                    disabled={!managed || !canStart(view.status.state)}
                    onClick={() => onStart(view)}
                  >
                    <Play />
                  </ActionButton>
                  <ActionButton
                    label={t("action.stop")}
                    disabled={!canStop(view.status.state)}
                    onClick={() => onStop(view)}
                  >
                    <CircleStop />
                  </ActionButton>
                  <ActionButton
                    label={t("action.restart")}
                    disabled={!managed}
                    onClick={() => onRestart(view)}
                  >
                    <RotateCw />
                  </ActionButton>
                  <ActionButton label={t("action.probe")} onClick={() => onProbe(view)}>
                    <Radar />
                  </ActionButton>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon-sm" variant="ghost" title={t("table.actions")}>
                        <Ellipsis />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => onDetails(view)}>
                        <Gauge />
                        {t("action.details")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onOpenPage(view)}>
                        <MonitorPlay />
                        {t("action.openPage")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onEdit(view)}>
                        <Pencil />
                        {t("action.edit")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onSelect={() => onDelete(view)}
                      >
                        <Trash />
                        {t("action.delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function ActionButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Button size="icon-sm" variant="ghost" disabled={disabled} aria-label={label} onClick={onClick}>
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
