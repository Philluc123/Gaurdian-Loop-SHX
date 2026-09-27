// llm-classifier (docs/module-contracts.md §3.5).
//
// Stateless async function: the only side effect is the Gemini API call.
// `classify` never throws and always settles within `timeoutMs` — on any
// error, timeout, or malformed response it resolves with `signals: []` and
// `reason: "llm_error"` so the orchestrator's pipeline never blocks.

import { GoogleGenAI, ThinkingLevel, type GenerateContentParameters, type ThinkingConfig } from "@google/genai";
import type { LLMRequest, LLMResult } from "@guardian-loop/shared-types";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt";
import { parseLLMOutput, RESPONSE_SCHEMA } from "./schema";

export { SYSTEM_PROMPT, buildUserPrompt } from "./prompt";
export { RESPONSE_SCHEMA, parseLLMOutput, SIGNALS } from "./schema";

// gemini-2.5-flash-lite is closed to new API keys (404), so 3.5 is the default.
export const DEFAULT_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_TIMEOUT_MS = 3000;
export const LLM_ERROR_REASON = "llm_error";

/** The one Gemini call this module makes; injectable so tests need no API key. */
export type GenerateFn = (params: GenerateContentParameters) => Promise<{ text?: string }>;

export interface ClassifierOptions {
  /** Gemini API key (from config.ts). Without it every call resolves with `llm_error`. */
  apiKey?: string;
  generate?: GenerateFn;
  model?: string;
  timeoutMs?: number;
  now?: () => number;
}

export function createClassifier(opts: ClassifierOptions = {}): (req: LLMRequest) => Promise<LLMResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const model = opts.model || DEFAULT_MODEL;
  let generate = opts.generate;

  return async function classify(req: LLMRequest): Promise<LLMResult> {
    const startedAt = now();
    const finish = (fields: Omit<LLMResult, "type" | "callId" | "seq" | "latencyMs" | "model" | "ts">): LLMResult => {
      const ts = now();
      return { type: "llm.result", callId: req.callId, seq: req.seq, ...fields, latencyMs: ts - startedAt, model, ts };
    };
    // On failure, keep the orchestrator's existing memory and score so an
    // error result can't erase context or pull the score toward zero.
    const fail = (err: unknown): LLMResult => {
      console.warn(`[llm-classifier] call=${req.callId} seq=${req.seq} failed:`, describe(err));
      return finish({
        signals: [],
        score: req.state.score,
        benignContext: false,
        reason: LLM_ERROR_REASON,
        carryContext: req.state.carryContext,
      });
    };

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      generate ??= defaultGenerate(opts.apiKey);

      const call = generate({
        model,
        contents: buildUserPrompt(req),
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: "application/json",
          responseJsonSchema: RESPONSE_SCHEMA,
          temperature: 0,
          maxOutputTokens: 256,
          thinkingConfig: thinkingConfigFor(model),
          abortSignal: controller.signal,
        },
      });
      // AbortSignal only cancels client-side; the race guarantees we settle on time.
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      const res = await Promise.race([call, timeout]);
      const parsed = parseLLMOutput(res.text);
      if (!parsed) return fail(new Error(`unparseable response: ${truncate(res.text)}`));
      return finish(parsed);
    } catch (err) {
      return fail(err);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * As little thinking as each generation allows, for latency. Gemini 3+ rejects
 * `thinkingBudget` with a bare 400 INVALID_ARGUMENT and takes `thinkingLevel`;
 * 2.x is the other way round.
 */
export function thinkingConfigFor(model: string): ThinkingConfig {
  return /^gemini-2\./.test(model) ? { thinkingBudget: 0 } : { thinkingLevel: ThinkingLevel.MINIMAL };
}

function defaultGenerate(apiKey: string | undefined): GenerateFn {
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  const ai = new GoogleGenAI({ apiKey });
  return (params) => ai.models.generateContent(params);
}

/**
 * One loggable line. Gemini's errors are raw JSON bodies that can quote the API
 * key back (e.g. "Consumer 'api_key:AIza…' has been suspended"), so keys are
 * redacted and the body is reduced to its code, status and message.
 */
export function describe(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  let text = raw;
  try {
    const body = JSON.parse(raw) as { error?: { code?: number; status?: string; message?: string } };
    if (body.error) text = [body.error.code, body.error.status, body.error.message].filter(Boolean).join(" ");
  } catch {
    // Not JSON: log the message as-is.
  }
  return truncate(text.replace(/AIza[0-9A-Za-z_-]{20,}/g, "AIza…[redacted]"), 300);
}

function truncate(s: string | undefined, max = 200): string {
  if (s === undefined) return "<empty>";
  return s.length > max ? s.slice(0, max) + "…" : s;
}
