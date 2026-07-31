export interface ChatContext {
  /** Unix epoch millis of the last observed message; omit for cold start. */
  lastMessageTimestamp?: number;

  /** Optional: sender handle of the current message (for X_0..X_7). */
  sender?: string;

  /** Optional: sender handle of the previous message (for X_8..X_15). */
  previousSender?: string;

  /** Optional: top active users in the context window (first 7 map to indices 0..6). */
  activeUsers?: string[];
}

export type PredictionResult = { targetClass: number | "AMBIGUOUS"; confidence: number };

