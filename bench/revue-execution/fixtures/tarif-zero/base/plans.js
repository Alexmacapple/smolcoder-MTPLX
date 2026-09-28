const rates = new Map([["free", 0], ["pro", 20]]);

function rateFor(plan) {
  return rates.get(plan);
}

module.exports = { rateFor };
