import type { Input } from "../command.ts";
import type { Output } from "../output.ts";
import { installSkill } from "../skill/install.ts";
import { installStageshow } from "../skill/stageshow.ts";

export async function skillCommand(
  { args: { sub }, flags, usage }: Input<"sub", { claude?: boolean; codex?: boolean; stageshow?: boolean }>,
  out: Output,
) {
  if (sub !== "install") throw usage();
  const dirs = installSkill({ claude: flags.claude, codex: flags.codex }, out);
  if (flags.stageshow) await installStageshow(out);
  out.result({ installed: dirs }, () => {});
}
