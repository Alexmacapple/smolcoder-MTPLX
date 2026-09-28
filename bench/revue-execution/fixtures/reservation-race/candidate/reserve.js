const { readAvailable, writeAvailable, audit } = require("./inventory");

async function reserve() {
  const available = readAvailable();
  if (available < 1) return false;
  await audit();
  writeAvailable(available - 1);
  return true;
}

module.exports = { reserve };
