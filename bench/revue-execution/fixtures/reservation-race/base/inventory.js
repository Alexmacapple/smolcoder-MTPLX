let available = 1;

function readAvailable() {
  return available;
}

function writeAvailable(value) {
  available = value;
}

async function audit() {
  await Promise.resolve();
}

module.exports = { readAvailable, writeAvailable, audit };
