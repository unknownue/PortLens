import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Toaster, toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Dashboard } from "@/components/dashboard";
import { DetailDrawer, type LogSink } from "@/components/detail-drawer";
import { NewTabDialog } from "@/components/new-tab-dialog";
import { PageBar } from "@/components/page-bar";
import { ServiceDialog } from "@/components/service-dialog";
import { SettingsDialog } from "@/components/settings-dialog";
import { TabStrip } from "@/components/tab-strip";
import { TitleBar } from "@/components/title-bar";
import { Toolbar } from "@/components/toolbar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { serviceUrl, titleFromUrl } from "@/format";
import { translate } from "@/i18n";
import { api, errorText, mergeStatuses, rectOf } from "@/lib/api";
import { I18nProvider, type TranslateFn } from "@/lib/i18n-react";
import { setWindowTheme } from "@/lib/shell";
import {
  DEFAULT_SETTINGS,
  asLanguage,
  asTheme,
  blankService,
  type EnvView,
  type Language,
  type ListenerView,
  type LogPayload,
  type Notice,
  type PageLoadPayload,
  type PageTab,
  type ServiceDef,
  type ServiceStatus,
  type ServiceView,
  type Settings,
  type Theme,
} from "@/types";

/** localStorage key remembering which page tab was active across restarts. */
const REMEMBERED_ACTIVE_KEY = "portlens.lastActiveUrl";

