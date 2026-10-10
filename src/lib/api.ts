// Typed wrappers around the frozen Tauri command surface (docs/CONTRACT.md).
// Tauri maps JS camelCase argument keys to the Rust snake_case parameters.

import { invoke } from "@tauri-apps/api/core";

import type {
  EnvView,
  ListenerView,
  NoticeLevel,
  LogTab,
  PageConfigPlain,
  PageTab,
  Rect,
  ServiceDef,
  ServiceStatus,
  ServiceView,
  Settings,
} from "@/types";

export const api = {
  getServices: () => invoke<ServiceView[]>("get_services"),
  addService: (service: ServiceDef) => invoke<ServiceView[]>("add_service", { service }),
  updateService: (service: ServiceDef) => invoke<ServiceView[]>("update_service", { service }),
  removeService: (id: string) => invoke<ServiceView[]>("remove_service", { id }),
  startService: (id: string) => invoke<ServiceView>("start_service", { id }),
  stopService: (id: string, force: boolean) => invoke<ServiceView>("stop_service", { id, force }),
  restartService: (id: string) => invoke<ServiceView>("restart_service", { id }),
  stopAllServices: (force: boolean) => invoke<ServiceView[]>("stop_all_services", { force }),
  probeNow: (id: string) => invoke<ServiceView>("probe_now", { id }),
  getServiceLogs: (id: string, limit: number) => invoke<string[]>("get_service_logs", { id, limit }),
  clearServiceLogs: (id: string) => invoke<void>("clear_service_logs", { id }),
  listListeners: () => invoke<ListenerView[]>("list_listeners"),
  stopPid: (pid: number, force: boolean) => invoke<void>("stop_pid", { pid, force }),
  getEnvironment: () => invoke<EnvView>("get_environment"),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
  importPreset: () => invoke<ServiceView[]>("import_preset"),
  listPages: () => invoke<PageTab[]>("list_pages"),
  takeSavedPages: () => invoke<PageTab[]>("take_saved_pages"),
  /** Log tab identities; unlike `take_saved_pages` this does not clear them. */
  listLogTabs: () => invoke<LogTab[]>("list_log_tabs"),
  saveLogTabs: (tabs: LogTab[]) => invoke<void>("save_log_tabs", { tabs }),
  openPage: (url: string, title: string, rect: Rect) =>
    invoke<PageTab>("open_page", { url, title, ...rect }),
  /** Opens the service's configured page and injects its `page.headers`. */
  openServicePage: (id: string, rect: Rect) => invoke<PageTab>("open_service_page", { id, ...rect }),
  /** Plaintext page config, for prefilling the edit dialog only. */
  getPageConfig: (id: string) => invoke<PageConfigPlain>("get_page_config", { id }),
  /** Plaintext of a single header, only when the user asks to reveal or copy it. */
  revealPageHeader: (id: string, name: string) =>
    invoke<string>("reveal_page_header", { id, name }),
  closePage: (label: string) => invoke<void>("close_page", { label }),
  /** `null` hides every child page view and shows the dashboard. */
  activatePage: (label: string | null) => invoke<void>("activate_page", { label }),
  setPageBounds: (label: string, rect: Rect) =>
    invoke<void>("set_page_bounds", { label, ...rect }),
  navigatePage: (label: string, url: string) => invoke<void>("navigate_page", { label, url }),
  reloadPage: (label: string) => invoke<void>("reload_page", { label }),
  renamePage: (label: string, title: string) => invoke<void>("rename_page", { label, title }),
  notice: (level: NoticeLevel, code: string, detail: string) =>
    invoke<void>("notice", { level, code, detail }),
};

/** Error values from `invoke` are plain strings; keep them readable in toasts. */
export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/** Non-null status replacement keyed by service id; order of `prev` is preserved. */
export function mergeStatuses(prev: ServiceView[], incoming: ServiceStatus[]): ServiceView[] {
  if (incoming.length === 0) return prev;
  const byId = new Map(incoming.map((status) => [status.id, status]));
  let changed = false;
  const next = prev.map((view) => {
    const status = byId.get(view.id);
    if (!status || status === view.status) return view;
    changed = true;
    return { ...view, status };
  });
  return changed ? next : prev;
}

/** Content-container rect in logical pixels, ready for `open_page` / `set_page_bounds`. */
export function rectOf(element: Element | null): Rect | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
  };
}
