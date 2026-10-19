import { describe, expect, it } from "bun:test";
import type { HostModel } from "../../shared/host-chats.ts";
import { contextLabel, filterModels, shortModelName, modelTabs, pickerSections, providerMark, rowDetail, rememberRecent, recentModels, togglePinned, pinnedModels } from "./modelProvider.ts";

const model = (id: string, name: string, provider = "copilotcli", extra: Partial<HostModel> = {}): HostModel => ({ id, name, provider, efforts: null, context: null, ...extra });

describe("providerMark: VS Code's order, names with a provider in parentheses too", () => {
  it.each([
    ["Claude Opus 5.5 (Anthropic)", "claude"],
    ["GLM-5.3 (OpenCode Go)", "zhipu"],
    ["GPT 5.6 Sol (OpenAI)", "openai"],
    ["DeepSeek V4 Pro (New) (OpenCode Go)", "deepseek"],
    ["HydraFusion", "sparkle"],
    ["Auto", "copilot"],
    ["Grok 4.7 (xAI)", "grok"],
    ["Gemini 3 Pro", "gemini"],
    ["Kimi K3", "kimi"],
    ["MAI-2", "microsoft"],
    ["o3-mini", "openai"],
    ["Qwen3.8 Flash", "qwen"],
    ["MiniMax M3", "minimax"],
  ] as [string, string][])("%s → %s", (name, mark) => {
    expect(providerMark({ id: "fictional/x", name, provider: "copilotcli" }) as string).toBe(mark);
  });
  it("the first match wins: a Claude model served through OpenRouter is Claude", () => {
    expect(providerMark({ id: "openrouter/anthropic-claude", name: "Claude (OpenRouter)", provider: "copilotcli" })).toBe("claude");
  });
});

describe("the model picker's rows", () => {
  it("row_shows_effort_and_context: \"High · 1M\"", () => {
    expect(rowDetail(model("a", "A", "copilotcli", { context: 1_000_000 }), "high")).toBe("High · 1M");
    expect(rowDetail(model("a", "A", "copilotcli", { context: 500_000 }), null)).toBe("500K");
    expect(rowDetail(model("a", "A"), "medium")).toBe("Medium");
    expect(rowDetail(model("a", "A"), null)).toBe("");
    expect(contextLabel(200_000)).toBe("200K");
    expect(contextLabel(1_048_576)).toBe("1M");
  });
  it("search_filters_335_models: typing glm shows only GLM rows; tabs group by provider, none with one provider", () => {
    const models = Array.from({ length: 335 }, (_, index) => index % 67 === 0 ? model(`fictional/glm-${index}`, `GLM-${index} (FICTIONAL)`, "fictional-router") : model(`fictional/m-${index}`, `FICTIONAL M${index}`, index % 2 ? "copilotcli" : "fictional-router"));
    const shown = filterModels(models, "glm");
    expect(shown.length).toBe(5);
    expect(shown.every((each) => /GLM/.test(each.name))).toBe(true);
    expect(modelTabs(models)).toEqual(["fictional-router", "copilotcli"]);
    expect(modelTabs(models.filter((each) => each.provider === "fictional-router"))).toEqual([]);
    expect(filterModels(models, "", "copilotcli").every((each) => each.provider === "copilotcli")).toBe(true);
  });
  it("pinned_and_recent_sections: Pinned, then the last 5 picked on this PC, then All models", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
    const models = ["a", "b", "c", "d", "e", "f", "g"].map((id) => model(id, `FICTIONAL ${id}`));
    for (const id of ["a", "b", "c", "d", "e", "f", "b"]) rememberRecent("desk", id, storage);
    expect(recentModels("desk", storage)).toEqual(["b", "f", "e", "d", "c"]);
    expect(recentModels("laptop", storage)).toEqual([]);
    togglePinned("desk", "g", storage);
    expect(pinnedModels("desk", storage)).toEqual(["g"]);
    const sections = pickerSections(models, pinnedModels("desk", storage), recentModels("desk", storage));
    expect(sections.map((section) => [section.title, section.models.map((each) => each.id)])).toEqual([
      ["Pinned", ["g"]], ["Recent", ["b", "f", "e", "d", "c"]], ["All models", ["a", "b", "c", "d", "e", "f", "g"]],
    ]);
    togglePinned("desk", "g", storage);
    expect(pickerSections(models, [], []).map((section) => section.title)).toEqual(["All models"]);
  });
});

describe("shortModelName: the trigger drops what the mark already says", () => {
  it.each([
    ["Claude Opus 5.5 (Anthropic)", "Claude Opus 5.5"],
    ["DeepSeek V4 Pro (New) (OpenCode Go)", "DeepSeek V4 Pro (New)"],
    ["GLM-5.3 (OpenCode Go)", "GLM-5.3"],
    ["HydraFusion (Lab)", "HydraFusion (Lab)"],
    ["GPT 5.6", "GPT 5.6"],
  ] as [string, string][])("%s → %s", (name, short) => {
    expect(shortModelName({ id: "fictional/x", name, provider: "copilotcli" })).toBe(short);
  });
});
