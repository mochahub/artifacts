/** Copies quietly: a browser that refuses still shows the text, so there's nothing more to say. */
export const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => {});
