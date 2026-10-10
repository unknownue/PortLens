import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, FolderOpen, Plus, Trash2, TriangleAlert } from "lucide-react";
// Aliased: the component prop `open` shadows a plain `open` import.
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n-react";
import {
  HEADER_ISSUE_KEY,
  checkHeaderDrafts,
  draftKey,
  externalPageHost,
  headerDraftsFromPlain,
  headersFromDrafts,
  pageTitleForEditor,
  pageUrlForEditor,
  parseHttpUrl,
  type HeaderDraft,
} from "@/page";
import { isPortRisky, type PortEnv } from "@/status";
import {
  LOG_ENCODINGS,
  LOG_SOURCE_TYPES,
  PROBE_TYPES,
  asLogEncoding,
  asLogSource,
  asPageView,
  type LogEncoding,
  type LogSourceType,
  type PageConfig,
  type ProbeType,
  type ServiceDef,
} from "@/types";

const MIN_INTERVAL_MS = 200;
const MIN_TIMEOUT_MS = 1;
const MIN_THRESHOLD = 1;

/** Plaintext fetch state of `page.headers`; `failed` blocks submit (no masked write-back). */
type HeadersState = "ready" | "loading" | "failed";

function dropKey(source: Record<string, string>, key: string): Record<string, string> {
  if (!source[key]) return source;
  const next = { ...source };
  delete next[key];
  return next;
}

type ServiceDialogProps = {
  open: boolean;
  mode: "add" | "edit";
  /** Stable while the dialog is open; the form rehydrates when `open` flips true. */
  initial: ServiceDef;
  /**
   * Names of the headers the view reports as configured (masked values only reach us
   * as `••••••`, so the count is all we can trust). A failed plaintext fetch is only
   * fatal when this is non-empty.
   */
  maskedHeaders?: string[];
  env: PortEnv | null;
  onOpenChange: (open: boolean) => void;
  /** Resolves true when the backend accepted the definition. */
  onSubmit: (def: ServiceDef) => Promise<boolean>;
};

