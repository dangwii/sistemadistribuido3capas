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

const WORKER_PORT = Number(process.env.WORKER_PORT || 8081);
const CACHE_KEY = "imdb:movies:top";
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 60);
const EXCHANGE = "mini_imdb.events";
const DLX_EXCHANGE = "mini_imdb.dlx";
const QUEUE_REVIEWS = "reviews.created";
const QUEUE_REVIEWS_DLQ = "reviews.dlq";
const QUEUE_CATALOG_CHANGED = "catalog.changed";
const QUEUE_CATALOG_REFRESH = "catalog.refresh";

const pool = mysql.createPool({
  host: required("DB_HOST"),
  port: Number(process.env.DB_PORT || 3306),
  database: required("DB_NAME"),
  user: required("DB_USER"),
  password: required("DB_PASSWORD"),
  waitForConnections: true,
  connectionLimit: 5,
});

const mongoAuthSource = process.env.MONGO_AUTH_SOURCE || "admin";
const mongoUri = process.env.MONGO_URI
  ? process.env.MONGO_URI
  : `mongodb://${required("MONGO_HOST")}:${Number(process.env.MONGO_PORT || 27017)}/${encodeURIComponent(required("MONGO_DB"))}?authSource=${encodeURIComponent(mongoAuthSource)}`;

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

const redis = process.env.REDIS_URL
  ? createClient({ url: process.env.REDIS_URL })
  : createClient({
      password: process.env.REDIS_PASSWORD || undefined,
      socket: {
        host: required("REDIS_HOST"),
        port: Number(process.env.REDIS_PORT || 6379),
      },
    });
redis.on("error", (err) => console.error("Worker Redis error:", err));

let rabbitReady = false;
let amqpConn = null;
let amqpChannel = null;
const stats = {
  reviewsProcessed: 0,
  reviewsDlq: 0,
  cacheInvalidations: 0,
  cacheRefreshes: 0,
};

