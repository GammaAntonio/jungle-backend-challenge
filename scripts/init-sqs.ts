import { initQueues } from "../src/infrastructure/sqs";
await initQueues();
console.log("SQS queues initialized");
