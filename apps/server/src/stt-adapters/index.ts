// Picks the STT vendor from config. Swapping vendors is a change to
// STT_PROVIDER in .env, never a change to calling code
// (docs/module-contracts.md §3.2).

import type { SttAdapter } from "@guardian-loop/shared-types";
import type { SttConfig } from "../config";
import { createDeepgramAdapter } from "./deepgram";

export function createSttAdapter(cfg: SttConfig): SttAdapter {
  switch (cfg.provider) {
    case "deepgram":
      return createDeepgramAdapter(cfg.deepgram);
    case "elevenlabs":
    case "azure":
      throw new Error(
        `STT_PROVIDER="${cfg.provider}" is not implemented yet — only "deepgram" is. ` +
          `Add an adapter under src/stt-adapters/${cfg.provider}/ implementing SttAdapter.`
      );
    default: {
      const exhaustive: never = cfg.provider;
      throw new Error(`Unknown STT provider: ${String(exhaustive)}`);
    }
  }
}

export { createSttBridge } from "./bridge";
export { createDeepgramAdapter } from "./deepgram";
