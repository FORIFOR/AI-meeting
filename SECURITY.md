# Security policy

AI-meeting is a beta application. Security fixes target the current `main` branch; older snapshots may require updating. No response-time or long-term support commitment is offered yet.

## Report a vulnerability privately

Use GitHub's **Report a vulnerability** option on the repository's [Security page](https://github.com/FORIFOR/AI-meeting/security), when available. Include the affected revision, component, reproduction steps, expected impact, and a minimal example using synthetic data.

If private reporting is unavailable, open a public issue asking only for a private security contact. Do not include exploit details, access tokens, API keys, recordings, or participant information in that issue. Coordinate a private channel before sending sensitive material.

Please allow time to investigate and prepare a fix before public disclosure. There is currently no bug-bounty program.

## Useful report areas

- Token-broker authentication, authorization, and API-key exposure.
- Cloud requests that bypass `strict_local` or a user's connection choice.
- Unsafe handling of imported model/audio files, redirects, or external resources.
- Meeting-session authorization and unintended exposure of transcripts or recordings.
- Dependency vulnerabilities with a reproducible impact on this application.

Test against your own local instance and accounts. Keep reports limited to the data needed to demonstrate the issue, and redact secrets from logs and screenshots.
