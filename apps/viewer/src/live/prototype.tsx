import type { Artifact } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { Menu } from "lucide-preact";
import { LiveFrame, savedNotice } from "./frame.tsx";

export type PrototypePage = {
  key: string;
  title: string | null;
  meta: { livePath: string; device?: string };
};

type Props = {
  artifact: Artifact;
  page: PrototypePage;
  version: number;
  onPages(): void;
  onVersions(): void;
};

export function PrototypeView({ artifact, page, version, onPages, onVersions }: Props) {
  const scope = useSignal<"shared" | "me" | null>(null);
  return (
    <div class="on-canvas proto">
      <div class="capsule glass">
        <button type="button" class="icon-btn" aria-label="Pages" onClick={onPages}>
          <Menu />
        </button>
        <button type="button" class="where" onClick={onPages}>
          <b>{page.title ?? page.key}</b>
          <span>{artifact.title}</span>
        </button>
        <button type="button" class="vchip" aria-label="Version history" onClick={onVersions}>
          v{version}
        </button>
      </div>
      {scope.value && (
        <div class="hint glass">{savedNotice(scope.value)}. Its author can see what's saved.</div>
      )}
      <div class="stage">
        <LiveFrame
          artifact={artifact}
          version={version}
          path={page.meta.livePath}
          onUse={(used) => {
            scope.value = used;
          }}
        />
      </div>
    </div>
  );
}
