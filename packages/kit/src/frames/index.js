// Device frames as web components: <a-phone>, <a-ipad>, <a-watch>, <a-mac>, <a-browser>.
// Generalized from CameraBuddy's mock.js. The chrome lives in a shadow root, so lint's checks on
// the author's own content never trip over the status bar or home indicator.
const SIZES = {
  "a-phone": { width: 393, height: 852, radius: 55 },
  "a-ipad": { width: 820, height: 1180, radius: 28 },
  "a-watch": { width: 198, height: 242, radius: 44 },
  "a-mac": { width: 1280, height: 800, radius: 12 },
  "a-browser": { width: 1280, height: 800, radius: 12 },
};

class DeviceFrame extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const name = this.localName;
    const { width, height, radius } = SIZES[name];
    const time = this.getAttribute("time") ?? "9:41";
    const dark = this.hasAttribute("dark");
    const ink = dark ? "#fff" : "#000";
    const root = this.attachShadow({ mode: "open" });
    const phone = name === "a-phone";
    const titled = name === "a-mac" || name === "a-browser";
    root.innerHTML = `
      <style>
        :host { display: block; position: relative; width: ${width}px; height: ${height}px; border-radius: ${radius}px;
          overflow: hidden; background: ${dark ? "#000" : "#fff"}; color: ${ink}; box-shadow: 0 0 0 1px rgba(0,0,0,.15); }
        .status { position: absolute; top: 0; left: 0; right: 0; height: 54px; display: flex; justify-content: space-between;
          align-items: center; padding: 8px 32px 0 48px; font: 600 16px -apple-system, system-ui, sans-serif; z-index: 2; }
        .island { position: absolute; top: 11px; left: 50%; width: 126px; height: 37px; margin-left: -63px; border-radius: 19px; background: #000; z-index: 3; }
        .home { position: absolute; bottom: 8px; left: 50%; width: 139px; height: 5px; margin-left: -70px; border-radius: 3px; background: ${ink}; z-index: 3; }
        .bar { height: 38px; display: flex; align-items: center; gap: 7px; padding: 0 14px; background: rgba(120,120,128,.14); }
        .bar i { width: 12px; height: 12px; border-radius: 50%; background: rgba(120,120,128,.5); }
        .fill { position: absolute; inset: ${titled ? "38px 0 0" : "0"}; }
      </style>
      ${phone ? `<div class="status"><span>${time}</span><span></span></div><div class="island"></div><div class="home"></div>` : ""}
      ${titled ? "<div class=bar><i></i><i></i><i></i></div>" : ""}
      <div class="fill"><slot></slot></div>`;
  }
}

for (const name of Object.keys(SIZES)) {
  if (!customElements.get(name)) customElements.define(name, class extends DeviceFrame {});
}
