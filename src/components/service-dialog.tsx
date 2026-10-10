import { useEffect, useState } from "react";
import { FolderOpen, TriangleAlert } from "lucide-react";
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
import { useT } from "@/lib/i18n-react";
import { isPortRisky, type PortEnv } from "@/status";
import {
  LOG_ENCODINGS,
  LOG_SOURCE_TYPES,
  PROBE_TYPES,
  asLogEncoding,
  asLogSource,
  type LogEncoding,
  type LogSourceType,
  type ProbeType,
  type ServiceDef,
} from "@/types";

const MIN_INTERVAL_MS = 200;
const MIN_TIMEOUT_MS = 1;
const MIN_THRESHOLD = 1;

type ServiceDialogProps = {
  open: boolean;
  mode: "add" | "edit";
  /** Stable while the dialog is open; the form rehydrates when `open` flips true. */
  initial: ServiceDef;
  env: PortEnv | null;
  onOpenChange: (open: boolean) => void;
  /** Resolves true when the backend accepted the definition. */
  onSubmit: (def: ServiceDef) => Promise<boolean>;
};

export function ServiceDialog({ open, mode, initial, env, onOpenChange, onSubmit }: ServiceDialogProps) {
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
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
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
    setErrors({});
  }, [open, initial]);

  const portNumber = Number.parseInt(port, 10);
  const risky = isPortRisky(portNumber, env);

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

    setErrors(found);
    if (Object.keys(found).length > 0) return;

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
    };

    setBusy(true);
    const ok = await onSubmit(def);
    setBusy(false);
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
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