export function ServiceDialog({
  open,
  mode,
  initial,
  maskedHeaders = [],
  env,
  onOpenChange,
  onSubmit,
}: ServiceDialogProps) {
  const t = useT();
  const [name, setName] = useState(initial.name);
  const [port, setPort] = useState(String(initial.port));
  const [command, setCommand] = useState(initial.command ?? "");
  const [cwd, setCwd] = useState(initial.cwd ?? "");
  const [probe, setProbe] = useState<ProbeType>(
    (PROBE_TYPES as readonly string[]).includes(initial.health.type)
      ? (initial.health.type as ProbeType)
      : "tcp",
  );
  const [path, setPath] = useState(initial.health.path ?? "");
  const [probeCommand, setProbeCommand] = useState(initial.health.command ?? "");
  const [intervalMs, setIntervalMs] = useState(String(initial.health.intervalMs));
  const [timeoutMs, setTimeoutMs] = useState(String(initial.health.timeoutMs));
  const [threshold, setThreshold] = useState(String(initial.health.failureThreshold));
  const [logType, setLogType] = useState<LogSourceType>(asLogSource(initial.logSource).type);
  const [logPath, setLogPath] = useState(initial.logSource?.path ?? "");
  const [logEncoding, setLogEncoding] = useState<LogEncoding>(
    asLogEncoding(initial.logSource?.encoding),
  );
  const [pageUrl, setPageUrl] = useState("");
  const [pageTitle, setPageTitle] = useState("");
  const [headerDrafts, setHeaderDrafts] = useState<HeaderDraft[]>([]);
  const [headerErrors, setHeaderErrors] = useState<Record<string, string>>({});
  const [headersState, setHeadersState] = useState<HeadersState>("ready");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  /** Guards the async `get_page_config` result against a close or a retry. */
  const pageLoadSeq = useRef(0);

  const loadPageConfig = async (): Promise<void> => {
    const seq = ++pageLoadSeq.current;
    const fallback = asPageView(initial.page, initial.port);
    if (mode !== "edit" || !initial.id) {
      setPageUrl(pageUrlForEditor(fallback.url, initial.port));
      setPageTitle(pageTitleForEditor(fallback.title, initial.name));
      setHeaderDrafts([]);
      setErrors((prev) => dropKey(prev, "pageHeaders"));
      setHeadersState("ready");
      return;
    }
    setHeadersState("loading");
    try {
      // Plaintext on purpose: the masked view would write "••••••" back on save.
      const plain = await api.getPageConfig(initial.id);
      // A close (or a retry) while the command was in flight wins: no stale plaintext.
      if (seq !== pageLoadSeq.current) return;
      setPageUrl(pageUrlForEditor(plain.url ?? fallback.url, initial.port));
      setPageTitle(pageTitleForEditor(plain.title ?? fallback.title, initial.name));
      setHeaderDrafts(headerDraftsFromPlain(plain.headers));
      setErrors((prev) => dropKey(prev, "pageHeaders"));
      setHeadersState("ready");
    } catch {
      if (seq !== pageLoadSeq.current) return;
      // url/title are not secret, so the masked view still fills those in.
      setPageUrl(pageUrlForEditor(fallback.url, initial.port));
      setPageTitle(pageTitleForEditor(fallback.title, initial.name));
      setHeaderDrafts([]);
      setHeadersState(maskedHeaders.length > 0 ? "failed" : "ready");
    }
  };

  useEffect(() => {
    if (!open) {
      // Drop the plaintext header values from memory the moment the dialog closes.
      pageLoadSeq.current += 1;
      setHeaderDrafts([]);
      setHeaderErrors({});
      setHeadersState("ready");
      return;
    }
    setName(initial.name);
    setPort(String(initial.port));
    setCommand(initial.command ?? "");
    setCwd(initial.cwd ?? "");
    setProbe(
      (PROBE_TYPES as readonly string[]).includes(initial.health.type)
        ? (initial.health.type as ProbeType)
        : "tcp",
    );
    setPath(initial.health.path ?? "");
    setProbeCommand(initial.health.command ?? "");
    setIntervalMs(String(initial.health.intervalMs));
    setTimeoutMs(String(initial.health.timeoutMs));
    setThreshold(String(initial.health.failureThreshold));
    setLogType(asLogSource(initial.logSource).type);
    setLogPath(initial.logSource?.path ?? "");
    setLogEncoding(asLogEncoding(initial.logSource?.encoding));
    setHeaderErrors({});
    setErrors({});
    // Rehydrates the page block too: the header values only ever come from
    // `get_page_config` (plaintext), never from the masked list view.
    void loadPageConfig();
  }, [open, initial, mode, maskedHeaders]);

  const portNumber = Number.parseInt(port, 10);
  const risky = isPortRisky(portNumber, env);
  const headerTarget = externalPageHost(pageUrl);
  const portForHint = Number.isInteger(portNumber) && portNumber > 0 ? portNumber : initial.port;

  const patchHeader = (key: string, patch: Partial<HeaderDraft>) => {
    setHeaderDrafts((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    setHeaderErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const addHeader = () => {
    setHeaderDrafts((prev) => [...prev, { key: draftKey(prev.length), name: "", value: "", show: false }]);
  };

  const removeHeader = (key: string) => {
    setHeaderDrafts((prev) => prev.filter((row) => row.key !== key));
    setHeaderErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const browseLogPath = async () => {
    const current = logPath.trim();
    // A wildcard pattern is not a valid `defaultPath` for the system dialog.
    const seed = current && !/[*?]/.test(current) ? current : undefined;
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        title: t("service.logPath"),
        defaultPath: seed,
      });
      if (typeof picked === "string" && picked.trim()) setLogPath(picked);
    } catch {
      // Native dialog unavailable: keep whatever the user typed.
    }
  };

  const submit = async () => {
    const found: Record<string, string> = {};
    const intervalValue = Number.parseInt(intervalMs, 10);
    const timeoutValue = Number.parseInt(timeoutMs, 10);
    const thresholdValue = Number.parseInt(threshold, 10);

    if (!name.trim()) found.name = t("service.nameRequired");
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      found.port = t("service.portInvalid");
    }
    if (!Number.isInteger(intervalValue) || intervalValue < MIN_INTERVAL_MS) {
      found.interval = t("service.intervalInvalid", { min: MIN_INTERVAL_MS });
    }
    if (!Number.isInteger(timeoutValue) || timeoutValue < MIN_TIMEOUT_MS) {
      found.timeout = t("service.timeoutInvalid", { min: MIN_TIMEOUT_MS });
    }
    if (!Number.isInteger(thresholdValue) || thresholdValue < MIN_THRESHOLD) {
      found.threshold = t("service.thresholdInvalid", { min: MIN_THRESHOLD });
    }
    if (probe === "http" && !path.trim()) found.path = t("service.pathRequired");
    if (probe === "exec" && !probeCommand.trim()) found.command = t("service.commandRequired");
    if (logType === "file" && !logPath.trim()) found.logPath = t("service.logPathRequired");
    if (pageUrl.trim() && !parseHttpUrl(pageUrl)) found.pageUrl = t("service.pageUrlInvalid");
    // Saving while the plaintext is still unknown would wipe the configured headers.
    if (maskedHeaders.length > 0 && headersState !== "ready") {
      found.pageHeaders = t("service.pageHeadersLoadFailed");
    }

    // Rows are validated through the pure checker so the rules stay testable.
    const rowErrors: Record<string, string> = {};
    for (const check of checkHeaderDrafts(headerDrafts)) {
      const key = headerDrafts[check.index]?.key;
      if (key) rowErrors[key] = t(HEADER_ISSUE_KEY[check.issue], { name: check.name });
    }

    setErrors(found);
    setHeaderErrors(rowErrors);
    if (Object.keys(found).length > 0 || Object.keys(rowErrors).length > 0) return;

    const page: PageConfig = {
      url: pageUrl.trim() ? pageUrl.trim() : null,
      title: pageTitle.trim() ? pageTitle.trim() : null,
      // Blank rows (no name) were already reported or are deliberately ignored.
      headers: headersFromDrafts(headerDrafts),
    };

    const def: ServiceDef = {
      id: mode === "edit" ? initial.id : "",
      name: name.trim(),
      port: portNumber,
      command: command.trim() ? command.trim() : null,
      cwd: cwd.trim() ? cwd.trim() : null,
      health: {
        type: probe,
        path: path.trim() ? path.trim() : null,
        command: probeCommand.trim() ? probeCommand.trim() : null,
        intervalMs: intervalValue,
        timeoutMs: timeoutValue,
        failureThreshold: thresholdValue,
      },
      logSource:
        logType === "file"
          ? { type: "file", path: logPath.trim(), encoding: logEncoding }
          : { type: "process", path: null, encoding: null },
      page,
    };

    setBusy(true);
    const ok = await onSubmit(def);
    setBusy(false);
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="service-dialog">
        <DialogHeader>
          <DialogTitle>{mode === "add" ? t("service.addTitle") : t("service.editTitle")}</DialogTitle>
          <DialogDescription>{t("service.commandHint")}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t("service.name")} htmlFor="service-name" error={errors.name} className="col-span-1">
            <Input
              id="service-name"
              value={name}
              placeholder={t("service.namePlaceholder")}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <Field label={t("service.port")} htmlFor="service-port" error={errors.port}>
            <Input
              id="service-port"
              value={port}
              inputMode="numeric"
              onChange={(event) => setPort(event.target.value)}
            />
          </Field>

          {risky ? (
            <p className="col-span-2 flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">
              <TriangleAlert className="mt-px size-3.5 shrink-0" />
              {t("service.riskyWarning", { port: Number.isInteger(portNumber) ? portNumber : port })}
            </p>
          ) : null}

          <Field label={t("service.command")} htmlFor="service-command" className="col-span-2">
            <Input
              id="service-command"
              value={command}
              placeholder={t("service.commandPlaceholder")}
              spellCheck={false}
              onChange={(event) => setCommand(event.target.value)}
            />
          </Field>

          <Field label={t("service.cwd")} htmlFor="service-cwd" className="col-span-2">
            <Input
              id="service-cwd"
              value={cwd}
              placeholder={t("service.cwdPlaceholder")}
              spellCheck={false}
              onChange={(event) => setCwd(event.target.value)}
            />
          </Field>

          <Field label={t("service.probeType")}>
            <Select value={probe} onValueChange={(value) => setProbe(value as ProbeType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROBE_TYPES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`probe.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {probe === "http" ? (
            <Field label={t("service.probePath")} htmlFor="service-path" error={errors.path}>
              <Input
                id="service-path"
                value={path}
                placeholder="/health"
                spellCheck={false}
                onChange={(event) => setPath(event.target.value)}
              />
            </Field>
          ) : probe === "exec" ? (
            <Field
              label={t("service.probeCommand")}
              htmlFor="service-probe-command"
              error={errors.command}
              hint={t("service.probeCommandHint")}
            >
              <Input
                id="service-probe-command"
                value={probeCommand}
                spellCheck={false}
                onChange={(event) => setProbeCommand(event.target.value)}
              />
            </Field>
          ) : (
            <div className="hidden" />
          )}

          <Field
            label={t("service.logSource")}
            hint={t("service.logSourceHint")}
            className={logType === "file" ? undefined : "col-span-2"}
          >
            <Select value={logType} onValueChange={(value) => setLogType(value as LogSourceType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOG_SOURCE_TYPES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`logSource.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {logType === "file" ? (
            <Field
              label={t("service.logEncoding")}
              htmlFor="service-log-encoding"
              hint={t("service.logEncodingHint")}
            >
              <Select value={logEncoding} onValueChange={(value) => setLogEncoding(value as LogEncoding)}>
                <SelectTrigger id="service-log-encoding">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOG_ENCODINGS.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}

          {logType === "file" ? (
            <Field
              label={t("service.logPath")}
              htmlFor="service-log-path"
              error={errors.logPath}
              className="col-span-2"
            >
              <div className="flex items-center gap-2">
                <Input
                  id="service-log-path"
                  className="flex-1"
                  value={logPath}
                  placeholder={t("service.logPathPlaceholder")}
                  spellCheck={false}
                  onChange={(event) => setLogPath(event.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => void browseLogPath()}
                >
                  <FolderOpen />
                  {t("service.logPathBrowse")}
                </Button>
              </div>
            </Field>
          ) : null}

          {/* Page tab config: url / title / injected request headers (docs/CONTRACT.md §9). */}
          <section className="col-span-2 flex flex-col gap-3 rounded-md border border-border p-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("service.page")}
              </span>
              <p className="text-[11px] leading-tight text-muted-foreground">{t("service.pageHint")}</p>
            </div>

            <Field label={t("service.pageUrl")} htmlFor="service-page-url" error={errors.pageUrl}>
              <Input
                id="service-page-url"
                value={pageUrl}
                spellCheck={false}
                placeholder={t("service.pageUrlPlaceholder", { port: portForHint })}
                onChange={(event) => setPageUrl(event.target.value)}
              />
            </Field>

            {headerTarget ? (
              <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">
                <TriangleAlert className="mt-px size-3.5 shrink-0" />
                {t("service.pageExternalWarning", { host: headerTarget })}
              </p>
            ) : null}

            <Field label={t("service.pageTitle")} htmlFor="service-page-title">
              <Input
                id="service-page-title"
                value={pageTitle}
                spellCheck={false}
                placeholder={t("service.pageTitlePlaceholder")}
                onChange={(event) => setPageTitle(event.target.value)}
              />
            </Field>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  {t("service.pageHeaders")}
                </span>
                <Button size="sm" variant="outline" onClick={addHeader}>
                  <Plus />
                  {t("service.pageHeadersAdd")}
                </Button>
              </div>
              <p className="text-[11px] leading-tight text-muted-foreground">
                {t("service.pageHeadersHint")}
              </p>

              {headersState === "loading" ? (
                <p className="text-[11px] text-muted-foreground">{t("common.loading")}</p>
              ) : null}

              {errors.pageHeaders || headersState === "failed" ? (
                <p className="flex flex-wrap items-center gap-2 text-[11px] leading-tight text-destructive">
                  {t("service.pageHeadersLoadFailed")}
                  <Button size="sm" variant="outline" onClick={() => void loadPageConfig()}>
                    {t("service.pageHeadersRetry")}
                  </Button>
                </p>
              ) : null}

              {headerDrafts.length === 0 ? (
                headersState === "loading" ? null : (
                  <p className="text-[11px] text-muted-foreground">{t("service.pageHeadersEmpty")}</p>
                )
              ) : (
                <div className="flex flex-col gap-2">
                  {headerDrafts.map((row) => (
                    <div key={row.key} className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <Input
                          className="h-7 flex-1"
                          value={row.name}
                          spellCheck={false}
                          aria-label={t("service.headerName")}
                          placeholder={t("service.headerName")}
                          onChange={(event) => patchHeader(row.key, { name: event.target.value })}
                        />
                        <Input
                          className="h-7 flex-1"
                          // Password by default: the plaintext stays off screen until asked for.
                          type={row.show ? "text" : "password"}
                          autoComplete="off"
                          value={row.value}
                          spellCheck={false}
                          aria-label={t("service.headerValue")}
                          placeholder={t("service.headerValue")}
                          onChange={(event) => patchHeader(row.key, { value: event.target.value })}
                        />
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          title={row.show ? t("action.hide") : t("action.show")}
                          aria-label={row.show ? t("action.hide") : t("action.show")}
                          onClick={() => patchHeader(row.key, { show: !row.show })}
                        >
                          {row.show ? <EyeOff /> : <Eye />}
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          title={t("action.delete")}
                          aria-label={t("action.delete")}
                          onClick={() => removeHeader(row.key)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                      {headerErrors[row.key] ? (
                        <p className="text-[11px] leading-tight text-destructive">{headerErrors[row.key]}</p>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <Field label={t("service.intervalMs")} htmlFor="service-interval" error={errors.interval}>
            <Input
              id="service-interval"
              value={intervalMs}
              inputMode="numeric"
              onChange={(event) => setIntervalMs(event.target.value)}
            />
          </Field>

          <Field label={t("service.timeoutMs")} htmlFor="service-timeout" error={errors.timeout}>
            <Input
              id="service-timeout"
              value={timeoutMs}
              inputMode="numeric"
              onChange={(event) => setTimeoutMs(event.target.value)}
            />
          </Field>

          <Field label={t("service.failureThreshold")} htmlFor="service-threshold" error={errors.threshold}>
            <Input
              id="service-threshold"
              value={threshold}
              inputMode="numeric"
              onChange={(event) => setThreshold(event.target.value)}
            />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("action.cancel")}
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {t("action.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
