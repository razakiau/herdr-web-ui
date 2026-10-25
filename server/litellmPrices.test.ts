import { describe, expect, it } from "bun:test";
import { LiteLlmPrices, litellmPricesFrom } from "./litellmPrices.ts";

const perToken = (input: number, output: number, cached?: number) => ({
  input_cost_per_token: input / 1e6, output_cost_per_token: output / 1e6, mode: "chat",
  ...(cached === undefined ? {} : { cache_read_input_token_cost: cached / 1e6 }),
});

describe("LiteLLM's price map, a fallback behind OmniRoute's (ZAC-224)", () => {
  it("keeps the maker's own price for each bare name, never an aggregator's", () => {
    const raw = {
      sample_spec: { input_cost_per_token: "0", litellm_provider: "one of …" },
      "claude-opus-5-5": { ...perToken(4, 20, 0.2), litellm_provider: "anthropic" },
      "zai/glm-5.3": { ...perToken(1.4, 4.4, 0.26), litellm_provider: "zai" },
      "nebius/zai-org/GLM-5.3": { ...perToken(1.4, 4.4), litellm_provider: "nebius" },
      "deepseek-v4-flash": { ...perToken(0.3, 1.2, 0.006), litellm_provider: "deepseek" },
      // the same model under its maker's prefix, priced apart: the bare row is the one kept
      "deepseek/deepseek-v4-flash": { ...perToken(0.31, 1.21), litellm_provider: "deepseek" },
      "coralbricks/deepseek-v4.1-flash": { ...perToken(0.01, 1.2), litellm_provider: "coralbricks" },
      "xiaomi_mimo/mimo-v2.6-pro": { ...perToken(0.435, 0.87), litellm_provider: "xiaomi_mimo" },
      "text-embedding-3-small": { ...perToken(0.02, 0), litellm_provider: "openai", mode: "embedding" },
      "broken": { input_cost_per_token: -1, output_cost_per_token: 1, litellm_provider: "openai" },
    };
    expect(litellmPricesFrom(raw)).toEqual({
      "claude-opus-5-5": { input: 4, output: 20, cached: 0.2 },
      "glm-5.3": { input: 1.4, output: 4.4, cached: 0.26 },
      "deepseek-v4-flash": { input: 0.3, output: 1.2, cached: 0.006 },
      "mimo-v2.6-pro": { input: 0.435, output: 0.87 },
    });
  });

  it("reads the map once in six hours, and keeps the last one through a failure", async () => {
    let now = 1_000_000;
    let down = false;
    let asked = 0;
    const prices = new LiteLlmPrices(async () => { asked += 1; return down ? new Response("", { status: 502 }) : Response.json({ "zai/glm-5.3": { ...perToken(1.4, 4.4), litellm_provider: "zai" } }); }, () => now);
    expect(await prices.read()).toEqual({ "glm-5.3": { input: 1.4, output: 4.4 } });
    now += 60_000;
    await prices.read();
    expect(asked).toBe(1);
    now += 7 * 3600_000; down = true;
    expect(await prices.read()).toEqual({ "glm-5.3": { input: 1.4, output: 4.4 } });
    expect(asked).toBe(2);
    // a failed read is not asked again on every open
    await prices.read();
    expect(asked).toBe(2);
  });

  it("is null while it has never read a map", async () => {
    expect(await new LiteLlmPrices(async () => { throw new Error("offline"); }).read()).toBeNull();
  });
});
