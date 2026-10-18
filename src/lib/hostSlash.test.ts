import { describe, expect, it } from "bun:test";
import { hostSlashItems, resolveHostSlash } from "./hostSlash.ts";

describe("resolveHostSlash: VS Code's config commands on send", () => {
  it("plan_with_text_sets_mode_and_sends_rest", () => {
    expect(resolveHostSlash("/plan fix it")).toEqual({ config: { mode: "plan" }, text: "fix it" });
    expect(resolveHostSlash("/goal ship it")).toEqual({ config: { mode: "plan" }, text: "ship it" });
  });
  it("autopilot_on_only_changes_config: nothing is sent", () => {
    expect(resolveHostSlash("/autopilot on")).toEqual({ config: { mode: "autopilot" }, text: "" });
    expect(resolveHostSlash("/autopilot off")).toEqual({ config: { mode: "interactive" }, text: "" });
    // an objective after it: autopilot, and the objective is sent
    expect(resolveHostSlash("/autopilot finish the release")).toEqual({ config: { mode: "autopilot" }, text: "finish the release" });
  });
  it("yolo_and_allow_all_set_bypass", () => {
    expect(resolveHostSlash("/yolo on")).toEqual({ config: { autoApprove: "autoApprove" }, text: "" });
    expect(resolveHostSlash("/allow-all on")).toEqual({ config: { autoApprove: "autoApprove" }, text: "" });
    expect(resolveHostSlash("/yolo off")).toEqual({ config: { autoApprove: "default" }, text: "" });
    // VS Code: a named-option command with no base option and an unknown argument is not one of these
    expect(resolveHostSlash("/yolo maybe")).toBeNull();
    // and a bare one takes its first option
    expect(resolveHostSlash("/yolo")).toEqual({ config: { autoApprove: "autoApprove" }, text: "" });
  });
  it("unknown_slash_is_sent_as_text", () => {
    expect(resolveHostSlash("/fictional-skill do it")).toBeNull();
    expect(resolveHostSlash("plain words")).toBeNull();
    expect(resolveHostSlash("/plan/x")).toBeNull();
  });
});

describe("hostSlashItems: the / menu", () => {
  const commands = [{ name: "fictional-skill", description: "FICTIONAL does a thing", kind: "skill" as const }, { name: "Report", description: "FICTIONAL writes a report", kind: "agent" as const }];
  it("the config commands first, as VS Code sorts them, then the host's, filtered as you type", () => {
    const all = hostSlashItems("", commands, { mode: "interactive", approvals: "default" });
    expect(all.map((item) => item.label)).toEqual(["/allow-all on", "/autopilot", "/autopilot on", "/goal", "/plan", "/yolo on", "/fictional-skill", "/Report"]);
    expect(all.find((item) => item.label === "/plan")).toMatchObject({ insert: "/plan ", description: "Create an implementation plan before coding" });
    expect(all.find((item) => item.label === "/yolo on")).toMatchObject({ insert: "/yolo on", description: "Set permissions to bypass approvals" });
    expect(hostSlashItems("pl", commands, null).map((item) => item.label)).toEqual(["/plan"]);
    expect(hostSlashItems("fict", commands, null).map((item) => item.label)).toEqual(["/fictional-skill"]);
  });
  it("offers what changes something: off once on, as VS Code's shouldOfferOption", () => {
    const labels = hostSlashItems("", [], { mode: "autopilot", approvals: "autoApprove" }).map((item) => item.label);
    expect(labels).toContain("/autopilot off");
    expect(labels).toContain("/yolo off");
    expect(labels).not.toContain("/autopilot on");
    expect(labels).not.toContain("/yolo on");
  });
});
