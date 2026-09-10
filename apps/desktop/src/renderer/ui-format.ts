import { uiFormatLocale } from "./i18n";

const currencies = new Map<string, Intl.NumberFormat>();
const timeUnits = new Map<string, Intl.NumberFormat>();

/** Display-only formatting: never use these helpers for protocol fields/input values. */
export function uiCurrency(value: number, fractionDigits: number): string {
  const locale = uiFormatLocale();
  const key = `${locale}:${fractionDigits}`;
  let formatter = currencies.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, {
      style: "currency", currency: "USD", currencyDisplay: "narrowSymbol",
      minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits,
    });
    currencies.set(key, formatter);
  }
  return formatter.format(value);
}

export function uiTimeUnit(value: number, unit: "day" | "hour" | "minute" | "second"): string {
  const locale = uiFormatLocale();
  const key = `${locale}:${unit}`;
  let formatter = timeUnits.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, {
      style: "unit", unit, unitDisplay: "narrow", useGrouping: false,
    });
    timeUnits.set(key, formatter);
  }
  return formatter.format(value);
}
