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

### Fixed

- On a PC with several agent hosts running, herdr connects to one that lists models, so the "+"
  dialog offers **Agent host** again; it no longer starts another host while one is still starting
  (VS Code downloading its server took longer than the 30 s deadline).
- A chat VS Code opened and never sent no longer shows as a "Session" row that opens nothing.
