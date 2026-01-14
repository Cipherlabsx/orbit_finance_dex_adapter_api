import crypto from "node:crypto";
import assert from "node:assert";

process.env.WS_TOKEN ||= "test_super_secret_ws_token_1234567890";

function b64url(buf) {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function sign(ts, nonce, secret) {
  return crypto.createHmac("sha256", secret).update(`${ts}.${nonce}`).digest();
}

function makeTicket(secret) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString("hex");
  const sig = b64url(sign(ts, nonce, secret));
  return `${ts}.${nonce}.${sig}`;
}

const ticket = makeTicket(process.env.WS_TOKEN);
console.log("Generated ticket:", ticket);

assert(ticket.split(".").length === 3, "ticket must have 3 parts");
const [ts] = ticket.split(".");
assert(Math.abs(Date.now() / 1000 - Number(ts)) < 5, "timestamp should be recent");

console.log("ws_auth test passed");