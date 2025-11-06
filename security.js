const crypto = require("crypto");

const SALT_BYTES = 16;
const KEY_LENGTH = 64;
const ITERATIONS = 16384;

function hashPassword(password) {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Password must be a non-empty string");
  }

  const salt = crypto.randomBytes(SALT_BYTES).toString("base64");
  const hash = crypto
    .scryptSync(password, salt, KEY_LENGTH, { N: ITERATIONS })
    .toString("base64");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== "string") {
    return false;
  }

  const [salt, originalHash] = storedHash.split(":");
  if (!salt || !originalHash) {
    return false;
  }

  try {
    const hash = crypto
      .scryptSync(password, salt, KEY_LENGTH, { N: ITERATIONS })
      .toString("base64");
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(originalHash));
  } catch (err) {
    return false;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
};
