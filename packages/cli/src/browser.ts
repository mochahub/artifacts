/** Opens a link from the server. Only web pages open: not file:, an app's own scheme, or a path. */
export function openBrowser(url: string) {
  if (process.env.ARTIFACTS_NO_BROWSER || !/^https?:\/\//i.test(url)) return;
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    Bun.spawn([command, url], { stdout: "ignore", stderr: "ignore" });
  } catch {}
}
