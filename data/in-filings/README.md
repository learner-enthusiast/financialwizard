# India filings (local cache)

Place pre-downloaded DRHP PDFs under `drhp/` (filename should include the company legal name).

Optional `companies.json` at `data/in-filings/companies.json`:

```json
[{ "legalName": "Example Ltd", "drhpUrl": "https://..." }]
```

Live fetch uses `lib/clients/firecrawl.ts` only when no local PDF matches.
