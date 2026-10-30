import { data } from "./vendor/artifacts-kit/data.js";

const render = async () => {
  const votes = (await data.shared.get("votes"))?.value ?? {};
  const mine = (await data.me.get("choice"))?.value ?? null;
  for (const choice of ["a", "b"]) {
    document.getElementById(`count-${choice}`).textContent = String(votes[choice] ?? 0);
  }
  document.getElementById("mine").textContent = mine ? `You picked ${mine.toUpperCase()}` : "Pick one";
};

async function vote(choice) {
  await data.me.put("choice", choice);
  await data.shared.update("votes", (votes) => {
    const next = { schema: 1, a: 0, b: 0, ...votes };
    next[choice] += 1;
    return next;
  });
  await render();
}

for (const choice of ["a", "b"]) {
  document.getElementById(`vote-${choice}`).addEventListener("click", () => vote(choice));
}
render();
