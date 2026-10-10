import { useEffect, useState } from "react";
import { Check, Copy, Package } from "lucide-react";

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
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { copyText } from "@/lib/clipboard";
import { useT } from "@/lib/i18n-react";
import { LANGUAGES } from "@/i18n";
import { toast } from "sonner";
import type { EnvView, Language, Settings, Theme } from "@/types";

type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
  env: EnvView | null;
  /** Resolves true when the backend persisted the settings. */
  onSave: (settings: Settings) => Promise<boolean>;
  onImportPreset: () => Promise<void>;
};

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  env,
  onSave,
  onImportPreset,
}: SettingsDialogProps) {
  const t = useT();
  const [pollInterval, setPollInterval] = useState(String(settings.pollIntervalMs));
  const [language, setLanguage] = useState<Language>(settings.language === "en" ? "en" : "zh");
  const [theme, setTheme] = useState<Theme>(settings.theme === "light" ? "light" : "dark");
  const [stopOnExit, setStopOnExit] = useState(settings.stopManagedOnExit);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPollInterval(String(settings.pollIntervalMs));
    setLanguage(settings.language === "en" ? "en" : "zh");
    setTheme(settings.theme === "light" ? "light" : "dark");
    setStopOnExit(settings.stopManagedOnExit);
  }, [open, settings]);

  const copy = async (value: string) => {
    const ok = await copyText(value);
    if (ok) toast.success(t("action.copied"));
    else toast.error(t("toast.copyFailed", { message: value }));
  };

  const submit = async () => {
    const parsed = Number.parseInt(pollInterval, 10);
    const next: Settings = {
      pollIntervalMs: Number.isInteger(parsed) && parsed >= 200 ? parsed : settings.pollIntervalMs,
      language,
      theme,
      stopManagedOnExit: stopOnExit,
    };
    setBusy(true);
    const ok = await onSave(next);
    setBusy(false);
    if (ok) onOpenChange(false);
  };

  const excluded = env && env.excluded.length > 0
    ? env.excluded.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(", ")
    : t("settings.excludedNone");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="settings-dialog">
        <DialogHeader>
          <DialogTitle>{t("settings.title")}</DialogTitle>
          <DialogDescription>{t("settings.importPresetHint")}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t("settings.pollInterval")} htmlFor="settings-poll">
            <Input
              id="settings-poll"
              value={pollInterval}
              inputMode="numeric"
              onChange={(event) => setPollInterval(event.target.value)}
            />
          </Field>

          <Field label={t("settings.language")}>
            <Select value={language} onValueChange={(value) => setLanguage(value as Language)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item === "zh" ? t("lang.zh") : t("lang.en")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label={t("settings.theme")}>
            <Select value={theme} onValueChange={(value) => setTheme(value as Theme)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dark">{t("theme.dark")}</SelectItem>
                <SelectItem value="light">{t("theme.light")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <div className="flex flex-col justify-center gap-1.5 pt-4">
            <div className="flex items-center gap-2">
              <Switch id="settings-stop-exit" checked={stopOnExit} onCheckedChange={setStopOnExit} />
              <Label htmlFor="settings-stop-exit">{t("settings.stopManagedOnExit")}</Label>
            </div>
            <p className="text-[11px] leading-tight text-muted-foreground">
              {t("settings.stopManagedOnExitHint")}
            </p>
          </div>
        </div>

        <Separator />

        <div className="flex flex-col gap-2">
          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {t("settings.paths")}
          </Label>
          <PathRow
            label={t("settings.manifestPath")}
            value={env?.manifestPath ?? ""}
            copyLabel={t("action.copy")}
            onCopy={copy}
          />
          <PathRow
            label={t("settings.dataDir")}
            value={env?.dataDir ?? ""}
            copyLabel={t("action.copy")}
            onCopy={copy}
          />
        </div>

        <Separator />

        <div className="flex flex-col gap-1.5">
          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {t("settings.env")}
          </Label>
          <div className="grid grid-cols-3 gap-2 text-[11px] text-muted-foreground">
            <span>
              {t("settings.dynamicStart")}: <span className="text-foreground">{env?.dynamicStart ?? "—"}</span>
            </span>
            <span>
              {t("settings.dynamicCount")}: <span className="text-foreground">{env?.dynamicCount ?? "—"}</span>
            </span>
            <span className="col-span-3 truncate" title={excluded}>
              {t("settings.excluded")}: <span className="text-foreground">{excluded}</span>
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="mt-1 self-start"
            onClick={() => void onImportPreset()}
          >
            <Package />
            {t("settings.importPreset")}
          </Button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("action.cancel")}
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            <Check />
            {t("action.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PathRow({
  label,
  value,
  copyLabel,
  onCopy,
}: {
  label: string;
  value: string;
  copyLabel: string;
  onCopy: (value: string) => Promise<void>;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <Input readOnly value={value} className="h-7 flex-1 font-mono text-[11px]" />
      <Button
        size="icon-sm"
        variant="ghost"
        title={copyLabel}
        aria-label={copyLabel}
        disabled={!value}
        onClick={() => void onCopy(value)}
      >
        <Copy />
      </Button>
    </div>
  );
}
