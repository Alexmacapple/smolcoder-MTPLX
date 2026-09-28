const { withLock, readAvailable, writeAvailable, audit } = require("./inventory");

async function reserve() {
  return withLock(async () => {
    const available = readAvailable();
    if (available < 1) return false;
    writeAvailable(available - 1);
    await audit();
    return true;
  });
}

module.exports = { reserve };
