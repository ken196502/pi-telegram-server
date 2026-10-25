# Agent Rules

- No fallbacks to hide problems. Surface failures instead of silently degrading.
- Clean up all test processes after testing.
- Write a plan md file to the `Docs` folder before developing.
- Add generated data to `.gitignore`.
- Tell the user what to do next before the first tool call in every chat.
- Run every long-lived process (pipelines, runners, downloads, renders, browsers, servers) inside a NAMED tmux session (e.g. `tmux new-session -d -s <pipeline>-pipeline -c <workdir>`), never via `nohup`, bare `&`, or a blocking foreground call, so the user can always find/kill it with `tmux ls` / `tmux kill-session`.
- After starting such a process, always report the tmux session name and the exact attach/view/kill commands.
