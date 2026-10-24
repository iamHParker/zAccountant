// Request logs and metrics for monitoring (Section 14.2). ℹ️ Like strain gauges on a structure:
// every request writes one JSON log line (ids only: never names, amounts or query text), and
// GET /metrics gives totals in the Prometheus text format that Grafana reads and alerts on.
import { randomUUID, timingSafeEqual } from 'node:crypto';

const BUCKETS = [0.025, 0.05, 0.1, 0.25, 0.5, 0.8, 1, 2, 5]; // seconds; 0.8 and 2 are the alert thresholds

export function createMetrics({ log = (line) => console.log(line) } = {}) {
  const requests = new Map(); // `${method}|${route}|${status}` -> count
  const durations = new Map(); // route -> { buckets: number[], sum, count }
  const started = Date.now();

  /** Express middleware: request id, one log line per request, counters. */
  function middleware(req, res, next) {
    const t0 = process.hrtime.bigint();
    const reqId = /^[\w-]{8,64}$/.test(req.headers['x-request-id'] ?? '') ? req.headers['x-request-id'] : randomUUID();
    req.id = reqId;
    res.set('X-Request-Id', reqId);
    res.on('finish', () => {
      const secs = Number(process.hrtime.bigint() - t0) / 1e9;
      // The route pattern ("/api/companies/:companyId/entries"), not the URL, so ids don't explode the series.
      // (Express resets baseUrl when an error leaves a router, so fall back to the mount point in the URL.)
      const mount = req.baseUrl || (/^\/api\/auth(\/|$)/.test(req.originalUrl) ? '/api/auth' : req.originalUrl.startsWith('/api/') ? '/api' : '');
      const route = req.route ? `${mount}${req.route.path}` : (req.originalUrl.startsWith('/api/') ? 'unmatched' : 'static');
      const key = `${req.method}|${route}|${res.statusCode}`;
      requests.set(key, (requests.get(key) ?? 0) + 1);
      const d = durations.get(route) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
      BUCKETS.forEach((b, i) => { if (secs <= b) d.buckets[i]++; });
      d.sum += secs; d.count++;
      durations.set(route, d);
      if (route === 'static' && res.statusCode < 400) return; // don't log every stylesheet
      log(JSON.stringify({
        level: res.statusCode >= 500 ? 'error' : 'info', msg: 'request', reqId, method: req.method, route,
        status: res.statusCode, ms: Math.round(secs * 1000), userId: req.user?.id, companyId: req.params?.companyId,
      }));
    });
    next();
  }

  const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

  /** Prometheus text exposition. `pool`: the pg pool, for connection gauges. */
  function render(pool) {
    const out = [];
    out.push('# HELP http_requests_total HTTP requests by method, route pattern and status.', '# TYPE http_requests_total counter');
    for (const [k, n] of requests) {
      const [method, route, status] = k.split('|');
      out.push(`http_requests_total{method="${esc(method)}",route="${esc(route)}",status="${status}"} ${n}`);
    }
    out.push('# HELP http_request_duration_seconds Request time by route pattern.', '# TYPE http_request_duration_seconds histogram');
    for (const [route, d] of durations) {
      const r = esc(route);
      BUCKETS.forEach((b, i) => out.push(`http_request_duration_seconds_bucket{route="${r}",le="${b}"} ${d.buckets[i]}`));
      out.push(`http_request_duration_seconds_bucket{route="${r}",le="+Inf"} ${d.count}`);
      out.push(`http_request_duration_seconds_sum{route="${r}"} ${d.sum.toFixed(6)}`);
      out.push(`http_request_duration_seconds_count{route="${r}"} ${d.count}`);
    }
    if (pool) {
      out.push('# HELP db_pool_connections Database connections in the app pool.', '# TYPE db_pool_connections gauge');
      out.push(`db_pool_connections{state="total"} ${pool.totalCount}`, `db_pool_connections{state="idle"} ${pool.idleCount}`);
      out.push('# HELP db_pool_waiting Requests waiting for a database connection.', '# TYPE db_pool_waiting gauge');
      out.push(`db_pool_waiting ${pool.waitingCount}`);
    }
    out.push('# HELP process_uptime_seconds Seconds since this server started.', '# TYPE process_uptime_seconds gauge');
    out.push(`process_uptime_seconds ${Math.round((Date.now() - started) / 1000)}`);
    out.push('# HELP process_resident_memory_bytes Memory in use.', '# TYPE process_resident_memory_bytes gauge');
    out.push(`process_resident_memory_bytes ${process.memoryUsage().rss}`);
    return `${out.join('\n')}\n`;
  }

  return { middleware, render };
}

/** True when the request carries `Authorization: Bearer <token>` (compared in constant time). */
export function bearerMatches(req, token) {
  if (!token) return false;
  const got = Buffer.from(String(req.headers.authorization ?? ''));
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}
