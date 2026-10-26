import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { registerCompanionServices } from "./companion-services.js";
import { registerClawbitsTools, reportClawbitsTools } from "./companion-tools.js";
import { registerMcpLoginGuard } from "./mcp-oauth.js";

export { CLAWBITS_TOOL_NAMES } from "./companion-tools.js";

export default definePluginEntry({
  id: "clawbits-tools",
  name: "Clawbits Tools & Services",
  description: "Clawbits tools and companion background services.",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    registerClawbitsTools(api);
    if (api.registrationMode === "full" || api.registrationMode === undefined) {
      registerCompanionServices(api);
      registerMcpLoginGuard(api);
      // Now when the channel registered first, else once both are up.
      reportClawbitsTools(api.runtime);
      api.on?.("gateway_start", () => reportClawbitsTools(api.runtime));
    }
  },
});
