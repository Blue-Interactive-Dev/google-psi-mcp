import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const API_KEY = process.env.GOOGLE_PSI_API_KEY;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const PORT = parseInt(process.env.PORT || "3000", 10);

if (!API_KEY) {
  console.error("GOOGLE_PSI_API_KEY is required");
  process.exit(1);
}

if (!MCP_AUTH_TOKEN) {
  console.warn(
    "WARNING: MCP_AUTH_TOKEN env var is not set. " +
    "All MCP requests will be rejected with 500 until you set it in Railway."
  );
} else {
  console.log(
    `MCP_AUTH_TOKEN loaded (prefix=${MCP_AUTH_TOKEN.slice(0, 6)}..., length=${MCP_AUTH_TOKEN.length})`
  );
}

// ---------------------------------------------------------------------------
// Token extraction — supports both methods, query param is primary for Claude
// ---------------------------------------------------------------------------
function extractToken(req: Request): { token: string | null; source: string } {
  // 1. Check Authorization: Bearer header (for non-Claude clients like curl)
  const authHeader = req.headers["authorization"];
  if (authHeader) {
    const parts = authHeader.split(/\s+/, 2);
    if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
      return { token: parts[1], source: "header" };
    }
    return { token: authHeader.trim(), source: "header_malformed" };
  }

  // 2. Fall back to ?token= query parameter (Claude connector method)
  const queryToken = req.query.token;
  if (typeof queryToken === "string" && queryToken) {
    return { token: queryToken, source: "query" };
  }

  return { token: null, source: "none" };
}

