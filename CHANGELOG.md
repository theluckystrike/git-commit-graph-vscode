# Changelog

## 0.1.0

- First release: the commit graph with virtual scrolling for very large repositories, search over the full history (message, author, hash, file path, changed text), commit details and diffs, compare two commits, file and line history.
- Checkout, branch, tag, merge, rebase, cherry-pick, revert, reset, stash and squash, each with the git command shown in a confirmation first.
- Read commands run with repository hooks, fsmonitor, textconv, external diff, the pager and the repository's own clean/smudge filters off.
- A branch, tag or remote whose name starts with "-" is refused with a message instead of being passed to git, where it would be read as an option.
- Branch comparison report, visual interactive rebase and saved filters (free in this version).
- Rating ask v2.2, Support and related Zovo tools.
