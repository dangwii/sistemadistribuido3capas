import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import amqp from "amqplib";
import { MongoClient } from "mongodb";
import mysql from "mysql2/promise";
import { createClient } from "redis";

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const APP_PORT = Number(process.env.PORT || 8080);
const APP_HOST = process.env.HOST || "0.0.0.0";
const APP_VERSION = process.env.APP_VERSION || "2.2.0";
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 60);

// 3.4: Connection-pool tuning: 10 conexiones máx por réplica de API (12-factor via env)
const pool = mysql.createPool({
  host: required("DB_HOST"),
  port: Number(process.env.DB_PORT || 3306),
  database: required("DB_NAME"),
  user: required("DB_USER"),
  password: required("DB_PASSWORD"),
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  maxIdle: Number(process.env.DB_CONNECTION_LIMIT || 10),
  idleTimeout: 60000,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
});

// 2.1: Soporte para MongoDB Replica Set (rs0) o MONGO_URI 12-factor
const mongoAuthSource = process.env.MONGO_AUTH_SOURCE || "admin";
const mongoReplicaSet = process.env.MONGO_REPLICA_SET || "rs0";
const mongoUri = process.env.MONGO_URI
  ? process.env.MONGO_URI
  : (() => {
    const mongoHosts = required("MONGO_HOST");
    return mongoHosts.includes(",")
      ? `mongodb://${mongoHosts}/${encodeURIComponent(required("MONGO_DB"))}?replicaSet=${encodeURIComponent(mongoReplicaSet)}&authSource=${encodeURIComponent(mongoAuthSource)}&readPreference=primaryPreferred`
      : `mongodb://${mongoHosts}:${Number(process.env.MONGO_PORT || 27017)}/${encodeURIComponent(required("MONGO_DB"))}?authSource=${encodeURIComponent(mongoAuthSource)}`;
  })();

const mongoOptions = {
  authSource: mongoAuthSource,
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
};
if (!process.env.MONGO_URI && process.env.MONGO_USER) {
  mongoOptions.auth = {
    username: required("MONGO_USER"),
    password: required("MONGO_PASSWORD"),
  };
}
const mongo = new MongoClient(mongoUri, mongoOptions);

// 2.2: Conexión a Redis HA (12-factor via REDIS_URL o REDIS_HOST/REDIS_PORT)
const redis = process.env.REDIS_URL
  ? createClient({ url: process.env.REDIS_URL })
  : createClient({
    password: process.env.REDIS_PASSWORD || undefined,
    socket: {
      host: required("REDIS_HOST"),
      port: Number(process.env.REDIS_PORT || 6379),
    },
  });
redis.on("error", (error) => console.error("Redis client error:", error));

// Fase 3: Publicador opcional a RabbitMQ (cuando RABBITMQ_URL está definida en Kubernetes)
const RABBITMQ_EXCHANGE = "mini_imdb.events";
let rabbitConn = null;
let rabbitChannel = null;

const connectRabbit = async () => {
  const rabbitUrl = process.env.RABBITMQ_URL;
  if (!rabbitUrl) return;
  try {
    rabbitConn = await amqp.connect(rabbitUrl);
    rabbitConn.on("error", (err) => console.error("API RabbitMQ error:", err.message));
    rabbitConn.on("close", () => {
      rabbitChannel = null;
      setTimeout(() => void connectRabbit(), 3000);
    });
    rabbitChannel = await rabbitConn.createChannel();
    await rabbitChannel.assertExchange(RABBITMQ_EXCHANGE, "topic", { durable: true });
    console.log("Mini-IMDb API connected to RabbitMQ exchange:", RABBITMQ_EXCHANGE);
  } catch (err) {
    rabbitChannel = null;
    console.warn("RabbitMQ not ready yet for API publisher; retrying in 3s:", err.message);
    setTimeout(() => void connectRabbit(), 3000);
  }
};

const publishEvent = (routingKey, payload) => {
  if (!rabbitChannel) return false;
  return rabbitChannel.publish(
    RABBITMQ_EXCHANGE,
    routingKey,
    Buffer.from(JSON.stringify(payload)),
    { persistent: true, contentType: "application/json" },
  );
};

