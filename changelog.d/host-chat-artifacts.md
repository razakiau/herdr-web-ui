### Added

- An agent host chat lists the files each edit changed, with the lines it added and removed; a tap opens the edit's diff under it, read from the host, and the file opens in the viewer.
- Above its composer the chat shows what its session produced, as VS Code does: each GitHub pull request and issue in its state's colour (open, draft, merged, closed), an "artifacts" sheet with the rest by kind (commits, websites, files, resources) and the references, and the shells and subagents still running, a shell stoppable where VS Code allows it. Set `HERDR_WEB_GITHUB_TOKEN` for the state of private repositories' pull requests.
- In a host chat, tapping a running subagent in the "N running" sheet takes you to its row in the transcript, opened.
