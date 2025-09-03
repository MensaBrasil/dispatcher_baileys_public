import { config as configDotenv } from "dotenv";
import { createClient, type RedisClientType } from "redis";
import logger from "../utils/logger.js";
import type { JsonValue, QueueName, RedisModule } from "../types/RedisTypes.js";

configDotenv({ path: ".env" });

// Single shared client instance and connection state
let client: RedisClientType | undefined;
let isConnected = false;

function getClient(): RedisClientType {
  if (!client) {
    const host = process.env.REDIS_HOST ?? "127.0.0.1";
    const port = Number(process.env.REDIS_PORT ?? 6379);
    const password = process.env.REDIS_PASSWORD || undefined;

    client = createClient({
      password,
      socket: {
        host,
        port,
        reconnectStrategy: (retries) => {
          if (retries > 20) {
            logger.error("Too many attempts to reconnect. Redis connection terminated");
            return new Error("Too many retries.");
          }
          return Math.min(retries * 500, 5000);
        },
      },
    });

    client.on("error", (err) => {
      logger.error({ err }, "[redis] client error");
    });
    client.on("connect", () => {
      logger.debug("[redis] connecting...");
    });
    client.on("ready", () => {
      isConnected = true;
      logger.info("[redis] connected");
    });
    client.on("end", () => {
      isConnected = false;
      logger.warn("[redis] disconnected");
    });
  }
  return client;
}

async function connect(): Promise<void> {
  const c = getClient();
  if (!isConnected) {
    await c.connect();
    // isConnected will be set on "ready" event; await an immediate ping to ensure usability
    try {
      await c.ping();
      isConnected = true;
    } catch {
      // fallthrough; event handlers may still update isConnected
    }
  }
}

async function disconnect(): Promise<void> {
  if (client && isConnected) {
    try {
      await client.quit();
    } finally {
      isConnected = false;
    }
  }
}

async function testRedisConnection(): Promise<void> {
  try {
    await connect();
    logger.info("Successfully connected to Redis");
    await disconnect();
  } catch (error) {
    logger.error({ err: error }, "Failed to connect to Redis");
    process.exit(1);
  }
}

async function sendToQueue<T extends JsonValue>(objArray: T[], queueName: QueueName): Promise<boolean> {
  try {
    if (!objArray || objArray.length === 0) {
      logger.info({ queueName }, "No objects to send to queue");
      return false;
    }
    await connect();
    const c = getClient();
    const jsonArray = objArray.map((obj) => JSON.stringify(obj));
    await c.rPush(queueName, jsonArray);
    return true;
  } catch (error) {
    logger.error({ err: error, queueName }, "Error sending to queue");
    return false;
  }
}

async function getAllFromQueue<T = unknown>(queueName: QueueName): Promise<T[]> {
  try {
    await connect();
    const c = getClient();
    const elements = await c.lRange(queueName, 0, -1);
    return elements.map((e) => {
      try {
        return JSON.parse(e) as T;
      } catch {
        return e as unknown as T;
      }
    });
  } catch (error) {
    logger.error({ err: error, queueName }, `Error getting all from ${queueName}`);
    return [] as T[];
  }
}

async function getQueueLength(queueName: QueueName): Promise<number> {
  try {
    await connect();
    const c = getClient();
    return await c.lLen(queueName);
  } catch (error) {
    logger.error({ err: error, queueName }, `Error getting length of ${queueName}`);
    return 0;
  }
}

async function clearQueue(queueName: QueueName): Promise<boolean> {
  try {
    await connect();
    const c = getClient();
    await c.del(queueName);
    return true;
  } catch (error) {
    logger.error({ err: error, queueName }, `Error clearing ${queueName}`);
    return false;
  }
}

const redisModule: RedisModule = {
  connect,
  disconnect,
  testRedisConnection,
  sendToQueue,
  getAllFromQueue,
  getQueueLength,
  clearQueue,
};

export default redisModule;
export { connect, disconnect, testRedisConnection, sendToQueue, getAllFromQueue, getQueueLength, clearQueue };
