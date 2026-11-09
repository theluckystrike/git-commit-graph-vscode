# Search all history

Type in the search box and press Enter. Enter again goes to the next match, Shift+Enter to the previous one.

- Message, author, hash: the whole message (not only the first line), the author name or email, or a hash prefix.
- File path: commits that touched a path or a glob, for example `src/parser` or `*.md`.
- Changed text (-S): commits that added or removed a piece of text (git log -S).
- Changed lines regex (-G): commits whose changed lines match a regular expression (git log -G).

The search runs over the full history with git, so it also finds commits far below the rows on screen.
