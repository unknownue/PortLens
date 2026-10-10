import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useT } from "@/lib/i18n-react";
import { cn } from "@/lib/utils";

type ForceOption = { checked: boolean; onChange: (checked: boolean) => void };

type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: string;
  confirmLabel?: string;
  destructive?: boolean;
  /** Renders the "force kill process tree" switch when provided. */
  force?: ForceOption;
  onConfirm: () => void;
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  destructive = true,
  force,
  onConfirm,
}: ConfirmDialogProps) {
  const t = useT();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>

        {force ? (
          <div className="flex flex-col gap-1 rounded-md border border-border bg-muted/40 p-2.5">
            <div className="flex items-center gap-2">
              <Switch id="confirm-force" checked={force.checked} onCheckedChange={force.onChange} />
              <Label htmlFor="confirm-force" className="text-xs font-medium">
                {t("confirm.force")}
              </Label>
            </div>
            <p className="text-[11px] leading-tight text-muted-foreground">{t("confirm.forceHint")}</p>
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel>{t("action.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className={cn(destructive && "bg-destructive text-destructive-foreground hover:bg-destructive/90")}
            onClick={onConfirm}
          >
            {confirmLabel ?? t("action.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
