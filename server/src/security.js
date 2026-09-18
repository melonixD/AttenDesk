import crypto from "node:crypto";

const base64url = (input) => Buffer.from(input).toString("base64url");
const stableEqual = (left, right) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
export const keyedHash = (secret, value) => crypto.createHmac("sha256", secret).update(String(value)).digest("hex");
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const numericOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
export const otpHash = (secret, organizationId, email, code) =>
  crypto.createHmac("sha256", secret).update(`${organizationId}:${email.toLowerCase()}:${code}`).digest("hex");

export function issueAccessToken(secret, claims, lifetimeSeconds = 900) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ ...claims, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + lifetimeSeconds }));
  const signature = crypto.createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

export function verifyAccessToken(secret, token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest("base64url");
  if (!stableEqual(parts[2], expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload.exp > Math.floor(Date.now() / 1000) ? payload : null;
  } catch {
    return null;
  }
}

export function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(self), bluetooth=(self), geolocation=(), microphone=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}

export function createRateLimiter({ windowMs = 60_000, max = 60 } = {}) {
  const buckets = new Map();
  let requestCount = 0;
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const current = buckets.get(key);
    const now = Date.now();
    requestCount += 1;
    if (requestCount % 500 === 0) {
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(bucketKey);
      }
    }
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      res.setHeader("RateLimit-Limit", String(max));
      res.setHeader("RateLimit-Remaining", String(Math.max(0, max - 1)));
      res.setHeader("RateLimit-Reset", String(Math.ceil((now + windowMs) / 1000)));
      return next();
    }
    current.count += 1;
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, max - current.count)));
    res.setHeader("RateLimit-Reset", String(Math.ceil(current.resetAt / 1000)));
    if (current.count > max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((current.resetAt - now) / 1000))));
      return res.status(429).json({ error: "RATE_LIMITED", message: "Too many requests. Please wait." });
    }
    next();
  };
}

export const ipDigest = (secret, ip) => crypto.createHmac("sha256", secret).update(ip || "unknown").digest("hex");
