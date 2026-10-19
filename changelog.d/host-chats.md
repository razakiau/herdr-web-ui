### Added

- Copilot host chats: with `HERDR_WEB_AGENT_HOST=on`, the Copilot chats each PC's agent host runs are
  Copilot agents in the app. They stand as tabs of the workspace in their folder (else a folder row
  under the PC), show in Agents while they work or ask, and read like VS Code: folded tool groups,
  subagents, Question / Answered, images. "+" starts one as **Copilot (host)** with its first
  message, model, agent and mode; Send steers a working chat (Alt+Enter or the caret queues, or
  stops and sends), `/plan` and the other Copilot commands work, files and `@` picks go as
  attachments, a question's typed answer takes files and dictation, and the row over the box says
  what the chat waits on with its context window.
- The PC groups fold from three PCs: the ones not in use go under "Other PCs", and one with a chat
  or agent that needs you stays open.
