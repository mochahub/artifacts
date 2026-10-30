// Tail worker: receives each dynamic worker's console output and exceptions, forwards to the app.
export default {
  async tail(events, env) {
    const lines = [];
    for (const ev of events) {
      for (const l of ev.logs ?? []) lines.push({ level: l.level, message: l.message, at: l.timestamp, outcome: ev.outcome });
      for (const x of ev.exceptions ?? []) lines.push({ level: "error", message: [`${x.name}: ${x.message}`], at: x.timestamp, outcome: ev.outcome });
      if (!(ev.logs?.length) && !(ev.exceptions?.length)) lines.push({ level: "outcome", message: [ev.outcome], at: ev.eventTimestamp });
    }
    await env.APP.fetch("http://app/internal/logs", { method: "POST", headers: { authorization: `Bearer ${env.RUNNER_SECRET}` }, body: JSON.stringify(lines) });
  },
};
