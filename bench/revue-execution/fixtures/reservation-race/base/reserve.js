const { readAvailable, writeAvailable, audit } = require("./inventory");

async function reserve() {
  const available = readAvailable();
  if (available < 1) return false;
  writeAvailable(available - 1);
  await audit();
  return true;
}

module.exports = { reserve };
