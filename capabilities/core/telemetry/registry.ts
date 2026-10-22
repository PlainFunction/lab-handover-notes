import type { Registry } from '../kernel/registry'
import { Logger } from '../kernel/logger'
import { CloudflareSecretStore, SecretStore } from '../secrets/secrets'
import { TelemetryLogger, instrument } from './instrument'
import { CloudflareTelemetry, OtlpTelemetry, Telemetry, parseTraceparent, type SpanHandle, type TelemetryResource } from './telemetry'

// Telemetry for any Worker built on a Registry, which every lab is: the same
// adapters, logs and span shape as CoreModule and createWorker.

export interface TelemetryEnv {
  ENVIRONMENT?: string
  OTEL_EXPORTER_OTLP_ENDPOINT?: string
  /** A secret. */
  OTEL_EXPORTER_OTLP_HEADERS?: string
}

/**
 * Binds Telemetry (Cloudflare's tracing, or our exporter when
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set), routes Logger through it so logs
 * reach Loki tied to their trace, and traces every port the registry builds.
 */
export function bindTelemetry(c: Registry, env: TelemetryEnv, resource: Omit<TelemetryResource, 'environment'>): Registry {
  const r = { ...resource, environment: env.ENVIRONMENT ?? 'production' }
  const secrets = (c: Registry) => c.has(SecretStore) ? c.get(SecretStore) : new CloudflareSecretStore(env)
  c.bind(Telemetry, c => env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? new OtlpTelemetry({ resource: r, endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT, headers: env.OTEL_EXPORTER_OTLP_HEADERS ? secrets(c).ref('OTEL_EXPORTER_OTLP_HEADERS') : undefined })
    : new CloudflareTelemetry(r))
  c.bind(Logger, c => new TelemetryLogger(c.get(Telemetry)))
  c.intercept(instrument(() => c.get(Telemetry)))
  return c
}

/**
 * One request in a root server span, `<METHOD> <route>`, and one log line
 * for it, flushed from waitUntil so the response isn't held up. `route` is a
 * template (`/api/actions/:name`), never ids. The caller records errors on
 * its 500 path.
 */
export function traceFetch(
  c: Registry, request: Request, ctx: ExecutionContext | undefined, route: string,
  fn: (span: SpanHandle) => Promise<Response>,
): Promise<Response> {
  const t = c.get(Telemetry)
  const started = Date.now()
  const p = t.run(() => t.inSpan(`${request.method} ${route}`, {
    kind: 'server',
    parent: parseTraceparent(request.headers.get('traceparent')),
    attrs: { 'faas.trigger': 'http', 'http.request.method': request.method, 'http.route': route, 'url.scheme': new URL(request.url).protocol.slice(0, -1) },
  }, async span => {
    const res = await fn(span)
    span.setAttribute('http.response.status_code', res.status)
    c.get(Logger).write(res.status >= 500 ? 'error' : 'info', 'http.request', {
      'http.request.method': request.method, 'http.route': route, 'http.response.status_code': res.status, duration_ms: Date.now() - started,
    })
    return res
  }))
  ctx?.waitUntil(p.then(() => undefined, () => undefined).then(() => t.flush()))
  return p
}
