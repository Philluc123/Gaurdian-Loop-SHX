// llm-classifier (docs/module-contracts.md §3.5).
//
// Stateless async function: the only side effect is the Gemini API call.
// `classify` never throws and always settles within `timeoutMs` — on any
// error, timeout, or malformed response it resolves with `signals: []` and
// `reason: "llm_error"` so the orchestrator's pipeline never blocks.

import { GoogleGenAI, type GenerateContentParameters } from "@google/genai";
import type { LLMRequest, LLMResult } from "@guardian-loop/shared-types";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt";
import { parseLLMOutput, RESPONSE_SCHEMA } from "./schema";

export { SYSTEM_PROMPT, buildUserPrompt } from "./prompt";
export { RESPONSE_SCHEMA, parseLLMOutput, SIGNALS } from "./schema";

export const DEFAULT_MODEL = "gemini-2.5-flash-lite";
export const DEFAULT_TIMEOUT_MS = 3000;
export const LLM_ERROR_REASON = "llm_error";

/** The one Gemini call this module makes; injectable so tests need no API key. */
export type GenerateFn = (params: GenerateContentParameters) => Promise<{ text?: string }>;

export interface ClassifierOptions {
  generate?: GenerateFn;
  model?: string;
  timeoutMs?: number;
  now?: () => number;
}

export function createClassifier(opts: ClassifierOptions = {}): (req: LLMRequest) => Promise<LLMResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  let generate = opts.generate;

  return async function classify(req: LLMRequest): Promise<LLMResult> {
    const startedAt = now();
    // Env is read per call (not at import) so dotenv can load after this module.
    const model = opts.model ?? process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
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
      generate ??= defaultGenerate();

      const call = generate({
        model,
        contents: buildUserPrompt(req),
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: "application/json",
          responseJsonSchema: RESPONSE_SCHEMA,
          temperature: 0,
          maxOutputTokens: 256,
          thinkingConfig: { thinkingBudget: 0 },
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

function defaultGenerate(): GenerateFn {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  const ai = new GoogleGenAI({ apiKey });
  return (params) => ai.models.generateContent(params);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(s: string | undefined, max = 200): string {
  if (s === undefined) return "<empty>";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** Default classifier reading GEMINI_API_KEY / GEMINI_MODEL from the environment. */
export const classify = createClassifier();