const connectRabbitWithRetry = async (reviewsCollection) => {
  const rabbitUrl = required("RABBITMQ_URL");
  while (true) {
    try {
      amqpConn = await amqp.connect(rabbitUrl);
      amqpConn.on("error", (err) => {
        console.error("RabbitMQ connection error:", err.message);
        rabbitReady = false;
      });
      amqpConn.on("close", () => {
        console.warn("RabbitMQ connection closed; reconnecting in 3s...");
        rabbitReady = false;
        setTimeout(() => void connectRabbitWithRetry(reviewsCollection), 3000);
      });

      amqpChannel = await amqpConn.createChannel();
      await amqpChannel.prefetch(5);

      await amqpChannel.assertExchange(EXCHANGE, "topic", { durable: true });
      await amqpChannel.assertExchange(DLX_EXCHANGE, "direct", { durable: true });

      await amqpChannel.assertQueue(QUEUE_REVIEWS_DLQ, { durable: true });
      await amqpChannel.bindQueue(QUEUE_REVIEWS_DLQ, DLX_EXCHANGE, QUEUE_REVIEWS_DLQ);

      await amqpChannel.assertQueue(QUEUE_REVIEWS, {
        durable: true,
        arguments: {
          "x-dead-letter-exchange": DLX_EXCHANGE,
          "x-dead-letter-routing-key": QUEUE_REVIEWS_DLQ,
        },
      });
      await amqpChannel.bindQueue(QUEUE_REVIEWS, EXCHANGE, QUEUE_REVIEWS);

      await amqpChannel.assertQueue(QUEUE_CATALOG_CHANGED, { durable: true });
      await amqpChannel.bindQueue(QUEUE_CATALOG_CHANGED, EXCHANGE, QUEUE_CATALOG_CHANGED);

      await amqpChannel.assertQueue(QUEUE_CATALOG_REFRESH, { durable: true });
      await amqpChannel.bindQueue(QUEUE_CATALOG_REFRESH, EXCHANGE, QUEUE_CATALOG_REFRESH);

      await amqpChannel.consume(QUEUE_REVIEWS, async (msg) => {
        if (!msg) return;
        try {
          const payload = JSON.parse(msg.content.toString("utf8"));
          if (
            !payload.idempotencyKey ||
            !payload.movieCode ||
            !payload.reviewer ||
            !Number.isInteger(payload.rating) ||
            payload.rating < 1 ||
            payload.rating > 5 ||
            !payload.comment
          ) {
            throw new Error("Invalid review message schema");
          }

          await reviewsCollection.updateOne(
            { idempotencyKey: payload.idempotencyKey },
            {
              $setOnInsert: {
                idempotencyKey: payload.idempotencyKey,
                movieCode: payload.movieCode,
                sku: payload.movieCode,
                reviewer: payload.reviewer,
                rating: payload.rating,
                comment: payload.comment,
                createdAt: new Date(payload.createdAt || Date.now()),
              },
            },
            { upsert: true },
          );
          stats.reviewsProcessed += 1;
          amqpChannel.ack(msg);
          console.log(`[worker] Review persisted (${payload.movieCode}, key=${payload.idempotencyKey})`);
        } catch (error) {
          stats.reviewsDlq += 1;
          console.error("[worker] Sending failed review to DLQ:", error.message);
          amqpChannel.nack(msg, false, false);
        }
      });

      await amqpChannel.consume(QUEUE_CATALOG_CHANGED, async (msg) => {
        if (!msg) return;
        try {
          await redis.del(CACHE_KEY);
          stats.cacheInvalidations += 1;
          amqpChannel.ack(msg);
          console.log("[worker] Cache invalidated via catalog.changed");
        } catch (error) {
          console.error("[worker] Failed catalog.changed:", error.message);
          amqpChannel.nack(msg, false, true);
        }
      });

      await amqpChannel.consume(QUEUE_CATALOG_REFRESH, async (msg) => {
        if (!msg) return;
        try {
          const [movies] = await pool.execute(
            "SELECT id, code, code AS sku, title, title AS name, director, genre, release_year, rating, rating AS price FROM movies ORDER BY rating DESC, release_year DESC LIMIT 10",
          );
          await redis.set(CACHE_KEY, JSON.stringify(movies), { EX: CACHE_TTL_SECONDS });
          stats.cacheRefreshes += 1;
          amqpChannel.ack(msg);
          console.log(`[worker] Cache warmed (${movies.length} movies) via catalog.refresh`);
        } catch (error) {
          console.error("[worker] Failed catalog.refresh:", error.message);
          amqpChannel.nack(msg, false, true);
        }
      });

      rabbitReady = true;
      console.log("[worker] Connected to RabbitMQ and consuming queues");
      return;
    } catch (error) {
      rabbitReady = false;
      console.error("[worker] RabbitMQ not ready, retrying in 3s:", error.message);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
};

const start = async () => {
  await Promise.all([mongo.connect(), redis.connect()]);
  const reviewsCollection = mongo.db(required("MONGO_DB")).collection("movie_reviews");
  await reviewsCollection.createIndex({ idempotencyKey: 1 }, { unique: true, sparse: true });

  const server = createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "alive", service: "mini-imdb-worker", stats }));
      return;
    }
    if (pathname === "/readyz") {
      const code = rabbitReady ? 200 : 503;
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: rabbitReady ? "ready" : "connecting", rabbitReady, stats }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(WORKER_PORT, "0.0.0.0", () => {
    console.log(`Mini-IMDb Worker health server listening on :${WORKER_PORT}`);
  });

  void connectRabbitWithRetry(reviewsCollection);

  const shutdown = () => {
    server.close(() => {
      void Promise.allSettled([
        amqpChannel?.close(),
        amqpConn?.close(),
        pool.end(),
        mongo.close(),
        redis.quit(),
      ]).then(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

start().catch((error) => {
  console.error("Worker startup failed:", error);
  process.exitCode = 1;
});
