import { useEffect, useState } from "react";
import { LoaderCircle, RotateCw, SquareArrowOutUpRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n-react";
import { normalizeUrl } from "@/format";
import type { PageTab } from "@/types";

type PageBarProps = {
  tab: PageTab;
  loading: boolean;
  onNavigate: (url: string) => void;
  onReload: () => void;
  onOpenExternal: () => void;
};

/** Address bar of the active page tab; sits above the child webview rect. */
export function PageBar({ tab, loading, onNavigate, onReload, onOpenExternal }: PageBarProps) {
  const t = useT();
  const [draft, setDraft] = useState(tab.url);

  useEffect(() => {
    setDraft(tab.url);
  }, [tab.label, tab.url]);

  const submit = () => {
    const url = normalizeUrl(draft);
    if (!url) return;
    onNavigate(url);
  };

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-background px-2">
      <Input
        value={draft}
        spellCheck={false}
        placeholder={t("tabs.urlPlaceholder")}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
        className="h-7 flex-1"
      />
      <Button size="sm" variant="outline" onClick={submit}>
        {t("tabs.go")}
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon-sm" variant="ghost" onClick={onReload}>
            {loading ? <LoaderCircle className="animate-spin" /> : <RotateCw />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("tabs.reload")}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="icon-sm" variant="ghost" onClick={onOpenExternal}>
            <SquareArrowOutUpRight />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("tabs.external")}</TooltipContent>
      </Tooltip>
    </div>
  );
}