class HttpError extends Error {
  constructor(statusCode, message, trace) {
    super(message);
    this.statusCode = statusCode;
    this.trace = trace;
  }
}

const readJsonBody = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) {
      throw new HttpError(413, "Request body is too large");
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
};

const sendJson = (response, statusCode, payload, trace = []) => {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "x-request-trace": trace.join(" -> "),
  });
  response.end(JSON.stringify(payload));
};

const start = async () => {
  await Promise.all([mongo.connect(), redis.connect()]);
  void connectRabbit();
  const reviews = mongo.db(required("MONGO_DB")).collection("movie_reviews");
  const moviesCacheKey = "imdb:movies:top";

  const server = createServer((request, response) => {
    const trace = [
      request.headers["x-presentation-lb"] || "presentation-lb-unknown",
      request.headers["x-web-node"] || "web-node-unknown",
      request.headers["x-application-lb"] || "application-lb-unknown",
      process.env.APPLICATION_NODE || "app-node-unknown",
    ];

    void (async () => {
      const pathname = new URL(request.url, "http://localhost").pathname;

      // Liveness probe (Kubernetes): confirma que el proceso HTTP está vivo
      if (request.method === "GET" && pathname === "/healthz") {
        sendJson(response, 200, {
          status: "alive",
          service: "mini-imdb-api",
          version: APP_VERSION,
          node: process.env.APPLICATION_NODE || process.env.HOSTNAME || "app-node",
        }, trace);
        return;
      }

      // Readiness probe (Kubernetes) y /health (compatibilidad HAProxy/Nagios)
      if (request.method === "GET" && (pathname === "/readyz" || pathname === "/health")) {
        await Promise.all([pool.query("SELECT 1"), mongo.db().command({ ping: 1 }), redis.ping()]);
        sendJson(response, 200, {
          status: "ok",
          service: "mini-imdb-api",
          version: APP_VERSION,
          database_proxy: process.env.DB_HOST,
          mongodb_topology: process.env.MONGO_URI ? "Custom URI" : `Replica Set (${mongoReplicaSet})`,
          redis_mode: "High-Availability Persistent Cache",
          rabbitmq: process.env.RABBITMQ_URL ? (rabbitChannel ? "connected" : "connecting") : "disabled",
        }, [...trace, `${process.env.DB_HOST} (mariadb)`, "mongo", `${process.env.REDIS_HOST || "redis"} (redis)`]);
        return;
      }

      if (request.method === "GET" && pathname === "/") {
        sendJson(response, 200, {
          service: "mini-imdb-api",
          version: APP_VERSION,
          top_movies: "/movies/top",
          movie_reviews: "/movies/{code}/reviews",
          health: "/health",
          healthz: "/healthz",
          readyz: "/readyz",
        }, trace);
        return;
      }

      // Consulta de Top Películas con Redis Cache y Galera fallback vía proxy
      if (request.method === "GET" && (pathname === "/movies/top" || pathname === "/products/cheapest")) {
        trace.push("database-lb (redis)");
        const cached = await redis.get(moviesCacheKey);
        if (cached) {
          trace.push("cache hit");
          sendJson(response, 200, JSON.parse(cached), trace);
          return;
        }

        trace[trace.length - 1] = "database-lb (redis miss)";
        trace.push("database-lb (galera-cluster)");
        const [movies] = await pool.execute(
          "SELECT id, code, code AS sku, title, title AS name, director, genre, release_year, rating, rating AS price FROM movies ORDER BY rating DESC, release_year DESC LIMIT 10",
        );

        trace.push("redis (cache write)");
        await redis.set(moviesCacheKey, JSON.stringify(movies), { EX: CACHE_TTL_SECONDS });
        sendJson(response, 200, movies, trace);
        return;
      }

      // Purga de Caché (y publicación de eventos catalog.changed + catalog.refresh en RabbitMQ)
      if (request.method === "POST" && pathname === "/cache/clear") {
        const removed = await redis.del(moviesCacheKey);
        const queuedInvalidation = publishEvent("catalog.changed", { cacheKey: moviesCacheKey, requestedAt: new Date().toISOString() });
        const queuedRefresh = publishEvent("catalog.refresh", { cacheKey: moviesCacheKey, requestedAt: new Date().toISOString() });
        sendJson(
          response,
          200,
          {
            cacheKey: moviesCacheKey,
            cacheEntryRemoved: removed === 1,
            asyncEventsPublished: queuedInvalidation && queuedRefresh,
          },
          [...trace, "redis (del)", ...(queuedRefresh ? ["rabbitmq (catalog.refresh)"] : [])],
        );
        return;
      }

      // Lectura de Reseñas de Película desde MongoDB Replica Set
      const reviewMatch = pathname.match(/^\/(?:movies|products)\/([A-Za-z0-9-]+)\/reviews$/);
      if (reviewMatch && request.method === "GET") {
        const movieCode = reviewMatch[1];
        const movieReviews = await reviews
          .find({ $or: [{ movieCode }, { sku: movieCode }] })
          .sort({ createdAt: -1 })
          .limit(50)
          .project({ _id: 0, movieCode: 1, reviewer: 1, rating: 1, comment: 1, createdAt: 1 })
          .toArray();
        sendJson(response, 200, { movieCode, reviews: movieReviews }, [...trace, "mongo-rs0"]);
        return;
      }

      // Inserción de Nueva Reseña (Verificación en Galera vía Proxy + Inserción en Mongo Replica Set)
      if (reviewMatch && request.method === "POST") {
        if (!request.headers["content-type"]?.includes("application/json")) {
          throw new HttpError(415, "Content-Type must be application/json");
        }
        const body = await readJsonBody(request);
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          throw new HttpError(400, "Request body must be a JSON object");
        }
        const reviewer = typeof body.reviewer === "string" ? body.reviewer.trim() : "";
        const comment = typeof body.comment === "string" ? body.comment.trim() : "";
        if (
          reviewer.length < 1 ||
          reviewer.length > 80 ||
          !Number.isInteger(body.rating) ||
          body.rating < 1 ||
          body.rating > 5 ||
          comment.length < 1 ||
          comment.length > 1000
        ) {
          throw new HttpError(400, "Provide reviewer, rating (1-5), and comment within the allowed lengths");
        }

        trace.push("database-lb (galera lookup)");
        const [matches] = await pool.execute("SELECT 1 FROM movies WHERE code = ? LIMIT 1", [
          reviewMatch[1],
        ]);
        if (matches.length === 0) {
          throw new HttpError(404, "Movie not found in catalog", trace);
        }

        const review = {
          idempotencyKey: request.headers["idempotency-key"] || randomUUID(),
          movieCode: reviewMatch[1],
          sku: reviewMatch[1],
          reviewer,
          rating: body.rating,
          comment,
          createdAt: new Date().toISOString(),
        };

        if (publishEvent("reviews.created", review)) {
          sendJson(
            response,
            202,
            { status: "queued", ...review },
            [...trace, "rabbitmq (reviews.created)"],
          );
          return;
        }

        const result = await reviews.insertOne({ ...review, createdAt: new Date(review.createdAt) });
        sendJson(response, 201, { id: result.insertedId.toString(), ...review }, [...trace, "mongo-rs0 (insert review)"]);
        return;
      }

      sendJson(response, 404, { error: "Not found" }, trace);
    })().catch((error) => {
      if (!(error instanceof HttpError)) {
        console.error("Request failed:", error);
      }
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(
        response,
        error instanceof HttpError ? error.statusCode : 503,
        { error: error instanceof HttpError ? error.message : "Service temporarily unavailable" },
        error instanceof HttpError && error.trace ? error.trace : trace,
      );
    });
  });

  server.listen(APP_PORT, APP_HOST, () => {
    console.log(`Mini-IMDb API v${APP_VERSION} listening on ${APP_HOST}:${APP_PORT}`);
  });

  const shutdown = () => {
    server.close(() => {
      void Promise.all([pool.end(), mongo.close(), redis.quit()]).then(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

start().catch((error) => {
  console.error("Application startup failed:", error);
  process.exitCode = 1;
});