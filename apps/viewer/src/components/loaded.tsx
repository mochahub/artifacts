import type { ComponentChildren } from "preact";
import { type ApiFailure, isMissing } from "../api.ts";
import type { Remote } from "../poll.ts";
import { useTitle } from "../title.ts";
import { useSignInOn401 } from "./guard.tsx";
import { LoadFailed } from "./placeholder.tsx";

export function NotFound() {
  useTitle("Nothing here");
  return (
    <main class="screen">
      <h1 class="h1">Nothing here</h1>
      <p class="sub">
        This page doesn't exist. <a href="/">Go to Artifacts</a>
      </p>
    </main>
  );
}

/** A deleted link: the date only, no title and no names (07·6). */
export function Deleted({ at }: { at: string }) {
  return (
    <main class="screen">
      <h1 class="h1 m">This artifact was deleted</h1>
      <p class="sub">
        On {new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}.
      </p>
    </main>
  );
}

const failuresOf = (from: Remote<unknown>[]) =>
  from.flatMap((remote) => (remote.error.value ? [remote.error.value] : []));

/**
 * A screen a failure can take over. Nobody signed in goes to sign in. A deleted artifact says so to
 * whoever could see it, which is who gets a 410 (SPEC §5.5, 03); `missing` failures say Nothing here.
 */
export function Gate({
  from,
  missing = isMissing,
  children,
}: {
  from: Remote<unknown>[];
  missing?(failure: ApiFailure): boolean;
  children: ComponentChildren;
}) {
  const failures = failuresOf(from);
  const signedOut = failures.some((failure) => failure.status === 401);
  useSignInOn401(signedOut ? 401 : undefined);
  if (signedOut) return null;
  const gone = failures.find((failure) => failure.status === 410);
  if (gone) return <Deleted at={gone.details.deletedAt as string} />;
  if (failures.some(missing)) return <NotFound />;
  return <>{children}</>;
}

/**
 * The first answer, or what stands in for it: `placeholder` while it's on its way, and a way to ask again
 * if it didn't come. Once something has loaded, a failed poll leaves it on screen.
 */
export function Loaded<T>({
  from,
  value,
  placeholder,
  failed = (retry) => <LoadFailed retry={retry} />,
  children,
}: {
  from: Remote<unknown>[];
  value: T | null | undefined;
  placeholder: ComponentChildren;
  failed?(retry: () => void): ComponentChildren;
  children(value: T): ComponentChildren;
}) {
  if (value !== null && value !== undefined) return <>{children(value)}</>;
  if (failuresOf(from).length > 0 && from.every((remote) => !remote.loading)) {
    const retry = () => {
      for (const remote of from) remote.refresh();
    };
    return <>{failed(retry)}</>;
  }
  return <>{placeholder}</>;
}
