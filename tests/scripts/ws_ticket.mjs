import crypto from "node:crypto";

const secret = process.env.WS_TOKEN;
if (!secret || secret.length < 8) {
  console.error("WS_TOKEN missing/too short");
  process.exit(1);
}

function b64url(buf) {
  return buf
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function sign(ts, nonce, secretKey) {
  return crypto.createHmac("sha256", secretKey).update(`${ts}.${nonce}`).digest();
}

const ts = Math.floor(Date.now() / 1000);
const nonce = crypto.randomBytes(16).toString("hex");
const sig = b64url(sign(ts, nonce, secret));

process.stdout.write(`${ts}.${nonce}.${sig}`);