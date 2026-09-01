import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerCompanionServices } from "./companion-services.js";
import { registerClawbitsTools } from "./companion-tools.js";

export { CLAWBITS_TOOL_NAMES } from "./companion-tools.js";

export default definePluginEntry({
  id: "clawbits-tools",
  name: "Clawbits Tools & Services",
  description: "Clawbits tools and companion background services.",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  register(api) {
    registerClawbitsTools(api);
    if (api.registrationMode === "full" || api.registrationMode === undefined) {
      registerCompanionServices(api);
    }
  },
});
