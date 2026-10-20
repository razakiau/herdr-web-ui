### Fixed
- A Copilot `ask_user` form read as one entry too many: the call itself showed as a question
  with every answer joined, above the form's own questions. The form now reads as its report
  once ("Report: …", opening to the whole message), then one question per field.
