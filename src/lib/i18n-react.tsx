// React binding for the pure dictionaries in src/i18n.ts.

import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";

import { translate, type I18nKey } from "@/i18n";
import type { Language } from "@/types";

export type TranslateFn = (key: I18nKey, params?: Record<string, string | number>) => string;

type I18nValue = { lang: Language; t: TranslateFn };

const fallback: I18nValue = {
  lang: "zh",
  t: (key, params) => translate("zh", key, params),
};

const I18nContext = createContext<I18nValue>(fallback);

export function I18nProvider({ lang, children }: { lang: Language; children: ReactNode }) {
  const value = useMemo<I18nValue>(
    () => ({ lang, t: (key, params) => translate(lang, key, params) }),
    [lang],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

export function useT(): TranslateFn {
  return useContext(I18nContext).t;
}
