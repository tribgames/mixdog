import type { Api, Model } from "@earendil-works/pi-ai";
import type { SettingsManager } from "./settings-manager.ts";
export declare function mergeProviderAttributionHeaders(model: Model<Api>, settingsManager: SettingsManager, sessionId: string | undefined, ...headerSources: Array<Record<string, string> | undefined>): Record<string, string> | undefined;
//# sourceMappingURL=provider-attribution.d.ts.map