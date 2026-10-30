import { caller } from "../vendor/artifacts-kit/backend.js";

// Votes are kept by person, and only totals go back, so nobody sees how anyone else voted.
export default {
  async fetch(request, env) {
    const who = caller(request);
    const votes = (await env.DATA.get("votes")) ?? { schema: 1, by: {} };
    if (request.method === "POST") {
      votes.by[who.id] = (await request.json()).choice;
      await env.DATA.put("votes", votes);
      console.log("vote from", who.name);
    }
    const totals = { a: 0, b: 0 };
    for (const choice of Object.values(votes.by)) totals[choice] += 1;
    return Response.json({ totals, mine: votes.by[who.id] ?? null, name: who.name });
  },
};
