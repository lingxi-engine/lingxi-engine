# Observability

LingXi Engine exposes Prometheus-format metrics at `GET /metrics` (added in v2.0.42,
cardinality-guarded in v2.0.44). This page documents the metrics and ships a ready-made
Grafana dashboard.

## Endpoint & access

- `GET /metrics` — Prometheus text exposition format.
- Access is restricted to **loopback callers or a valid admin token** (same guard as
  other admin surfaces). Scrape it from the same host, or pass an admin bearer token.
- Set `METRICS_ENABLED=false` to disable collection entirely (zero overhead).

## Metrics

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `lingxi_up` | gauge | — | Always `1` while the process is alive |
| `process_uptime_seconds` | gauge | — | Process uptime |
| `lingxi_http_requests_total` | counter | `method`, `route`, `status` | HTTP requests |
| `lingxi_http_request_duration_ms` | summary (`_sum`/`_count`) | `method`, `route` | Request latency (ms) |
| `lingxi_ai_calls_total` | counter | `model`, `type` | AI invocations |
| `lingxi_ai_prompt_tokens_total` | counter | `model` | Prompt tokens consumed |
| `lingxi_ai_completion_tokens_total` | counter | `model` | Completion tokens produced |
| `lingxi_ai_tokens_total` | counter | `model` | Total tokens |

### Cardinality guard

`route` labels are normalized (IDs collapsed to `:id`) and each metric is capped at
**512 distinct label sets**; overflow is folded into `route="(overflow)"`. This prevents
a random-path 404 scan from exhausting memory. See `src/middleware/metrics.ts`.

## Prometheus scrape config

```yaml
scrape_configs:
  - job_name: lingxi
    scrape_interval: 15s
    static_configs:
      - targets: ['127.0.0.1:3456']
    # If scraping remotely, supply an admin token:
    # authorization:
    #   credentials: <ADMIN_TOKEN>
```

## Grafana dashboard

Import [`deploy/grafana/lingxi-dashboard.json`](../deploy/grafana/lingxi-dashboard.json)
into Grafana (Dashboards → Import). It assumes a Prometheus datasource named
`Prometheus` (adjust the `datasource` uid on import). Panels:

- Engine up / uptime
- HTTP request rate by status
- Average HTTP latency (ms)
- AI calls per minute by model
- Token throughput (prompt vs completion)

## Useful PromQL

```promql
# Request rate by status
sum by (status) (rate(lingxi_http_requests_total[5m]))

# Average latency (ms)
rate(lingxi_http_request_duration_ms_sum[5m])
  / rate(lingxi_http_request_duration_ms_count[5m])

# AI calls per minute by model
sum by (model) (rate(lingxi_ai_calls_total[5m])) * 60

# Token throughput
sum(rate(lingxi_ai_tokens_total[5m])) * 60
```
