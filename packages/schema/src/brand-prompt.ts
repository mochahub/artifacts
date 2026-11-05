/** What a person hands an agent. Printed by the CLI and copied from Settings, so no zod here. */
export const BRAND_PROMPT = `Make Artifacts look like our brand.

1. Read our brand guide: <paste a link, or the path to it>.
2. Run: artifacts skill install, then read references/brand.md in the artifacts skill.
3. Write a brand.json with our colours, fonts, corner radius and type. Only use font files we're licensed to embed and redistribute: they ship inside every published artifact, so ask me if you can't tell.
4. Run: artifacts brand preview brand.json, and look at the contact sheet. Fix anything that doesn't look like us, or that fails contrast.
5. Run: artifacts brand propose brand.json, and give me the link.

A person applies it in Settings, Brand. You can't apply it yourself.`;
