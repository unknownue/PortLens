import { useEffect, useState } from "react";
import { EthernetPort, Maximize2, Minus, Square, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n-react";
import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  toggleMaximizeWindow,
} from "@/lib/shell";
import { cn } from "@/lib/utils";

// Frameless window chrome. `decorations: false` in tauri.conf.json, so the drag
// region and the three buttons are the only window controls.
export function TitleBar() {
  const t = useT();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    void isWindowMaximized().then((value) => {
      if (alive) setMaximized(value);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div
      data-tauri-drag-region
      className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-card select-none"
    >
      <div data-tauri-drag-region className="pointer-events-none flex h-full flex-1 items-center gap-2 pl-3">
        <EthernetPort className="size-3.5 text-primary" />
        <span className="text-xs font-semibold tracking-wide">{t("app.title")}</span>
        <span className="text-[11px] text-muted-foreground">{t("app.tagline")}</span>
      </div>
      <div className="flex h-full items-stretch">
        <Button
          variant="ghost"
          size="icon"
          className="h-full w-11 rounded-none"
          title={t("window.minimize")}
          aria-label={t("window.minimize")}
          onClick={() => void minimizeWindow()}
        >
          <Minus />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-full w-11 rounded-none"
          title={maximized ? t("window.restore") : t("window.maximize")}
          aria-label={maximized ? t("window.restore") : t("window.maximize")}
          onClick={() => void toggleMaximizeWindow().then(setMaximized)}
        >
          {maximized ? <Square className="size-3" /> : <Maximize2 className="size-3" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn("h-full w-11 rounded-none hover:bg-destructive hover:text-destructive-foreground")}
          title={t("window.close")}
          aria-label={t("window.close")}
          onClick={() => void closeWindow()}
        >
          <X />
        </Button>
      </div>
    </div>
  );
}
