import type { ReactNode } from "react";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type FieldProps = {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  className?: string;
  children: ReactNode;
};

/** Label + control + one line of hint/error, shared by both dialogs. */
export function Field({ label, htmlFor, hint, error, className, children }: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p className="text-[11px] leading-tight text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-[11px] leading-tight text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
