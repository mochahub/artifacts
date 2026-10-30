import type { Meta, Person } from "@artifacts/schema";
import { signal } from "@preact/signals";
import { ApiFailure, api } from "./api.ts";

export const meta = signal<Meta | null>(null);
export const me = signal<Person | null>(null);
export const bootFailed = signal(false);
export const ready = signal(false);

export async function refreshMe() {
  try {
    const { person } = await api<{ person: Person }>("/api/me");
    me.value = person;
  } catch (error) {
    if (!(error instanceof ApiFailure) || error.status !== 401) throw error;
    me.value = null;
  }
}

export async function boot() {
  try {
    meta.value = await api<Meta>("/api/meta");
    if (meta.value.orgName) await refreshMe();
  } catch {
    bootFailed.value = true;
  }
  ready.value = true;
}
