let available = 1;
let tail = Promise.resolve();

async function withLock(work) {
  const previous = tail;
  let release;
  tail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

function readAvailable() {
  return available;
}

function writeAvailable(value) {
  available = value;
}

async function audit() {
  await Promise.resolve();
}

module.exports = { withLock, readAvailable, writeAvailable, audit };
