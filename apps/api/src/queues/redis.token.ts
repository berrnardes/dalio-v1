// DI token for the shared ioredis client. Lives alone to break the circular
// import queues.module ↔ redis-scripts.service (a cycle leaves the symbol
// undefined at decoration time and Nest cannot resolve the injection).
export const REDIS = Symbol('REDIS');
