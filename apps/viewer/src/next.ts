/**
 * Only same-site paths, so a crafted link can't send someone elsewhere after signing in. Browsers drop
 * tabs and line breaks from a URL, so "/<tab>/evil.test" would mean "//evil.test": whitespace is refused.
 */
export function safeNext(value: string | undefined) {
  return value?.startsWith("/") && !value.startsWith("//") && !/[\\\s]/.test(value) ? value : "/";
}
