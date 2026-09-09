# Google Cloud billing observation — 2026-09-09

Authenticated Google Cloud Billing Reports was read in the user's browser. The project grouping contained exactly one row, AI-meeting (`gen-lang-client-0307428960`), confirming the service totals belong to this project rather than another project on the billing account.

The report displayed **2026-09-01 through 2026-09-07** as its actual cost coverage, although the query is “this month.” Currency was JPY. Displayed usage before savings was **¥5,276**, savings **¥48**, and net **¥5,228**. Tax was shown as a dash; it is not recorded as zero or as included. This is reported usage to date, not a final monthly invoice or payment receipt.

| Service | Gross JPY | Savings JPY | Net JPY |
| --- | ---: | ---: | ---: |
| Vertex AI | 5215 | 0 | 5215 |
| Cloud Run | 55 | 48 | 7 |
| Cloud Storage | 6 | 0 | 6 |
| Artifact Registry | 0 | 0 | 0 |

Values are rounded yen as displayed by Google, not higher-precision exported charges. Zero display values may contain sub-yen usage. September 8–9 usage is not represented by this observation. Do not combine it with the September 9 Attendee consumption snapshot into a same-period total. Do not convert these actual JPY figures using the hypothetical USD exchange rate used by the bot calculator, or add Vertex AI to the Cloud total again.

The public UI now presents this separate dated Cloud total and expandable service breakdown. It removes the implication that all Cloud costs are still awaiting authentication, but retains the limitations on historical token accounting and final payment. Raw login URLs, browser authentication parameters, emails, and payment details were not copied to the published snapshot.

Validation: two Cloud reconciliation tests and two existing cost-display tests passed; web typecheck and production build passed. Backend unchanged. Snapshot remains operator-reviewed, not automatic billing synchronization.

Published source `6482280` to Firebase Hosting `05bc5b27bfd683a8` at 2026-09-09T14:35:00.163Z. Public snapshot retrieval confirmed JPY 5,228 and coverage ending September 7.
