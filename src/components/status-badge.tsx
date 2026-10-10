import { ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n-react";
import { cn } from "@/lib/utils";
import { stateBadgeClass, stateDotClass, stateLabelKey } from "@/status";
import type { ServiceStatus } from "@/types";

/** Status pill: color by state, `detail` (the health-machine verdict) in the tooltip. */
export function StatusBadge({ status, className }: { status: ServiceStatus; className?: string }) {
  const t = useT();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge className={cn("gap-1", stateBadgeClass(status.state), className)}>
          <span className={cn("size-1.5 rounded-full", stateDotClass(status.state))} />
          {t(stateLabelKey(status.state))}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        {status.detail?.trim() ? status.detail : t("common.none")}
      </TooltipContent>
    </Tooltip>
  );
}

/** Shown when the port sits in the Windows dynamic range or a winnet exclusion. */
export function RiskyBadge() {
  const t = useT();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge className="gap-1 border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300">
          <ShieldAlert />
          {t("risk.badge")}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{t("risk.tooltip")}</TooltipContent>
    </Tooltip>
  );
}
