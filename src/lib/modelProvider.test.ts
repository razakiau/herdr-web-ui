import { describe, expect, it } from "bun:test";
import type { HostModel } from "../../shared/host-chats.ts";
import { contextLabel, filterModels, groupName, modelGroupOf, multiplierLabel, shortModelName, modelTabs, pickerSections, vendorOf, providerMark, rowDetail, rememberRecent, recentModels, togglePinned, pinnedModels } from "./modelProvider.ts";

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
    // the host's default effort shows until one is picked (VS Code's row reads "Medium · 528K" too)
    const thinking = { ...model("a", "A", "copilotcli", { context: 528_000 }), efforts: { key: "thinkingLevel", values: ["low", "medium", "high"], default: "medium" } };
    expect(rowDetail(thinking, null)).toBe("Medium · 528K");
    expect(rowDetail(thinking, "high")).toBe("High · 528K");
    expect(contextLabel(200_000)).toBe("200K");
    expect(contextLabel(1_048_576)).toBe("1M");
  });
  it("search_filters_335_models: typing glm shows only GLM rows; tabs are the groups, Copilot first, none with one group", () => {
    const models = Array.from({ length: 335 }, (_, index) => index % 67 === 0 ? model(`fictional/glm-${index}`, `GLM-${index} (FICTIONAL)`) : model(index % 2 ? `copilot-m-${index}` : `fictional/m-${index}`, `FICTIONAL M${index}`, "copilotcli", index % 2 ? { group: "copilot" } : {}));
    const shown = filterModels(models, "glm");
    expect(shown.length).toBe(5);
    expect(shown.every((each) => /GLM/.test(each.name))).toBe(true);
    expect(modelTabs(models)).toEqual(["copilot", "fictional"]);
    expect(modelTabs(models.filter((each) => each.id.startsWith("fictional/")))).toEqual([]);
    expect(filterModels(models, "", "copilot").every((each) => each.group === "copilot")).toBe(true);
    // a bridge older than 1007 sends no group: the id's prefix files it, a bare id under Other
    expect(modelGroupOf({ id: "fictional/x" })).toBe("fictional");
    expect(modelGroupOf({ id: "bare" })).toBe("other");
  });
  it("pinned_and_recent_sections: Pinned, then the last 5 picked on this PC, then the models' group", () => {
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
      ["Pinned", ["g"]], ["Recent", ["b", "f", "e", "d", "c"]], ["Other", ["a", "b", "c", "d", "e", "f", "g"]],
    ]);
    togglePinned("desk", "g", storage);
    expect(pickerSections(models, [], []).map((section) => section.title)).toEqual(["Other"]);
  });
  it("groups_copilot_then_routers_by_vendor_then_other: the lab's 33 models in five sections", () => {
    const models = [
      model("auto", "Auto", "copilotcli", { group: "copilot" }),
      model("fictional-big", "FICTIONAL Big", "copilotcli", { group: "copilot", multiplier: 27 }),
      model("omniroute/n", "FICTIONAL N", "copilotcli", { group: "omniroute" }),
      model("omniroute/a1", "FICTIONAL A1 (Anthropic)", "copilotcli", { group: "omniroute" }),
      model("omniroute/o1", "FICTIONAL O1 (OpenAI)", "copilotcli", { group: "omniroute" }),
      model("omniroute/a2", "FICTIONAL A2 (Anthropic)", "copilotcli", { group: "omniroute" }),
      model("bare", "FICTIONAL Bare", "copilotcli", { group: "other" }),
    ];
    expect(pickerSections(models, [], []).map((section) => [section.title, section.vendor, section.models.map((each) => each.id)])).toEqual([
      ["Copilot", null, ["auto", "fictional-big"]],
      ["OmniRoute", "Anthropic", ["omniroute/a1", "omniroute/a2"]],
      ["OmniRoute", "OpenAI", ["omniroute/o1"]],
      ["OmniRoute", null, ["omniroute/n"]],
      ["Other", null, ["bare"]],
    ]);
    expect(groupName("fictionalrouter")).toBe("fictionalrouter");
    expect(vendorOf({ name: "FICTIONAL A1 (Anthropic)" })).toBe("Anthropic");
    expect(multiplierLabel({ multiplier: 27 })).toBe("27x");
    expect(multiplierLabel({ multiplier: 1 / 3 })).toBe("0.33x");
    expect(multiplierLabel({ multiplier: null })).toBeNull();
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
