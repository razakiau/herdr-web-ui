### Maintenance
- zhomelab deploy branch only: remote bundles are numbered from 1001, so a bridge installed from
  upstream's `remote-v28` release is never taken for this branch's own, and a missing local
  manifest fails instead of fetching upstream's bridge. Each change to the bundle's inputs bumps
  the number by one, which updates every connected PC's bridge.
- zhomelab bundle 1002: carries the Copilot form reader fix, so every connected PC updates its bridge.
- zhomelab bundle 1003: carries the wrapped-form reader fix.
- zhomelab bundle 1004: carries VS Code chats on the phone (the bridge reads and drives VS Code's agent host).
- zhomelab bundle 1005: carries Copilot host chats rebuilt on upstream main (remote v31's bridge plus the agent-host reader).
- zhomelab bundle 1006: carries the VS Code 1.142 subagent fix and chat delete for old sessions.
- zhomelab bundle 1007: model picker grouped by Copilot / router / vendor (the bridge sends each model's group, multiplier and deprecation notice).
- zhomelab bundle 1008: VS Code turn errors with Try again (chat/resume), terminal commands from the call input, context from the turn's contextAttribution, chat reads titled by their session.
- zhomelab bundle 1009: plugin skills in "/" from the host's completions (Coder workspaces had none), context meter by VS Code's math (turn tokens over the model window, clamped at 100%).
- zhomelab bundle 1010: ask card options as numbered rows with a Recommended pill and "Title - description" split, the live "Working…" shimmer, a just-sent VS Code-style turn shows its Working head.
- zhomelab bundle 1011: Skip on an optional Copilot question passes over it alone (VS Code carousel), skipped steps marked.
- zhomelab bundle 1012: a Copilot form pages on the phone and Submits whole (back, change, optional left empty), replacing 1011's Skip; questions and subagents stay where they came in a turn.
- zhomelab bundle 1013: a host's system notification ("`x` has completed") sits where it came, VS Code's check row with its Markdown; the ask card's expand and fold sit together, its title no longer red.
- zhomelab bundle 1014: the turn's message stays pinned at the chat's top (VS Code sticky request); Restore Checkpoint / Start Over on each message puts back the agent's file edits, with Redo.
- zhomelab bundle 1015: Start Over, Restore and Try again reach the PC (the proxy had no route for them); Mark as done archives the session as VS Code does and stays done; opening Archived scrolls to it.
- zhomelab bundle 1016: New chat opens an empty chat in the chat's own composer (skills, permissions, dictation, attach), dropped again if you leave it empty; dictation in a question card shows over its field; Chrome on Android no longer repeats dictated words.
- zhomelab bundle 1017: browser dictation keeps going through a pause (Chrome ends its session at each pause) and keeps the unfinished phrase.
- zhomelab bundle 1018: a model row says its thinking level ("Medium · 528K") with a chevron that opens the levels, and the composer pill shows the default level before any pick.
- zhomelab bundle 1019: the model picker keeps its search and provider tabs pinned at the top, each tab with its model count.
- zhomelab bundle 1020: Fork Conversation on a Copilot chat request (as VS Code 1.142), and forks made in VS Code listed as chats of their own.
- zhomelab bundle 1021: a Copilot folder's header ⋯ is its row's menu; All agents has a real search field, folder pills and VS Code's date groups; alerts also go to an ntfy topic, and host chats alert (asks, finishes, errors) with a tap that opens the chat.
- zhomelab bundle 1022: a chat row's age counts calendar days like its group; reply text between tool calls wraps and wide tables scroll inside it; All agents scrolls from any row (a stroke on a row's text no longer scrolls the chat behind); ntfy alerts carry an icon, and Settings → Alerts names the ntfy topic.
- zhomelab bundle 1023: a forked Copilot chat no longer makes its source chat look like it asks (or alert in its name); Settings → Alerts has its own switch for this device.
- zhomelab: Settings → Alerts grouped by channel (this device: push, in the app, sound; the server: ntfy, read-only); the ⋯ item is Push to this device.
- zhomelab bundle 1024: an answered ask_user call reads as its question, with a folded Show report that opens the whole message as markdown.
- zhomelab bundle 1027: an ask_user form reads as its report once, then its questions (no extra entry); a new Copilot chat lists skills in "/" before its first message.
- zhomelab bundle 1026: the usage panel's account header takes two lines, so a long account or plan stays inside the card; plans read as sold ("Max 20x").
- zhomelab bundle 1025: plan limits from the OmniRoute gateway, each provider opt-in in Settings → Subscription usage (New, search, Shown); the usage panel can sort closest to a limit first; a Copilot folder pins into Pinned.
