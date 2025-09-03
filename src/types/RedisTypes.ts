export type QueueName = string;

// JSON-serializable types for queue payloads
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface RedisModule {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  testRedisConnection: () => Promise<void>;
  sendToQueue: <T extends JsonValue>(items: T[], queueName: QueueName) => Promise<boolean>;
  getAllFromQueue: <T = unknown>(queueName: QueueName) => Promise<T[]>;
  getQueueLength: (queueName: QueueName) => Promise<number>;
  clearQueue: (queueName: QueueName) => Promise<boolean>;
}
