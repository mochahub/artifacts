import { ChevronLeft } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { me } from "../../session.ts";

export const isAdmin = () => me.value?.role === "owner" || me.value?.role === "admin";
export const isMemberOrUp = () => isAdmin() || me.value?.role === "member";

/** A settings page: the way back, and its title. */
export function Frame({
  title,
  back = "/settings",
  backLabel = "Settings",
  children,
}: {
  title: ComponentChildren;
  back?: string;
  backLabel?: string;
  children: ComponentChildren;
}) {
  return (
    <main class="main">
      <a class="back" href={back}>
        <ChevronLeft />
        {backLabel}
      </a>
      <h1 class="h1">{title}</h1>
      {children}
    </main>
  );
}
