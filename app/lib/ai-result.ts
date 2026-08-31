// Client-safe types describing the Gemini analysis result returned in the
// statement upload response (see routes/api/statements/upload.ts). Kept in a
// dependency-free module so both the uploader and the FX/AI page can consume it
// without pulling in the server-only Gemini parser (which imports @google/genai).
//
// Structural mirror of the server's validated output. Money values are strings.

export interface AiTransaction {
  transactionDate: string;
  description: string;
  transactionType: "income" | "expense" | "equity" | "asset";
  currency: string;
  amount: string;
  exchangeRate?: string | null;
  amountThb?: string | null;
  confidence?: number | null;
}

export interface AiGeminiStatementResult {
  statement: {
    transactions: AiTransaction[];
    warnings: string[];
  };
}

export type AiResult =
  | { source: "gemini"; code: null; result: AiGeminiStatementResult }
  | { source: "unavailable"; code: string; errors: string[] };
