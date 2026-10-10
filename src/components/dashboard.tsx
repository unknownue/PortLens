import { ServiceTable } from "@/components/service-table";
import { ListenerSection } from "@/components/listener-section";
import { useT } from "@/lib/i18n-react";
import type { ListenerView, ServiceView } from "@/types";

type DashboardProps = {
  services: ServiceView[];
  listeners: ListenerView[];
  onStart: (view: ServiceView) => void;
  onStop: (view: ServiceView) => void;
  onRestart: (view: ServiceView) => void;
  onProbe: (view: ServiceView) => void;
  onOpenPage: (view: ServiceView) => void;
  onOpenLogs: (view: ServiceView) => void;
  onEdit: (view: ServiceView) => void;
  onDelete: (view: ServiceView) => void;
  onDetails: (view: ServiceView) => void;
  onStopListener: (listener: ListenerView, force: boolean) => void;
};

export function Dashboard({
  services,
  listeners,
  onStart,
  onStop,
  onRestart,
  onProbe,
  onOpenPage,
  onOpenLogs,
  onEdit,
  onDelete,
  onDetails,
  onStopListener,
}: DashboardProps) {
  const t = useT();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border bg-card px-2.5 text-[11px] text-muted-foreground">
        <span>{t("common.total", { count: services.length })}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <ServiceTable
          services={services}
          onStart={onStart}
          onStop={onStop}
          onRestart={onRestart}
          onProbe={onProbe}
          onOpenPage={onOpenPage}
          onOpenLogs={onOpenLogs}
          onEdit={onEdit}
          onDelete={onDelete}
          onDetails={onDetails}
        />
      </div>

      <ListenerSection listeners={listeners} onStop={onStopListener} />
    </div>
  );
}