// ---------------------------------------------------------------------------
// Constant-time token comparison
// ---------------------------------------------------------------------------
function tokenMatches(provided: string, expected: string): boolean {
  // Hash both so buffers are always equal length, preventing length leakage
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Accept header normalization
// ---------------------------------------------------------------------------
// The MCP streamable-HTTP spec requires Accept to include both
// 'application/json' and 'text/event-stream'. Claude's connector sends
// 'Accept: */*' on its initial probe, which the SDK rejects with 406.
// Rewrite it before the MCP handler sees it.
function normalizeAcceptHeader(req: Request): boolean {
  const accept = req.headers["accept"] || "";
  if (accept.includes("application/json") && accept.includes("text/event-stream")) {
    return false; // already compliant
  }
  req.headers["accept"] = "application/json, text/event-stream";
  return true;
}

// ---------------------------------------------------------------------------
// PSI helpers
// ---------------------------------------------------------------------------
const PSI_BASE = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const CATEGORIES = ["performance", "seo", "accessibility", "best-practices"];

interface MetricValue {
  value: number;
  unit?: string;
  rating: string;
}

interface Scores {
  performance: number;
  seo: number;
  accessibility: number;
  bestPractices: number;
}

interface CoreWebVitals {
  fcp: MetricValue;
  lcp: MetricValue;
  cls: MetricValue;
  tbt: MetricValue;
  ttfb: MetricValue;
  speedIndex: MetricValue;
}

interface Opportunity {
  id: string;
  title: string;
  description: string;
  savings?: string;
  impact: string;
}

interface Audit {
  id: string;
  title: string;
  description: string;
  score: number;
  displayValue?: string;
}

interface PSIResult {
  url: string;
  strategy: string;
  analyzedAt: string;
  scores: Scores;
  coreWebVitals: CoreWebVitals;
  opportunities: Opportunity[];
  failingAudits: Audit[];
  passedAuditIds: string[];
  error?: string;
}

function rating(value: number, thresholds: [number, number]): string {
  if (value < thresholds[0]) return "good";
  if (value < thresholds[1]) return "needs-improvement";
  return "poor";
}

function parseMetric(audits: Record<string, any>, id: string, divisor = 1000, thresholds: [number, number] = [1, 2], unit = "s"): MetricValue {
  const a = audits[id];
  if (!a || a.numericValue == null) return { value: 0, rating: "unknown" };
  const val = Math.round((a.numericValue / divisor) * 100) / 100;
  return { value: val, unit, rating: rating(val, thresholds) };
}

function analyzePSIResponse(url: string, strategy: string, data: any): PSIResult {
  const result: PSIResult = {
    url,
    strategy,
    analyzedAt: new Date().toISOString(),
    scores: { performance: 0, seo: 0, accessibility: 0, bestPractices: 0 },
    coreWebVitals: {
      fcp: { value: 0, rating: "unknown" },
      lcp: { value: 0, rating: "unknown" },
      cls: { value: 0, rating: "unknown" },
      tbt: { value: 0, rating: "unknown" },
      ttfb: { value: 0, rating: "unknown" },
      speedIndex: { value: 0, rating: "unknown" },
    },
    opportunities: [],
    failingAudits: [],
    passedAuditIds: [],
  };

  const lhr = data.lighthouseResult;
  if (!lhr) return result;

  const cats = lhr.categories || {};
  result.scores = {
    performance: Math.round((cats.performance?.score ?? 0) * 100),
    seo: Math.round((cats.seo?.score ?? 0) * 100),
    accessibility: Math.round((cats.accessibility?.score ?? 0) * 100),
    bestPractices: Math.round((cats["best-practices"]?.score ?? 0) * 100),
  };

  const audits = lhr.audits || {};
  result.coreWebVitals = {
    fcp: parseMetric(audits, "first-contentful-paint", 1000, [1.8, 3.0]),
    lcp: parseMetric(audits, "largest-contentful-paint", 1000, [2.5, 4.0]),
    cls: parseMetric(audits, "cumulative-layout-shift", 1, [0.1, 0.25], ""),
    tbt: parseMetric(audits, "total-blocking-time", 1, [200, 600], "ms"),
    ttfb: parseMetric(audits, "server-response-time", 1000, [0.8, 1.8]),
    speedIndex: parseMetric(audits, "speed-index", 1000, [3.4, 5.8]),
  };

  for (const [id, a] of Object.entries<any>(audits)) {
    if (a.score == null) continue;
    if (a.score >= 0.9) {
      result.passedAuditIds.push(id);
      continue;
    }
    const audit: Audit = {
      id,
      title: a.title,
      description: a.description,
      score: a.score,
      displayValue: a.displayValue,
    };
    if (a.details?.type === "opportunity") {
      result.opportunities.push({
        id,
        title: a.title,
        description: a.description,
        savings: a.displayValue,
        impact: a.score < 0.5 ? "high" : a.score < 0.75 ? "medium" : "low",
      });
    } else {
      result.failingAudits.push(audit);
    }
  }

  return result;
}

async function runPSI(url: string, strategy: string): Promise<PSIResult> {
  const params = new URLSearchParams({ url, strategy, key: API_KEY! });
  for (const cat of CATEGORIES) params.append("category", cat);

  try {
    const res = await fetch(`${PSI_BASE}?${params}`);
    const data = await res.json();
    if (!res.ok) {
      return {
        url, strategy, analyzedAt: new Date().toISOString(),
        scores: { performance: 0, seo: 0, accessibility: 0, bestPractices: 0 },
        coreWebVitals: { fcp: { value: 0, rating: "unknown" }, lcp: { value: 0, rating: "unknown" }, cls: { value: 0, rating: "unknown" }, tbt: { value: 0, rating: "unknown" }, ttfb: { value: 0, rating: "unknown" }, speedIndex: { value: 0, rating: "unknown" } },
        opportunities: [], failingAudits: [], passedAuditIds: [],
        error: `PSI API error ${res.status}: ${JSON.stringify(data?.error?.message ?? data)}`,
      };
    }
    return analyzePSIResponse(url, strategy, data);
  } catch (err: any) {
    return {
      url, strategy, analyzedAt: new Date().toISOString(),
      scores: { performance: 0, seo: 0, accessibility: 0, bestPractices: 0 },
      coreWebVitals: { fcp: { value: 0, rating: "unknown" }, lcp: { value: 0, rating: "unknown" }, cls: { value: 0, rating: "unknown" }, tbt: { value: 0, rating: "unknown" }, ttfb: { value: 0, rating: "unknown" }, speedIndex: { value: 0, rating: "unknown" } },
      opportunities: [], failingAudits: [], passedAuditIds: [],
      error: err.message,
    };
  }
}

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------
function createServer(): McpServer {
  const server = new McpServer({
    name: "google-psi-mcp",
    version: "1.0.0",
  });

  server.tool(
    "analyze_page",
    "Analyze a single URL using Google PageSpeed Insights. Returns Core Web Vitals scores, category scores (performance, SEO, accessibility, best-practices), and actionable audit findings.",
    {
      url: z.string().describe("The URL to analyze"),
      strategy: z.enum(["mobile", "desktop", "both"]).default("both").describe("Device strategy to analyze"),
    },
    async ({ url, strategy }) => {
      const strategies = strategy === "both" ? ["mobile", "desktop"] : [strategy];
      const results = await Promise.all(strategies.map((s) => runPSI(url, s)));
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
  );

  server.tool(
    "analyze_pages",
    "Analyze multiple URLs using Google PageSpeed Insights in a single call. Returns an array of results, one per URL.",
    {
      urls: z.array(z.string()).describe("List of URLs to analyze"),
      strategy: z.enum(["mobile", "desktop", "both"]).default("both").describe("Device strategy to analyze"),
    },
    async ({ urls, strategy }) => {
      const strategies = strategy === "both" ? ["mobile", "desktop"] : [strategy];
      const entries = await Promise.all(
        urls.map(async (url) => {
          const results = await Promise.all(strategies.map((s) => runPSI(url, s)));
          return { url, results };
        })
      );
      return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Express app with auth middleware
// ---------------------------------------------------------------------------
async function main() {
  const app = express();
  app.use(express.json());

  // --- Public endpoints (no auth) — Railway healthcheck needs these -------
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", token_configured: !!MCP_AUTH_TOKEN });
  });

  app.get("/", (_req: Request, res: Response) => {
    res.json({
      service: "google-psi-mcp",
      status: "ok",
      mcp_endpoint: "/mcp",
      auth_methods: [
        "Authorization: Bearer <token>  header",
        "?token=<token>                  query param",
      ],
      token_configured: !!MCP_AUTH_TOKEN,
    });
  });

  // --- Auth middleware for /mcp paths -------------------------------------
  const mcpAuthMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    console.log("=".repeat(70));
    console.log(`Incoming request: ${req.method} ${req.path}`);
    console.log(`Query string: ${req.url.includes("?") ? req.url.split("?")[1] : "<empty>"}`);

    // Log headers (mask sensitive ones)
    console.log("Headers received:");
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() === "authorization") {
        const val = String(v);
        console.log(`  ${k}: ${val.slice(0, 20)}...`);
      } else if (k.toLowerCase() === "cookie") {
        console.log(`  ${k}: <redacted>`);
      } else {
        console.log(`  ${k}: ${v}`);
      }
    }

    // Server misconfigured guard
    if (!MCP_AUTH_TOKEN) {
      console.error("Rejecting request: MCP_AUTH_TOKEN is not set on the server");
      res.status(500).json({ error: "server_misconfigured", detail: "MCP_AUTH_TOKEN not set" });
      return;
    }

    const { token, source } = extractToken(req);
    console.log(`Token extraction: source=${source}, token_present=${token !== null}`);

    if (!token) {
      console.warn("No token provided — returning 401");
      res.status(401).json({ error: "unauthorized", detail: "missing token" });
      return;
    }

    if (source === "header_malformed") {
      console.warn("Authorization header present but not in 'Bearer X' form — returning 401");
      res.status(401).json({ error: "unauthorized", detail: "malformed Authorization header" });
      return;
    }

    // Constant-time comparison
    if (!tokenMatches(token, MCP_AUTH_TOKEN)) {
      console.warn(`Token mismatch (source=${source}, received_prefix=${token.slice(0, 6)}...) — returning 401`);
      res.status(401).json({ error: "unauthorized", detail: "invalid token" });
      return;
    }

    console.log(`Auth OK via ${source} — forwarding to handler`);

    // Normalize Accept header for MCP SDK compliance
    if (normalizeAcceptHeader(req)) {
      console.log("Rewrote Accept header to satisfy MCP streamable-HTTP spec");
    }

    next();
  };

  // --- MCP handler (behind auth) ------------------------------------------
  const mcpHandler = async (req: Request, res: Response) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => transport.close());

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP request error:", err);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
  };

  // Handle both /mcp and /mcp/ — Claude's connector sends the trailing slash
  app.all("/mcp", mcpAuthMiddleware, mcpHandler);
  app.all("/mcp/", mcpAuthMiddleware, mcpHandler);

  app.listen(PORT, () => {
    console.log(`google-psi-mcp listening on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});