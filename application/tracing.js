import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (otlpEndpoint) {
  const serviceName = process.env.OTEL_SERVICE_NAME || "mini-imdb-api";
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.APP_VERSION || "2.2.0",
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${otlpEndpoint.replace(/\/$/, "")}/v1/traces`,
    }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: `${otlpEndpoint.replace(/\/$/, "")}/v1/metrics`,
      }),
      exportIntervalMillis: 15000,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();
  console.log(`[otel] OpenTelemetry enabled for ${serviceName} -> ${otlpEndpoint}`);

  const shutdownOtel = () => {
    void sdk.shutdown().catch((err) => console.error("[otel] Shutdown error:", err));
  };
  process.on("SIGTERM", shutdownOtel);
  process.on("SIGINT", shutdownOtel);
}
