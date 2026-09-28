const { rateFor } = require("./plans");

function amountFor(plan) {
  const rate = rateFor(plan);
  if (rate === undefined) throw new Error("Plan inconnu");
  return rate * 100;
}

module.exports = { amountFor };
