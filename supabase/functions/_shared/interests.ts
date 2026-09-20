import { bad, reqString } from "./validate.ts";

export interface Interest { topic: string; weight: number }

export function topicKey(topic: string): string {
  return topic.trim().replace(/\s+/g, " ").toLowerCase();
}

export function parseInterest(value: unknown, field = "interest"): Interest {
  const input = typeof value === "string" ? { topic: value } : value;
  if (!input || typeof input !== "object" || Array.isArray(input)) bad(field, "must be a topic string or object");
  const obj = input as Record<string, unknown>;
  const topic = reqString(obj.topic, `${field}.topic`, 100).replace(/\s+/g, " ");
  const weight = obj.weight === undefined ? 1 : obj.weight;
  if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > 3) {
    bad(`${field}.weight`, "must be a number between 0 and 3");
  }
  return { topic, weight };
}

export function parseInterests(value: unknown): Interest[] {
  if (!Array.isArray(value)) bad("interests", "must be an array");
  const unique = new Map<string, Interest>();
  value.forEach((item, i) => {
    const interest = parseInterest(item, `interests[${i}]`);
    unique.set(topicKey(interest.topic), interest);
  });
  return [...unique.values()];
}