export default function App() {
  const [services, setServices] = useState<ServiceView[]>([]);
  const [listeners, setListeners] = useState<ListenerView[]>([]);
  const [env, setEnv] = useState<EnvView | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [tabs, setTabs] = useState<PageTab[]>([]);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [detailId, setDetailId] = useState<string | null>(null);
  const [serviceDialog, setServiceDialog] = useState<{ mode: "add" | "edit"; def: ServiceDef } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newTabOpen, setNewTabOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ServiceView | null>(null);
  const [stopAllOpen, setStopAllOpen] = useState(false);
  const [stopAllForce, setStopAllForce] = useState(false);

  const lang = asLanguage(settings.language);
  const theme = asTheme(settings.theme);
  const t = useMemo<TranslateFn>(() => (key, params) => translate(lang, key, params), [lang]);
  const tRef = useRef(t);
  tRef.current = t;

  // The content region is the geometry source for every child webview rect.
  const contentRef = useRef<HTMLDivElement | null>(null);
  const logSinkRef = useRef<LogSink | null>(null);

  const activeTab = tabs.find((tab) => tab.label === activeLabel) ?? null;
  const activeTabRef = useRef<PageTab | null>(null);
  const service = services.find((item) => item.id === detailId) ?? null;
  const startable = services.filter((item) => Boolean(item.command && item.command.trim())).length;
  const overlayOpen =
    settingsOpen ||
    newTabOpen ||
    stopAllOpen ||
    pendingDelete !== null ||
    serviceDialog !== null ||
    detailId !== null;

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    void setWindowTheme(theme);
  }, [theme]);

  const registerLogSink = useCallback((sink: LogSink | null) => {
    logSinkRef.current = sink;
  }, []);

  const syncBounds = useCallback(async (label: string) => {
    const rect = rectOf(contentRef.current);
    if (!rect) return;
    try {
      await api.setPageBounds(label, rect);
    } catch {
      // The view disappeared between activation and resize; nothing to sync.
    }
  }, []);

  const createPage = useCallback(
    async (url: string, title?: string) => {
      const rect = rectOf(contentRef.current);
      if (!rect) {
        toast.error(tRef.current("toast.noBounds"));
        return;
      }
      try {
        const tab = await api.openPage(url, title?.trim() || titleFromUrl(url), rect);
        setTabs((prev) => [...prev, tab]);
        setActiveLabel(tab.label);
      } catch (error) {
        toast.error(tRef.current("toast.failed", { message: errorText(error) }));
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    try {
      const [views, listenerViews] = await Promise.all([api.getServices(), api.listListeners()]);
      setServices(views);
      setListeners(listenerViews);
    } catch (error) {
      toast.error(tRef.current("toast.failed", { message: errorText(error) }));
    }
  }, []);

  // Snapshot + subscribe + restore saved tabs. No StrictMode (see main.tsx), so this
  // runs exactly once; unlisten handles are drained on unmount.
  useEffect(() => {
    let disposed = false;
    const unlisten: UnlistenFn[] = [];

    const track = async (pending: Promise<UnlistenFn>) => {
      try {
        const off = await pending;
        if (disposed) off();
        else unlisten.push(off);
      } catch {
        // Event bridge unavailable: the snapshot still renders, live updates do not.
      }
    };

    const restorePages = async (saved: PageTab[]) => {
      if (saved.length === 0) return;
      const rect = rectOf(contentRef.current);
      if (!rect) {
        toast.error(tRef.current("toast.noBounds"));
        return;
      }
      const restored: PageTab[] = [];
      for (const tab of saved) {
        try {
          restored.push(await api.openPage(tab.url, tab.title, rect));
        } catch (error) {
          toast.error(tRef.current("toast.failed", { message: errorText(error) }));
        }
      }
      if (disposed) return;
      setTabs(restored);
      // `take_saved_pages` clears the backend's active label and `open_page` activates
      // the last restored tab, so the previously active tab is matched by URL from the
      // locally remembered value; without a match the dashboard wins.
      let remembered: string | null = null;
      try {
        remembered = window.localStorage.getItem(REMEMBERED_ACTIVE_KEY);
      } catch {
        remembered = null;
      }
      const match = remembered ? restored.find((tab) => tab.url === remembered) : undefined;
      setActiveLabel(match ? match.label : null);
    };

    void (async () => {
      try {
        const [views, listenerViews, loadedSettings, environment, saved] = await Promise.all([
          api.getServices(),
          api.listListeners(),
          api.getSettings(),
          api.getEnvironment(),
          api.takeSavedPages(),
        ]);
        if (disposed) return;
        setServices(views);
        setListeners(listenerViews);
        setSettings(loadedSettings);
        setEnv(environment);
        await restorePages(saved);
      } catch (error) {
        toast.error(tRef.current("toast.failed", { message: errorText(error) }));
      }
    })();

    void track(
      listen<ServiceStatus[]>("port-status", (event) => {
        setServices((prev) => mergeStatuses(prev, event.payload));
      }),
    );
    void track(
      listen<ListenerView[]>("listener-status", (event) => {
        setListeners(event.payload);
      }),
    );
    void track(
      listen<LogPayload>("service-log", (event) => {
        logSinkRef.current?.(event.payload.id, event.payload.lines);
      }),
    );
    void track(
      listen<PageLoadPayload>("page-load", (event) => {
        const { label, phase } = event.payload;
        setLoading((prev) => ({ ...prev, [label]: phase === "started" }));
      }),
    );
    void track(
      listen<Notice>("notice", (event) => {
        const { level, code, detail } = event.payload;
        const prefix =
          level === "error"
            ? tRef.current("notice.error")
            : level === "warn"
              ? tRef.current("notice.warn")
              : tRef.current("notice.info");
        const message = detail?.trim() ? `${detail} (${code})` : code;
        const text = `${prefix}: ${message}`;
        if (level === "error") toast.error(text);
        else if (level === "warn") toast.warning(text);
        else toast.message(text);
      }),
    );

    return () => {
      disposed = true;
      for (const off of unlisten) off();
    };
  }, []);

  // Activate the front page view (or hide every child view for the dashboard) and keep
  // its rect in sync with the content container.
  useEffect(() => {
    let cancelled = false;

    if (activeLabel === null) {
      void api.activatePage(null).catch(() => undefined);
      return;
    }

    void (async () => {
      try {
        await api.activatePage(activeLabel);
      } catch (error) {
        toast.error(tRef.current("toast.failed", { message: errorText(error) }));
        return;
      }
      if (!cancelled) await syncBounds(activeLabel);
    })();

    const element = contentRef.current;
    const observer = new ResizeObserver(() => void syncBounds(activeLabel));
    if (element) observer.observe(element);
    const onResize = () => void syncBounds(activeLabel);
    window.addEventListener("resize", onResize);

    return () => {
      cancelled = true;
      observer.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [activeLabel, syncBounds]);

  // Modals and the drawer are HTML inside the main webview, so every native child view
  // must hide while they are open, then come back on close.
  useEffect(() => {
    if (!overlayOpen) return;
    void api.activatePage(null).catch(() => undefined);
    return () => {
      const tab = activeTabRef.current;
      if (!tab) return;
      void (async () => {
        try {
          await api.activatePage(tab.label);
          await syncBounds(tab.label);
        } catch {
          // View closed in the meantime.
        }
      })();
    };
  }, [overlayOpen, syncBounds]);

  useEffect(() => {
    try {
      if (activeTab) window.localStorage.setItem(REMEMBERED_ACTIVE_KEY, activeTab.url);
      else window.localStorage.removeItem(REMEMBERED_ACTIVE_KEY);
    } catch {
      // Storage unavailable; restore falls back to the dashboard.
    }
  }, [activeTab]);

  const fail = (error: unknown) => toast.error(tRef.current("toast.failed", { message: errorText(error) }));

  const startService = async (view: ServiceView) => {
    try {
      const updated = await api.startService(view.id);
      setServices((prev) => mergeStatuses(prev, [updated.status]));
      toast.success(t("toast.started", { name: view.name }));
    } catch (error) {
      fail(error);
    }
  };

  const stopService = async (view: ServiceView, force = false) => {
    try {
      const updated = await api.stopService(view.id, force);
      setServices((prev) => mergeStatuses(prev, [updated.status]));
      toast.success(t("toast.stopped", { name: view.name }));
    } catch (error) {
      fail(error);
    }
  };

  const restartService = async (view: ServiceView) => {
    try {
      const updated = await api.restartService(view.id);
      setServices((prev) => mergeStatuses(prev, [updated.status]));
      toast.success(t("toast.restarted", { name: view.name }));
    } catch (error) {
      fail(error);
    }
  };

  const probeService = async (view: ServiceView) => {
    try {
      const updated = await api.probeNow(view.id);
      setServices((prev) => mergeStatuses(prev, [updated.status]));
      toast.success(t("toast.probed", { name: view.name }));
    } catch (error) {
      fail(error);
    }
  };

  const submitService = async (def: ServiceDef): Promise<boolean> => {
    const mode = serviceDialog?.mode ?? "add";
    try {
      const views = mode === "edit" ? await api.updateService(def) : await api.addService(def);
      setServices(views);
      toast.success(
        mode === "edit" ? t("toast.saved", { name: def.name }) : t("toast.added", { name: def.name }),
      );
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };

  const removeService = async (view: ServiceView) => {
    try {
      const views = await api.removeService(view.id);
      setServices(views);
      setDetailId((prev) => (prev === view.id ? null : prev));
      toast.success(t("toast.removed", { name: view.name }));
    } catch (error) {
      fail(error);
    }
  };

  const stopAll = async () => {
    try {
      const views = await api.stopAllServices(stopAllForce);
      setServices(views);
      toast.success(t("toast.stoppedAll"));
    } catch (error) {
      fail(error);
    }
  };

  const stopListener = async (listener: ListenerView, force: boolean) => {
    try {
      await api.stopPid(listener.pid, force);
      toast.success(t("toast.listenerStopped", { pid: listener.pid }));
      window.setTimeout(() => void refresh(), 400);
    } catch (error) {
      fail(error);
    }
  };

  const saveSettings = async (next: Settings): Promise<boolean> => {
    try {
      const saved = await api.saveSettings(next);
      setSettings(saved);
      toast.success(t("settings.saved"));
      return true;
    } catch (error) {
      toast.error(t("settings.saveFailed", { message: errorText(error) }));
      return false;
    }
  };

  const importPreset = async () => {
    const before = services.length;
    try {
      const views = await api.importPreset();
      setServices(views);
      toast.success(t("toast.presetImported", { count: Math.max(views.length - before, 0) }));
    } catch (error) {
      fail(error);
    }
  };

  const applyPreferences = (patch: Partial<Settings>) => {
    const next: Settings = { ...settings, ...patch };
    setSettings(next);
    void api.saveSettings(next).catch(() => undefined);
  };

  const closePage = async (label: string) => {
    try {
      await api.closePage(label);
      setTabs((prev) => prev.filter((tab) => tab.label !== label));
      setLoading((prev) => {
        const next = { ...prev };
        delete next[label];
        return next;
      });
      setActiveLabel((prev) => (prev === label ? null : prev));
    } catch (error) {
      fail(error);
    }
  };

  const renamePage = async (label: string, title: string) => {
    setTabs((prev) => prev.map((tab) => (tab.label === label ? { ...tab, title } : tab)));
    try {
      await api.renamePage(label, title);
    } catch (error) {
      fail(error);
    }
  };

  const navigatePage = async (label: string, url: string) => {
    setTabs((prev) => prev.map((tab) => (tab.label === label ? { ...tab, url } : tab)));
    try {
      await api.navigatePage(label, url);
    } catch (error) {
      fail(error);
    }
  };

  const reloadPage = async (label: string) => {
    try {
      await api.reloadPage(label);
    } catch (error) {
      fail(error);
    }
  };

  const openExternal = async (url: string) => {
    try {
      await openUrl(url);
    } catch (error) {
      fail(error);
    }
  };

  const selectTab = (label: string | null) => {
    // Overlays would be painted under a native child view, so leave them first.
    setDetailId(null);
    setSettingsOpen(false);
    setNewTabOpen(false);
    setActiveLabel(label);
  };

  const defaultNewTabUrl = services.length > 0 ? serviceUrl(services[0].port) : "";

  return (
    <I18nProvider lang={lang}>
      <TooltipProvider delayDuration={200}>
        <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
          <TitleBar />
          <Toolbar
            lang={lang}
            theme={theme}
            startable={startable}
            onAdd={() => setServiceDialog({ mode: "add", def: blankService() })}
            onStartAll={() => {
              for (const view of services) {
                if (view.command && view.command.trim()) void startService(view);
              }
            }}
            onStopAll={() => {
              setStopAllForce(false);
              setStopAllOpen(true);
            }}
            onRefresh={() => void refresh()}
            onLangChange={(value: Language) => applyPreferences({ language: value })}
            onThemeChange={(value: Theme) => applyPreferences({ theme: value })}
            onOpenSettings={() => setSettingsOpen(true)}
          />
          <TabStrip
            tabs={tabs}
            active={activeLabel}
            loading={loading}
            onSelect={selectTab}
            onClose={(label) => void closePage(label)}
            onRename={(label, title) => void renamePage(label, title)}
            onNew={() => setNewTabOpen(true)}
          />
          {activeTab ? (
            <PageBar
              tab={activeTab}
              loading={loading[activeTab.label] === true}
              onNavigate={(url) => void navigatePage(activeTab.label, url)}
              onReload={() => void reloadPage(activeTab.label)}
              onOpenExternal={() => void openExternal(activeTab.url)}
            />
          ) : null}

          <div className="relative min-h-0 flex-1">
            {/* Geometry probe for `open_page` / `set_page_bounds`; never interactive. */}
            <div ref={contentRef} className="pointer-events-none absolute inset-0" />
            {activeTab ? (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                {t("common.loading")}
              </div>
            ) : (
              <div className="absolute inset-0 flex flex-col">
                <Dashboard
                  services={services}
                  listeners={listeners}
                  onStart={(view) => void startService(view)}
                  onStop={(view) => void stopService(view)}
                  onRestart={(view) => void restartService(view)}
                  onProbe={(view) => void probeService(view)}
                  onOpenPage={(view) => void createPage(serviceUrl(view.port), view.name)}
                  onEdit={(view) =>
                    setServiceDialog({
                      mode: "edit",
                      def: {
                        id: view.id,
                        name: view.name,
                        port: view.port,
                        command: view.command ?? null,
                        cwd: view.cwd ?? null,
                        health: { ...view.health },
                      },
                    })
                  }
                  onDelete={(view) => setPendingDelete(view)}
                  onDetails={(view) => setDetailId(view.id)}
                  onStopListener={(listener, force) => void stopListener(listener, force)}
                />
              </div>
            )}
          </div>
        </div>

        <ServiceDialog
          open={serviceDialog !== null}
          mode={serviceDialog?.mode ?? "add"}
          initial={serviceDialog?.def ?? blankService()}
          env={env}
          onOpenChange={(open) => {
            if (!open) setServiceDialog(null);
          }}
          onSubmit={submitService}
        />

        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          settings={settings}
          env={env}
          onSave={saveSettings}
          onImportPreset={importPreset}
        />

        <NewTabDialog
          open={newTabOpen}
          onOpenChange={setNewTabOpen}
          defaultUrl={defaultNewTabUrl}
          onSubmit={(url) => void createPage(url)}
        />

        <DetailDrawer
          service={service}
          open={service !== null}
          onOpenChange={(open) => {
            if (!open) setDetailId(null);
          }}
          registerLogSink={registerLogSink}
          onClearLogs={async (id) => {
            try {
              await api.clearServiceLogs(id);
            } catch (error) {
              fail(error);
            }
          }}
        />

        <ConfirmDialog
          open={pendingDelete !== null}
          onOpenChange={(open) => {
            if (!open) setPendingDelete(null);
          }}
          title={t("service.deleteTitle")}
          body={t("service.deleteBody", { name: pendingDelete?.name ?? "" })}
          confirmLabel={t("action.delete")}
          onConfirm={() => {
            if (pendingDelete) void removeService(pendingDelete);
            setPendingDelete(null);
          }}
        />

        <ConfirmDialog
          open={stopAllOpen}
          onOpenChange={setStopAllOpen}
          title={t("toolbar.stopAllTitle")}
          body={t("toolbar.stopAllBody")}
          confirmLabel={t("toolbar.stopAll")}
          force={{ checked: stopAllForce, onChange: setStopAllForce }}
          onConfirm={() => void stopAll()}
        />

        <Toaster position="top-center" richColors closeButton />
      </TooltipProvider>
    </I18nProvider>
  );
}
