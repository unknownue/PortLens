import { CircleStop, Languages, Moon, Play, Plus, RefreshCw, Settings, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n-react";
import { LANGUAGES } from "@/i18n";
import type { Language, Theme } from "@/types";

type ToolbarProps = {
  lang: Language;
  theme: Theme;
  /** Services that actually define a command; 0 disables "start all". */
  startable: number;
  onAdd: () => void;
  onStartAll: () => void;
  onStopAll: () => void;
  onRefresh: () => void;
  onLangChange: (lang: Language) => void;
  onThemeChange: (theme: Theme) => void;
  onOpenSettings: () => void;
};

export function Toolbar({
  lang,
  theme,
  startable,
  onAdd,
  onStartAll,
  onStopAll,
  onRefresh,
  onLangChange,
  onThemeChange,
  onOpenSettings,
}: ToolbarProps) {
  const t = useT();

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-background px-2">
      <Button size="sm" onClick={onAdd}>
        <Plus />
        {t("toolbar.add")}
      </Button>

      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button size="sm" variant="outline" disabled={startable === 0} onClick={onStartAll}>
              <Play />
              {t("toolbar.startAll")}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t("toolbar.startAllHint")}</TooltipContent>
      </Tooltip>

      <Button size="sm" variant="outline" onClick={onStopAll}>
        <CircleStop />
        {t("toolbar.stopAll")}
      </Button>

      <Separator orientation="vertical" className="mx-1 h-5" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label={t("toolbar.refresh")} onClick={onRefresh}>
            <RefreshCw />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("toolbar.refreshHint")}</TooltipContent>
      </Tooltip>

      <div className="flex-1" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost">
            <Languages />
            {lang === "zh" ? t("lang.zh") : t("lang.en")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{t("toolbar.language")}</DropdownMenuLabel>
          {LANGUAGES.map((item) => (
            <DropdownMenuCheckboxItem
              key={item}
              checked={lang === item}
              onCheckedChange={() => onLangChange(item)}
            >
              {item === "zh" ? t("lang.zh") : t("lang.en")}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" title={t("toolbar.theme")}>
            {theme === "dark" ? <Moon /> : <Sun />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{t("toolbar.theme")}</DropdownMenuLabel>
          <DropdownMenuCheckboxItem checked={theme === "dark"} onCheckedChange={() => onThemeChange("dark")}>
            {t("theme.dark")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={theme === "light"} onCheckedChange={() => onThemeChange("light")}>
            {t("theme.light")}
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button size="icon-sm" variant="ghost" title={t("toolbar.settings")} onClick={onOpenSettings}>
        <Settings />
      </Button>
    </div>
  );
}
