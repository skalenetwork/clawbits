import { describe, expect, it } from "bun:test";
import { mcpBrand, signInDomain } from "./mcpBrands";

describe("MCP sign-in brands", () => {
  it("names the registrable domain of the sign-in host", () => {
    expect(signInDomain("mcp.linear.app")).toBe("linear.app");
    expect(signInDomain("supportive-banquet-05.authkit.app")).toBe("authkit.app");
    expect(signInDomain("auth.acme.co.uk")).toBe("acme.co.uk");
    expect(signInDomain("github.com")).toBe("github.com");
    expect(signInDomain("login.evil.com.")).toBe("evil.com");
    expect(signInDomain("10.0.0.1")).toBe("10.0.0.1");
  });

  it("recognizes a service only by where the human signs in", () => {
    expect(mcpBrand("mcp.linear.app")?.name).toBe("Linear");
    expect(mcpBrand("supportive-banquet-05.authkit.app")?.name).toBe("AgentPit");
    expect(mcpBrand("someone-else.authkit.app")).toBeUndefined();
    expect(mcpBrand("linear.app.evil.com")).toBeUndefined();
    expect(mcpBrand("evil-linear.app")).toBeUndefined();
  });
});
