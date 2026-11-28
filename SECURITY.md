# Security policy

## Reporting a vulnerability

Use the private GitHub Security Advisory form at [Report a vulnerability](https://github.com/draarivpatel-ui/armbench/security/advisories/new). Do not open a public issue, pull request or discussion with exploit details.

Never include a live secret, token, cookie, private key, victim hostname or proprietary payload in a report. Use synthetic values and redacted transcripts.

## Supported versions

| Version | Status |
| --- | --- |
| latest `main` | Supported |

Security fixes are applied to the latest state of the default branch.

## Scope

This policy covers the static ArmBench browser application, including local benchmark execution, workload state, optimization lab results, share links, report exports, browser rendering and the command line bench runner.

In scope:

- A cross-site scripting or HTML injection path through workload state, benchmark output, imported text, share links or report output.
- A share-link decoder or serialization flaw that bypasses validation, corrupts another benchmark state or executes attacker-controlled code.
- A report export or spreadsheet escaping flaw that makes generated output execute a formula or script when opened.
- A benchmark runner or browser execution flaw that misrepresents local measurements as cloud measurements or sends data off the device.
- A static asset or content-security flaw that allows attacker-controlled application code to run across an update.

Out of scope:

- Browser vulnerabilities, operating system compromise or physical access to the machine.
- Damage caused by modified copies of the static application that do not come from this repository.
- The documented accuracy limits of local benchmarks and estimated cloud comparisons, unless a report shows a specific validation or output integrity failure.

## Coordinated disclosure

- Acknowledgment: within 3 business days.
- Initial triage: within 14 calendar days.
- Fix or mitigation target: within 90 calendar days for confirmed reports.
- Coordinated public disclosure: up to 90 days by default, adjusted by mutual agreement when exploitation or user risk requires a different date.
