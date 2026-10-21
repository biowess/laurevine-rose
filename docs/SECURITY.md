# Security and trust model

Research Presentation Editor runs on your computer and can run code you or a file give it: Python scripts (figures), TeX
documents (LaTeX figures) and LibreOffice (PDF export). This page says what protects you and what does not.

**Short version: the Python and LaTeX windows are not a sandbox. A script runs with your user's permissions. Only run code
you have read or trust. For untrusted scripts, use a container or VM (below).**

## What the server does

- **Loopback only.** `python3 run.py` binds `127.0.0.1:8000`. A non-loopback `HOST` is refused unless `ALLOW_REMOTE=1`, and then
  a warning is printed. With `ALLOW_REMOTE=1` anyone who can reach the port can fetch the session token and run code as you:
  do it only inside a container or VM on a network you control, ideally behind your own authentication.
- **Host check.** Requests whose `Host` header is not `127.0.0.1`, `localhost` or `[::1]` get HTTP 403 (this blocks DNS rebinding).
  Extra names: `RPE_ALLOWED_HOSTS=name1,name2` (set automatically for `HOST` under `ALLOW_REMOTE=1`).
- **Same-origin only.** No wildcard CORS. A cross-origin preflight is refused and any `/api/` request carrying a foreign `Origin` is
  answered 403. To serve the page from another origin, list it in `RPE_ALLOWED_ORIGINS=https://a.example,https://b.example`
  (read at server start). A `backendUrl` preference that points to another origin needs the page's origin in that list.
- **Session token (blocks drive-by requests).** The server makes a random token at start. The page gets it from `GET /api/session`
  (same-origin only) and sends it as `X-RPE-Token` on every `POST /api/figures/*` (render, export, Python run/data, LaTeX
  compile/render, job cancel, CSV parse). A web page on another site cannot read the token, and its requests are refused
  (403). The token changes on every restart; the page fetches a new one when it sees a 403. It is not a password: any program
  on your computer can read it, and it only protects against other websites.
- **Bodies.** Figure `POST`s accept only `application/json` (and `multipart/form-data` for CSV import), otherwise 415.
  Limits (413): 10 MB per figure request, 5 MB per CSV, 2 MB per script or TeX source, 64 MB per presentation save/export.
- **Rate limit.** At most 60 job starts per minute (render, export, Python run/data, LaTeX compile/render), then 429.
  Change it with `RPE_JOBS_PER_MIN`. Running jobs are also capped per kind (contract s4y).
- Code runs only when you press Run, Compile, Insert or Export; never on opening, importing or switching tabs.

## What the subprocess isolation does

Python and TeX run in a child process with: a temporary working folder, a scrubbed environment (no API keys or tokens from your
shell), a timeout, output size caps, POSIX resource limits (CPU, memory, file size) and a process group that is killed on
cancel or timeout. That limits accidents (runaway loops, huge output, leftover files).

## What it does NOT do

- **No sandbox.** A script can read and write any file your user can, start programs, and use the network. Environment
  scrubbing hides variables, not files (`~/.ssh`, browser profiles, documents are reachable). Resource limits do not exist on Windows.
- **TeX shell escape is disabled** (`-no-shell-escape`), which stops `\write18`. This is a setting of your TeX installation, not a
  guarantee: a TeX engine bug, a package, or a changed `texmf.cnf` can still matter. TeX can read files the engine may open.
- **No automatic installs or downloads.** The app never runs `pip`, `tlmgr` or fetches packages or fonts. A missing module or
  package is reported and you install it yourself. (A script you run can of course do anything itself.)
- **No protection from you or from local programs.** The token and Host/Origin checks stop other websites, not other software
  on your machine.
- Presentations and `.rpe.json` files you open can contain scripts. They are only stored, never run on open.

## Running untrusted scripts

Use a disposable environment and keep the port on loopback of that environment:

```bash
# container: nothing of your home folder is mounted, outbound network can be switched off
docker run --rm -it --network none -p 127.0.0.1:8000:8000 -e HOST=0.0.0.0 -e ALLOW_REMOTE=1 \
  -v "$PWD":/app -w /app python:3.12 bash -c "pip install -r requirements.txt && python run.py"
```

(`--network none` also blocks the published port on some setups; drop it if the page does not load, and then restrict network
access some other way.) A VM with a snapshot you revert is stronger still. Do not mount folders you care about.

## Reporting problems

Open an issue with steps to reproduce. Please do not publish a working exploit for a released version before it is fixed.
