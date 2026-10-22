### Added

- An agent host chat lists the files each edit changed, with the lines it added and removed; a tap opens the edit's diff under it, read from the host, and the file opens in the viewer.
- Above its composer the chat shows what its session produced, one pill per kind as VS Code does: the chat's changes ("2 files +30 −3", each file's diff a tap away), pull requests, issues, artifacts, references, subagents and shells. A kind with one entry shows it inline (a pull request as `#12` in its state's colour: open, draft, merged, closed); with several, their count in the most pressing state, and a sheet. A shell is stoppable where VS Code allows it. Set `HERDR_WEB_GITHUB_TOKEN` for the state of private repositories' pull requests.
- In a host chat, tapping a running subagent in the Subagents sheet takes you to its row in the transcript, opened.
