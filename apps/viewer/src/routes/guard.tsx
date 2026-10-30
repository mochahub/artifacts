import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { useLocation } from "preact-iso";
import { me } from "../session.ts";

/** Anything that needs a signed-in person: sends everyone else to sign in, and back again. */
export function SignedIn({ children }: { children: ComponentChildren }) {
  const { route, url } = useLocation();
  useEffect(() => {
    if (!me.value) route(`/sign-in?next=${encodeURIComponent(url)}`, true);
  }, [route, url]);
  return me.value ? children : null;
}

/** For pages a guest can open too: signs in only once the API says nobody is there. */
export function useSignInOn401(status: number | undefined) {
  const { route, url } = useLocation();
  useEffect(() => {
    if (status === 401) route(`/sign-in?next=${encodeURIComponent(url)}`, true);
  }, [status, route, url]);
}
