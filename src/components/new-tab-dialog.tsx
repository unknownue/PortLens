import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/field";
import { Input } from "@/components/ui/input";
import { normalizeUrl } from "@/format";
import { useT } from "@/lib/i18n-react";

type NewTabDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultUrl: string;
  onSubmit: (url: string) => void;
};

export function NewTabDialog({ open, onOpenChange, defaultUrl, onSubmit }: NewTabDialogProps) {
  const t = useT();
  const [url, setUrl] = useState(defaultUrl);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setUrl(defaultUrl);
    setError("");
  }, [open, defaultUrl]);

  const submit = () => {
    const normalized = normalizeUrl(url);
    if (!normalized) {
      setError(t("tabs.urlInvalid"));
      return;
    }
    onOpenChange(false);
    onSubmit(normalized);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("tabs.newTitle")}</DialogTitle>
          <DialogDescription>{t("tabs.newHint")}</DialogDescription>
        </DialogHeader>

        <Field label={t("tabs.open")} htmlFor="new-tab-url" error={error}>
          <Input
            id="new-tab-url"
            autoFocus
            value={url}
            spellCheck={false}
            placeholder={t("tabs.urlPlaceholder")}
            onChange={(event) => {
              setUrl(event.target.value);
              setError("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
        </Field>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("action.cancel")}
          </Button>
          <Button onClick={submit}>{t("tabs.open")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
