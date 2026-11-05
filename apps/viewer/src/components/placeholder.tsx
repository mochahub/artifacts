/** Quiet stand-ins while the first answer is on its way: the page's shape in the page's grey, nothing moving. */

export function PlaceholderRows({ rows = 3 }: { rows?: number }) {
  return (
    <div class="group ph" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div class="li" key={index}>
          <span class="ph-box" />
          <div class="grow">
            <span class="ph-line" style={{ width: `${62 - (index % 3) * 12}%` }} />
            <span class="ph-line short" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function PlaceholderTiles({ tiles = 4 }: { tiles?: number }) {
  return (
    <div class="grid ph" aria-hidden="true">
      {Array.from({ length: tiles }, (_, index) => (
        <div class="card tile" key={index}>
          <span class="th cover ph-cover" />
          <div class="body">
            <span class="ph-line" style={{ width: `${70 - (index % 2) * 20}%` }} />
            <span class="ph-line short" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function PlaceholderCard() {
  return (
    <div class="card pad ph" aria-hidden="true">
      <span class="th cover ph-cover" />
      <div>
        <span class="ph-line" style="width:58%" />
        <span class="ph-line short" />
      </div>
    </div>
  );
}

/** A page that hasn't arrived: a title's worth of lines where the reading column will be. */
export function PlaceholderPage() {
  return (
    <div class="ph-page" aria-hidden="true">
      <span class="ph-line" style="width:44%;height:28px" />
      <span class="ph-line" style="width:92%" />
      <span class="ph-line" style="width:84%" />
      <span class="ph-line" style="width:66%" />
    </div>
  );
}

/** The first answer didn't come: say so, with a way to ask again, instead of a shape that never fills. */
export function LoadFailed({ retry }: { retry(): void }) {
  return (
    <div class="empty">
      Couldn't load this.{" "}
      <button type="button" class="vchip" onClick={retry}>
        Try again
      </button>
    </div>
  );
}
