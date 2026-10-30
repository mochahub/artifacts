const show = ({ totals, mine }) => {
  document.getElementById("count-a").textContent = String(totals.a);
  document.getElementById("count-b").textContent = String(totals.b);
  document.getElementById("mine").textContent = mine ? `You picked ${mine.toUpperCase()}` : "Pick one";
};

async function vote(choice) {
  const response = await fetch("api/votes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ choice }),
  });
  show(await response.json());
}

for (const choice of ["a", "b"]) {
  document.getElementById(`vote-${choice}`).addEventListener("click", () => vote(choice));
}
fetch("api/votes").then((response) => response.json()).then(show);
