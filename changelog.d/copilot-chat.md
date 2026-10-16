### Added
- A GitHub Copilot pane opens as a chat: its prompts, answers, reasoning and tool calls, read from
  the session Copilot writes under `~/.copilot/session-state` (or `COPILOT_HOME`), including chats
  VS Code moved there from its Local harness. Pictures a tool showed Copilot (a viewed image, a
  browser screenshot) appear in that tool's row. A question Copilot asks with `ask_user` gets its
  own card, answered by tapping a choice or typing an answer; a form asks one card per field, and a
  typed answer replaces anything left half-typed in the terminal.
