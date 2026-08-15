# Project instructions

## Direct implementation

- Do not create design documents, specification files, or files under
  `docs/superpowers/specs/` unless the user explicitly asks for that artifact.
- When the user asks to implement, fix, or change something, proceed directly to
  implementation after the necessary local inspection. Do not pause for design
  approval or written-spec review unless a material ambiguity or safety boundary
  makes user input necessary.

## Branch workflow

- Never create or use Git worktrees for this project. Perform implementation work in
  the regular repository checkout on a dedicated branch; do not implement directly on
  `develop`.
- After every completed step, immediately update the active implementation plan with
  its status and completion evidence before starting the next step.
- After the user merges the current branch and `develop` is updated from its upstream,
  clean the relevant project caches and generated temporary/build artifacts before
  starting the next step. Inspect cleanup targets first, preserve user-authored and
  unrelated untracked files, and do not use broad destructive cleanup commands such as
  `git clean -fdx`.
