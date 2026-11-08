import { ApiFailure } from "../api.ts";
export const statusLabel = (value: string) =>
  ({
    waiting_human: "Needs human review",
    budget_exhausted: "Budget exhausted",
    done: "Processed",
    succeeded: "Completed",
  })[value] ?? value.replaceAll("_", " ");
export const usd = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(
    value / 1_000_000,
  );
/** Never display upstream bodies: they may contain provider or source data. */
export function safeError(error: unknown) {
  if (error instanceof ApiFailure) {
    if (error.status === 409) return "This changed elsewhere. Refresh before trying again.";
    if ([401, 403, 404].includes(error.status)) return "This is unavailable or you no longer have access.";
    if (error.status === 429) return "Too many requests. Try again later.";
  }
  return "The request could not be completed. Check your settings and try again.";
}
