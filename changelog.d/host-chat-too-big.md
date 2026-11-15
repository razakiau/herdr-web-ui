### Fixed

- A host chat whose snapshot is over 128 MB no longer disconnects every chat on its PC: its
  snapshot is read over a socket of its own first, and the chat fails alone with "This chat is too
  big to open" (413 `chat_too_big`, with its CLI record's size). zhomelab bundle 1102.
