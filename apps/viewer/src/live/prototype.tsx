import type { Artifact, DataScope } from "@artifacts/schema";
import { useSignal } from "@preact/signals";
import { PageCapsule } from "../components/shell.tsx";
import { LiveFrame, SavedNotice } from "./frame.tsx";

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
  const scope = useSignal<DataScope | null>(null);
  return (
    <div class="on-canvas proto">
      <PageCapsule
        title={page.title ?? page.key}
        subtitle={artifact.title}
        version={version}
        onPages={onPages}
        onVersions={onVersions}
      />
      <SavedNotice scope={scope.value} place="hint" />
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
