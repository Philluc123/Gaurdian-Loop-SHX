// The STT adapter the service runs with. Deepgram is the only vendor; callers
// depend on the SttAdapter interface (docs/module-contracts.md §3.2), so a
// different vendor would slot in here without changes to calling code.

import type { SttAdapter } from "@guardian-loop/shared-types";
import type { SttConfig } from "../config";
import { createDeepgramAdapter } from "./deepgram";

export function createSttAdapter(cfg: SttConfig): SttAdapter {
  return createDeepgramAdapter(cfg.deepgram);
}

export { createDeepgramAdapter } from "./deepgram";
