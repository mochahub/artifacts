import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SETUP_TOKEN } from "../../../apps/server/test/helpers.ts";
import { fakeBin } from "./sandbox.ts";

/**
 * A stand-in `railway` on PATH. It logs every call and answers in the shape of Railway CLI 5.71.0,
 * as far as its help shows. This tests our side of the conversation, not Railway itself. Each call
 * starts a new log, so a test reads only the calls it made.
 */
export function fakeRailway(
  home: string,
  state: { viewerUrl: string; signedIn?: boolean; deployFails?: boolean; status?: string },
) {
  const log = join(home, "railway.log");
  writeFileSync(log, "");
  const viewer = new URL(state.viewerUrl).host;
  const bin = fakeBin(
    join(home, "bin"),
    "railway",
    `echo "$@" >> ${log}
case "$1 $2" in
  "--version "*) echo "railway 5.71.0" ;;
  "whoami --json") ${state.signedIn === false ? 'echo "not signed in" >&2; exit 1' : `echo '{"email":"zahin@example.com","workspaces":[{"id":"w1","name":"Mochahub"}]}'`} ;;
  "init "*) echo '{"id":"proj-1"}' ;;
  "deploy "*) ${state.deployFails ? 'echo "not a TTY" >&2; exit 1' : 'echo "deployed"'} ;;
  "delete "*) echo "deleted" ;;
  "service status") echo '{"status":"${state.status ?? "SUCCESS"}"}' ;;
  "domain list") echo '[{"domain":"${viewer}","targetPort":8080},{"domain":"content.up.railway.app","targetPort":8081}]' ;;
  "variable list") echo '{"SETUP_TOKEN":"${SETUP_TOKEN}","MORE_URLS":""}' ;;
  "variable set") echo "set" ;;
  "service source") echo "connected" ;;
  *) case "$1" in domain) echo "CNAME art -> x.up.railway.app" ;; *) echo "unexpected: $*" >&2; exit 1 ;; esac ;;
esac`,
  );
  return { bin, log };
}
