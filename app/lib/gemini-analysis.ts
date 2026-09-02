// Server-only Gemini insights analysis module.
//
// This module produces NEUTRAL, informational insights about a user's imported
// statement activity. It is deliberately separated from the deterministic
// statement parser (gemini-statement-parser.ts) and from the tax engine.
//
// Hard rules:
//  - Gemini NEVER computes or suggests tax figures.
//  - Gemini NEVER invents financial values. All numbers in the response context
//    are computed deterministically from the DB and passed in; the output schema
//    contains only TEXT fields, so the model cannot produce money values.
//  - The output is strictly validated with Zod (strict mode — extra fields
//    rejected) before it is returned to the client.
//  - On any failure the caller receives an "unavailable" state; a Gemini problem
//    can never break existing features.
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { DEFAULT_GEMINI_MODEL, resolveGeminiModel, classifyGeminiRequestFailure, GeminiErrorCode } from "./gemini-statement-parser";

/**
 * Deterministic, DB-computed aggregates that context the model is allowed to
 * reference. These are computed in the route from the authenticated user's own
 * rows — never provided by the model and never by the client.
 */
export interface TransactionAggregates {
  transactionCount: number;
  currencies: string[];
  minDate: string;
  maxDate: string;
  cashInTotalThb: string;
  cashOutTotalThb: string;
}

export const geminiInsightSchema = z
  .object({
    summary: z.string().trim().min(1).max(1000),
    patterns: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
    dataQualityNotes: z
      .array(z.string().trim().min(1).max(500))
      .max(10)
      .default([]),
    taxReadinessNotes: z
      .array(z.string().trim().min(1).max(500))
      .max(10)
      .default([]),
  })
  .strict();

export type GeminiInsight = z.infer<typeof geminiInsightSchema>;

export const GEMINI_INSIGHT_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING", description: "A short neutral summary of the statement activity" },
    patterns: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "Observable patterns in the imported activity (dates, currencies, direction)",
    },
    dataQualityNotes: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "Data quality observations (missing fields, ambiguous rows, mixed currencies)",
    },
    taxReadinessNotes: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "Why tax cannot currently be computed for this data (missing cost basis etc.) — NEVER any numeric tax figure",
    },
  },
  required: ["summary", "patterns", "dataQualityNotes", "taxReadinessNotes"],
};

function buildInsightPrompt(agg: TransactionAggregates): string {
  return [
    "You are a neutral data-quality analyst for the STAX tax application.",
    "You are given deterministic figures computed from a user's imported broker statements.",
    "Rules:",
    "- Do NOT invent, recalculate, or add any financial numbers beyond the figures provided.",
    "- Do NOT calculate or suggest any tax amount, rate, or liability.",
    "- Do NOT give investment advice or guaranteed returns.",
    "- summary: one short neutral paragraph describing the activity in the data.",
    "- patterns: 1-5 observable patterns (e.g. recurring monthly deposits, currency mix, large one-off outflows).",
    "- dataQualityNotes: 1-5 notes about data quality (e.g. missing cost basis, mixed currencies, sparse rows).",
    "- taxReadinessNotes: explain that tax cannot be computed because the ledger stores raw cash in/out with no acquisition cost basis or per-unit proceeds; never output a tax figure.",
    "Respond with JSON matching the provided schema.",
    "",
    "--- DETERMINISTIC ACTIVITY FIGURES (from the user's own rows) ---",
    `transactionCount: ${agg.transactionCount}`,
    `currencies: ${agg.currencies.join(", ") || "(none)"}`,
    `dateRange: ${agg.minDate} .. ${agg.maxDate}`,
    `cashInTotalThb: ${agg.cashInTotalThb}`,
    `cashOutTotalThb: ${agg.cashOutTotalThb}`,
  ].join("\n");
}

/**
 * Validate raw Gemini response text into the strictly-typed insight shape.
 * Throws GeminiError on malformed JSON / schema violations. Pure function.
 */
export function validateGeminiInsightText(rawText: string): GeminiInsight {
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    throw new Error("gemini_empty");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error("gemini_bad_json");
  }
  const validated = geminiInsightSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error("gemini_schema");
  }
  return validated.data;
}

export interface InsightOutcome {
  ok: true;
  result: GeminiInsight;
  model: string;
}

/**
 * Call Gemini to produce neutral insights from the given deterministic
 * aggregates. The model cannot see the API key (server-side only) and can only
 * emit text fields validated locally by Zod. Throws GeminiError on failure.
 */
export async function analyzeWithGemini(
  aggregates: TransactionAggregates
): Promise<InsightOutcome> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("gemini_not_configured");
  }

  const model = resolveGeminiModel();
  const ai = new GoogleGenAI({ apiKey });

  let response;
  try {
    response = await ai.models.generateContent({
      model,
      contents: buildInsightPrompt(aggregates),
      config: {
        responseMimeType: "application/json",
        responseSchema: GEMINI_INSIGHT_RESPONSE_SCHEMA as never,
        temperature: 0.2,
      },
    });
  } catch (error) {
    const failure = classifyGeminiRequestFailure(error);
    console.error("analyzeWithGemini: request failed", {
      upstreamType: failure.type,
      upstreamStatus: failure.status ?? undefined,
      causeCode: failure.code ?? undefined,
    });
    throw new Error("gemini_request_failed");
  }

  let result: GeminiInsight;
  try {
    result = validateGeminiInsightText(response.text ?? "");
  } catch (error) {
    const failure = classifyGeminiRequestFailure(error);
    console.error("analyzeWithGemini: validation failed", {
      downstream: error instanceof Error ? error.message : String(error),
      upstreamType: failure.type,
      upstreamStatus: failure.status ?? undefined,
      causeCode: failure.code ?? undefined,
    });
    throw new Error("gemini_invalid_response");
  }

  return { ok: true, result, model };
}