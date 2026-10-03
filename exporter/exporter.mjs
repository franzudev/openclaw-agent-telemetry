import { exec } from 'node:child_process';
import { createServer } from 'node:http';

const HOST = process.env.OBS_HOST || '127.0.0.1';
const PORT = Number(process.env.OBS_PORT || 3220);
const AUDIT_LIMIT = process.env.AUDIT_LIMIT || '500';
const ACTIVE_MINUTES = process.env.ACTIVE_MINUTES || '1440';
const REFRESH_INTERVAL_MS = Number(process.env.REFRESH_INTERVAL_MS || 15000);
// The recent-failures series carries a truncated session message preview in
// its `reason` label. Set INCLUDE_REASON_LABELS=0 to drop it.
const INCLUDE_REASON = process.env.INCLUDE_REASON_LABELS !== '0';

let metricsText = '# openclaw observability exporter starting\n';
let lastScrapeAt = 0;
let lastError = '';

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

function esc(label) {
  return String(label).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function fmtLabels(labels) {
  const pairs = Object.entries(labels)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}="${esc(v)}"`);
  return pairs.length ? `{${pairs.join(',')}}` : '';
}

function line(name, labels, value) {
  return `${name}${fmtLabels(labels)} ${Number(value) || 0}`;
}

async function refresh() {
  const t0 = Date.now();
  try {
    const [auditRaw, sessionsRaw] = await Promise.all([
      run(`openclaw audit --json --limit ${Number(AUDIT_LIMIT) || 500}`),
      run(`openclaw sessions --json --active ${ACTIVE_MINUTES} --limit all --all-agents`),
    ]);

    const audit = JSON.parse(auditRaw || '{}');
    const sessionsData = JSON.parse(sessionsRaw || '{}');

    const sessions = Array.isArray(sessionsData.sessions) ? sessionsData.sessions : [];
    const events = Array.isArray(audit.events) ? audit.events : [];

    const sessionMap = new Map();
    for (const s of sessions) {
      sessionMap.set(s.sessionId, s);
    }

    function shortReason(s = { lastMessagePreview: '' }) {
      const preview = String(s?.lastMessagePreview ?? '');
      return preview ? preview.replace(/\s+/g, ' ').trim().slice(0, 120) : 'no preview';
    }

    const enriched = events.map((e) => {
      const s = sessionMap.get(e.sessionId);
      return {
        ...e,
        model: s?.model ?? 'unknown',
        agentId: s?.agentId ?? e.agentId ?? 'unknown',
        reason: shortReason(s),
      };
    });

    const total = enriched.length;
    const succeeded = enriched.filter((e) => e.status === 'succeeded').length;
    const failed = enriched.filter((e) => e.status === 'failed').length;
    const started = enriched.filter((e) => e.status === 'started').length;
    const cancelled = enriched.filter((e) => e.status === 'cancelled').length;
    const unknown = total - succeeded - failed - started - cancelled;

    const byModel = {};
    for (const e of enriched) {
      const m = e.model;
      if (!byModel[m]) byModel[m] = { total: 0, succeeded: 0, failed: 0, other: 0 };
      byModel[m].total++;
      if (e.status === 'succeeded') byModel[m].succeeded++;
      else if (e.status === 'failed') byModel[m].failed++;
      else byModel[m].other++;
    }

    const byError = {};
    for (const e of enriched) {
      if (e.status !== 'failed') continue;
      const code = e.errorCode ?? 'unknown';
      byError[code] = (byError[code] ?? 0) + 1;
    }

    const byTool = {};
    for (const e of enriched) {
      if (e.status !== 'failed' || e.kind !== 'tool_action') continue;
      const t = e.toolName ?? 'unknown';
      byTool[t] = (byTool[t] ?? 0) + 1;
    }

    const byKind = {};
    for (const e of enriched) {
      const k = e.kind ?? 'unknown';
      if (!byKind[k]) byKind[k] = { succeeded: 0, failed: 0 };
      if (e.status === 'succeeded') byKind[k].succeeded++;
      if (e.status === 'failed') byKind[k].failed++;
    }

    const lines = [];
    lines.push('# HELP openclaw_audit_event_total Total audit events');
    lines.push('# TYPE openclaw_audit_event_total counter');
    lines.push(line('openclaw_audit_event_total', { status: 'succeeded', model: 'all', kind: 'all' }, succeeded));
    lines.push(line('openclaw_audit_event_total', { status: 'failed', model: 'all', kind: 'all' }, failed));
    lines.push(line('openclaw_audit_event_total', { status: 'started', model: 'all', kind: 'all' }, started));
    lines.push(line('openclaw_audit_event_total', { status: 'cancelled', model: 'all', kind: 'all' }, cancelled));
    lines.push(line('openclaw_audit_event_total', { status: 'unknown', model: 'all', kind: 'all' }, unknown));

    lines.push('# HELP openclaw_audit_event_by_model_total Audit events by model and status');
    lines.push('# TYPE openclaw_audit_event_by_model_total counter');
    for (const [model, v] of Object.entries(byModel)) {
      lines.push(line('openclaw_audit_event_by_model_total', { model, status: 'succeeded' }, v.succeeded));
      lines.push(line('openclaw_audit_event_by_model_total', { model, status: 'failed' }, v.failed));
      lines.push(line('openclaw_audit_event_by_model_total', { model, status: 'other' }, v.other));
    }

    lines.push('# HELP openclaw_audit_failed_by_error_total Failed events by error code');
    lines.push('# TYPE openclaw_audit_failed_by_error_total counter');
    for (const [code, v] of Object.entries(byError)) {
      lines.push(line('openclaw_audit_failed_by_error_total', { error_code: code }, v));
    }

    lines.push('# HELP openclaw_audit_tool_failure_total Failed tool actions by tool name');
    lines.push('# TYPE openclaw_audit_tool_failure_total counter');
    for (const [tool, v] of Object.entries(byTool)) {
      lines.push(line('openclaw_audit_tool_failure_total', { tool }, v));
    }

    lines.push('# HELP openclaw_audit_event_by_kind_total Audit events by kind and status');
    lines.push('# TYPE openclaw_audit_event_by_kind_total counter');
    for (const [kind, v] of Object.entries(byKind)) {
      lines.push(line('openclaw_audit_event_by_kind_total', { kind, status: 'succeeded' }, v.succeeded));
      lines.push(line('openclaw_audit_event_by_kind_total', { kind, status: 'failed' }, v.failed));
    }

    // Recent failures as labels on a gauge; Grafana table can use instant queries on these series.
    lines.push('# HELP openclaw_audit_recent_failure_timestamp_ms Timestamp of recent failure');
    lines.push('# TYPE openclaw_audit_recent_failure_timestamp_ms gauge');
    let rank = 0;
    for (const e of enriched
      .filter((e) => e.status === 'failed')
      .sort((a, b) => (b.occurredAt ?? 0) - (a.occurredAt ?? 0))
      .slice(0, 20)) {
      const labels = {
        error_code: e.errorCode ?? 'unknown',
        tool: e.toolName ?? e.kind ?? 'unknown',
        model: e.model ?? 'unknown',
        reason: INCLUDE_REASON ? e.reason : undefined,
        rank: String(rank++),
        run_id: e.runId ? String(e.runId).slice(0, 32) : '—',
      };
      lines.push(line('openclaw_audit_recent_failure_timestamp_ms', labels, e.occurredAt ?? 0));
    }

    lines.push('# HELP openclaw_collector_last_refresh_timestamp_seconds Unix timestamp of last successful refresh');
    lines.push('# TYPE openclaw_collector_last_refresh_timestamp_seconds gauge');
    lines.push(line('openclaw_collector_last_refresh_timestamp_seconds', {}, Math.floor(Date.now() / 1000)));

    lines.push('# HELP openclaw_collector_refresh_duration_seconds Duration of last refresh');
    lines.push('# TYPE openclaw_collector_refresh_duration_seconds gauge');
    lines.push(line('openclaw_collector_refresh_duration_seconds', {}, ((Date.now() - t0) / 1000).toFixed(3)));

    lastError = '';
    lastScrapeAt = Date.now();
    metricsText = lines.join('\n') + '\n';
  } catch (err) {
    lastError = String(err?.message ?? err);
    const lines = [];
    lines.push('# HELP openclaw_collector_last_error_info Last collector failure reason');
    lines.push('# TYPE openclaw_collector_last_error_info gauge');
    lines.push(line('openclaw_collector_last_error_info', { error: lastError.slice(0, 100) }, 1));
    lines.push('# HELP openclaw_collector_last_refresh_timestamp_seconds Unix timestamp of last refresh attempt');
    lines.push('# TYPE openclaw_collector_last_refresh_timestamp_seconds gauge');
    lines.push(line('openclaw_collector_last_refresh_timestamp_seconds', {}, Math.floor(Date.now() / 1000)));
    metricsText = lines.join('\n') + '\n';
  }
}

const server = createServer((req, res) => {
  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(metricsText);
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, lastRefresh: lastScrapeAt, error: lastError || null }));
    return;
  }
  res.writeHead(404).end('not found');
});

server.listen(PORT, HOST, () => {
  console.log(`OpenClaw telemetry exporter listening on http://${HOST}:${PORT}/metrics`);
  refresh();
  setInterval(refresh, REFRESH_INTERVAL_MS);
});
