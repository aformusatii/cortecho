# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private vulnerability reporting: open the repository's **Security**
tab → **Report a vulnerability**. Include the version/commit, what an attacker
can do, and the smallest reproduction you can.

You should get an answer within a week. If the report is valid, we will fix it,
credit you if you want, and publish an advisory after the fix is available.

## In scope

- The Cortecho API, web UI, the ESPHome client and the Noise implementation.
- Leaks of secrets: the OpenAI key, an Echo's API key, `data/app.db`, logs and
  turn history.
- Authentication/authorization of the HTTP endpoints.
- A tool that lets the model or a remote caller do more than its allow-list.

## Out of scope

- The Echo firmware, the rooting procedure and echo-dot-assist itself: report
  those to [echo-dot-assist](https://github.com/Gamer92000/echo-dot-assist).
- OpenAI's API and models.
- The fact that the web UI has no authentication of its own: it is designed for
  a trusted LAN or an authenticated reverse proxy, and this is documented.
- Physical access to the Echo or the Docker host, and the root access those
  imply.

## What is stored

`data/app.db` contains the OpenAI key, every Echo's API key, the prompts and the
turn history, in plaintext SQLite. Protect it like a password file, back it up
privately, and never attach it to an issue.
