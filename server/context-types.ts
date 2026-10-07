export type TokenUsageBreakdown = { totalTokens: number; inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number }
export type ThreadTokenUsage = { total: TokenUsageBreakdown; last: TokenUsageBreakdown; modelContextWindow: number | null }
